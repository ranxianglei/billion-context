import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import type { NativeInterceptState } from "../src/agent/native-intercept.js";

// #5625 regression pins (rework of reverted PR #4280; original report #4276):
// the opencode V2 http.request hook must NOT rewrite
// the shared request payload — every later hook (provider-scoped plugins and
// opencode's own built-in provider hooks) sees the ORIGINAL upstream URL, and
// the <proxy>/bili/<upstream> rewrite happens at fetch time in the shared
// native intercept chain (installed by the entry's setup()).
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-5625-state-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

const MODEL_URL = "https://api.anthropic.com/v1/messages";
// The Antigravity pool endpoint the provider plugin rewrites to in the #4276
// repro: not a model-API shape, so the chain must pass it through unproxied.
const POOL_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const DIRECT_PREFIX = "https://ex.example";
const EXEMPT_URL = `${DIRECT_PREFIX}/v1/chat/completions`;

interface SinkEntry { url: string; headers: Record<string, string>; }

function fakeAnchor(sink: SinkEntry[]): typeof fetch {
    return (async (input: string | URL | Request, _init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(input as string | URL, _init);
        sink.push({ url: req.url, headers: Object.fromEntries(req.headers.entries()) });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

async function withChain<T>(state: NativeInterceptState, fn: () => Promise<T>): Promise<{ result: T; sink: SinkEntry[] }> {
    const saved = globalThis.fetch;
    const sink: SinkEntry[] = [];
    const { _resetForTest, installNativeFetchIntercept } = await import("../src/agent/native-intercept.js");
    _resetForTest();
    globalThis.fetch = fakeAnchor(sink);
    try {
        assert.equal(installNativeFetchIntercept(state), true);
        const result = await fn();
        return { result, sink };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

interface HookCbs { [name: string]: ((e: Record<string, unknown>) => void | Promise<void>) | undefined; }

function makeHookCtx() {
    const cbs: HookCbs = {};
    const ctx = {
        session: {
            hook: async (name: string, cb: (e: Record<string, unknown>) => void | Promise<void>) => {
                cbs[name] = cb;
                return { dispose() {} };
            },
        },
    };
    return { ctx, cbs };
}

test("hook leaves e.request untouched; the fetch routes to <origin>/bili/<url> (#4276)", async () => {
    const origin = "http://127.0.0.1:43210";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const { createNativeRoute } = await import("../src/agent/opencode-native.js");
    const { createOpencodeV2Setup } = await import("../src/agent/opencode-v2.js");
    const { ctx, cbs } = makeHookCtx();
    const cleanup = await createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => true }) })(ctx as never);
    try {
        const { sink } = await withChain(state, async () => {
            const original = new Request(MODEL_URL, { method: "POST", headers: { authorization: "Bearer k" } });
            const e: Record<string, unknown> = { sessionID: "ses_4276", model: { providerID: "anthropic", id: "claude-x" }, request: original };
            await cbs["http.request"]!(e);
            // Every later hook (provider plugins included) reads THIS object.
            assert.equal(e.request, original, "hook must not replace the shared request");
            assert.equal((e.request as Request).url, MODEL_URL, "provider-scoped hooks see the original URL");
            assert.equal((e.request as Request).headers.get("x-bili-plugin"), "opencode", "identity still stamped in place");
            assert.equal((e.request as Request).headers.get("authorization"), "Bearer k");
            const res = await globalThis.fetch(e.request as Request);
            assert.equal(res.status, 200);
        });
        // bili's own control-plane fetches (__bili/*) ride the same global
        // fetch — the model request is the non-control entry.
        const model = sink.filter((s) => !s.url.includes("/__bili/"));
        assert.deepEqual(model.map((s) => s.url), [`${origin}/bili/${MODEL_URL}`]);
        assert.equal(model[0].headers["x-bili-plugin"], "opencode");
        assert.equal(model[0].headers["authorization"], "Bearer k");
    } finally {
        cleanup();
    }
});

test("provider plugin rewriting to a pool endpoint passes through unproxied (#4276)", async () => {
    const origin = "http://127.0.0.1:43211";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin) };
    const { createNativeRoute } = await import("../src/agent/opencode-native.js");
    const { createOpencodeV2Setup } = await import("../src/agent/opencode-v2.js");
    const { ctx, cbs } = makeHookCtx();
    const cleanup = await createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => true }) })(ctx as never);
    try {
        const { sink } = await withChain(state, async () => {
            const e: Record<string, unknown> = { sessionID: "ses_4276", model: { providerID: "google", id: "gemini-x" }, request: new Request(MODEL_URL, { method: "POST" }) };
            await cbs["http.request"]!(e);
            // Provider-scoped request hook (Antigravity shape): the canonical
            // Google URL is visible, so it passes its gate and rewrites the
            // request to its pool endpoint with fresh auth headers.
            e.request = new Request(POOL_URL, { method: "POST", headers: { authorization: "Bearer pool-token" } });
            await globalThis.fetch(e.request as Request);
        });
        const model = sink.filter((s) => !s.url.includes("/__bili/"));
        assert.deepEqual(model.map((s) => s.url), [POOL_URL], "pool endpoint sent byte-identical, unproxied");
        assert.equal(model[0].headers["x-bili-plugin"], undefined, "chain adds no bili headers to non-model traffic");
        assert.equal(model[0].headers["authorization"], "Bearer pool-token");
    } finally {
        cleanup();
    }
});

test("providers.direct exemption: marked direct by the hook, sent unproxied (#4276)", async () => {
    const origin = "http://127.0.0.1:43212";
    const state: NativeInterceptState = { origin, ready: Promise.resolve(origin), directPrefixes: [DIRECT_PREFIX] };
    const { createNativeRoute } = await import("../src/agent/opencode-native.js");
    const { createOpencodeV2Setup } = await import("../src/agent/opencode-v2.js");
    const { ctx, cbs } = makeHookCtx();
    const cleanup = await createOpencodeV2Setup({ route: createNativeRoute(state, { probe: async () => true }), directPrefixes: [DIRECT_PREFIX] })(ctx as never);
    try {
        const { sink } = await withChain(state, async () => {
            const e: Record<string, unknown> = { sessionID: "ses_4276", model: { providerID: "ex", id: "m1" }, request: new Request(EXEMPT_URL, { method: "POST" }) };
            await cbs["http.request"]!(e);
            assert.equal(e.biliDirect, true, "hook marks the exempt request");
            assert.equal((e.request as Request).headers.get("x-bili-plugin"), null, "no bili identity rides the direct send");
            await globalThis.fetch(e.request as Request);
        });
        assert.deepEqual(sink.map((s) => s.url), [EXEMPT_URL]);
        assert.equal(sink[0].headers["x-bili-plugin"], undefined);
    } finally {
        cleanup();
    }
});

function startProbeServer(): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: "9.9.9-test" }));
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }));
}

/** Runs the real entry in a child process and reports whether setup() patched
 *  globalThis.fetch. Attach mode keeps the probe hermetic (no proxy fork). */
function probeInstallGate(probeOrigin: string, extraEnv: Record<string, string>): { patched: boolean; detail: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, BILLION_CONTEXT_PROXY: probeOrigin };
    delete env.NODE_TEST_CONTEXT;
    const entryUrl = new URL("../src/agent/opencode-native.ts", import.meta.url).href;
    const script = [
        "const before = globalThis.fetch;",
        `const mod = await import(${JSON.stringify(entryUrl)});`,
        "process.stderr.write(\"plan=\" + JSON.stringify(mod.planNativeOpencode(process.env)) + \";\\n\");",
        "await mod.default.setup({});",
        "process.stdout.write(String(globalThis.fetch !== before));",
        "process.exit(0);",
    ].join("\n");
    const res = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { encoding: "utf8", timeout: 120_000, env });
    assert.equal(res.status, 0, `install-gate probe failed: ${res.stderr}`);
    const detail = `child stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify((res.stderr ?? "").slice(-500))}`;
    // Last stdout line only: setup() logs its install notice on stdout too.
    return { patched: res.stdout.trim().split("\n").pop() === "true", detail };
}

test("setup installs the fetch chain unless the kill switch opts out (#4276)", async () => {
    const probe = await startProbeServer();
    try {
        const on = probeInstallGate(probe.origin, {});
        assert.equal(on.patched, true, `default: chain installed by setup() — ${on.detail}`);
        const off = probeInstallGate(probe.origin, { BILLION_CONTEXT_PLUGIN: "0" });
        assert.equal(off.patched, false, `kill switch: fully inert — ${off.detail}`);
    } finally {
        await probe.close();
    }
});
