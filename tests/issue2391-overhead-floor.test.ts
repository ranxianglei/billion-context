import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { type CompressSettings, type ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #2391: when the MANDATORY per-request overhead (fixed instruction/system text +
// tool schemas) alone reaches the budget, it lives OUTSIDE the fold space, so no
// amount of conversation folding can fit the payload (fit gate is `< limit`). Before
// the fix this ran the doomed walk → misleading "0 compressible range(s)" + the #726
// cooldown dead-end (telling operators to wait when waiting can't help), with no
// breakdown of WHAT dominates and no recovery options. The fix detects the floor at
// the decision point and fails fast with an actionable breakdown. These pin it.

type Call = { stream: boolean; body: string };

const SUMMARY_TEXT = "SUMMARY: the folded conversation segment is no longer needed verbatim.";

function makeUpstream(calls: Call[], protocol: "anthropic" | "responses"): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            calls.push({ stream: !!parsed.stream, body: raw });
            if (!parsed.stream) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(protocol === "responses"
                    ? JSON.stringify({ output_text: SUMMARY_TEXT })
                    : JSON.stringify({ content: [{ type: "text", text: SUMMARY_TEXT }] }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (protocol === "responses") {
                res.write(`event: response.completed\ndata: ${JSON.stringify({ response: { id: "r", status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } })}\n\n`);
            } else {
                res.write(
                    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 100 } } })}\n\n` +
                    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
                    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
                    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
                    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
                    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
                );
            }
            res.end();
        });
    });
}

function startProxy(upstreamPort: number, models: Record<string, { context: number }>, compressOverrides?: Partial<CompressSettings>): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true, ...compressOverrides },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

function overheadBody(instructionsChars: number, toolCount: number) {
    const instructions = "INSTR_".repeat(Math.floor(instructionsChars / 6));
    const tools = Array.from({ length: toolCount }, (_, i) => ({
        type: "function",
        name: `tool_${i}`,
        description: `Tool ${i} does a deterministic thing for the test harness. `.repeat(30),
        parameters: { type: "object", properties: { arg: { type: "string", description: "d" } } },
    }));
    return { instructions, tools };
}

test("#2391 (Responses/Codex): mandatory instruction+tool overhead alone >= budget → actionable 502 breakdown, nothing folded, no forward, no summary call", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, "responses");
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    // Small declared window (10k). Responses reserves output headroom, so the
    // effective budget lands below 10k; the fixed instructions+tools clear it on
    // their own while the conversation is two tiny messages (nothing to fold).
    const proxy = await startProxy(upstreamPort, { "gpt-resp": { context: 10_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

    const { instructions, tools } = overheadBody(36_000, 20);
    const body = {
        model: "gpt-resp",
        stream: true,
        session_id: "issue2391-overhead-sess",
        max_output_tokens: 1024,
        instructions,
        tools,
        input: [
            { type: "message", role: "user", content: "start the task" },
            { type: "message", role: "assistant", content: "on it" },
        ],
    };

    try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(r.status, 502, "fail-fast 502 when the fixed overhead alone clears the budget");
        const json = JSON.parse(await r.text()) as { error?: { code?: string; message?: string; retryable?: boolean } };
        assert.equal(json.error?.code, "preflight_compress_failed");
        assert.equal(json.error?.retryable, false);
        const msg = json.error?.message ?? "";
        assert.ok(msg.includes("mandatory per-request overhead alone exceeds the budget"), `names the overhead floor (got: ${msg})`);
        assert.ok(msg.includes("instruction/system text"), `breaks down the instruction/system share (got: ${msg})`);
        assert.ok(msg.includes("tool definitions"), `breaks down the tool-schema share (got: ${msg})`);
        assert.ok(msg.includes("CANNOT reduce it"), `states folding cannot fix it (got: ${msg})`);
        assert.ok(msg.includes("Recovery options"), `offers recovery options (got: ${msg})`);
        assert.ok(msg.includes("NOT forwarded"), `states the payload was withheld (got: ${msg})`);
        assert.ok(!msg.includes("compressible range"), `does not fall into the misleading '0 compressible ranges' path (got: ${msg})`);
        assert.equal(calls.filter((c) => c.stream).length, 0, "the over-window payload was NOT forwarded upstream");
        assert.equal(calls.filter((c) => !c.stream).length, 0, "no summarization call was spent — short-circuited before the doomed walk");

        // A second identical request must get the SAME actionable diagnostic, not a
        // #726 cached/cooldown diagnosis (the fix returns before arming the dead-end).
        const r2 = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(r2.status, 502);
        const msg2 = (JSON.parse(await r2.text()) as { error?: { message?: string } }).error?.message ?? "";
        assert.ok(msg2.includes("mandatory per-request overhead alone exceeds the budget"), `second identical request still gets the actionable diagnostic (got: ${msg2})`);
        assert.equal(calls.filter((c) => c.stream).length, 0, "still not forwarded on retry");
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});

test("#2391 guard: overhead UNDER the budget + foldable conversation → normal fold path (check defers, no false 502)", async () => {
    const calls: Call[] = [];
    const upstream = makeUpstream(calls, "anthropic");
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    // Anthropic does NOT reserve output headroom, so the effective window is the
    // full declared 20k. System ~3k tokens plus bili-injected ACP tools (~2.4k) =>
    // ~5.4k overhead ALONE is well under the 20k budget, so the new floor check must
    // defer to the normal fold path; the long foldable conversation (~45k) overflows
    // on its own and folding the old messages brings the payload comfortably under.
    const proxy = await startProxy(upstreamPort, { "claude-small": { context: 20_000 } });
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

    try {
        const big = "A".repeat(24_000);
        const messages: Array<{ role: string; content: string }> = [];
        for (let i = 0; i < 7; i++) messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `OLD_${i}_ ` + big });
        for (let i = 0; i < 5; i++) messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `recent-${i} small` });
        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue2391-guard-sess" },
            body: JSON.stringify({ model: "claude-small", max_tokens: 1024, stream: true, system: "S".repeat(12_000), messages }),
        });
        assert.equal(r.status, 200, "overhead-under-budget payload is folded and forwarded, not 502'd by the new check");
        await r.text();
        assert.ok(calls.filter((c) => !c.stream).length >= 1, "a summarization call folded the old messages (normal fold path ran)");
        assert.equal(calls.filter((c) => c.stream).length, 1, "the folded payload was forwarded upstream");
        const fwd = calls.find((c) => c.stream)?.body ?? "";
        const keptOld = ["OLD_0_", "OLD_1_", "OLD_2_", "OLD_3_", "OLD_4_", "OLD_5_", "OLD_6_"].filter((m) => fwd.includes(m)).length;
        assert.ok(keptOld < 7, `at least one old foldable message was folded out of the forward (kept ${keptOld}/7)`);
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
    }
});
