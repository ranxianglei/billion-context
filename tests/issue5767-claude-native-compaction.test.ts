// #5767: Claude Code's auto-compact (CLAUDE_CODE_AUTO_COMPACT_WINDOW) rewrites
// the client's history in place: the shadowed region is replaced by ONE
// continuation user message opening with the verbatim sentence "This session
// is being continued from a previous conversation that ran out of context",
// and the next request replays [continuation summary, retained tail…] against
// the SAME session id. Before this fix the anthropic lane's compaction-landing
// detection knew only the dsh checkpoint framing, so the landing fell through
// to detectUnannouncedHistoryRewrite → "unannounced-rewrite" (signal tier) and
// the conflict banner alarmed for the client's own auto-compact. The anthropic
// lane now detects the CC continuation framing (three gates: carrier / novelty
// / standalone — the same discipline as the dsh detector, #2621/#4438),
// records "native-compaction" (handled tier) and rebases the ACP state onto
// the compacted history — the same marker+rebase treatment as the dsh lane
// (#2432/#2658) and the codex lane (#2373).

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, _resetSessionsForTest } from "../src/session.ts";
import { conflictEventsOf } from "../src/conflict-watch.ts";
import { carriesClaudeNativeCompactionSummary, CLAUDE_COMPACTION_CONTINUATION_PREFIX } from "../src/server/claude-compaction-guard.ts";

const MODEL = "claude-test";
const SYSTEM = "You are Claude Code, an interactive CLI tool.";

type Rig = {
    proxyPort: number;
    upstreamPort: number;
    bodies: string[];
    close: () => Promise<void>;
};

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function startRig(compress: { injectTool: boolean; injectNudge?: boolean }): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            // Report prompt tokens proportional to the payload so the token
            // baseline moves between turns (a constant report pins it).
            const promptTokens = Math.max(1, Math.round(raw.length / 4));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(anthropicSse("message_start", { type: "message_start", message: { id: `msg_${bodies.length}`, role: "assistant", usage: { input_tokens: promptTokens } } }));
            res.write(anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
            res.write(anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }));
            res.write(anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }));
            res.write(anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }));
            res.write(anthropicSse("message_stop", { type: "message_stop" }));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL]: { context: 30_000 } } } },
        modelContextLimit: 30_000,
        kernelConfig: defaultConfig(30_000),
        compress,
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
    return {
        proxyPort: (proxy.address() as { port: number }).port,
        upstreamPort,
        bodies,
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

const messagesUrl = (rig: Rig) => `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;

function claudeHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-claude-code-session-id": conv };
}

function post(rig: Rig, headers: Record<string, string>, messages: unknown[]): Promise<Response> {
    return fetch(messagesUrl(rig), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, system: SYSTEM, messages }),
    });
}

// 14 messages sized like the codex #2372 fixture: the kernel protects the
// last 5 messages, so folding m00001–m00009 covers 9 ids (> the 8-id floor).
function seedInput() {
    return Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230),
    }));
}

function continuationMessage() {
    return {
        role: "user",
        content: `${CLAUDE_COMPACTION_CONTINUATION_PREFIX}. The summary below covers the earlier portion of the conversation.\n\n## Primary Request and Intent\n- drive a fold, then replay the compacted view`,
    };
}

const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

async function seedAndFold(rig: Rig, conv: string, headers: Record<string, string>): Promise<void> {
    const r1 = await post(rig, headers, seedInput());
    assert.equal(r1.status, 200, "seed request succeeds");
    await r1.text();
    const s = getSession(conv);
    assert.ok(s, `seed session exists under the key "${conv}"`);
    assert.ok(Object.keys(s!.state.messageRefs.byRaw).length >= 14, "refs assigned to the seeded history");

    const r2 = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: "m00001", endId: "m00009", summary: FOLD_SUMMARY }] } }),
    });
    const j = (await r2.json()) as { ok: boolean; result?: string };
    assert.ok(j.ok, `fold accepted (${r2.status})`);
    assert.ok(!j.result?.includes("[Compression FAILED"), `fold succeeded: ${j.result?.slice(0, 200)}`);
    const covered = new Set((s!.state.blocks ?? []).flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
    assert.ok(covered.size >= 8, `fold covers >=8 ids (got ${covered.size})`);
}

test("drift pin: claude continuation sentence is versioned (#5767)", () => {
    // The verbatim opening of Claude Code's auto-compact continuation message
    // (quoted in the #4168 report). If Claude Code rewords it, detection
    // degrades to the pre-#5767 unannounced-rewrite archive path — never a
    // false positive. This pin makes the drift visible in CI.
    assert.equal(CLAUDE_COMPACTION_CONTINUATION_PREFIX, "This session is being continued from a previous conversation that ran out of context");
});

test("unit: carriesClaudeNativeCompactionSummary matches framing only on a user/text carrier (#2621)", () => {
    const QUOTE = `the transcript literally contains "${CLAUDE_COMPACTION_CONTINUATION_PREFIX}" at line 40`;
    // Positive: a freshly-landed continuation is a user-role plain-text
    // message whose text opens with the sentence. (No knownIds set here →
    // novelty gate skipped, so these exercise the carrier gate alone.)
    assert.equal(carriesClaudeNativeCompactionSummary([]), false, "empty history");
    assert.equal(carriesClaudeNativeCompactionSummary([{ role: "user", contentType: "text", text: "plain prose" }]), false);
    assert.equal(carriesClaudeNativeCompactionSummary([{ role: "user", contentType: "text", text: CLAUDE_COMPACTION_CONTINUATION_PREFIX + ". The summary below…" }]), true, "continuation sentence at message start");
    assert.equal(carriesClaudeNativeCompactionSummary([{ role: "user", contentType: "text", text: `intro\n\n${CLAUDE_COMPACTION_CONTINUATION_PREFIX}. The summary below…` }]), false, "#4438: sentence embedded MID-message is a quote, not a landing");
    assert.equal(carriesClaudeNativeCompactionSummary([{ role: "user", contentType: "text", content: `see ${CLAUDE_COMPACTION_CONTINUATION_PREFIX} below` }]), false, "mid-text quote via raw wire content is not a landing");
    assert.equal(carriesClaudeNativeCompactionSummary([{ role: "assistant", contentType: "text", text: `checking: ${QUOTE}` }]), false, "assistant prose quoting the sentence");
    assert.equal(carriesClaudeNativeCompactionSummary([{ role: "assistant", contentType: "reasoning", text: QUOTE }]), false, "assistant reasoning quoting the sentence");
    assert.equal(carriesClaudeNativeCompactionSummary([{ role: "user", contentType: "tool-result", text: QUOTE }]), false, "tool result flattened to role=user (anthropic lane) quoting the sentence");
    assert.equal(carriesClaudeNativeCompactionSummary([{ role: "tool", contentType: "tool-result", text: QUOTE }]), false, "openai role=tool result quoting the sentence");
    assert.equal(carriesClaudeNativeCompactionSummary([{ role: "assistant", contentType: "tool-call", text: QUOTE }]), false, "assistant tool-call args quoting the sentence");
    assert.equal(carriesClaudeNativeCompactionSummary([{ text: QUOTE }]), false, "role-less bare shape reads false (safe miss, #2621 direction)");
});

test("unit: carriesClaudeNativeCompactionSummary novelty gate — old ids never match (#2621)", () => {
    const framed = `${CLAUDE_COMPACTION_CONTINUATION_PREFIX}. The summary below covers the earlier portion.\n\n## section`;
    // A user/text message carrying the sentence but whose id is ALREADY in the
    // pre-turn ref map is a replay/quote, not a fresh landing → no match.
    assert.equal(
        carriesClaudeNativeCompactionSummary([{ id: "old", role: "user", contentType: "text", text: framed }], new Set(["old"])),
        false, "an already-seen user/text replay of the continuation is not a landing");
    // The identical framed message with a FRESH id (absent from the pre-turn
    // map) matches.
    assert.equal(
        carriesClaudeNativeCompactionSummary([{ id: "fresh", role: "user", contentType: "text", text: framed }], new Set(["other"])),
        true, "a fresh user/text message carrying the continuation is a landing");
    // Omitting knownIds skips the novelty gate (carrier gate only) — the
    // framed user/text message still matches, preserving the direct-caller
    // contract.
    assert.equal(
        carriesClaudeNativeCompactionSummary([{ id: "whatever", role: "user", contentType: "text", text: framed }]),
        true, "no knownIds set → novelty gate skipped, carrier gate decides");
});

test("e2e #5767: claude replaying [continuation, retained tail] rebases the ACP state instead of lighting the conflict banner", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    try {
        const conv = "cc-5767";
        await seedAndFold(rig, conv, claudeHeaders(conv));
        const s = getSession(conv)!;
        assert.ok(s.state.blocks.some((b) => b.active), "fold produced an active block");

        // CC auto-compact lands: the shadowed region is replaced by the
        // continuation summary; the retained tail is re-sent.
        const r = await post(rig, claudeHeaders(conv), [continuationMessage(), seedInput()[12]!, seedInput()[13]!]);
        assert.equal(r.status, 200, "compaction-landing request succeeds");
        const raw = await r.text();
        assert.ok(raw.includes("message_stop"), "stream completed");

        const events = conflictEventsOf(s);
        const native = events.find((e) => e.kind === "native-compaction");
        assert.ok(native, `native-compaction recorded (events: ${JSON.stringify(events.map((e) => e.kind))})`);
        assert.ok(native!.detail.startsWith("claude native compaction"), `claude attribution: ${native!.detail}`);
        assert.equal(events.find((e) => e.kind === "unannounced-rewrite"), undefined, "no unannounced-rewrite beside the native-compaction attribution");

        // Rebased: the pre-compaction fold state is gone; the ref space is
        // re-seeded with the high-water pinned (no ref re-issue).
        assert.equal(s.state.blocks.filter((b) => b.active).length, 0, "active blocks cleared by the rebase");
        const boundary = s.metadata.nativeCompactionBoundary as { pendingRebase?: boolean } | undefined;
        assert.equal(boundary?.pendingRebase, false, "boundary marked AND reconciled");
        assert.ok(typeof s.metadata.nativeCompactionAt === "number", "nativeCompactionAt stamped");
        assert.ok(Object.keys(s.state.messageRefs.byRaw).length >= 3, "ref map re-seeded from the retained tail");

        // The forwarded body carries the continuation summary (wire untouched).
        const fwd = rig.bodies[rig.bodies.length - 1]!;
        assert.ok(fwd.includes(CLAUDE_COMPACTION_CONTINUATION_PREFIX), "continuation summary forwarded upstream");

        // Post-compaction turns keep working (no cannot-be-anchored death
        // spiral) and the replayed continuation (now an OLD id) does not
        // re-trigger the rebase.
        const r2 = await post(rig, claudeHeaders(conv), [continuationMessage(), seedInput()[12]!, seedInput()[13]!, { role: "user", content: "what did we decide about the harness?" }]);
        assert.equal(r2.status, 200, "post-compaction turn succeeds");
        await r2.text();
        const events2 = conflictEventsOf(s);
        assert.equal(events2.filter((e) => e.kind === "native-compaction").length, 1, "the replayed continuation (old id) does not re-trigger the rebase");
    } finally {
        await rig.close();
    }
});

test("e2e #5767 negative: decimated history WITHOUT the continuation framing does not rebase (no false positive)", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    try {
        const conv = "cc-5767-noframe";
        await seedAndFold(rig, conv, claudeHeaders(conv));
        const s = getSession(conv)!;

        // Same decimation shape, but the replacement message is plain prose
        // (no continuation sentence) — an unknown host or a user edit. Must
        // NOT rebase: a framing-less gap stays on the existing paths.
        const r = await post(rig, claudeHeaders(conv), [{ role: "user", content: "Here is a summary of what we covered so far: we set up the harness and drove a fold." }, seedInput()[12]!, seedInput()[13]!]);
        assert.equal(r.status, 200, "framing-less decimation request succeeds");
        await r.text();

        const events = conflictEventsOf(s);
        assert.equal(events.find((e) => e.kind === "native-compaction"), undefined, "no native-compaction without the framing");
        assert.equal(s.metadata.nativeCompactionBoundary, undefined, "no boundary marked — no rebase");
    } finally {
        await rig.close();
    }
});

test("e2e #5767 negative: continuation sentence QUOTED by an assistant message does not rebase (#2621)", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    try {
        const conv = "cc-5767-quote";
        await seedAndFold(rig, conv, claudeHeaders(conv));
        const s = getSession(conv)!;

        // The model quotes the sentence in its own prose while the history is
        // decimated. The carrier gate must reject it — rebasing on a quote
        // would destroy live fold state with no host compaction behind it.
        const r = await post(rig, claudeHeaders(conv), [
            { role: "assistant", content: `FYI the host injected this: "${CLAUDE_COMPACTION_CONTINUATION_PREFIX}. The summary below covers the earlier portion of the conversation."` },
            seedInput()[12]!, seedInput()[13]!,
        ]);
        assert.equal(r.status, 200, "assistant-quote request succeeds");
        await r.text();

        const events = conflictEventsOf(s);
        assert.equal(events.find((e) => e.kind === "native-compaction"), undefined, "an assistant quote of the sentence is not a landing");
        assert.equal(s.metadata.nativeCompactionBoundary, undefined, "no boundary marked — no rebase");
    } finally {
        await rig.close();
    }
});

test("e2e #5767 negative: a continuation message already seen (old id) does not rebase (#2621 novelty)", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    try {
        const conv = "cc-5767-oldid";
        await seedAndFold(rig, conv, claudeHeaders(conv));
        const s = getSession(conv)!;

        // Turn 1: the continuation lands alongside the INTACT history (no
        // gap) — it is just a new user message; it gets a ref.
        const r1 = await post(rig, claudeHeaders(conv), [...seedInput(), continuationMessage()]);
        assert.equal(r1.status, 200, "continuation-with-intact-history request succeeds");
        await r1.text();
        assert.equal(conflictEventsOf(s).find((e) => e.kind === "native-compaction"), undefined, "no gap → no rebase on turn 1");

        // Turn 2: the compacted replay now includes the SAME continuation
        // (old id) + a decimated tail. The novelty gate must reject it.
        const r2 = await post(rig, claudeHeaders(conv), [continuationMessage(), seedInput()[12]!, seedInput()[13]!]);
        assert.equal(r2.status, 200, "replayed-continuation request succeeds");
        await r2.text();

        const events = conflictEventsOf(s);
        assert.equal(events.find((e) => e.kind === "native-compaction"), undefined, "a replayed continuation (old id) is not a landing");
        assert.equal(s.metadata.nativeCompactionBoundary, undefined, "no boundary marked — no rebase");
    } finally {
        await rig.close();
    }
});

test("e2e #5767 negative: the claude framing on a NON-claude session does not rebase (lane gate)", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    try {
        const conv = "cc-5767-foreign";
        // A generic session (x-acp-session key, no claude header, no claude
        // UA): the lane gate must reject the claude framing for a foreign
        // client even when the decimation shape is identical.
        const genericHeaders = { "content-type": "application/json", "x-acp-session": conv };
        await seedAndFold(rig, conv, genericHeaders);
        const s = getSession(conv)!;

        const r = await post(rig, genericHeaders, [continuationMessage(), seedInput()[12]!, seedInput()[13]!]);
        assert.equal(r.status, 200, "foreign-session framing request succeeds");
        await r.text();

        const events = conflictEventsOf(s);
        assert.equal(events.find((e) => e.kind === "native-compaction"), undefined, "the claude framing never matches on a non-claude lane");
        assert.equal(s.metadata.nativeCompactionBoundary, undefined, "no boundary marked — no rebase");
    } finally {
        await rig.close();
    }
});
