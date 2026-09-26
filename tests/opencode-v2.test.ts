import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import biliOpencodePlugin from "../src/agent/opencode.ts";
import { ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI } from "../src/compress-tool.ts";
import { fetchManifest } from "../src/agent/shared.ts";

const EXPECTED_TOOLS = [...ACP_TOOLS_OPENAI.map((t) => t.function.name), ABSORB_TOOL_OPENAI.function.name];

function startFakeProxyV2(): Promise<{ origin: string; toolCalls: Array<{ conversationId?: string; tool?: string; args?: unknown }>; compacts: string[]; close: () => Promise<void> }> {
    const toolCalls: Array<{ conversationId?: string; tool?: string; args?: unknown }> = [];
    const compacts: string[] = [];
    const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/tool" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const data = JSON.parse(body) as { conversationId?: string; tool?: string; args?: unknown };
                toolCalls.push(data);
                res.writeHead(200, { "content-type": "application/json" });
                if (data.tool === "acp_status") {
                    res.end(JSON.stringify({ ok: true, result: "STATUS-RESULT" }));
                } else if (data.tool === "acp_cache") {
                    res.end(JSON.stringify({ ok: true, result: data.conversationId === "ses_cache_long" ? "L".repeat(9000) : "CACHE-REPORT-OK" }));
                } else {
                    res.end(JSON.stringify({ ok: false, error: `boom-${data.tool}` }));
                }
            });
            return;
        }
        if (url === "/__bili/plugin/compact" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const data = JSON.parse(body) as { conversationId?: string };
                compacts.push(data.conversationId ?? "");
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }
        if ((req.url ?? "").startsWith("/__bili/plugin/status")) {
            if ((req.url ?? "").includes("ses_acp_idle")) {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: "unknown plugin conversation" }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            const panel = (req.url ?? "").includes("ses_acp_long") ? "X".repeat(1500) : "ACP-PANEL-OK";
            res.end(JSON.stringify({ ok: true, panel }));
            return;
        }
        if ((req.url ?? "") === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ version: "9.9.9-test" }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => ({
        origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        toolCalls,
        compacts,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }));
}

interface FakeAddedTool {
    name: string;
    description?: string;
    input: unknown;
    options?: Record<string, unknown>;
    execute: (input: Record<string, unknown>, ctx: { sessionID: string }) => Promise<{ content: string }>;
}

interface FakeAddedCommand {
    name: string;
    description?: string;
    execute: (input: Record<string, unknown>) => Promise<void>;
}

function makeFakeCtx() {
    const eventQueue: Array<{ type?: unknown; data?: Record<string, unknown> }> = [];
    let wake: (() => void) | undefined;
    let closed = false;
    let signal: AbortSignal | undefined;
    const addedTools: FakeAddedTool[] = [];
    const addedCommands: FakeAddedCommand[] = [];
    const syntheticCalls: Array<{ sessionID: string; text: string; description?: string; resume?: boolean }> = [];
    let modelRequestCb: ((e: Record<string, unknown>) => void | Promise<void>) | undefined;
    const disposed: number[] = [];

    const ctx = {
        session: {
            hook: async (name: string, cb: (e: Record<string, unknown>) => void | Promise<void>) => {
                assert.equal(name, "http.request");
                modelRequestCb = cb;
                return { dispose: () => { disposed.push(1); } };
            },
            synthetic: async (input: { sessionID: string; text: string; description?: string; resume?: boolean }) => {
                syntheticCalls.push(input);
                return {};
            },
        },
        tool: {
            transform: async (cb: (editor: { add: (t: FakeAddedTool) => void }) => void) => {
                cb({ add: (t) => addedTools.push(t) });
                return { dispose: () => { disposed.push(2); } };
            },
        },
        command: {
            transform: async (cb: (editor: { add: (c: FakeAddedCommand) => void }) => void) => {
                cb({ add: (c) => addedCommands.push(c) });
                return { dispose: () => { disposed.push(3); } };
            },
        },
        event: {
            subscribe: (opts?: { signal?: AbortSignal }) => {
                signal = opts?.signal;
                signal?.addEventListener("abort", () => { closed = true; wake?.(); }, { once: true });
                return {
                    [Symbol.asyncIterator]: (): AsyncIterator<{ type?: unknown; data?: Record<string, unknown> }> => ({
                        next: async () => {
                            while (eventQueue.length === 0 && !closed && !signal?.aborted) {
                                await new Promise<void>((r) => (wake = r));
                            }
                            wake = undefined;
                            const v = eventQueue.shift();
                            return v === undefined ? { done: true as const, value: undefined } : { done: false as const, value: v };
                        },
                    }),
                };
            },
        },
        catalog: {
            model: {
                list: async () => ({ data: [{ providerID: "qwen", id: "m1", limit: { context: 262144 } }] }),
            },
        },
    };

    return {
        ctx,
        fireModelRequest: async (opts: { sessionID?: unknown; baseURL?: unknown; model?: unknown }) => {
            const store: Record<string, string> = {};
            await modelRequestCb!({
                sessionID: opts.sessionID,
                model: opts.model,
                request: {
                    url: opts.baseURL,
                    headers: { set: (k: string, v: string) => { store[k] = v; } },
                },
            });
            return { headers: store };
        },
        pushEvent: (evt: { type?: unknown; data?: Record<string, unknown> }) => { eventQueue.push(evt); wake?.(); },
        get addedTools() { return addedTools; },
        get addedCommands() { return addedCommands; },
        get syntheticCalls() { return syntheticCalls; },
        get disposed() { return disposed; },
    };
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error("condition not met in time");
        await new Promise((r) => setTimeout(r, 10));
    }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>): Promise<void> {
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

test("object export: .id/.setup for V2 and .server for V1 >= 1.18.29", () => {
    assert.equal(typeof biliOpencodePlugin, "object");
    assert.ok(biliOpencodePlugin !== null);
    assert.equal(biliOpencodePlugin.id, "billion-context-opencode");
    assert.equal(typeof biliOpencodePlugin.setup, "function");
    assert.equal(typeof biliOpencodePlugin.server, "function");
});

test("v2 setup: registers the bundled bili tools synchronously with exact schema parity", async () => {
    const fake = makeFakeCtx();
    await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
        const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
        try {
            assert.deepEqual(fake.addedTools.map((t) => t.name), EXPECTED_TOOLS);
            for (const t of fake.addedTools) {
                assert.equal(t.options?.codemode, false);
                assert.equal(t.options?.permission, "allow");
            }
            const compressSrc = [...ACP_TOOLS_OPENAI, ABSORB_TOOL_OPENAI].find((t) => t.function.name === "compress")!;
            assert.deepEqual(fake.addedTools.find((t) => t.name === "compress")!.input, compressSrc.function.parameters);
        } finally {
            cleanup();
        }
    });
});

test("v2 setup: inert without proxy detection (tools present but no headers, no forwarding)", async () => {
    const fake = makeFakeCtx();
    await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
        const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
        try {
            const res = await fake.fireModelRequest({ sessionID: "s1", baseURL: "http://upstream.example/v1" });
            assert.deepEqual(res.headers, {});
            const out = await fake.addedTools[0].execute({}, { sessionID: "s1" });
            assert.match(out.content, /no proxy detected/);
        } finally {
            cleanup();
            assert.ok(fake.disposed.includes(1) && fake.disposed.includes(2));
        }
    });
});

test("v2 setup: inert-safe when the host exposes none of the V2 seams", async () => {
    const cleanup = await biliOpencodePlugin.setup({} as never);
    assert.equal(typeof cleanup, "function");
    cleanup();
});

test("v2 setup: kill switch stays inert even with /bili/ URL + proxy env", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: "0" }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const res = await fake.fireModelRequest({ sessionID: "s1", baseURL: `${proxy.origin}/bili/http://upstream.example/v1` });
                assert.deepEqual(res.headers, {});
                const out = await fake.addedTools.find((t) => t.name === "compress")!.execute({ content: [] }, { sessionID: "s1" });
                assert.match(out.content, /disabled \(BILLION_CONTEXT_PLUGIN=0\)/);
                assert.equal(proxy.toolCalls.length, 0);
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 setup: activates from /bili/ baseURL on round 1, stamps headers, forwards tools", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const r1 = await fake.fireModelRequest({
                    sessionID: "ses_v2_1",
                    baseURL: `${proxy.origin}/bili/http://upstream.example/v1`,
                    model: { providerID: "qwen", id: "m1" },
                });
                assert.equal(r1.headers["x-bili-plugin"], "opencode");
                assert.equal(r1.headers["x-bili-plugin-conversation"], "ses_v2_1");
                // window header needs the async catalog fetch — lands from round 2
                const r2 = await fake.fireModelRequest({
                    sessionID: "ses_v2_1",
                    baseURL: `${proxy.origin}/bili/http://upstream.example/v1`,
                    model: { providerID: "qwen", id: "m1" },
                });
                await until(() => r2.headers["x-bili-plugin-context-window"] === "262144");

                const out = await fake.addedTools.find((t) => t.name === "compress")!.execute({ content: [] }, { sessionID: "ses_v2_1" });
                assert.match(out.content, /boom-compress/);
                assert.equal(proxy.toolCalls.at(-1)?.conversationId, "ses_v2_1");
                assert.equal(proxy.toolCalls.at(-1)?.tool, "compress");

                // Panel-first: acp_status returns the status panel when the
                // proxy serves one for this conversation (ses_other gets the
                // generic "ACP-PANEL-OK"), and falls back to the forwarded
                // kernel tool when the status endpoint 404s (ses_acp_idle).
                const panelOut = await fake.addedTools.find((t) => t.name === "acp_status")!.execute({}, { sessionID: "ses_other" });
                assert.equal(panelOut.content, "ACP-PANEL-OK");
                const statusOut = await fake.addedTools.find((t) => t.name === "acp_status")!.execute({}, { sessionID: "ses_acp_idle" });
                assert.equal(statusOut.content, "STATUS-RESULT");
                assert.equal(proxy.toolCalls.at(-1)?.tool, "acp_status");
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 setup: env-based activation without /bili/ URL", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const res = await fake.fireModelRequest({ sessionID: "s2", baseURL: "http://real-upstream.example/v1" });
                assert.equal(res.headers["x-bili-plugin"], "opencode");
                assert.equal(res.headers["x-bili-plugin-conversation"], "s2");
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 setup: session.compaction.ended reports boundary to proxy archive", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                await fake.fireModelRequest({ sessionID: "s3", baseURL: "http://u.example/v1", headers: {} });
                fake.pushEvent({ type: "session.compaction.ended", data: { sessionID: "s3", reason: "manual" } });
                fake.pushEvent({ type: "session.created", data: { info: { id: "nope" } } });
                await until(() => proxy.compacts.includes("s3"));
                assert.deepEqual(proxy.compacts, ["s3"]);
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 setup: cleanup aborts event subscription and disposes registrations", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            await fake.fireModelRequest({ sessionID: "s4", baseURL: "http://u.example/v1", headers: {} });
            cleanup();
            assert.ok(fake.disposed.includes(1), "model.request hook registration disposed");
            assert.ok(fake.disposed.includes(2), "tool transform registration disposed");
        });
    } finally {
        await proxy.close();
    }
});

test("v2 setup: /acp command registered and renders proxy status panel via synthetic", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const acp = fake.addedCommands.find((c) => c.name === "acp");
                assert.ok(acp, "/acp command registered");
                assert.equal(typeof acp!.execute, "function");
                await acp!.execute({ sessionID: "ses_acp_1" });
                await until(() => fake.syntheticCalls.length === 1);
                assert.equal(fake.syntheticCalls[0].sessionID, "ses_acp_1");
                assert.match(fake.syntheticCalls[0].description!, /ACP-PANEL-OK/);
                assert.match(fake.syntheticCalls[0].text, /displayed in your terminal/);
                assert.match(fake.syntheticCalls[0].text, /not an instruction/);
                assert.equal(fake.syntheticCalls[0].resume, false);
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 setup: /acp reports no proxy detected via synthetic when no proxy", async () => {
    const fake = makeFakeCtx();
    await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
        const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
        try {
            const acp = fake.addedCommands.find((c) => c.name === "acp")!;
            await acp.execute({ sessionID: "s_nopx" });
            await until(() => fake.syntheticCalls.length === 1);
            assert.match(fake.syntheticCalls[0].description!, /no proxy detected/);
            assert.match(fake.syntheticCalls[0].text, /not an instruction/);
            assert.equal(fake.syntheticCalls[0].resume, false);
        } finally {
            cleanup();
        }
    });
});

test("v2 setup: first /acp before any model request shows the idle notice (proxy 404s the conversation)", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const acp = fake.addedCommands.find((c) => c.name === "acp")!;
                await acp.execute({ sessionID: "ses_acp_idle" });
                await until(() => fake.syntheticCalls.length === 1);
                assert.match(fake.syntheticCalls[0].description!, /billion-context@9\.9\.9-test \u2014 proxy connected, no ACP session yet/);
                assert.match(fake.syntheticCalls[0].text, /not an instruction/);
                assert.equal(fake.syntheticCalls[0].resume, false);
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});


test("v2 setup: /acp truncates long panels to the TUI notice cap", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const acp = fake.addedCommands.find((c) => c.name === "acp")!;
                await acp.execute({ sessionID: "ses_acp_long" });
                await until(() => fake.syntheticCalls.length === 1);
                const desc = fake.syntheticCalls[0].description ?? "";
                assert.ok(desc.length > 0 && desc.length <= 1024);
                assert.match(desc, /\[panel truncated\]$/);
                assert.match(fake.syntheticCalls[0].text, /not an instruction/);
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 /acp: host omits sessionID → warn once, render nothing (never an empty-id synthetic)", async () => {
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg?: unknown) => { warns.push(String(msg)); };
    try {
        for (const plugin of ["0", undefined]) {
            const f = makeFakeCtx();
            await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: plugin }, async () => {
                const cleanup = await biliOpencodePlugin.setup(f.ctx as never);
                try {
                    const acp = f.addedCommands.find((c) => c.name === "acp")!;
                    await acp.execute({});
                    await new Promise((r) => setTimeout(r, 20));
                    assert.equal(f.syntheticCalls.length, 0, `no synthetic for missing sessionID (BILLION_CONTEXT_PLUGIN=${String(plugin)})`);
                } finally {
                    cleanup();
                }
            });
        }
        assert.equal(warns.filter((w) => w.includes("sessionID")).length, 2, "one warning per no-sessionID invocation");
    } finally {
        console.warn = origWarn;
    }
});

test("v2 /acp: disabled + valid session still renders the 'disabled' notice", async () => {
    const fake = makeFakeCtx();
    await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: "0" }, async () => {
        const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
        try {
            const acp = fake.addedCommands.find((c) => c.name === "acp")!;
            await acp.execute({ sessionID: "ses_dis" });
            await until(() => fake.syntheticCalls.length === 1);
            assert.match(fake.syntheticCalls[0].description!, /disabled/);
            assert.equal(fake.syntheticCalls[0].sessionID, "ses_dis");
        } finally {
            cleanup();
        }
    });
});

test("v2 setup: /acp-cache registered and renders the cache report via synthetic (#1146)", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const cache = fake.addedCommands.find((c) => c.name === "acp-cache");
                assert.ok(cache, "/acp-cache command registered");
                await cache!.execute({ sessionID: "ses_cache_1" });
                await until(() => fake.syntheticCalls.length === 1);
                assert.equal(fake.syntheticCalls[0].sessionID, "ses_cache_1");
                assert.match(fake.syntheticCalls[0].description!, /CACHE-REPORT-OK/);
                assert.match(fake.syntheticCalls[0].text, /not an instruction/);
                assert.equal(fake.syntheticCalls[0].resume, false);
                assert.deepEqual(proxy.toolCalls, [{ conversationId: "ses_cache_1", tool: "acp_cache", args: {} }]);
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 /acp-cache: full flag maps to detail=full; long reports truncate at the report cap (#1146)", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const cache = fake.addedCommands.find((c) => c.name === "acp-cache")!;
                await cache.execute({ sessionID: "ses_cache_full", arguments: "full" });
                await until(() => fake.syntheticCalls.length === 1);
                assert.match(fake.syntheticCalls[0].description!, /CACHE-REPORT-OK/);
                assert.deepEqual(proxy.toolCalls.at(-1), { conversationId: "ses_cache_full", tool: "acp_cache", args: { detail: "full" } });

                await cache.execute({ sessionID: "ses_cache_long" });
                await until(() => fake.syntheticCalls.length === 2);
                const desc = fake.syntheticCalls[1].description ?? "";
                assert.ok(desc.length <= 8192, `report cap holds (${desc.length})`);
                assert.match(desc, /\[report truncated\]$/);
            } finally {
                cleanup();
            }
        });
    } finally {
        await proxy.close();
    }
});

test("v2 /acp-cache: missing sessionID warns and renders nothing (#1146)", async () => {
    const proxy = await startFakeProxyV2();
    const fake = makeFakeCtx();
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg?: unknown) => { warns.push(String(msg)); };
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: proxy.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const cache = fake.addedCommands.find((c) => c.name === "acp-cache")!;
                await cache.execute({});
                await new Promise((r) => setTimeout(r, 20));
                assert.equal(fake.syntheticCalls.length, 0);
            } finally {
                cleanup();
            }
        });
        assert.ok(warns.some((w) => w.includes("/acp-cache") && w.includes("sessionID")));
    } finally {
        console.warn = origWarn;
        await proxy.close();
    }
});

test("v2 /acp-cache: disabled plugin and no-proxy diagnostics render via synthetic (#1146)", async () => {
    for (const env of [
        { BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: "0" },
        { BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined },
    ] as Array<Record<string, string | undefined>>) {
        const fake = makeFakeCtx();
        await withEnv(env, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const cache = fake.addedCommands.find((c) => c.name === "acp-cache")!;
                await cache.execute({ sessionID: "s_diag" });
                await until(() => fake.syntheticCalls.length === 1);
                if (env.BILLION_CONTEXT_PLUGIN === "0") assert.match(fake.syntheticCalls[0].description!, /disabled/);
                else assert.match(fake.syntheticCalls[0].description!, /no proxy detected/);
            } finally {
                cleanup();
            }
        });
    }
});

test("v2 /acp: surfaces status.error when the proxy returns no panel", async () => {
    const server = http.createServer((req, res) => {
        if ((req.url ?? "").startsWith("/__bili/plugin/status")) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, error: "backend-busy" }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                const acp = fake.addedCommands.find((c) => c.name === "acp")!;
                await acp.execute({ sessionID: "ses_err" });
                await until(() => fake.syntheticCalls.length === 1);
                assert.match(fake.syntheticCalls[0].description!, /no status panel/);
                assert.match(fake.syntheticCalls[0].description!, /backend-busy/);
            } finally {
                cleanup();
            }
        });
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test("v2 /acp: a throwing command editor degrades to no-/acp without killing setup", async () => {
    const fake = makeFakeCtx();
    const ctxObj = fake.ctx as unknown as { command?: unknown };
    ctxObj.command = {
        transform: async (cb: (editor: { add: (c: unknown) => void }) => void) => {
            cb({ add: () => { throw new Error("command editor has no add"); } });
            return { dispose: () => {} };
        },
    };
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg?: unknown) => { warns.push(String(msg)); };
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await biliOpencodePlugin.setup(fake.ctx as never);
            try {
                assert.ok(typeof cleanup === "function", "setup resolved despite the command editor throwing");
            } finally {
                cleanup();
            }
        });
        assert.ok(warns.some((w) => w.includes("/acp")), "degradation logged");
    } finally {
        console.warn = origWarn;
    }
});

test("fetchManifest openai format maps parameters to inputSchema", async () => {
    const MANIFEST_OPENAI = [
        { name: "compress", description: "Compress a range", parameters: { type: "object", properties: { content: { type: "array" } }, required: ["content"] } },
        { name: "acp_status", description: "Context status", parameters: { type: "object", properties: {} } },
    ];
    const server = http.createServer((req, res) => {
        if ((req.url ?? "") === "/__bili/plugin/manifest" && req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, protocolVersion: 1, version: "99.0.0-test", tools: { openai: MANIFEST_OPENAI } }));
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
        const tools = await fetchManifest(origin, "openai");
        assert.deepEqual(tools.map((t) => t.name), ["compress", "acp_status"]);
        assert.deepEqual(tools[0].inputSchema, MANIFEST_OPENAI[0].parameters);
        const anthropic = await fetchManifest(origin, "anthropic").catch((e) => e);
        assert.ok(anthropic instanceof Error, "fake serves no anthropic tools — format must not cross-contaminate");
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

import { createOpencodeV2Setup } from "../src/agent/opencode-v2.ts";

function startRegisterProxy(failFirst = 0): Promise<{ origin: string; registers: Array<{ conversationId?: string; agent?: string; identity?: boolean; parentConversationId?: string }>; close: () => Promise<void> }> {
    const registers: Array<{ conversationId?: string; agent?: string; identity?: boolean; parentConversationId?: string }> = [];
    let failuresLeft = failFirst;
    const server = http.createServer((req, res) => {
        if ((req.url ?? "") === "/__bili/plugin/register" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                registers.push(JSON.parse(body));
                if (failuresLeft > 0) {
                    failuresLeft--;
                    res.writeHead(500);
                    res.end("{}");
                } else {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true }));
                }
            });
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    return new Promise((resolve) => {
        server.once("listening", () => {
            const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
            resolve({ origin, registers, close: () => new Promise<void>((r) => server.close(() => r())) });
        });
    });
}

test("#1362: V2 child session links its parent via session.created + first request", async () => {
    const reg = await startRegisterProxy();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: reg.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                fake.pushEvent({ type: "session.created", data: { sessionID: "ses_c", parentID: "ses_p" } });
                await new Promise((r) => setTimeout(r, 20));
                const r1 = await fake.fireModelRequest({ sessionID: "ses_c", baseURL: "http://upstream.example/v1" });
                assert.equal(r1.headers["x-bili-plugin-conversation"], "ses_c");
                await until(() => reg.registers.length >= 1);
                assert.deepEqual(reg.registers[0], { conversationId: "ses_c", agent: "opencode", identity: true, parentConversationId: "ses_p" });
                await fake.fireModelRequest({ sessionID: "ses_c", baseURL: "http://upstream.example/v1" });
                await new Promise((r) => setTimeout(r, 50));
                assert.equal(reg.registers.length, 1, "derived sid registered exactly once");
            } finally {
                cleanup();
            }
        });
    } finally {
        await reg.close();
    }
});

test("#1362: V2 root sessions (no parentID) send no register", async () => {
    const reg = await startRegisterProxy();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: reg.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                fake.pushEvent({ type: "session.created", data: { sessionID: "ses_root" } });
                await new Promise((r) => setTimeout(r, 20));
                await fake.fireModelRequest({ sessionID: "ses_root", baseURL: "http://upstream.example/v1" });
                await fake.fireModelRequest({ sessionID: "ses_root", baseURL: "http://upstream.example/v1" });
                await new Promise((r) => setTimeout(r, 80));
                assert.deepEqual(reg.registers, []);
            } finally {
                cleanup();
            }
        });
    } finally {
        await reg.close();
    }
});

test("#1362: V2 self-parent is filtered at ingest", async () => {
    const reg = await startRegisterProxy();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: reg.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                fake.pushEvent({ type: "session.created", data: { sessionID: "ses_s", parentID: "ses_s" } });
                await new Promise((r) => setTimeout(r, 20));
                await fake.fireModelRequest({ sessionID: "ses_s", baseURL: "http://upstream.example/v1" });
                await fake.fireModelRequest({ sessionID: "ses_s", baseURL: "http://upstream.example/v1" });
                await new Promise((r) => setTimeout(r, 80));
                assert.deepEqual(reg.registers, []);
            } finally {
                cleanup();
            }
        });
    } finally {
        await reg.close();
    }
});

test("#1362: V2 parent announced after the child's first request links late", async () => {
    const reg = await startRegisterProxy();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: reg.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                await fake.fireModelRequest({ sessionID: "ses_l", baseURL: "http://upstream.example/v1" });
                await new Promise((r) => setTimeout(r, 50));
                assert.deepEqual(reg.registers, [], "no parent known yet");
                fake.pushEvent({ type: "session.created", data: { sessionID: "ses_l", parentID: "ses_lp" } });
                await new Promise((r) => setTimeout(r, 20));
                await fake.fireModelRequest({ sessionID: "ses_l", baseURL: "http://upstream.example/v1" });
                await until(() => reg.registers.length >= 1);
                assert.deepEqual(reg.registers[0], { conversationId: "ses_l", agent: "opencode", identity: true, parentConversationId: "ses_lp" });
            } finally {
                cleanup();
            }
        });
    } finally {
        await reg.close();
    }
});

test("#1362: failed V2 derive register retries after the cooldown window", async () => {
    const reg = await startRegisterProxy(1);
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: reg.origin, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            const cleanup = await createOpencodeV2Setup({ derivedRetryMs: 60 })(fake.ctx as never);
            try {
                fake.pushEvent({ type: "session.created", data: { sessionID: "ses_f", parentID: "ses_fp" } });
                await new Promise((r) => setTimeout(r, 20));
                await fake.fireModelRequest({ sessionID: "ses_f", baseURL: "http://upstream.example/v1" });
                await until(() => reg.registers.length >= 1);
                await fake.fireModelRequest({ sessionID: "ses_f", baseURL: "http://upstream.example/v1" });
                assert.equal(reg.registers.length, 1, "throttled during cooldown");
                await new Promise((r) => setTimeout(r, 100));
                await fake.fireModelRequest({ sessionID: "ses_f", baseURL: "http://upstream.example/v1" });
                await until(() => reg.registers.length >= 2);
                assert.deepEqual(reg.registers[1], { conversationId: "ses_f", agent: "opencode", identity: true, parentConversationId: "ses_fp" });
            } finally {
                cleanup();
            }
        });
    } finally {
        await reg.close();
    }
});

test("#1362: V2 kill switch suppresses derivation reporting too", async () => {
    const reg = await startRegisterProxy();
    const fake = makeFakeCtx();
    try {
        await withEnv({ BILLION_CONTEXT_PROXY: reg.origin, BILLION_CONTEXT_PLUGIN: "0" }, async () => {
            const cleanup = await createOpencodeV2Setup({})(fake.ctx as never);
            try {
                fake.pushEvent({ type: "session.created", data: { sessionID: "ses_k", parentID: "ses_kp" } });
                await new Promise((r) => setTimeout(r, 20));
                const r1 = await fake.fireModelRequest({ sessionID: "ses_k", baseURL: "http://upstream.example/v1" });
                assert.equal(r1.headers["x-bili-plugin-conversation"], undefined, "no stamping under kill switch");
                await new Promise((r) => setTimeout(r, 80));
                assert.deepEqual(reg.registers, []);
            } finally {
                cleanup();
            }
        });
    } finally {
        await reg.close();
    }
});
