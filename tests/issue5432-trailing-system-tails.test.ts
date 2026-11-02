// #5432: Anthropic's mid-conversation system rule is TWO-sided — a non-directive
// system entry must FOLLOW a user message AND PRECEDE an assistant message or
// end the array. Two bili producers broke the PRECEDE side:
//   (A) the steady path (prepare-anthropic) appends ephemeral tail users
//       (sysNotes/nudge/decide/statusLine/retrieval notes) AFTER coreToAnthropic's
//       position heal — when the client history ends in a legal trailing system
//       (Claude Code's "The user hasn't heard from you…" reminder), the append
//       puts a user after it and the request 400s ("role 'system' must precede
//       an 'assistant' message or end the array");
//   (B) the round-2 compress-loop adapter (adapter-anthropic) did the same with
//       its notes.
// Pinned here through all three layers: the ordering helper itself, the
// adapter's buildRequest, and the REAL steady path via the hermetic server
// harness (client history ending in a system + an armed over-limit nudge).
// Bidirectional discipline (#3617): the no-trailing-system negative cases pin
// that the legacy tail-append behavior is UNCHANGED when nothing follows.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { anthropicToCore } from "acp-kernel/wire";
import { createAnthropicAdapter } from "../src/loop/index.ts";
import { insertBeforeTrailingSystemRun } from "../src/util.ts";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

type M = { role: string; content: unknown };

type Msg = { role: string; content: string | Array<{ type?: string; text?: string }> };
const textOf = (m: Msg): string =>
    typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("");

test("#5432 helper: insertions land BEFORE a trailing system run, run stays verbatim at the end", () => {
    const base: M[] = [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
        { role: "system", content: "sys1" },
        { role: "system", content: "sys2" },
    ];
    const out = insertBeforeTrailingSystemRun(base, [{ role: "user", content: "note" }]);
    assert.deepEqual(
        out.map((m) => `${m.role}:${String(m.content)}`),
        ["user:q", "assistant:a", "user:note", "system:sys1", "system:sys2"],
    );
});

test("#5432 helper: no trailing system → plain tail append (legacy behavior unchanged)", () => {
    const base: M[] = [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
    ];
    const out = insertBeforeTrailingSystemRun(base, [{ role: "user", content: "note" }]);
    assert.deepEqual(
        out.map((m) => `${m.role}:${String(m.content)}`),
        ["user:q", "assistant:a", "user:note"],
    );
});

test("#5432 helper: empty additions → same array back; all-system input → additions lead", () => {
    const base: M[] = [{ role: "system", content: "s" }];
    assert.equal(insertBeforeTrailingSystemRun(base, []), base);
    const out = insertBeforeTrailingSystemRun(base, [{ role: "user", content: "n" }]);
    assert.deepEqual(
        out.map((m) => m.role),
        ["user", "system"],
    );
});

test("#5432 helper: sequential batches keep their relative order before the run", () => {
    let msgs: M[] = [
        { role: "user", content: "q" },
        { role: "system", content: "sys" },
    ];
    msgs = insertBeforeTrailingSystemRun(msgs, [{ role: "user", content: "first" }]);
    msgs = insertBeforeTrailingSystemRun(msgs, [{ role: "user", content: "second" }]);
    assert.deepEqual(
        msgs.map((m) => `${m.role}:${String(m.content)}`),
        ["user:q", "user:first", "user:second", "system:sys"],
    );
});

// --- round-2 adapter layer -------------------------------------------------

const ADAPTER_TRAILING_SYSTEM = "The user hasn't heard from you in a while; continue working.";

function coreEndingInSystem(): ReturnType<typeof anthropicToCore>["msgs"] {
    return anthropicToCore({
        messages: [
            { role: "user", content: [{ type: "text", text: "q1" }] },
            { role: "assistant", content: [{ type: "text", text: "a1" }] },
            { role: "system", content: [{ type: "text", text: ADAPTER_TRAILING_SYSTEM }] },
        ],
    } as never).msgs;
}

function coreNoTrailingSystem(): ReturnType<typeof anthropicToCore>["msgs"] {
    return anthropicToCore({
        messages: [
            { role: "user", content: [{ type: "text", text: "q1" }] },
            { role: "assistant", content: [{ type: "text", text: "a1" }] },
        ],
    } as never).msgs;
}

test("#5432 adapter: notes insert before the trailing client system, which stays verbatim and last", () => {
    const adapter = createAnthropicAdapter({ model: "claude-test", max_tokens: 10 }, undefined, ["ADAPTER-NOTE"]);
    const req = adapter.buildRequest(coreEndingInSystem(), "top-system", { model: "claude-test", max_tokens: 10 }) as { messages: Msg[] };
    const msgs = req.messages;
    assert.equal(msgs[msgs.length - 1]!.role, "system", "the client's trailing system must still end the array");
    assert.equal(textOf(msgs[msgs.length - 1]!), ADAPTER_TRAILING_SYSTEM, "the trailing system stays verbatim");
    assert.equal(msgs[msgs.length - 2]!.role, "user", "the note lands immediately before the trailing system");
    assert.equal(textOf(msgs[msgs.length - 2]!), "ADAPTER-NOTE");
});

test("#5432 adapter negative: no trailing system → note still lands dead-last (legacy behavior)", () => {
    const adapter = createAnthropicAdapter({ model: "claude-test", max_tokens: 10 }, undefined, ["ADAPTER-NOTE"]);
    const req = adapter.buildRequest(coreNoTrailingSystem(), "top-system", { model: "claude-test", max_tokens: 10 }) as { messages: Msg[] };
    const msgs = req.messages;
    assert.equal(msgs[msgs.length - 1]!.role, "user");
    assert.equal(textOf(msgs[msgs.length - 1]!), "ADAPTER-NOTE");
});

// --- real steady path (hermetic server harness) ----------------------------

const WINDOW = 15_000;
const MODEL = "claude-test";
const SYSTEM = "You are a coding agent.";
// Distinctive slice of ANTHROPIC_LANE_NOTE — unique to the anthropic-lane nudge.
const NOTE = "Write the summary ONLY as the `compress` tool's `content` argument";
// Upstream-reported usage crossing the OVER-LIMIT band (90% of WINDOW) while
// the LOCAL estimate of the fixture stays well under it — so turn 1 is clean
// and only the recorded usage arms the turn-2 nudge (mirrors #3910).
const ARMED_INPUT_TOKENS = 13_500;
// Claude Code's trailing reminder shape: the client's LAST message is a
// mid-conversation system (legal at array end pre-injection).
const TRAILING_SYSTEM_TEXT = "The user hasn't heard from you in a while; continue working on the task.";

const notesIn = (s: string): number => s.split(NOTE).length - 1;

function filler(seed: number, targetChars: number): string {
    const para = `Paragraph ${seed}: the ledger module under review passed its integration suite across all four regions without any reported regressions. `;
    const unit = Math.max(1, Math.ceil(targetChars / para.length));
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
}

function clientMessages(withTrailingSystem: boolean): Array<{ role: string; content: Array<{ type: string; text: string }> }> {
    const out: Array<{ role: string; content: Array<{ type: string; text: string }> }> = [];
    for (let i = 1; i <= 7; i++) {
        out.push({ role: i % 2 === 1 ? "user" : "assistant", content: [{ type: "text", text: `Turn ${i}: working session entry. ` + filler(i, 4400) }] });
    }
    if (withTrailingSystem) {
        out.push({ role: "system", content: [{ type: "text", text: TRAILING_SYSTEM_TEXT }] });
    }
    return out;
}

const anthropicSse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

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

async function startHarness(): Promise<Harness> {
    const captured: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            captured.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.end(anthropicReply());
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

test("#5432 steady path: nudge inserts BEFORE the client's trailing system, which stays verbatim and last", async () => {
    const h = await startHarness();
    try {
        const url = `${h.origin}/bili/${h.upstreamUrl}/v1/messages`;
        const post = (session: string) => fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": session },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, system: SYSTEM, messages: clientMessages(true) }),
        });

        const r1 = await post("issue5432-anth-a");
        assert.equal(r1.status, 200);
        await r1.text();
        const r2 = await post("issue5432-anth-a");
        assert.equal(r2.status, 200);
        await r2.text();

        assert.ok(h.captured.length >= 2, `expected an arm + inject pair, got ${h.captured.length} upstream bodies`);
        assert.equal(notesIn(h.captured[0]!), 0, "turn 1 carries no nudge (fresh session, local estimate under the band)");

        const body = JSON.parse(h.captured[1]!) as { messages: Msg[] };
        assert.equal(body.messages.length, clientMessages(true).length + 1, "exactly ONE ephemeral message added");
        const last = body.messages[body.messages.length - 1]!;
        assert.equal(last.role, "system", "the client's trailing system must STILL end the outbound array (the #5432 case-2 shape)");
        // Not byte-equal: the steady path renders every message text through
        // the ACP tag strategy (KDD#2); the client's reminder text must survive
        // intact inside that rendering (undemoted, unsplit).
        assert.ok(textOf(last).includes(TRAILING_SYSTEM_TEXT), `trailing system keeps the client's text (got ${JSON.stringify(textOf(last).slice(0, 120))})`);
        const secondLast = body.messages[body.messages.length - 2]!;
        assert.equal(secondLast.role, "user", "the nudge lands immediately before the trailing system");
        assert.equal(notesIn(textOf(secondLast)), 1, "the lane note appears exactly once, in that preceding user message");
    } finally {
        await h.close();
    }
});

test("#5432 steady path negative: no trailing system → nudge still lands dead-last (legacy behavior unchanged)", async () => {
    const h = await startHarness();
    try {
        const url = `${h.origin}/bili/${h.upstreamUrl}/v1/messages`;
        const post = (session: string) => fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": session },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, system: SYSTEM, messages: clientMessages(false) }),
        });

        const r1 = await post("issue5432-anth-b");
        assert.equal(r1.status, 200);
        await r1.text();
        const r2 = await post("issue5432-anth-b");
        assert.equal(r2.status, 200);
        await r2.text();

        assert.ok(h.captured.length >= 2, `expected an arm + inject pair, got ${h.captured.length} upstream bodies`);
        const body = JSON.parse(h.captured[1]!) as { messages: Msg[] };
        assert.equal(body.messages.length, clientMessages(false).length + 1, "exactly ONE ephemeral message added");
        const last = body.messages[body.messages.length - 1]!;
        assert.equal(last.role, "user", "without a trailing system the nudge keeps landing as the final message");
        assert.equal(notesIn(textOf(last)), 1, "the lane note appears exactly once, in the trailing nudge message");
    } finally {
        await h.close();
    }
});
