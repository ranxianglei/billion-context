import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer, _resetChainWarningsForTest, _chainWarnSetForTest, WARNED_CHAIN_SESSION_CAP } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { getSession, peekSession, _resetSessionsForTest, flushAllSessions } from "../src/session.ts";
import { loadOptions, type ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";
import { artifactSeedHit, detectAcpArtifacts } from "../src/server/chain-artifacts.ts";

// #1086: the v0.1.133 chain-detection content fallback judged bili's OWN
// injected ACP artifacts (render tags re-sent by the client, ACP tool names
// in the tools array) as evidence of an upstream bili instance, so a
// single-instance setup passed EVERY turn through unprocessed and the
// compression kernel never ran again. Layers under test:
//   1. detectAcpArtifacts — structural detection (declarations alone are not
//      artifacts; historical tool calls are; real tags are; placeholders aren't).
//   2. self-state exemption — artifacts + local processed state ⇒ processed.
//   3. fresh plugin-mode session (declarations only) ⇒ processed, no warn.
//   4. #1357 Phase 1: foreign artifacts without local state are ADVISORY —
//      processed normally so the session owns itself; one advisory warn, and
//      only x-bili-hop remains decisive verbatim passthrough.
//   5. escape valve chainContentDetection=false disables the fallback.
//   6. liveness guard — a plain-client chat-wire session still compresses
//      as it grows (the #1086 failure mode was silent non-compression).

const MODEL = "gpt-test";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function toolDecl(name: string): Record<string, unknown> {
    return { type: "function", function: { name, description: `${name} test tool`, parameters: { type: "object", properties: {} } } };
}

function historyCall(name: string, id: string): Record<string, unknown> {
    return { id, type: "function", function: { name, arguments: "{}" } };
}

test("#1086 detector: tools declarations alone are NOT artifacts (group E — the #1086 repro)", () => {
    const parsed = { model: MODEL, tools: [toolDecl("acp_status"), toolDecl("search_context")], messages: [{ role: "user", content: "hello world" }] };
    const b = Buffer.from(JSON.stringify(parsed));
    assert.ok(artifactSeedHit(b), "byte pre-filter may hit on declarations");
    assert.equal(detectAcpArtifacts(b, parsed), null, "declarations without historical calls must not be a chain signal");
});

test("#1086 detector: ACP tool names invoked in HISTORY are artifacts (all wire shapes)", () => {
    const openai = { model: MODEL, messages: [
        { role: "assistant", content: null, tool_calls: [historyCall("acp_status", "call_1"), historyCall("search_context", "call_2")] },
        { role: "user", content: "next question" },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(openai)), openai), "tool-history");

    const anthropic = { model: MODEL, messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "acp_status", input: {} }, { type: "tool_use", id: "u2", name: "search_context", input: {} }] },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(anthropic)), anthropic), "tool-history");

    const responses = { model: MODEL, input: [
        { type: "function_call", call_id: "c1", name: "acp_status", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "search_context", arguments: "{}" },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(responses)), responses), "tool-history");

    const gemini = { model: MODEL, contents: [
        { parts: [{ functionCall: { name: "acp_status" } }, { functionCall: { name: "search_context" } }] },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(gemini)), gemini), "tool-history");
});

test("#1086 detector: real render tag is an artifact; placeholder tag and prose are not", () => {
    const realTag = "\x3cacp tokens=\"1.2K\" type=\"text\"\x3em00042\x3c/acp\x3e";
    const tagged = { model: MODEL, messages: [{ role: "user", content: `history ${realTag}` }] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(tagged)), tagged), "tags");
    const fullTagged = JSON.stringify(tagged);
    const unparseable = Buffer.from(fullTagged.slice(0, fullTagged.length - 4));
    assert.equal(detectAcpArtifacts(unparseable, null), "tags", "tag family must fire even when the body is unparseable (wire-escaped tag bytes intact)");

    const placeholder = "\x3cacp tokens=\"N\" type=\"text\"\x3em00042\x3c/acp\x3e";
    const ph = { model: MODEL, messages: [{ role: "user", content: placeholder }] };
    assert.ok(artifactSeedHit(Buffer.from(JSON.stringify(ph))));
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(ph)), ph), null, "placeholder tag (tokens=\"N\") is not a kernel artifact");

    const prose = { model: MODEL, messages: [{ role: "user", content: 'I called "acp_status" and "search_context" earlier' }] };
    const proseBuf = Buffer.from(JSON.stringify(prose));
    assert.equal(artifactSeedHit(proseBuf), false, "JSON-escaped prose quotes never hit the byte pre-filter");
    assert.equal(detectAcpArtifacts(proseBuf, prose), null, "prose mentioning the names is not a tool invocation");

    const renamed = { model: MODEL, tools: [toolDecl("ctx_status"), toolDecl("ctx_search")], messages: [
        { role: "assistant", content: null, tool_calls: [historyCall("ctx_status", "call_1"), historyCall("ctx_search", "call_2")] },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(renamed)), renamed), null, "renamed lookalike tools (group D) are not bili artifacts");

    const oneOnly = { model: MODEL, messages: [
        { role: "assistant", content: null, tool_calls: [historyCall("acp_status", "call_1")] },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(oneOnly)), oneOnly), null, "one of the two ACP tools called is not sufficient");
});

function makeOpts(upstream: string, extra?: Partial<ProxyOptions>): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream,
        routes: { [upstream]: { models: { [MODEL]: { context: 400_000 } } } } as ProxyOptions["routes"],
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        logFile: "off",
        mitm: { enabled: false, domains: [] },
        ...extra,
    };
}

type Captured = { url: string; headers: http.IncomingHttpHeaders; body: string };

function makeUpstream(captured: Captured[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push({ url: req.url ?? "", headers: req.headers, body });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-test",
                object: "chat.completion",
                model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }));
        });
    });
}

function makeJsonUpstream(captured: Captured[], respond: () => unknown): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            captured.push({ url: req.url ?? "", headers: req.headers, body });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(respond()));
        });
    });
}

type LogRec = { level: string; msg: string };
const chainWarns = (logs: LogRec[], sessionId?: string): LogRec[] =>
    logs.filter((l) => l.level === "warn" && l.msg.includes("[chain]") && (!sessionId || l.msg.includes(sessionId)));

// The #1086 incident shape: a bili-managed client whose history contains real
// invocations of both ACP tools (the plugin surfaces them; the model used them).
function incidentBody(): string {
    return JSON.stringify({
        model: MODEL,
        stream: false,
        tools: [toolDecl("acp_status"), toolDecl("search_context")],
        messages: [
            { role: "system", content: "You are a test assistant." },
            { role: "user", content: "hello world, please help me with a task" },
            { role: "assistant", content: null, tool_calls: [historyCall("acp_status", "call_1"), historyCall("search_context", "call_2")] },
            { role: "tool", tool_call_id: "call_1", content: "ok" },
            { role: "tool", tool_call_id: "call_2", content: "ok" },
        ],
    });
}

test("#1086 T1: self-produced artifacts (local processed state) are processed normally", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const s = getSession("own-1", { protocol: "openai" });
        s.stats.requests = 1;
        const raw = incidentBody();
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "own-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(sha(captured[0]!.body), sha(raw), "self-produced artifacts must go through the kernel (rebuilt body), not raw passthrough");
        assert.equal(chainWarns(logs, "own-1").length, 0, "no chain warning may fire for own-session artifacts");
        assert.equal(peekSession("own-1")?.stats.requests, 2, "kernel must have processed the request (stats advanced)");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1086 T2: fresh plugin-mode session (declarations only) is processed, not judged a chain", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        // Exact #1086 startup scenario: brand-new opencode-native session,
        // first request already carries the ACP tool declarations.
        const raw = JSON.stringify({
            model: MODEL,
            stream: false,
            tools: [toolDecl("acp_status"), toolDecl("search_context")],
            messages: [
                { role: "system", content: "You are a test assistant." },
                { role: "user", content: "hello world, what can you do?" },
            ],
        });
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "fresh-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(sha(captured[0]!.body), sha(raw), "request must be rebuilt by the kernel, not passed through");
        assert.equal(chainWarns(logs, "fresh-1").length, 0, "declarations alone must never warn or bypass (#1086 regression)");
        assert.equal(peekSession("fresh-1")?.stats.requests, 1);
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1086/#1357 T3: foreign artifacts without local state are ADVISORY — processed, owned, one warn", async () => {
    // #1100: "no local state ⇒ foreign" holds only when persistence proves ownership
    // across a restart, so T3 runs an ENABLED store over an empty temp dir (truly
    // foreign). Disabled-store variant is ambiguous (own session after restart) → T6.
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-t3-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const raw = incidentBody();
        for (let i = 0; i < 2; i++) {
            const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "foreign-1" },
                body: raw,
            });
            assert.equal(resp.status, 200);
            await resp.text();
        }
        assert.equal(captured.length, 2);
        assert.notEqual(captured[0]!.body, raw, "historical ACP content is advisory — processed, not passed through verbatim (#1357)");
        assert.notEqual(captured[1]!.body, raw, "second request also processed (no permanent passthrough)");
        const warns = chainWarns(logs, "foreign-1");
        assert.equal(warns.length, 1, `exactly one advisory warn per session (got ${warns.length}: ${JSON.stringify(warns)})`);
        assert.ok(warns[0]!.msg.includes("#1357"), "warn cites the #1357 advisory downgrade");
        assert.ok(warns[0]!.msg.includes("advisory"), "warn states historical ACP content is advisory-only");
        assert.ok(peekSession("foreign-1") !== undefined, "the advisory session establishes local ownership (no longer left trace-less)");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#1218/#1357: a content-detected conversation owns a real session; /acp shows real activity", async () => {
    // #1357 Phase 1: body-artifact detection is advisory-only, so a conversation
    // whose history carries ACP-shaped content is PROCESSED and owns its own state.
    // Pre-#1357 symptom (#1218): such requests passed through with NO session, so
    // /acp showed a misleading armed-idle "no model request yet". Now /acp reflects
    // the real session — requests served, panel built; never armed-idle or passthrough.
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-1218-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "chain-exp-1" },
            body: incidentBody(),
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.ok(peekSession("chain-exp-1") !== undefined, "advisory content establishes a real local session (#1357)");
        const probe = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/__bili/plugin/status?conversationId=chain-exp-1`);
        const probeBody = await probe.text();
        assert.equal(probe.status, 200, `status probe failed: ${probeBody.slice(0, 200)}`);
        const status = JSON.parse(probeBody) as { ok: boolean; conversationId: string; phase?: string; requests?: number; panel?: string };
        assert.equal(status.ok, true);
        assert.equal(status.conversationId, "chain-exp-1");
        assert.notEqual(status.phase, "chain-passthrough", "content is advisory, not a decisive chain verdict");
        assert.ok((status.requests ?? 0) >= 1, `/acp reflects the served request (got requests=${status.requests})`);
        assert.equal(typeof status.panel, "string", "/acp renders a real session panel, not the armed-idle notice");
        // A conversation with NO verdict keeps the pre-#1218 answer shape —
        // the new branch must not hijack unrelated probes.
        const clean = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/__bili/plugin/status?conversationId=never-seen`);
        // Pre-existing shape: an unknown conversation keeps the 404
        // "unknown plugin conversation" answer (clients render it as the
        // armed-idle notice) — the new branch must not hijack unrelated probes.
        assert.equal(clean.status, 404);
        const cleanStatus = JSON.parse(await clean.text()) as { ok: boolean; phase?: string };
        assert.equal(cleanStatus.ok, false);
        assert.notEqual(cleanStatus.phase, "chain-passthrough");
    } finally {
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#1086 T4: chainContentDetection=false disables the content fallback entirely", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`, { chainContentDetection: false }));
    await listen(proxy);
    try {
        const raw = incidentBody();
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "valve-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(sha(captured[0]!.body), sha(raw), "valve off ⇒ artifacts ignored, kernel processes");
        assert.equal(chainWarns(logs).length, 0);
        assert.ok(peekSession("valve-1")?.stats.requests === 1);
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

test("#1100 T6: BILI_PERSIST=0 + restart ⇒ replayed own session is processed, not permanently passed through", async () => {
    // Post-restart shape: store disabled (BILI_PERSIST=0) and memory cleared, so this
    // instance cannot prove ownership of the ACP artifacts the client re-sends. Pre-#1100
    // that read as "chain" → passthrough forever (#1086 symptom); it must be processed.
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const raw = incidentBody();
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "own-restart-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(sha(captured[0]!.body), sha(raw), "#1100: persist-off own session must be rebuilt by the kernel, NOT passed through verbatim");
        assert.equal(chainWarns(logs, "own-restart-1").length, 0, "ownership is unprovable (not confirmed-foreign), so no chain warning may fire");
        assert.equal(peekSession("own-restart-1")?.stats.requests, 1, "kernel must have processed the request (session created, stats advanced)");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
    }
});

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

async function readSseText(resp: Response): Promise<string> {
    if (!resp.body) return "";
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            try {
                const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
                const c = chunk.choices?.[0]?.delta?.content;
                if (typeof c === "string") out += c;
            } catch {
                // keep-alive comment line — ignore
            }
        }
    }
    return out;
}

test("#1086 T5 liveness: plain-client chat session keeps compressing as it grows", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));

    const THRESHOLD = 24 * 1024;
    const state = { bodies: [] as string[], compressCalls: 0, lastDemandBytes: Infinity, sinceDemand: 99 };
    const relay = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const bytes = Buffer.byteLength(body);
            state.bodies.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const refIds = parseRefIds(body);
            state.sinceDemand++;
            const noShrinkAfterDemand = state.sinceDemand <= 2 && bytes >= state.lastDemandBytes * 0.9;
            const shouldCompress = bytes > THRESHOLD && refIds.length >= 12 && !noShrinkAfterDemand;
            if (shouldCompress) {
                state.lastDemandBytes = bytes;
                state.sinceDemand = 0;
                state.compressCalls++;
                const from = refIds[2]!;
                const to = refIds[refIds.length - 10]!;
                res.write(sseLine({
                    id: "g1",
                    object: "chat.completion.chunk",
                    choices: [{
                        index: 0,
                        delta: {
                            role: "assistant",
                            content: null,
                            tool_calls: [{
                                index: 0,
                                id: `call_compress_${state.compressCalls}`,
                                type: "function",
                                function: {
                                    name: "compress",
                                    arguments: JSON.stringify({
                                        content: [{ startId: from, endId: to, topic: "liveness guard", summary: `summary covering ${from}..${to}: incremental context growth turns, per-turn overhead measurements, and periodic compression cycles; key results were recorded at each checkpoint.` }],
                                    }),
                                },
                            }],
                        },
                    }],
                }));
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 2 } }));
            } else {
                const text = `reply ${state.bodies.length} ` + "x".repeat(360);
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sseLine({ id: "g1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    relay.listen(0, "127.0.0.1");
    await listen(relay);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(relay.address() as { port: number }).port}`, {
        kernelConfig: defaultConfig(400_000, {
            preserveRecentMessages: 3,
            preserveRecentTokens: 800,
            compress: { minCompressRange: 400, maxSummaryLength: 20000, minSummaryLength: 20 },
        }),
    }));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const TURNS = 60;
        const userText = (i: number): string => `turn ${i}: ` + "filler ".repeat(80);
        const messages: Array<{ role: string; content?: string | null }> = [{ role: "system", content: "You are a test assistant." }];
        let nonEmptyReplies = 0;
        for (let i = 0; i < TURNS; i++) {
            messages.push({ role: "user", content: userText(i) });
            const resp = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "liveness-1" },
                body: JSON.stringify({ model: MODEL, stream: true, messages }),
            });
            assert.equal(resp.status, 200, `turn ${i} must succeed`);
            const text = await readSseText(resp);
            if (text.length > 0) nonEmptyReplies++;
            else assert.ok(state.bodies[state.bodies.length - 1]!.includes('"compress"'), `turn ${i}: empty reply without a pending compress round-trip`);
            messages.push({ role: "assistant", content: text });
        }
        assert.ok(state.compressCalls >= 1, `expected at least one model-driven compress round-trip, got ${state.compressCalls}`);
        const maxBytes = Math.max(...state.bodies.map((b) => Buffer.byteLength(b)));
        assert.ok(maxBytes < THRESHOLD * 2, `upstream context exceeded bound after compression: ${maxBytes} >= ${THRESHOLD * 2}`);
        assert.equal(nonEmptyReplies, TURNS, "every client turn must get a visible reply");
        assert.equal(chainWarns(logs).length, 0, "no chain warning may fire on a plain self-run session");
        assert.ok(peekSession("liveness-1")!.state.nextBlockId > 1, "kernel must have persisted compression blocks (compression actually ran)");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        relay.closeAllConnections?.();
        await close(relay);
    }
}, { timeout: 120_000 });

// #1101 (F2 of the #1090 deep review): three real paths were never exercised
// by the tests above — the disk branch of hasProcessedState
// (src/session.ts:342-343, "covers the auto-update restart"), the
// BILI_CHAIN_CONTENT env parse (src/config.ts), and the warn-set FIFO
// eviction (src/server.ts). These close those gaps.

test("#1101 T7: persisted own state survives a simulated restart — disk branch of hasProcessedState", async () => {
    const root = path.join(tmpdir(), `bili-chain-restart-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const storeA = new SessionStore({ dir: root, enabled: true, debounceMs: 0 });
    const stores: SessionStore[] = [storeA];
    _setStoreForTest(storeA);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        // Phase A (old process): build processed state through a REAL enabled store.
        // The warmup turn is artifact-free (a fresh client's first turn carries no
        // ACP artifacts); the artifacts enter the history later, as in #1086.
        const raw = incidentBody();
        const resp1 = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "restart-1" },
            body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: "system", content: "You are a test assistant." }, { role: "user", content: "hello world, please help me with a task" }] }),
        });
        assert.equal(resp1.status, 200);
        await resp1.text();
        assert.equal(peekSession("restart-1")?.stats.requests, 1, "kernel must have processed the warmup turn");
        await flushAllSessions();
        // Simulated auto-update restart: a new process is a fresh store instance over the
        // same dir whose boot() walked the tree (initSessions runs inside startServer and
        // cannot re-run in-process, so boot() is called directly), with an EMPTY memory map —
        // the >MAX_SESSIONS/evicted shape that forces the disk branch of hasProcessedState.
        const storeB = new SessionStore({ dir: root, enabled: true, debounceMs: 0 });
        stores.push(storeB);
        _setStoreForTest(storeB);
        await storeB.boot();
        _resetSessionsForTest();
        _resetChainWarningsForTest();
        assert.equal(peekSession("restart-1"), undefined, "memory must be empty before the replay");
        // Phase B (new process): replay the SAME artifact body — it must be processed,
        // not judged foreign and passed through (#1086's auto-update scenario).
        const resp2 = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "restart-1" },
            body: raw,
        });
        assert.equal(resp2.status, 200);
        await resp2.text();
        assert.equal(captured.length, 2);
        assert.notEqual(sha(captured[1]!.body), sha(raw), "persisted own session must be PROCESSED after restart, not passed through");
        assert.equal(chainWarns(logs, "restart-1").length, 0, "no chain warning may fire for own persisted state");
        assert.equal(peekSession("restart-1")?.stats.requests, 2, "session must have been RELOADED from disk (requests 1→2), not freshly created");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        // #1194: a post-turn persist flush (debounceMs 0) can already be in
        // flight here — cancelAll() only clears not-yet-fired debounces and
        // never drains the in-flight write chain. Drain BEFORE deleting the
        // store dir or rmSync races the writer (ENOTEMPTY on `openai/`).
        for (const s of stores) await s.flushAll([]);
        for (const s of stores) s.cancelAll();
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
});

test("#1101 T8: warn-set FIFO evicts the oldest session once past the cap", async () => {
    // ENABLED store over an empty temp dir: with persistence disabled the content
    // fallback is skipped entirely (#1100), so "foreign" can only be judged here.
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-fifo-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const warnSet = _chainWarnSetForTest();
        for (let i = 0; i < WARNED_CHAIN_SESSION_CAP; i++) warnSet.set(`pad-${i}`, { at: 0, kind: "tags", protocol: "openai" });
        const raw = incidentBody();
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "fifo-evict" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.notEqual(captured[0]!.body, raw, "#1357: foreign historical content is advisory — processed, not byte-identical");
        assert.ok(warnSet.has("fifo-evict"), "newly warned session must be tracked");
        assert.ok(!warnSet.has("pad-0"), "oldest entry must be FIFO-evicted once past the cap");
        assert.ok(warnSet.has("pad-1"), "only the single oldest entry is evicted per add");
        assert.equal(warnSet.size, WARNED_CHAIN_SESSION_CAP, "set stays bounded at the cap");
        assert.equal(chainWarns(logs, "fifo-evict").length, 1, "exactly one warn for the new session");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#1101 T9: BILI_CHAIN_CONTENT env parse — default ON, 0 disables, env wins over file", async () => {
    const root = path.join(tmpdir(), `bili-chain-env-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const cfgFile = path.join(root, "billion-context.json");
    const prevFile = process.env.BILI_CONFIG_FILE;
    try {
        process.env.BILI_CONFIG_FILE = cfgFile;
        assert.equal(loadOptions({}).chainContentDetection, true, "default ON when nothing is configured");
        assert.equal(loadOptions({ BILI_CHAIN_CONTENT: "0" }).chainContentDetection, false, "BILI_CHAIN_CONTENT=0 disables the fallback");
        assert.equal(loadOptions({ BILI_CHAIN_CONTENT: "1" }).chainContentDetection, true, "BILI_CHAIN_CONTENT=1 enables it");
        writeFileSync(cfgFile, JSON.stringify({ chainContentDetection: false }), "utf8");
        assert.equal(loadOptions({}).chainContentDetection, false, "file chainContentDetection=false disables the fallback");
        assert.equal(loadOptions({ BILI_CHAIN_CONTENT: "1" }).chainContentDetection, true, "env =1 wins over file false");
    } finally {
        if (prevFile === undefined) delete process.env.BILI_CONFIG_FILE; else process.env.BILI_CONFIG_FILE = prevFile;
        rmSync(root, { recursive: true, force: true });
    }
});

// #1197: tag-shaped text in the SYSTEM section is client-authored context
// (AGENTS.md/CLAUDE.md/README quoting the wire format — the billion-context
// repo itself carries literal examples), never bili compression output:
// render tags and the re-voiced acp_summary always live in HISTORY items.
test("#1197 detector: tags in system/developer/instructions are NOT artifacts", () => {
    const realTag = "\x3cacp tokens=\"59\" type=\"text\"\x3em00001\x3c/acp\x3e";

    const openaiSystem = { model: MODEL, messages: [
        { role: "system", content: `Project rules — refs look like ${realTag}` },
        { role: "user", content: "reply 1234" },
    ] };
    assert.ok(artifactSeedHit(Buffer.from(JSON.stringify(openaiSystem))), "byte pre-filter still hits");
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(openaiSystem)), openaiSystem), null, "openai system-role tags must not read as chain evidence");

    const developer = { model: MODEL, messages: [
        { role: "developer", content: `wire examples: ${realTag}` },
        { role: "user", content: "hi" },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(developer)), developer), null, "developer-role tags are context, not artifacts");

    const anthropicSystem = { model: MODEL, system: [{ type: "text", text: `docs quote ${realTag}` }], messages: [{ role: "user", content: "hi" }] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(anthropicSystem)), anthropicSystem), null, "anthropic top-level system is never scanned");

    const responsesInstructions = { model: MODEL, instructions: `format: ${realTag}`, input: [{ type: "message", role: "user", content: "hi" }] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(responsesInstructions)), responsesInstructions), null, "responses instructions is never scanned");
});

test("#1197 detector: tags in HISTORY still are artifacts (tool results, user messages)", () => {
    const realTag = "\x3cacp tokens=\"1.2K\" type=\"text\"\x3em00042\x3c/acp\x3e";
    const toolResult = { model: MODEL, messages: [
        { role: "user", content: "compress please" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "compress", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: `blocks folded ${realTag}` },
    ] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(toolResult)), toolResult), "tags", "tool-result tags (plugin compress replay) remain detectable");

    const userMsg = { model: MODEL, messages: [{ role: "user", content: `folded ${realTag}` }] };
    assert.equal(detectAcpArtifacts(Buffer.from(JSON.stringify(userMsg)), userMsg), "tags", "history-message tags remain detectable");
});

// The exact #1197 incident: a fresh session whose system prompt carries literal
// tag examples from the project's AGENTS.md (cwd = a billion-context checkout)
// used to be verdict-ed into permanent passthrough — /acp stuck on armed-idle
// and the whole session ran uncompressed.
test("#1197 T10: system-prompt tags on a fresh plain-client session are processed, not judged a chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-t10-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const realTag = "\x3cacp tokens=\"59\" type=\"text\"\x3em00001\x3c/acp\x3e";
        const raw = JSON.stringify({
            model: MODEL,
            stream: false,
            messages: [
                { role: "system", content: `# Project docs\nRef anchors ${realTag} in summaries.` },
                { role: "user", content: "reply with exactly: 1234" },
            ],
        });
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "ctx-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(sha(captured[0]!.body), sha(raw), "#1197: context-file tags must go through the kernel, not raw passthrough");
        assert.equal(chainWarns(logs, "ctx-1").length, 0, "no chain warning for client-authored system content");
        assert.equal(peekSession("ctx-1")?.stats.requests, 1, "session must be created and processed");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});

// A cooperative plugin's protocol re-sends its compression artifacts (compress
// tool call + result in history) by design; the announcement header outranks
// content-shape evidence, so a resumed plugin session is processed even when
// this instance holds no state for it.
test("#1197 T11: plugin-announced request with history artifacts is processed, not judged a chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-t11-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const raw = incidentBody();
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-acp-session": "plug-1",
                "x-bili-plugin": "pi",
                "x-bili-plugin-conversation": "plug-1",
            },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(sha(captured[0]!.body), sha(raw), "#1197: plugin-announced replay must be rebuilt by the kernel, not passed through");
        assert.equal(chainWarns(logs, "plug-1").length, 0, "no chain warning for a cooperative plugin's own replay");
        assert.equal(peekSession("plug-1")?.stats.requests, 1, "session must be created (plugin binding) and processed");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});

// #1357 Phase 1 regression (TAGS family, primary fixture): ACP tag literals in
// ordinary HISTORY are advisory-only. The literal below mirrors the AGENTS.md
// example VERBATIM and appears BOTH inlined AND inside a fenced code block — the
// exact real-world trigger. Pre-#1357 this forced byte-identical passthrough
// forever; now it is processed normally, the session owns itself, one advisory warn.
test("#1357 T12: ACP tag literals in history are advisory — processed, owned, one warn (not passthrough)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-t12-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeUpstream(captured);
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const acpExample = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e";
        const userText = [
            "Here is how compression tags look:",
            "",
            acpExample,
            "",
            "And inside a code fence:",
            "```",
            acpExample,
            "```",
            "",
            "Please continue from here.",
        ].join("\n");
        const raw = JSON.stringify({
            model: MODEL,
            stream: false,
            messages: [
                { role: "system", content: "You are a test assistant." },
                { role: "user", content: userText },
            ],
        });
        for (let i = 0; i < 2; i++) {
            const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": "foreign-tags-1" },
                body: raw,
            });
            assert.equal(resp.status, 200);
            await resp.text();
        }
        assert.equal(captured.length, 2);
        assert.notEqual(captured[0]!.body, raw, "ACP literals in history are advisory — processed, not passed through verbatim (#1357)");
        assert.notEqual(captured[1]!.body, raw, "second request also processed (no permanent passthrough)");
        const warns = chainWarns(logs, "foreign-tags-1");
        assert.equal(warns.length, 1, `exactly one advisory warn per session (got ${warns.length}: ${JSON.stringify(warns)})`);
        assert.ok(warns[0]!.msg.includes("#1357"), "warn cites the #1357 advisory downgrade");
        assert.ok(warns[0]!.msg.includes("advisory"), "inline + fenced ACP examples are advisory-only, not decisive");
        assert.ok(peekSession("foreign-tags-1") !== undefined, "the session establishes local ownership instead of leaving no trace");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#1357 T13: Responses wire — ACP tag literal in history is advisory, processed, owned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-resp-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeJsonUpstream(captured, () => ({
        id: "resp-test", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 10, output_tokens: 5 },
    }));
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const acpExample = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e";
        const raw = JSON.stringify({
            model: MODEL,
            stream: false,
            input: [
                { type: "message", role: "user", content: [{ type: "input_text", text: `earlier folded ${acpExample}\ncontinue please` }] },
            ],
        });
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "resp-advisory-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(captured[0]!.body, raw, "Responses ACP literal is advisory — processed, not passed through verbatim (#1357)");
        const warns = chainWarns(logs, "resp-advisory-1");
        assert.equal(warns.length, 1, `exactly one advisory warn (got ${warns.length})`);
        assert.ok(warns[0]!.msg.includes("#1357"), "warn cites #1357");
        assert.ok(peekSession("resp-advisory-1") !== undefined, "Responses session establishes local ownership");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("#1357 T14: Anthropic wire — ACP tag literal in history is advisory, processed, owned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-chain-anth-"));
    const store = new SessionStore({ dir, debounceMs: 5, enabled: true });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetChainWarningsForTest();
    setRegistryForTest({});
    const logs: LogRec[] = [];
    setLogCapture((level, msg) => logs.push({ level, msg }));
    const captured: Captured[] = [];
    const upstream = makeJsonUpstream(captured, () => ({
        id: "msg-test", type: "message", role: "assistant", model: MODEL,
        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
    }));
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const proxy = await startServer(makeOpts(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
    await listen(proxy);
    try {
        const acpExample = "\x3cacp tokens=\"2\" type=\"text\"\x3em00001\x3c/acp\x3e";
        const raw = JSON.stringify({
            model: MODEL,
            max_tokens: 1024,
            messages: [
                { role: "user", content: [{ type: "text", text: `earlier folded ${acpExample}\ncontinue please` }] },
            ],
        });
        const resp = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "anthropic-advisory-1" },
            body: raw,
        });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(captured.length, 1);
        assert.notEqual(captured[0]!.body, raw, "Anthropic ACP literal is advisory — processed, not passed through verbatim (#1357)");
        const warns = chainWarns(logs, "anthropic-advisory-1");
        assert.equal(warns.length, 1, `exactly one advisory warn (got ${warns.length})`);
        assert.ok(warns[0]!.msg.includes("#1357"), "warn cites #1357");
        assert.ok(peekSession("anthropic-advisory-1") !== undefined, "Anthropic session establishes local ownership");
    } finally {
        setLogCapture(null);
        proxy.closeAllConnections?.();
        await close(proxy);
        upstream.closeAllConnections?.();
        await close(upstream);
        store.cancelAll();
        rmSync(dir, { recursive: true, force: true });
    }
});
