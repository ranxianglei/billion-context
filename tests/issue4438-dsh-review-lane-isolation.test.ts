// #4438: dsh's auto-review sidecar (classifyRisk) reached bili UNSTAMPED on the
// web-profile topology — no x-bili-plugin header — while the session's sticky
// dsh binding kept the #2432 rebase gate armed for it. Every header-gated
// isolation gate (persona fork #1916, title clause #2503) missed the request,
// so the review blob rode the raw main session key through the FULL pipeline:
// its FILTERED_HISTORY section embedded an OLD landed checkpoint, which the
// mid-text includes() carrier match read as a fresh landing (0/N fold coverage
// → total ACP state wipe), and its usage sample clobbered the main baseline so
// the next turn skipped the output clamp (#453) into permanent upstream 400s.
//
// Fix under test (one mechanism family, two gates):
//   A2 — isDshAutoReviewRequest recognizes the review SHAPE (fixed REVIEW_POLICY
//        system prefix + exactly one non-system user blob + no tools) WITHOUT a
//        header gate; the request rides the #388 side passthrough (kernel state
//        untouched, usage never settles the main baseline) on every wire.
//   B  — carriesDshLocalCompactionSummary now requires the framing to OPEN the
//        message (standalone-checkpoint shape); a novel blob merely quoting an
//        old checkpoint mid-text can no longer false-positive, even if some
//        other aux traffic ever lands on a live session key again.

import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";
// This file pins the #4438 LANE contract (stateless passthrough forwarding, no
// |sub: fork) — run it with the #4634 default block opted out so the two suites
// cover complementary behaviors instead of colliding on the default.
process.env.BILI_DSH_AUTOREVIEW_BLOCK = "0";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, listSessions, _resetSessionsForTest } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { conflictEventsOf } from "../src/conflict-watch.ts";
import { carriesDshLocalCompactionSummary, DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";
import { DSH_AUTO_REVIEW_SYSTEM_PREFIX, isDshAutoReviewRequest } from "../src/server/side-request.ts";

const MODEL = "deepseek-flash";

// Version-pinned first line of @deepseek-ai/dsh-experimental-auto-review's
// fixed REVIEW_POLICY system prompt (tracked per dsh release like
// DSH_TITLE_SYSTEM_PREFIX / DSH_COMPACTION_INSTRUCTION_PREFIX). If it drifts
// the detector degrades to a miss — the pre-#4438 behavior for this traffic —
// which is safe (no state wipe), unlike a false positive.
const REVIEW_POLICY = `${DSH_AUTO_REVIEW_SYSTEM_PREFIX} in this conversation.\n\nYou must decide whether the pending action is allowed, and reply with exactly one JSON verdict.`;

// The freshly-flattened review snapshot: one user blob whose FILTERED_HISTORY
// section QUOTES an earlier landed checkpoint mid-text — the exact shape that
// false-positived the #2432 carrier before the standalone tightening (#4438).
const OLD_CHECKPOINT = `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- earlier work\n\x3c/compacted-summary\x3e`;

function reviewBlob(): string {
    return [
        "ENVIRONMENT",
        "profile: web; model: deepseek-v4.1-flash",
        "",
        "PROJECT_INSTRUCTIONS",
        "(none)",
        "",
        "FILTERED_HISTORY",
        "[user] earlier turn A about the harness setup.",
        OLD_CHECKPOINT,
        "[assistant] earlier turn B summarizing progress.",
        "",
        "PENDING_ACTION",
        "tool call: compress(content=[...])",
    ].join("\n");
}

type Rig = {
    proxyPort: number;
    upstreamPort: number;
    bodies: string[];
    close: () => Promise<void>;
};

async function startRig(compress: { injectTool: boolean; injectNudge?: boolean }): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            // Report prompt tokens proportional to the payload so each turn's
            // usage sample differs by size (the clobber assertion below relies
            // on the review reporting FEWER tokens than the seeded main turn).
            const promptTokens = Math.max(1, Math.round(raw.length / 4));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    _resetPluginStateForTest();
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

const chatUrl = (rig: Rig) => `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;

function dshHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
}

// The incident topology: the review arrives WITHOUT the plugin stamp, keyed to
// the main conversation only through the generic session header.
function unstampedHeaders(conv: string): Record<string, string> {
    return { "content-type": "application/json", "x-acp-session": conv };
}

function reviewBody(withSystem: boolean): Record<string, unknown> {
    const messages: Record<string, unknown>[] = [];
    if (withSystem) messages.push({ role: "system", content: REVIEW_POLICY });
    messages.push({ role: "user", content: reviewBlob() });
    return { model: MODEL, messages };
}

// 14 messages sized like the #2432 fixture: folding m00001–m00009 covers 9 ids
// (> the 8-id floor), giving the rebase gate a live fold to decimate against.
function seedInput(systemContent?: string): Record<string, unknown>[] {
    const msgs = Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230),
    }));
    if (systemContent !== undefined) msgs.unshift({ role: "system", content: systemContent });
    return msgs;
}

const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

async function seedAndFold(rig: Rig, conv: string, systemContent?: string): Promise<void> {
    const r1 = await fetch(chatUrl(rig), {
        method: "POST",
        headers: dshHeaders(conv),
        body: JSON.stringify({ model: MODEL, messages: seedInput(systemContent) }),
    });
    assert.equal(r1.status, 200, "seed request succeeds");
    await r1.text();
    const s = getSession(conv);
    assert.ok(s, "seed session exists under the conversation key");
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

test("drift pin: dsh auto-review policy prefix is versioned (#4438)", () => {
    assert.equal(DSH_AUTO_REVIEW_SYSTEM_PREFIX, "You are the final authorization reviewer for exactly one pending tool call");
});

test("unit: isDshAutoReviewRequest matches the review shape on every wire (#4438)", () => {
    // openai: system entry + single user blob, no tools.
    assert.equal(isDshAutoReviewRequest("openai", reviewBody(true)), true, "openai system+single user blob");
    // openai: parts-array user content.
    assert.equal(isDshAutoReviewRequest("openai", { model: MODEL, messages: [{ role: "system", content: REVIEW_POLICY }, { role: "user", content: [{ type: "text", text: reviewBlob() }] }] }), true, "openai parts-array content");
    // openai: developer-role carrier (some hosts use it for the system prompt).
    assert.equal(isDshAutoReviewRequest("openai", { model: MODEL, messages: [{ role: "developer", content: REVIEW_POLICY }, { role: "user", content: "blob" }] }), true, "developer-role carrier");
    // anthropic: TOP-LEVEL system field (the #3149 lesson — messages[] alone misses it).
    assert.equal(isDshAutoReviewRequest("anthropic", { model: MODEL, system: REVIEW_POLICY, messages: [{ role: "user", content: "blob" }] }), true, "anthropic top-level system");
    // responses: instructions field + single typed message item.
    assert.equal(isDshAutoReviewRequest("responses", { model: MODEL, instructions: REVIEW_POLICY, input: [{ type: "message", role: "user", content: "blob" }] }), true, "responses instructions + single item");
    // google: systemInstruction.parts + single user turn.
    assert.equal(isDshAutoReviewRequest("google", { model: MODEL, systemInstruction: { parts: [{ text: REVIEW_POLICY }] }, contents: [{ role: "user", parts: [{ text: "blob" }] }] }), true, "google systemInstruction.parts");
});

test("unit: isDshAutoReviewRequest vetoes every main-turn shape (#4438)", () => {
    // Any tools surface marks an agent turn.
    assert.equal(isDshAutoReviewRequest("openai", { ...reviewBody(true), tools: [{ type: "function", function: { name: "bash" } }] }), false, "tools present");
    // Multi-turn history (any assistant/tool turn) vetoes.
    assert.equal(isDshAutoReviewRequest("openai", { model: MODEL, messages: [{ role: "system", content: REVIEW_POLICY }, { role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }), false, "assistant turn in history");
    // Two user messages vetoes (the review is ONE freshly-flattened blob).
    assert.equal(isDshAutoReviewRequest("openai", { model: MODEL, messages: [{ role: "system", content: REVIEW_POLICY }, { role: "user", content: "a" }, { role: "user", content: "b" }] }), false, "two user messages");
    // No system carrier at all — the prefix must ride a SYSTEM carrier.
    assert.equal(isDshAutoReviewRequest("openai", { model: MODEL, messages: [{ role: "user", content: "blob" }] }), false, "no system carrier");
    // The prefix quoted inside the USER blob is not a policy carrier.
    assert.equal(isDshAutoReviewRequest("openai", { model: MODEL, messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: REVIEW_POLICY }] }), false, "prefix only in the user blob");
    // A different system prompt never matches, whatever the body looks like.
    assert.equal(isDshAutoReviewRequest("openai", { model: MODEL, messages: [{ role: "system", content: "You are a helpful assistant." }, { role: "user", content: "blob" }] }), false, "other system prompt");
    // Empty user content is not a review snapshot.
    assert.equal(isDshAutoReviewRequest("openai", { model: MODEL, messages: [{ role: "system", content: REVIEW_POLICY }, { role: "user", content: "" }] }), false, "empty user content");
    // Responses-side non-message items (reasoning / function_call) can only
    // appear in a real model round-trip.
    assert.equal(isDshAutoReviewRequest("responses", { model: MODEL, instructions: REVIEW_POLICY, input: [{ type: "reasoning", summary: [] }] }), false, "responses reasoning item");
    // Degenerate inputs.
    assert.equal(isDshAutoReviewRequest(null, reviewBody(true)), false, "null protocol");
    assert.equal(isDshAutoReviewRequest("openai", null), false, "null body");
    assert.equal(isDshAutoReviewRequest("openai", "nope"), false, "non-object body");
});

test("unit: the incident aux snapshot no longer reads as a landed checkpoint (#4438/B)", () => {
    // The review blob embeds an old checkpoint MID-text inside FILTERED_HISTORY.
    // Pre-fix the mid-text includes() matched it (freshly-synthesized blob →
    // novel id → novelty gate passed too) and rebased a live session onto a
    // compaction that never happened. Post-fix the framing must OPEN the
    // message; an embedded quote reads false.
    const blob = reviewBlob();
    assert.ok(blob.includes(DSH_CHECKPOINT_OPEN_TAG), "precondition: the blob really does quote the old checkpoint");
    assert.equal(carriesDshLocalCompactionSummary([{ id: "fresh-blob", role: "user", contentType: "text", text: blob }], new Set(["other"])), false, "embedded old-checkpoint quote in a novel aux blob is NOT a landing");
    // The genuine landing shape still matches (both framings, preamble-first
    // today, tag-first if the preamble ever drops out).
    assert.equal(carriesDshLocalCompactionSummary([{ id: "landed", role: "user", contentType: "text", text: OLD_CHECKPOINT }], new Set(["other"])), true, "standalone checkpoint (preamble-first) still matches");
    assert.equal(carriesDshLocalCompactionSummary([{ id: "landed-tag", role: "user", contentType: "text", text: `${DSH_CHECKPOINT_OPEN_TAG}\n## section\n\x3c/compacted-summary\x3e` }], new Set(["other"])), true, "standalone tag-first checkpoint still matches");
});

test("e2e #4438 (incident repro): UNSTAMPED review on a sticky-bound dsh session rides the side passthrough — no rebase, no baseline clobber", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "rev4438-unstamped";
    try {
        await seedAndFold(rig, conv);
        const s0 = getSession(conv)!;
        const coveredBefore = new Set(s0.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(coveredBefore.size >= 8, "precondition: live fold covering >=8 ids");
        const refsBefore = Object.keys(s0.state.messageRefs.byRaw).length;
        // The main turn's usage report settled the baseline at ~seed-size.
        const baselineBefore = s0.stats.lastInputTokens;
        assert.ok(baselineBefore > 0, "precondition: usage-grade baseline from the seeded main turn");
        // The review reports far fewer tokens than the seed — pre-fix that
        // smaller sample OVERWROTE the baseline (the #453 clamp skip).
        const reviewEstimate = Math.round(JSON.stringify(reviewBody(true)).length / 4);
        assert.ok(reviewEstimate < baselineBefore, "precondition: the review payload is smaller than the seeded main turn");

        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: unstampedHeaders(conv),
            body: JSON.stringify(reviewBody(true)),
        });
        assert.equal(r.status, 200, "review request succeeds");
        await r.text();

        const s = getSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "NO native-compaction boundary — the embedded old-checkpoint quote did not false-positive the #2432 guard");
        assert.ok(!conflictEventsOf(s).some((e) => e.kind === "native-compaction"), "no misattributed native-compaction conflict entry");
        const coveredAfter = new Set(s.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.equal(coveredAfter.size, coveredBefore.size, "fold coverage intact — no ACP state wipe");
        assert.deepEqual([...coveredAfter].sort(), [...coveredBefore].sort(), "the SAME ids stay covered");
        assert.equal(Object.keys(s.state.messageRefs.byRaw).length, refsBefore, "ref map untouched — the blob never entered processTurn");
        assert.equal(s.stats.lastInputTokens, baselineBefore, "usage baseline NOT clobbered by the smaller aux sample (#453 stays armed)");
        assert.equal(s.stats.lastInputTokensSource, "usage", "baseline source unchanged");
        // Stateless passthrough: no fork lane was created for the persona.
        assert.ok(!listSessions().some((x) => x.id.startsWith(`${conv}|sub:`)), "no |sub:<fp> fork session — the review is stateless, not a persisted persona lane");
        // The request itself went through verbatim (kernel-no-touch, #388).
        // Verbatim proof: parse the forwarded JSON and compare the message
        // contents byte-exact (a raw includes() would trip on JSON newline
        // escaping inside the multi-line policy text).
        const fwdParsed = JSON.parse(rig.bodies[rig.bodies.length - 1]) as { messages: { role: string; content: string }[] };
        assert.equal(fwdParsed.messages[0].content, REVIEW_POLICY, "review system policy forwarded verbatim");
        assert.equal(fwdParsed.messages[1].content, reviewBlob(), "review blob forwarded verbatim");

        // And the main session keeps working afterwards: append + forward,
        // fold still live, refs accumulate normally.
        const r2 = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL, messages: [...seedInput(), { role: "user", content: "Post-review main turn continues fine." }] }),
        });
        assert.equal(r2.status, 200, "post-review main turn succeeds");
        await r2.text();
        const s2 = getSession(conv)!;
        assert.ok((s2.state.blocks ?? []).some((b) => b.active), "fold survived the review round-trip");
        assert.ok(Object.keys(s2.state.messageRefs.byRaw).length > refsBefore, "refs accumulate append-only after the review");
    } finally {
        await rig.close();
    }
});

test("e2e #4438 (stamped variant): review WITH the dsh plugin header also rides the side passthrough — no |sub: fork lane", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "rev4438-stamped";
    try {
        // Seed WITH a main system prompt so the persona skeleton is anchored
        // under the raw key — the pre-fix stamped review would then have forked
        // onto a persisted |sub:<fp> lane (tagChanged vs the MAIN tag).
        await seedAndFold(rig, conv, "MAIN-SYSTEM-PROMPT-for-the-coding-assistant-session.");
        const s0 = getSession(conv)!;
        const refsBefore = Object.keys(s0.state.messageRefs.byRaw).length;
        const baselineBefore = s0.stats.lastInputTokens;
        assert.ok(baselineBefore > 0, "precondition: usage-grade baseline from the seeded main turn");

        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify(reviewBody(true)),
        });
        assert.equal(r.status, 200, "stamped review request succeeds");
        await r.text();

        assert.ok(!listSessions().some((x) => x.id.startsWith(`${conv}|sub:`)), "BEHAVIOR CHANGE (#4438): stamped reviews no longer fork onto a persisted |sub:<fp> persona lane — the forked state had no compression value (each blob is freshly serialized) and #3681 proved such lanes overflow their own window");
        const s = getSession(conv)!;
        assert.equal(Object.keys(s.state.messageRefs.byRaw).length, refsBefore, "main ref map untouched");
        assert.equal(s.stats.lastInputTokens, baselineBefore, "main baseline not clobbered by the stamped review either");
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no rebase on the stamped variant");
        const forward = rig.bodies[rig.bodies.length - 1];
        assert.ok(forward.includes("PENDING_ACTION"), "stamped review forwarded verbatim");
    } finally {
        await rig.close();
    }
});

test("negative #4438: a MAIN turn that quotes the review policy in its history is NOT demoted to the side lane", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "rev4438-mainquote";
    try {
        // A real multi-turn conversation where an earlier assistant message
        // happens to CONTAIN the reviewer policy text (e.g. the user pasted
        // dsh docs). Multi-turn history + tools must keep it on the main
        // pipeline — the single-blob bar rejects it.
        const msgs = seedInput("MAIN-SYSTEM.");
        msgs.push({ role: "assistant", content: `docs say: ${REVIEW_POLICY}` });
        msgs.push({ role: "user", content: "next question" });
        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL, messages: msgs, tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }] }),
        });
        assert.equal(r.status, 200, "main turn succeeds");
        await r.text();
        const s = getSession(conv)!;
        // msgs includes the system carrier, which never gets a ref: every
        // conversation message must have one.
        assert.ok(Object.keys(s.state.messageRefs.byRaw).length >= msgs.length - 1, "full pipeline ran — refs assigned to every message (not a passthrough)");
        assert.ok(!conflictEventsOf(s).some((e) => e.kind === "native-compaction"), "no conflict entries");
    } finally {
        await rig.close();
    }
});
