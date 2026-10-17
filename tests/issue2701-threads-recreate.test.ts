// #2701: Threads hosts (Claude Code / Claude Desktop) stamp every request with
// `thread: {type:"continue", previous_message_id}` (incremental 1–2 messages).
// When the model calls `compress` mid-turn, bili executes it locally and
// RE-REQUESTS upstream — the old anthropic loop adapter spread the client body
// verbatim, so the re-request reused a previous_message_id that round 1 had
// ALREADY consumed → upstream 400 "has already been continued" → the turn dies
// with the fold undelivered and ~200K+ input tokens rebilled next turn.
//
// The fix rewrites the re-request to `thread.create`: the rebuild resends the
// FULL post-fold view (never an increment), so create is the only valid form —
// and it delivers the fold to the server-side Thread immediately, which the
// host's next continue then inherits (#2701 finding 3). Dropping the field
// instead would orphan the response from any thread and break that continue.
//
// This harness emulates Anthropic's once-only continue rule on the scripted
// upstream: a second continue of the same id gets the exact production 400, so
// pre-fix this test fails (round-2 body still carries the consumed continue,
// the client stream ends in an upstream error); post-fix it passes end-to-end.
import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const anthropicSse = (event: string, data: unknown): string =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Enough distinct mass per message that the folded range clears the kernel's
// 5000-char minCompressRange floor and the compress commits (same shape as
// issue2499-anthropic-round2-cache.test.ts).
const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the module under review passed its integration suite across all four regions without any reported regressions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

// Seven single-block turns → refs m00001..m00007; the scripted compress folds
// m00001..m00002 — OUTSIDE the kernel's last-5 protected zone.
type TurnMsg = { role: string; content: Array<Record<string, unknown>> };
const buildTurns = (): TurnMsg[] => {
    const out: TurnMsg[] = [];
    for (let i = 1; i <= 3; i++) {
        out.push({ role: "user", content: [{ type: "text", text: `user turn ${i}: examine subsystem ${i} and report every failure mode you can find in the current implementation. ` + FILLER(i, 8) }] });
        out.push({ role: "assistant", content: [{ type: "text", text: `assistant ${i}: subsystem ${i} shows three notable failure modes centered on state recovery under load. ` + FILLER(100 + i, 8) }] });
    }
    out.push({ role: "user", content: [{ type: "text", text: "TRIGGER_TURN_2701: now patch the refresh-token rotation so a revoked token cannot mint a fresh one. " + FILLER(900, 1.0) }] });
    return out;
};

function compressSse(): string {
    const args = JSON.stringify({ startId: "m00001", endId: "m00002", topic: "fold", summary: "Folded the early subsystem-analysis turns; state-recovery failure modes and their remediation notes are retained in this summary." });
    return [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_r1", role: "assistant", usage: { input_tokens: 55 } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_c_2701", name: "compress", input: {} } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ].join("");
}

const TEXT_SSE = [
    anthropicSse("message_start", { type: "message_start", message: { id: "msg_r2", role: "assistant", usage: { input_tokens: 20 } } }),
    anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done after compress" } }),
    anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
    anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
    anthropicSse("message_stop", { type: "message_stop" }),
].join("");

type ThreadShape = { type?: string; previous_message_id?: string };
interface Harness {
    proxyPort: number;
    upstreamPort: number;
    captured: string[];
    close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
    const captured: string[] = [];
    let accepted = 0;
    // Anthropic Threads chain rule: each response id may be continued AT MOST
    // ONCE. A second continue of the same id → the exact production 400.
    const continuedIds = new Set<string>();
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            captured.push(raw);
            const body = JSON.parse(raw) as { thread?: ThreadShape };
            if (body.thread?.type === "continue") {
                const prev = body.thread.previous_message_id ?? "";
                if (continuedIds.has(prev)) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({
                        type: "error",
                        error: { type: "invalid_request_error", message: "The requested `previous_message_id` has already been continued. Each response `id` may be continued at most once." },
                    }));
                    return;
                }
                continuedIds.add(prev);
            }
            accepted += 1;
            const sse = accepted === 1 ? compressSse() : TEXT_SSE;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(sse);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;

    return {
        proxyPort,
        upstreamPort,
        captured,
        close: async () => {
            proxy.close();
            await once(proxy, "close");
            upstream.close();
            await once(upstream, "close");
        },
    };
}

test("#2701: mid-turn compress on a thread.continue round — re-request recreates the thread, turn survives, fold delivered", async () => {
    const h = await startHarness();
    try {
        // The client request is a CONTINUE (incremental semantics don't matter
        // to the bug — the thread field does): round 1 consumes msg_prev_2701.
        const resp = await fetch(`http://127.0.0.1:${h.proxyPort}/bili/http://127.0.0.1:${h.upstreamPort}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "issue2701-threads" },
            body: JSON.stringify({
                model: "claude-test",
                max_tokens: 1024,
                stream: true,
                system: "You are a coding agent.",
                messages: buildTurns(),
                thread: { type: "continue", previous_message_id: "msg_prev_2701" },
            }),
        });
        assert.equal(resp.status, 200);
        const out = await resp.text();

        assert.ok(h.captured.length >= 2, `expected a round-2 re-request, got ${h.captured.length} upstream bodies`);
        const r1 = JSON.parse(h.captured[0]!) as { thread?: ThreadShape };
        assert.deepEqual(r1.thread, { type: "continue", previous_message_id: "msg_prev_2701" }, "steady path forwards the client's own continue untouched (the bug scenario is live)");

        const r2 = JSON.parse(h.captured[1]!) as { thread?: ThreadShape };
        assert.deepEqual(r2.thread, { type: "create" }, "re-request rewritten to thread.create — a consumed previous_message_id can never ride the full-view rebuild");
        assert.ok(!h.captured[1]!.includes("msg_prev_2701"), "consumed previous_message_id absent from the re-request body");
        assert.ok(h.captured[1]!.includes("tokens saved"), "compress committed — the post-fold view reached upstream (fold delivered to the server-side Thread)");

        assert.ok(out.includes("Done after compress"), "round-2 text reached the client — the turn survived instead of dying on the 400");
        assert.ok(!out.includes("upstream error"), "no in-stream upstream error: the once-only continue rule was never tripped");
    } finally {
        await h.close();
    }
});
