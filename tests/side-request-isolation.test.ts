import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig, createInitialState } from "acp-kernel";
import { startServer, type ProxyOptions, isSideRequest } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";

// #388: side requests (title-gen / small utility calls) share the main session
// key but must not touch kernel state. The proxy routes them as pure passthrough
// (no processTurn / snapshot / usage capture) so the main session's view, nudge
// baseline and per-block survivedCount are driven ONLY by main requests.

test("isSideRequest: tiny output budget across protocol field names", () => {
    assert.equal(isSideRequest({ max_tokens: 100 }), true);
    assert.equal(isSideRequest({ max_tokens: 200 }), true, "boundary 200 is a side request");
    assert.equal(isSideRequest({ max_tokens: 201 }), false, "201 is NOT a side request");
    assert.equal(isSideRequest({ max_completion_tokens: 150 }), true, "openai max_completion_tokens");
    assert.equal(isSideRequest({ max_output_tokens: 50 }), true, "responses max_output_tokens");
    assert.equal(isSideRequest({ max_tokens: 8192 }), false, "normal budget is not a side request");
    assert.equal(isSideRequest({}), false, "no budget → not a side request");
    assert.equal(isSideRequest(null), false, "null body");
    assert.equal(isSideRequest(undefined), false, "undefined body");
    assert.equal(isSideRequest("not-an-object"), false, "non-object body");
    assert.equal(isSideRequest({ max_tokens: 0 }), false, "zero budget");
    assert.equal(isSideRequest({ max_tokens: -5 }), false, "negative budget");
    assert.equal(isSideRequest({ max_tokens: "100" }), false, "string budget is not a number");
});

const MODEL = "claude-sonnet-4-5";
const SESSION = "side-iso-sess";
const MAIN_INPUT_TOKENS = 50_000;
const SIDE_INPUT_TOKENS = 56;

function okSse(inputTokens: number): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: inputTokens } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function mainConversation(n: number): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < n; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Main message ${i} ${"z".repeat(500)}` });
    }
    return msgs;
}

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    /** When set, served verbatim for side requests (max_tokens<=200) instead
     *  of the generated okSse stream. */
    sideScript: string | null;
}

async function startRig(): Promise<Rig> {
    const rig: Rig = { proxyPort: 0, upstreamPort: 0, proxy: null as unknown as http.Server, upstream: null as unknown as http.Server, sideScript: null };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { max_tokens?: number } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            // Side requests (tiny max_tokens) report a TINY context; main requests
            // report a large one. The proxy must NOT capture the side request's
            // usage — that is exactly the pollution this regression guards.
            const isSide = typeof parsed.max_tokens === "number" && parsed.max_tokens <= 200;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(isSide && rig.sideScript ? rig.sideScript : okSse(isSide ? SIDE_INPUT_TOKENS : MAIN_INPUT_TOKENS));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = upstream.address().port as number;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = proxy.address().port as number;
    rig.proxy = proxy; rig.upstream = upstream; rig.proxyPort = proxyPort; rig.upstreamPort = upstreamPort;
    return rig;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

test("e2e: side request response still gets render-tag stripping (#460 contract)", async () => {
    const LT = "\x3c";
    const GT = "\x3e";
    const OPEN_MARK = `${LT}acp `;
    const CLOSE_MARK = `${LT}/acp${GT}`;
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };
        // Main request first so the session has a real view.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        await r1.text();
        const stateAfterMain = JSON.stringify(getSession(SESSION).state);
        // Side request whose stream echoes a render tag (a model echoing the
        // compressed history into a title). The strip pipes must still run for
        // side requests — kernel state untouched, response hygiene intact.
        const tagged = `title: ${LT}acp tokens="12" type="text"${GT}m00009${LT}/acp${GT}ok`;
        const sse =
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: SIDE_INPUT_TOKENS } } })}\n\n` +
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: tagged } })}\n\n` +
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
        rig.sideScript = sse;
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "Generate a short title." }] }) });
        assert.equal(r2.status, 200);
        let raw = "";
        for await (const chunk of r2.body) raw += Buffer.from(chunk).toString("utf8");
        assert.equal(raw.includes(OPEN_MARK), false, "side-request stream leaked a render open tag");
        assert.equal(raw.includes(CLOSE_MARK), false, "side-request stream leaked a render close tag");
        assert.equal(JSON.stringify(getSession(SESSION).state), stateAfterMain, "tag-strip pipe must not touch kernel state (session stays off)");
    } finally {
        await closeRig(rig);
    }
});

test("e2e: anthropic side request (title-gen) leaves main session kernel state untouched", async () => {
    const rig = await startRig();
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": SESSION };

        // Main request 1: a normal turn (large max_tokens) → kernel state mutates.
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(8) }) });
        assert.equal(r1.status, 200);
        await r1.text();

        const s1 = getSession(SESSION);
        assert.ok(s1, "session exists after the main request");
        assert.notEqual(JSON.stringify(s1.state), JSON.stringify(createInitialState()), "main request must mutate kernel state");
        assert.ok(Object.keys(s1.state.messageRefs.byRaw).length > 0, "refs assigned to the main messages");
        assert.equal(s1.stats.lastInputTokens, MAIN_INPUT_TOKENS, "main request usage captured as the nudge baseline");
        assert.ok(s1.lastMessages && s1.lastMessages.length > 0, "message snapshot set to the main request view");

        const stateAfterMain1 = JSON.stringify(s1.state);
        const statsAfterMain1 = JSON.stringify(s1.stats);
        const snapshotAfterMain1 = JSON.stringify(s1.lastMessages);
        const requestsAfterMain1 = s1.stats.requests;

        // Side request: title-gen (tiny max_tokens) on the SAME session key.
        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 100, stream: true, messages: [{ role: "user", content: "Generate a short title for this conversation." }] }) });
        assert.equal(r2.status, 200);
        await r2.text();

        const s2 = getSession(SESSION);
        assert.ok(s2, "session still exists after the side request");
        assert.equal(JSON.stringify(s2.state), stateAfterMain1, "side request must NOT mutate kernel state (refs / survivedCount / nudge baseline)");
        assert.equal(JSON.stringify(s2.stats), statsAfterMain1, "side request must NOT mutate stats");
        assert.equal(JSON.stringify(s2.lastMessages), snapshotAfterMain1, "side request must NOT clobber the message snapshot (bili export view)");
        assert.equal(s2.stats.lastInputTokens, MAIN_INPUT_TOKENS, "side request's tiny usage must NOT overwrite the main nudge baseline");
        assert.equal(s2.stats.requests, requestsAfterMain1, "side request must NOT increment the main request counter");

        // Main request 2: a normal turn again → kernel state advances (monotonic).
        const r3 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: mainConversation(9) }) });
        assert.equal(r3.status, 200);
        await r3.text();

        const s3 = getSession(SESSION);
        assert.ok(s3, "session exists after main request 2");
        assert.notEqual(JSON.stringify(s3.state), stateAfterMain1, "main request 2 must advance kernel state (driven only by main requests)");
        assert.ok(s3.stats.requests > requestsAfterMain1, "main request 2 increments the request counter");
    } finally {
        await closeRig(rig);
    }
});
