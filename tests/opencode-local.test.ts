import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import biliLocalPlugin, {
    DEFAULT_LOCAL_PORT,
    buildSpawnArgs,
    ensureProxyLoopback,
    parseLocalOptions,
    resolvePackageRoot,
    rewriteToBili,
} from "../src/agent/opencode-local.ts";
import { findNodeRuntime } from "../src/agent/shared.ts";
import { isProtocolSupported } from "../src/agent/opencode-v2.ts";

// Real WHATWG Request (not a plain object): the OpenCode seam hands us a Request
// whose .url is readonly, so the mock must mirror that or it cannot catch a
// regression that writes .url directly.
type HookEvent = { sessionID?: unknown; model?: unknown; request?: Request };
type HookCb = (e: HookEvent) => void | Promise<void>;
type AddedTool = { name: string; input: unknown; options?: Record<string, unknown> };

function makeLocalFakeCtx() {
    let cb: HookCb | undefined;
    const addedTools: AddedTool[] = [];
    const hookNames: string[] = [];
    const ctx = {
        session: {
            hook: async (name: string, c: HookCb) => {
                hookNames.push(name);
                cb = c;
                return { dispose: () => {} };
            },
        },
        tool: {
            transform: async (editor: (ed: { add: (t: AddedTool) => void }) => void) => {
                editor({ add: (t) => addedTools.push(t) });
                return { dispose: () => {} };
            },
        },
        catalog: {
            model: { list: async () => ({ data: [{ providerID: "qwen", id: "m1", limit: { context: 262144 } }] }) },
        },
    };
    const fire = async (input: string | Request, sessionID: string, model?: { providerID?: unknown; id?: unknown }): Promise<{ headers: Record<string, string>; url: string; before: Request; after: Request | null; swapped: boolean }> => {
        const before = typeof input === "string"
            ? new Request(input, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
            : input;
        const evt: HookEvent = { sessionID, model, request: before };
        await cb!(evt);
        const out: Record<string, string> = {};
        const h = evt.request?.headers;
        if (h) for (const [k, v] of h.entries()) out[k] = v;
        return { headers: out, url: evt.request?.url ?? "", before, after: evt.request ?? null, swapped: evt.request !== before };
    };
    return { ctx, fire, addedTools, hookNames };
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    return Promise.resolve(fn()).finally(() => {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });
}

test("object export: .id/.setup for the no-launcher entry", () => {
    assert.equal(biliLocalPlugin.id, "billion-context-opencode-local");
    assert.equal(typeof biliLocalPlugin.setup, "function");
});

test("rewriteToBili prefixes absolute http(s) upstreams and is idempotent", () => {
    const base = "http://127.0.0.1:18787";
    assert.equal(rewriteToBili("http://api.openai.com/v1/chat/completions", base), `${base}/bili/http://api.openai.com/v1/chat/completions`);
    assert.equal(rewriteToBili("https://api.anthropic.com/v1/messages", base), `${base}/bili/https://api.anthropic.com/v1/messages`);
    const q = "https://up.example/v1/x?a=1&b=2 c#f";
    assert.equal(rewriteToBili(q, base), `${base}/bili/${q}`);
    const oncePrefixed = rewriteToBili("http://api.openai.com/v1", base)!;
    assert.equal(rewriteToBili(oncePrefixed, base), oncePrefixed);
});

test("rewriteToBili leaves non-http(s) URLs untouched", () => {
    const base = "http://127.0.0.1:18787";
    assert.equal(rewriteToBili("/relative/path", base), undefined);
    assert.equal(rewriteToBili("ftp://x/y", base), undefined);
});

test("parseLocalOptions defaults and validates port", () => {
    assert.deepEqual(parseLocalOptions(undefined), { proxyBase: `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`, warnings: [] });
    assert.deepEqual(parseLocalOptions({}), { proxyBase: `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`, warnings: [] });
    assert.equal(parseLocalOptions({ port: 9000 }).proxyBase, "http://127.0.0.1:9000");
    assert.equal(parseLocalOptions({ port: "9000" }).proxyBase, "http://127.0.0.1:9000");
    for (const bad of ["18787x", -1, 0, 99999, 1878.5]) {
        const r = parseLocalOptions({ port: bad });
        assert.equal(r.proxyBase, `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`);
        assert.equal(r.warnings.length, 1);
        assert.match(r.warnings[0]!, /invalid plugin option "port"/);
    }
    assert.equal(parseLocalOptions("junk").proxyBase, `http://127.0.0.1:${DEFAULT_LOCAL_PORT}`);
});

test("buildSpawnArgs pins loopback, disables auto-update, uses the start subcommand", () => {
    const args = buildSpawnArgs("/some/root", 18787);
    assert.deepEqual(args, [path.join("/some/root", "dist", "index.js"), "start", "--port", "18787", "--host", "127.0.0.1", "--no-auto-update"]);
    assert.ok(args.includes("--no-auto-update"));
    assert.ok(args.includes("127.0.0.1"));
    assert.ok(args.includes("start"));
});

test("resolvePackageRoot is an absolute path", () => {
    assert.ok(path.isAbsolute(resolvePackageRoot()));
});

test("local mode adopts a live proxy, stamps headers, rewrites url idempotently", async () => {
    const server = http.createServer((req, res) => {
        if ((req.url ?? "") === "/__bili/plugin/manifest" && req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocolVersion: 1, proxy: "billion-context", version: "99.0.0-test" }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const fake = makeLocalFakeCtx();
    const cleanup = await biliLocalPlugin.setup(fake.ctx as never, { port });
    try {
        assert.deepEqual(fake.hookNames, ["http.request"]);
        assert.ok(fake.addedTools.length > 0, "native tools registered against the adopted proxy");
        const r1 = await fake.fire("https://api.openai.com/v1/chat/completions", "s1", { providerID: "qwen", id: "m1" });
        assert.equal(r1.headers["x-bili-plugin"], "opencode");
        assert.equal(r1.headers["x-bili-plugin-conversation"], "s1");
        assert.equal(r1.url, `http://127.0.0.1:${port}/bili/https://api.openai.com/v1/chat/completions`);
        const r2 = await fake.fire(r1.url, "s1");
        assert.equal(r2.url, r1.url);
    } finally {
        cleanup();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("local mode stands down inert when the launcher owns the proxy", async () => {
    const fake = makeLocalFakeCtx();
    await withEnv({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:9999" }, async () => {
        const cleanup = await biliLocalPlugin.setup(fake.ctx as never, { port: DEFAULT_LOCAL_PORT });
        assert.ok(typeof cleanup === "function");
        assert.deepEqual(fake.hookNames, [], "no hooks registered while standing down");
        assert.equal(fake.addedTools.length, 0, "no tools registered while standing down");
        cleanup();
    });
});

test("local mode stands down inert when the kill switch is set", async () => {
    const fake = makeLocalFakeCtx();
    await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: "0" }, async () => {
        const cleanup = await biliLocalPlugin.setup(fake.ctx as never, { port: DEFAULT_LOCAL_PORT });
        assert.deepEqual(fake.hookNames, []);
        assert.equal(fake.addedTools.length, 0);
        cleanup();
    });
});

test("local mode routes via request-reference swap on a real WHATWG Request (never writes readonly .url)", async () => {
    const server = http.createServer((req, res) => {
        if ((req.url ?? "") === "/__bili/plugin/manifest" && req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocolVersion: 1, proxy: "billion-context", version: "99.0.0-test" }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const fake = makeLocalFakeCtx();
    const cleanup = await biliLocalPlugin.setup(fake.ctx as never, { port });
    try {
        const r = await fake.fire("https://api.openai.com/v1/chat/completions", "s1");
        assert.ok(r.swapped, "hook replaced the request reference instead of writing readonly .url");
        assert.notStrictEqual(r.after, r.before);
        assert.equal(r.after!.url, `${base}/bili/https://api.openai.com/v1/chat/completions`);
        assert.equal(r.before.method, "POST");
    } finally {
        cleanup();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("findNodeRuntime: BILLION_CONTEXT_NODE override wins when it exists", () =>
    withEnv({ BILLION_CONTEXT_NODE: "/opt/custom/node" }, () => {
        assert.equal(findNodeRuntime({ execPath: "/usr/bin/opencode", pathEnv: "", exists: (p) => p === "/opt/custom/node" }), "/opt/custom/node");
    }));

test("findNodeRuntime: uses process.execPath when it is node", () =>
    withEnv({ BILLION_CONTEXT_NODE: undefined }, () => {
        assert.equal(findNodeRuntime({ execPath: "/usr/local/bin/node", pathEnv: "" }), "/usr/local/bin/node");
    }));

test("findNodeRuntime: walks PATH for node when execPath is a native binary", () =>
    withEnv({ BILLION_CONTEXT_NODE: undefined }, () => {
        const dirs = ["/opt/a", "/opt/b"];
        const hit = path.join(dirs[1], "node");
        assert.equal(findNodeRuntime({ execPath: "/usr/local/bin/opencode", pathEnv: dirs.join(path.delimiter), exists: (p) => p === hit }), hit);
    }));

test("findNodeRuntime: returns undefined when nothing resolves", () =>
    withEnv({ BILLION_CONTEXT_NODE: undefined }, () => {
        assert.equal(findNodeRuntime({ execPath: "/usr/local/bin/opencode", pathEnv: "/a:/b", exists: () => false }), undefined);
    }));

test("findNodeRuntime: running-under-node wins over BILLION_CONTEXT_NODE override", () =>
    withEnv({ BILLION_CONTEXT_NODE: "/opt/custom/node" }, () => {
        assert.equal(findNodeRuntime({ execPath: "/usr/local/bin/node", pathEnv: "" }), "/usr/local/bin/node");
    }));

test("isProtocolSupported: known version supported", () => {
    assert.equal(isProtocolSupported(1), true);
});

test("isProtocolSupported: unknown numeric version fails closed", () => {
    assert.equal(isProtocolSupported(2), false);
});

test("isProtocolSupported: missing protocolVersion fails closed", () => {
    assert.equal(isProtocolSupported(undefined), false);
});

test("ensureProxyLoopback observes async spawn 'error' and degrades inert instead of crashing the host", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-f3-"));
    try {
        fs.mkdirSync(path.join(tmpRoot, "dist"), { recursive: true });
        fs.writeFileSync(path.join(tmpRoot, "dist", "index.js"), "// stub\n");
        const child = Object.assign(new EventEmitter(), { unref: () => {} });
        const fakeSpawn = (() => {
            setTimeout(() => child.emit("error", new Error("spawn ENOENT")), 0);
            return child;
        });
        const result = await ensureProxyLoopback("http://127.0.0.1:18799", {
            spawn: fakeSpawn as unknown as typeof import("node:child_process").spawn,
            packageRoot: () => tmpRoot,
        });
        assert.deepEqual(result, { connected: false, identityOk: false });
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});
