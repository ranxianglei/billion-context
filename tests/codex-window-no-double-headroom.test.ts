import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// A codex live-table window (models_cache.json / model_catalog_json) is
// context_window x effective_context_window_percent, and codex defines that
// percent as the share usable for inputs AFTER reserving model output. bili
// used to reserve its default 25% output headroom on top, so for a 272K model
// codex grows the session to its own auto-compact point (90% of 272K = 244.8K)
// while bili's preflight wall sat at 258.4K x 0.75 = 193.8K: every turn past
// that is an unrecoverable 413 ("futile round") that codex keeps retrying.

import { codexWindowNetsOutputHeadroom } from "../src/codex-models.ts";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

const MODEL = "gpt-codex-window-test";
const NATIVE = 1_000_000;
const CODEX_CONTEXT = 272_000;
const CODEX_EFFECTIVE = 258_400; // 272000 x 95%
const CODEX_UA = "codex_cli_rs/0.53.0 (linux 6.8.0; x86_64) cli";

test("only live codex tables (which apply effective_context_window_percent) count as netted", () => {
    assert.equal(codexWindowNetsOutputHeadroom("codex-models-cache"), true);
    assert.equal(codexWindowNetsOutputHeadroom("codex-catalog"), true);
    for (const raw of ["client-metadata", "codex-config-window", "bundled-snapshot", "codex-fallback", undefined]) {
        assert.equal(codexWindowNetsOutputHeadroom(raw), false, `${String(raw)} is a raw window and keeps the reservation`);
    }
});

function makeUpstream(): http.Server {
    return http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "cw", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "cw", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 } })}\n\n`);
        res.end(`data: [DONE]\n\n`);
    });
}

async function withProxy(
    t: { after(fn: () => void | Promise<void>): void },
    modelCompress: Record<string, unknown> | undefined,
): Promise<{ proxyPort: number; upstreamPort: number }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-headroom-"));
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: MODEL, context_window: CODEX_CONTEXT, max_context_window: 872_000 }] }));
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const model: Record<string, unknown> = { context: NATIVE, output: 128_000 };
    if (modelCompress) model.compress = modelCompress;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: model } } },
        modelContextLimit: NATIVE,
        kernelConfig: defaultConfig(NATIVE),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    t.after(async () => {
        proxy.close();
        upstream.close();
        if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
        fs.rmSync(home, { recursive: true, force: true });
    });
    return { proxyPort: (proxy.address() as { port: number }).port, upstreamPort };
}

async function drive(proxyPort: number, upstreamPort: number, session: string): Promise<void> {
    // No output-budget field, like codex's native Responses traffic: the
    // reservation falls back to the declared max output (128000).
    const r = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session, "user-agent": CODEX_UA },
        body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(r.status, 200, `request must succeed, got ${r.status}: ${await r.text().catch(() => "")}`);
    await r.body?.cancel().catch(() => { /* drained */ });
}

test("codex live-table window is not reserved a second time: the wall stays at codex's own effective window", async (t) => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    t.after(() => setLogCapture(null));
    const h = await withProxy(t, undefined);
    await drive(h.proxyPort, h.upstreamPort, "codex-netted");
    assert.ok(logs.some((l) => l.includes(`effective window clamped ${NATIVE} → ${CODEX_EFFECTIVE}`) && l.includes("codex-models-cache")),
        `codex clamp to ${CODEX_EFFECTIVE} expected, got: ${JSON.stringify(logs.filter((l) => l.includes("[codex]")))}`);
    const reserved = logs.filter((l) => l.includes(`[headroom] model=${MODEL}: effective window`));
    assert.deepEqual(reserved, [], `no second output reservation on a codex-netted window (pre-fix: ${CODEX_EFFECTIVE} -> ${CODEX_EFFECTIVE * 0.75})`);
    assert.ok(logs.some((l) => l.includes(`[headroom] model=${MODEL}: no output reservation`)), "the skip must be stated once in the log");
});

test("an explicit operator outputHeadroomMaxPct still reserves on a codex window", async (t) => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    t.after(() => setLogCapture(null));
    const h = await withProxy(t, { outputHeadroomMaxPct: 0.1 });
    await drive(h.proxyPort, h.upstreamPort, "codex-operator");
    const reserved = logs.filter((l) => l.includes(`[headroom] model=${MODEL}: effective window`));
    assert.equal(reserved.length, 1, `operator cap must still reserve, got: ${JSON.stringify(reserved)}`);
    assert.ok(reserved[0].includes(`effective window ${CODEX_EFFECTIVE} -> ${CODEX_EFFECTIVE - 25_840}`), `10% of ${CODEX_EFFECTIVE} reserved, got: ${reserved[0]}`);
});
