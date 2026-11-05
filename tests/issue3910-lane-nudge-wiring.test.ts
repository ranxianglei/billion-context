// #3910 (residual gap from #3903): #3903 taught the Anthropic Messages lane to
// append ANTHROPIC_LANE_NOTE to every nudge by passing the "anthropic" protocol
// literal at BOTH prepare-anthropic call sites. The kernel contract is pinned by
// kernel/tests/nudge-text.test.ts and the function-level wiring by
// tests/anthropic-lane-nudge.test.ts — but NOTHING drove prepareAnthropic
// end-to-end and asserted the note actually reaches the OUTBOUND wire. If someone
// later drops the optional `, "anthropic"` argument (TS won't complain — it is
// optional), CI stays green and the production failure #3903 fixed (the model
// writes <analysis>/<summary> as reply prose, ends the turn with no tool call,
// session stalls until the user types "continue") silently regresses.
//
// Pinned here with the hermetic server harness: an OVER-LIMIT nudge is armed the
// same way tests/compaction-trigger-finality.test.ts does it (local estimate sits
// well under the threshold so turn 1 stays clean; the upstream-reported usage
// crosses the band so turn 2 injects). Positive case drives the anthropic wire
// and asserts the note lands exactly once, in the trailing nudge user message.
// Negative case (#3617 bidirectional discipline) drives the SAME over-limit
// scenario over the openai chat wire: a nudge IS still appended (so the absence
// is not vacuous) but the anthropic note is nowhere.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const WINDOW = 15_000;
const MODEL = "claude-test";
const SYSTEM = "You are a coding agent.";
// Distinctive, bracket-free slice of ANTHROPIC_LANE_NOTE — unique to the note,
// safe to count occurrences of without tripping the KDD#2 tag-stripping rule.
const NOTE = "Write the summary ONLY as the `compress` tool's `content` argument";
// Upstream-reported usage that crosses the OVER-LIMIT band (90% of WINDOW) while
// the LOCAL estimate of the fixture stays ~51% — so turn 1 is clean and only the
// recorded usage arms the turn-2 nudge (mirrors compaction-trigger-finality).
const ARMED_INPUT_TOKENS = 13_500;

const notesIn = (s: string): number => s.split(NOTE).length - 1;

// 7 messages × ~4400 distinct chars → local estimate ≈51% of WINDOW (below the
// band) with m00001/m00002 outside the kernel's last-5 protected zone, so a
// pending range exists for the nudge to point at.
function filler(seed: number, targetChars: number): string {
    const para = `Paragraph ${seed}: the ledger module under review passed its integration suite across all four regions without any reported regressions. `;
    const unit = Math.max(1, Math.ceil(targetChars / para.length));
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
}

const ANTHROPIC_MESSAGES = (): Array<{ role: string; content: Array<{ type: string; text: string }> }> => {
    const out: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
    for (let i = 1; i <= 7; i++) {
        out.push({ role: i % 2 === 1 ? "user" : "assistant", content: [{ type: "text", text: `Turn ${i}: working session entry. ` + filler(i, 4400) }] });
    }
    return out;
};

const OPENAI_MESSAGES = (): Array<{ role: string; content: string }> =>
    ANTHROPIC_MESSAGES().map((m) => ({ role: m.role, content: m.content.map((b) => b.text).join("") }));

const anthropicSse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

// Non-streaming text reply whose message_start reports the armed usage so the
// proxy records lastInputTokens for the next turn.
const anthropicReply = (): string =>
    [
        anthropicSse("message_start", { type: "message_start", message: { id: "msg_r", role: "assistant", usage: { input_tokens: ARMED_INPUT_TOKENS } } }),
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ack" } }),
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }),
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
        anthropicSse("message_stop", { type: "message_stop" }),
    ].join("");

interface Harness {
    origin: string;
    upstreamUrl: string;
    captured: string[];
    close(): Promise<void>;
}

async function startHarness(wire: "anthropic" | "openai"): Promise<Harness> {
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            if (wire === "anthropic") {
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                res.end(anthropicReply());
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "chat_r", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ack" }, finish_reason: "stop" }], usage: { prompt_tokens: ARMED_INPUT_TOKENS, completion_tokens: 3, total_tokens: ARMED_INPUT_TOKENS + 3 } }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { [MODEL]: { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        // Sub-floor fixture: pin legacy any-pending semantics (#3006) so the
        // escalation override keeps firing instead of being vetoed by the
        // minimum-benefit floor.
        kernelConfig: { ...defaultConfig(WINDOW), nudge: { ...defaultConfig(WINDOW).nudge, minPressureBenefitTokens: 0 } },
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
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;

    return {
        origin,
        upstreamUrl,
        captured,
        close: async () => {
            proxy.close();
            proxy.closeIdleConnections?.();
            await once(proxy, "close");
            upstream.close();
            upstream.closeIdleConnections?.();
            await once(upstream, "close");
        },
    };
}

test("#3910 positive: anthropic lane nudge carries ANTHROPIC_LANE_NOTE exactly once, in the trailing nudge message", async () => {
    const h = await startHarness("anthropic");
    try {
        const url = `${h.origin}/bili/${h.upstreamUrl}/v1/messages`;
        const post = (session: string) => fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": session },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, system: SYSTEM, messages: ANTHROPIC_MESSAGES() }),
        });

        const r1 = await post("issue3910-anth-a");
        assert.equal(r1.status, 200);
        await r1.text();
        const r2 = await post("issue3910-anth-a");
        assert.equal(r2.status, 200);
        await r2.text();

        assert.ok(h.captured.length >= 2, `expected an arm + inject pair, got ${h.captured.length} upstream bodies`);
        assert.equal(notesIn(h.captured[0]!), 0, "turn 1 carries no nudge note (fresh session, local estimate under the band)");

        const sent = ANTHROPIC_MESSAGES().length;
        const body = JSON.parse(h.captured[1]!) as { messages: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }> };
        assert.equal(body.messages.length, sent + 1, `exactly ONE nudge message appended (got ${body.messages.length}, sent ${sent})`);
        const last = body.messages[body.messages.length - 1]!;
        assert.equal(last.role, "user", "the nudge lands as a trailing user message");
        const lastText = typeof last.content === "string" ? last.content : last.content.map((b) => b.text ?? "").join("");
        assert.equal(notesIn(lastText), 1, "note appears exactly once in the trailing nudge message");
        for (let i = 0; i < body.messages.length - 1; i++) {
            const m = body.messages[i]!;
            const t = typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("");
            assert.equal(notesIn(t), 0, `message ${i} must not carry the note`);
        }
    } finally {
        await h.close();
    }
});

test("#3910 negative: the same over-limit scenario over the openai chat wire appends a nudge WITHOUT the anthropic note", async () => {
    const h = await startHarness("openai");
    try {
        const url = `${h.origin}/bili/${h.upstreamUrl}/v1/chat/completions`;
        const post = (session: string) => fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": session },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, messages: OPENAI_MESSAGES() }),
        });

        const r1 = await post("issue3910-openai-a");
        assert.equal(r1.status, 200);
        await r1.text();
        const r2 = await post("issue3910-openai-a");
        assert.equal(r2.status, 200);
        await r2.text();

        assert.ok(h.captured.length >= 2, `expected an arm + inject pair, got ${h.captured.length} upstream bodies`);
        type OMsg = { role: string; content: string | unknown[] };
        const t1 = JSON.parse(h.captured[0]!) as { messages: OMsg[] };
        const t2 = JSON.parse(h.captured[1]!) as { messages: OMsg[] };
        // Non-vacuity guard, wire-neutral: compare the ARMed turn-2 body against
        // the clean turn-1 body rather than assuming an absolute +1 (the openai
        // lane also injects its own system/dev message into `messages`, which
        // would skew an absolute count). A strictly larger turn-2 message list
        // proves the nudge appeared between turns — so "note absent" below is a
        // real absence, not a no-fire.
        assert.ok(t2.messages.length > t1.messages.length, `openai turn 2 appends its nudge (turn1=${t1.messages.length}, turn2=${t2.messages.length})`);
        assert.equal(t2.messages[t2.messages.length - 1]!.role, "user", "openai nudge lands as a trailing user message");
        assert.equal(notesIn(h.captured[1]!), 0, "NO anthropic lane note anywhere on the openai wire");
    } finally {
        await h.close();
    }
});
