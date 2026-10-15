// #2432: dsh desktop's native compaction can LAND without transiting bili —
// its summarizer calls ctx.llm.stream() directly, and manual /compact /
// idle-session paths have no ALS attribution so the plugin's takeover gate
// sends them DIRECT past the proxy. Before this fix the first replay of
// [checkpoint summary, retained tail…] against the same session id left the
// ACP state unrebased: syncBlocks kept partially-alive blocks forever, fold
// anchors self-destructed, and every later compress failed "cannot be anchored"
// (the issue's death spiral). The openai lane now detects the signature —
// dsh-bound session + checkpoint framing in resent history + decimated fold
// coverage — and rebases onto the compacted view in the SAME turn (same
// pattern as codex local compaction, #2373). Also covered here: per-turn
// nudge injection goes quiet while the compress circuit breaker is armed
// (#2432 item 1), so the surfaces stop inviting the failing calls.

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
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { conflictEventsOf } from "../src/conflict-watch.ts";
import { carriesDshLocalCompactionSummary, dshCheckpointFingerprint, detectDshLocalCompactionCheckpoint, normalizeDshCheckpointText, DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";

const MODEL = "deepseek-flash";
const NUDGE_PREFIX = "This is an efficiency nudge";

type Rig = {
    proxyPort: number;
    upstreamPort: number;
    bodies: string[];
    close: () => Promise<void>;
};

type KernelNudgeOverrides = { growthFloor?: number; growthCap?: number; minGrowthFloor?: number };

async function startRig(compress: { injectTool: boolean; injectNudge?: boolean }, kernelNudge?: KernelNudgeOverrides): Promise<Rig> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            bodies.push(raw);
            // Report prompt tokens proportional to the payload so the nudge
            // decision sees real growth between turns (a constant report pins
            // the token baseline and the nudge never fires).
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
        // The kernel's flat nudge band (growthFloor==growthCap==50000, minGrowthFloor 20000)
        // never fires on a small in-memory fixture; flatten it explicitly when a test needs
        // the per-turn nudge to fire deterministically.
        kernelConfig: kernelNudge ? { ...defaultConfig(30_000), nudge: { ...defaultConfig(30_000).nudge, ...kernelNudge } } : defaultConfig(30_000),
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

// 14 messages sized like the codex #2372 fixture: the kernel protects the
// last 5 messages, so folding m00001–m00009 covers 9 ids (> the 8-id floor).
function seedInput() {
    return Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230),
    }));
}

function checkpointMessage() {
    return {
        role: "user",
        content: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far, as context for continuing. The work established the harness, drove one fold, and then dsh compacted natively. Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- drive a fold, then replay the compacted view`,
    };
}

const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

/** A retained-tail message: deterministic (so every turn re-sends the SAME raw
 *  id) and large enough that a post-replay compress of the pair clears the
 *  kernel's 5000-char minimum. */
function retainedTail(label: string) {
    return { role: "user", content: `Retained tail ${label} after the native compaction. ` + `FILLER_${label}_content_`.repeat(230) };
}

async function seedAndFold(rig: Rig, conv: string): Promise<void> {
    const r1 = await fetch(chatUrl(rig), {
        method: "POST",
        headers: dshHeaders(conv),
        body: JSON.stringify({ model: MODEL, messages: seedInput() }),
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

test("drift pin: dsh checkpoint framing bytes are versioned (#2432)", () => {
    // Hex escapes per KDD #2 — the literal bytes come from
    // @deepseek-ai/dsh-compaction-basic 0.2.x (SUMMARY_OPEN_TAG /
    // CHECKPOINT_PREAMBLE). If they drift the detector degrades to the
    // pre-#2432 archive path; this pin makes the drift visible in CI.
    assert.equal(DSH_CHECKPOINT_OPEN_TAG, "\x3ccompacted-summary\x3e");
    assert.equal(DSH_CHECKPOINT_PREAMBLE_PREFIX, "This is an automatically generated checkpoint condensing an earlier span of the conversation");
});

test("unit: carriesDshLocalCompactionSummary matches framing only on a user/text carrier (#2621)", () => {
    // Positive: a freshly-landed checkpoint is a user-role plain-text message
    // whose text carries the framing. (No knownIds set here → novelty gate
    // skipped, so these exercise the carrier gate alone.)
    assert.equal(carriesDshLocalCompactionSummary([]), false, "empty history");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "user", contentType: "text", text: "plain prose" }]), false);
    assert.equal(carriesDshLocalCompactionSummary([{ role: "user", contentType: "text", text: `intro\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## section` }]), true, "open tag mid-message");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "user", contentType: "text", text: DSH_CHECKPOINT_PREAMBLE_PREFIX + " of the conversation…" }]), true, "preamble at message start");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "user", contentType: "text", content: `see ${DSH_CHECKPOINT_OPEN_TAG} below` }]), true, "raw wire content fallback (user text)");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "user", contentType: "text", text: "compacted summary mentioned without tags" }]), false, "the WORD 'compacted' alone is not framing");
});

test("unit #2621: only user TEXT messages can carry framing — quotes from any other producer read false", () => {
    // Real-world carriers from the #2621 session: 19 assistant prose quotes,
    // 9 tool-call args, 8 tool results (transcript reads), 0 user messages.
    // Every one of them must read false, or ordinary fold drift + "someone
    // talked about the marker" rebases ACP state with no host compaction.
    const QUOTE = `the transcript literally contains ${DSH_CHECKPOINT_OPEN_TAG} at line 40`;
    assert.equal(carriesDshLocalCompactionSummary([{ role: "assistant", contentType: "text", text: `checking: ${QUOTE}` }]), false, "assistant prose quoting the marker");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "assistant", contentType: "reasoning", text: QUOTE }]), false, "assistant reasoning quoting the marker");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "user", contentType: "tool-result", text: QUOTE }]), false, "tool result flattened to role=user (anthropic lane) quoting the marker");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "tool", contentType: "tool-result", text: QUOTE }]), false, "openai role=tool result quoting the marker");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "assistant", contentType: "tool-call", text: QUOTE }]), false, "assistant tool-call args quoting the marker (bili's own compress echoes ride here)");
    assert.equal(carriesDshLocalCompactionSummary([{ role: "assistant", contentType: "text", text: DSH_CHECKPOINT_PREAMBLE_PREFIX + " that a colleague pasted for reference" }]), false, "preamble quoted by the assistant");
    assert.equal(carriesDshLocalCompactionSummary([{ text: QUOTE }]), false, "role-less bare shape reads false (safe miss, #2621 direction)");
});

test("unit: carriesDshLocalCompactionSummary novelty gate — old ids never match (#2621)", () => {
    const framed = `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## section`;
    // A user/text message carrying the framing but whose id is ALREADY in the
    // pre-turn ref map is a replay/quote, not a fresh landing → no match.
    assert.equal(
        carriesDshLocalCompactionSummary([{ id: "old", role: "user", contentType: "text", text: framed }], new Set(["old"])),
        false, "an already-seen user/text quote of the framing is not a landing");
    // The identical framed message with a FRESH id (absent from the pre-turn map) matches.
    assert.equal(
        carriesDshLocalCompactionSummary([{ id: "fresh", role: "user", contentType: "text", text: framed }], new Set(["other"])),
        true, "a fresh user/text message carrying the framing is a landing");
    // Omitting knownIds skips the novelty gate (carrier gate only) — the framed
    // user/text message still matches, preserving the direct-caller contract.
    assert.equal(
        carriesDshLocalCompactionSummary([{ id: "whatever", role: "user", contentType: "text", text: framed }]),
        true, "no knownIds set → novelty gate skipped, carrier gate decides");
});

test("e2e #2432: dsh replaying [checkpoint, retained tail] rebases the ACP state instead of drifting forever", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-openai-main";
    try {
        await seedAndFold(rig, conv);
        const s0 = getSession(conv)!;
        const coveredBefore = new Set(s0.state.blocks.flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
        assert.ok(coveredBefore.size >= 8, "precondition: live fold covering >=8 ids");

        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL, messages: [checkpointMessage(), seedInput()[12], seedInput()[13]] }),
        });
        assert.equal(r.status, 200, "compacted replay request succeeds");
        await r.text();

        const s = getSession(conv)!;
        assert.equal((s.state.blocks ?? []).length, 0, "block list empty after the rebase reset");
        const boundary = s.metadata.nativeCompactionBoundary as { pendingRebase?: boolean } | undefined;
        assert.ok(boundary, "native-compaction boundary recorded");
        assert.equal(boundary?.pendingRebase, false, "rebase consumed within the same request");
        assert.ok(s.metadata.nativeCompactionAt, "nativeCompactionAt recorded by the reset");
        // #3033: the reset persists WHICH checkpoint it consumed, so the
        // re-minted replay of that same compaction stops re-firing the detector.
        assert.equal(typeof s.metadata.dshCompactionFingerprint, "string", "rebase records the consumed checkpoint's fingerprint");
        assert.equal(s.metadata.dshCompactionFingerprint, dshCheckpointFingerprint(checkpointMessage().content), "…of exactly the checkpoint that landed");
        // #2592/F5: 3 re-seeded entries + the pinned ref floor.
        assert.equal(Object.keys(s.state.messageRefs.byRaw).length, 4, "refs re-seeded onto exactly the compacted view (checkpoint + 2 retained + ref-floor)");

        const events = conflictEventsOf(s);
        assert.ok(events.some((e) => e.kind === "native-compaction"), "classified as native-compaction in the conflict ledger");
        assert.ok(!events.some((e) => e.kind === "unannounced-rewrite"), "no double-record as unannounced-rewrite beside it");

        const forward = rig.bodies[rig.bodies.length - 1];
        assert.ok(forward.includes(DSH_CHECKPOINT_OPEN_TAG), "checkpoint framing forwarded upstream");
        assert.ok(forward.includes("FILLER_13_"), "retained tail forwarded upstream");

        // The session keeps working afterwards (append + forward).
        const r2 = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL, messages: [checkpointMessage(), seedInput()[12], seedInput()[13], { role: "user", content: "Post-compaction turn continues fine." }] }),
        });
        assert.equal(r2.status, 200, "post-compaction turn succeeds");
        await r2.text();
        const s2 = getSession(conv)!;
        assert.equal(Object.keys(s2.state.messageRefs.byRaw).length, 5, "refs accumulate append-only after the rebase");
    } finally {
        await rig.close();
    }
});

test("negative #2432: same compacted shape on a NON-dsh plugin lane does NOT rebase", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-openai-nonbind";
    try {
        // Seed + fold under a DIFFERENT plugin agent (pi): the sticky
        // pluginAgent binding stays "pi", so the identical compacted shape
        // must not trigger the dsh-specific rebase.
        const r1 = await fetch(chatUrl(rig), {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": conv },
            body: JSON.stringify({ model: MODEL, messages: seedInput() }),
        });
        assert.equal(r1.status, 200);
        await r1.text();
        const r2 = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: "m00001", endId: "m00009", summary: FOLD_SUMMARY }] } }),
        });
        const j = (await r2.json()) as { ok: boolean };
        assert.ok(j.ok, "fold accepted on the non-dsh lane");
        const s0 = getSession(conv)!;
        assert.equal(s0.metadata["pluginAgent"], "pi", "precondition: session bound to the pi lane");
        const before = Object.keys(s0.state.messageRefs.byRaw).length;

        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": conv },
            body: JSON.stringify({ model: MODEL, messages: [checkpointMessage(), seedInput()[12], seedInput()[13]] }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary outside the dsh lane");
        assert.ok(Object.keys(s.state.messageRefs.byRaw).length >= before, "ref map not re-seeded");
    } finally {
        await rig.close();
    }
});

test("negative #2432: decimated history WITHOUT checkpoint framing stays on the existing paths", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-openai-nomarker";
    try {
        await seedAndFold(rig, conv);
        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: "user", content: "A different rewritten head — no dsh checkpoint framing here. " + "HEAD_.repeat".repeat(40) },
                    seedInput()[12],
                    seedInput()[13],
                ],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no rebase without the checkpoint framing (gap alone is ordinary churn)");
    } finally {
        await rig.close();
    }
});

test("negative #2621: quoting the framing from a non-user message + fold drift does NOT rebase", async () => {
    // The false positive as reported: dsh lane, active fold, resent history
    // decimated by ordinary drift, and the ONLY framing hit is an assistant
    // message quoting the marker (a transcript read / reasoning quote). Pre-fix
    // this fired "dsh native compaction detected" and rebased 667 covered ids
    // onto a compaction that never happened.
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-openai-quote-fp";
    try {
        await seedAndFold(rig, conv);
        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: "assistant", content: `While debugging I read the transcript and saw ${DSH_CHECKPOINT_OPEN_TAG} in the log — quoting it here for reference, not a compaction.` },
                    seedInput()[12],
                    seedInput()[13],
                ],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "quoting the marker from a non-user message never rebases (#2621)");
        assert.ok(!conflictEventsOf(s).some((c) => c.kind === "native-compaction"), "no misattributed native-compaction conflict entry");
    } finally {
        await rig.close();
    }
});

test("negative #2432: user pasting the framing while history is intact does NOT rebase", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-openai-paste";
    try {
        await seedAndFold(rig, conv);
        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL,
                messages: [...seedInput(), { role: "user", content: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} that a colleague pasted into the chat for reference — not a compaction boundary.` }],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok((s.state.blocks ?? []).some((b) => b.active), "full replay keeps the fold — no gap, no rebase");
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary without coverage decimation");
    } finally {
        await rig.close();
    }
});

test("negative #2621: marker quoted by a NON-user carrier + real fold gap does NOT rebase", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-openai-falsecarrier";
    try {
        // Seed + fold → a live fold covering m00001–m00009. Replaying a decimated
        // head that omits those ids yields a REAL foldCoverage gap (missing≥8,
        // missing*2≥expected) with NO host compaction — signal ② alone.
        await seedAndFold(rig, conv);
        // The marker now survives ONLY inside an assistant message (the model
        // "quoted" it from a transcript read) — a carrier that can never be a
        // dsh checkpoint. Pre-#2621 the bare byte-match fired on this quote and
        // rebased a healthy session; post-fix the carrier gate rejects it.
        const r = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: "user", content: "continue please" },
                    { role: "assistant", content: `I checked the other session's transcript and it contained ${DSH_CHECKPOINT_OPEN_TAG} — not a boundary.` },
                    seedInput()[12],
                    seedInput()[13],
                ],
            }),
        });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "a non-user carrier quoting the marker must NOT trigger a native-compaction rebase (#2621)");
        assert.ok(!conflictEventsOf(s).some((e) => e.kind === "native-compaction"), "no misattributed native-compaction conflict recorded (#2621)");
    } finally {
        await rig.close();
    }
});

test("#2432: per-turn nudge injection goes quiet while the compress breaker is armed", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: true }, { growthFloor: 500, growthCap: 500, minGrowthFloor: 100 });
    // The nudge decision prices THIS turn with the PREVIOUS request's upstream
    // usage report (one-turn lag), and the growth baseline stamps on the first
    // turn — so small → grown → grown is the minimal deterministic shape: the
    // third request sees the big report against the small baseline.
    const small = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `warm-${i}-` + "z".repeat(1000) }));
    const grown = [...small, ...Array.from({ length: 48 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `grow-${i}-` + "z".repeat(1000) }))];
    const post = (conv: string, messages: { role: string; content: string }[]) =>
        fetch(chatUrl(rig), { method: "POST", headers: dshHeaders(conv), body: JSON.stringify({ model: MODEL, messages }) });
    try {
        // Control: healthy session through the growth shape → nudge on turn 3.
        for (const [i, m] of [small, grown, grown].entries()) {
            const r = await post("dshc-nudge-control", m);
            assert.equal(r.status, 200);
            await r.text();
            if (i < 2) continue;
            assert.ok(rig.bodies[rig.bodies.length - 1].includes(NUDGE_PREFIX), "control session gets the nudge on the growth turn");
        }

        // Armed: arm the breaker after turn 1, same shape → no nudge on turn 3.
        let r = await post("dshc-nudge-armed", small);
        assert.equal(r.status, 200);
        await r.text();
        const armedSession = getSession("dshc-nudge-armed");
        assert.ok(armedSession, "armed session exists");
        armedSession!.metadata["compressFailStreak"] = { n: 3, lastAt: Date.now() };
        r = await post("dshc-nudge-armed", grown);
        assert.equal(r.status, 200);
        await r.text();
        r = await post("dshc-nudge-armed", grown);
        assert.equal(r.status, 200);
        await r.text();
        assert.ok(!rig.bodies[rig.bodies.length - 1].includes(NUDGE_PREFIX), "armed session: the nudge that would invite failing compresses is suppressed");
    } finally {
        await rig.close();
    }
});

// ---------- #3033: a replay of the already-consumed checkpoint must not re-rebase ----------

/** A checkpoint summary that CITES prior refs the way real ones do — "summaries
 *  cite tags across turns" (kernel contract) — so its text carries bili's own
 *  render tags. A #2432 rebase re-issues those numbers, which is exactly what
 *  made the #3033 detector re-fire forever: same compaction, fresh message id. */
function checkpointCiting(refs: string[], prose = "The work established the harness, drove one fold, and then dsh compacted natively."): { role: string; content: string } {
    const citations = refs.map((r) => `\x3cacp tokens="1" type="text"\x3e${r}\x3c/acp\x3e`).join(" ");
    return {
        role: "user",
        content: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far, as context for continuing. ${prose} Continue the task directly from the messages that follow, without acknowledging this checkpoint.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- drive a fold, then replay the compacted view\n- earlier context: ${citations}`,
    };
}

test("unit #3033: the checkpoint fingerprint survives ref re-minting (the loop's root cause)", () => {
    const gen1 = checkpointCiting(["m00002", "m00005"]).content;
    const gen2 = checkpointCiting(["m00007", "m00011"]).content; // same compaction, re-minted numbering
    assert.notEqual(gen1, gen2, "the re-minted checkpoint is a DIFFERENT message — a fresh id, so the novelty gate stays open");
    assert.equal(dshCheckpointFingerprint(gen1), dshCheckpointFingerprint(gen2), "…but the SAME compaction: the fingerprint ignores the numbering churn");
    assert.equal(normalizeDshCheckpointText(gen1).includes("m00002"), false, "normalization strips the volatile ref numbers");
    assert.notEqual(
        dshCheckpointFingerprint(gen1),
        dshCheckpointFingerprint(checkpointCiting(["m00002"], "a later, different compaction").content),
        "different content ⇒ different fingerprint — the suppression is per-compaction, never blanket");
});

test("unit #3033: detect reports suppressed ONLY for the checkpoint the last rebase consumed", () => {
    const replay = checkpointCiting(["m00007"]).content;
    const hit = detectDshLocalCompactionCheckpoint([{ id: "fresh", role: "user", contentType: "text", text: replay }], new Set(["old"]), dshCheckpointFingerprint(checkpointCiting(["m00002"]).content));
    assert.ok(hit, "the re-minted replay still passes the carrier + novelty gates");
    assert.equal(hit!.suppressed, true, "…and is recognized as the already-rebased checkpoint");
    assert.equal(carriesDshLocalCompactionSummary([{ id: "fresh", role: "user", contentType: "text", text: replay }], new Set(["old"]), dshCheckpointFingerprint(checkpointCiting(["m00002"]).content)), false, "a suppressed replay reads false to the boolean wrapper");
    assert.equal(detectDshLocalCompactionCheckpoint([{ id: "fresh", role: "user", contentType: "text", text: replay }], new Set(["old"]), dshCheckpointFingerprint(checkpointCiting(["m00009"], "an unrelated compaction").content))!.suppressed, false, "a DIFFERENT checkpoint is not suppressed");
    assert.equal(detectDshLocalCompactionCheckpoint([{ id: "fresh", role: "user", contentType: "text", text: replay }], new Set(["old"]))!.suppressed, false, "no stored fingerprint ⇒ never suppressed");
});

/** Drive one full #2432 rebase (iteration 1), let the session keep running on
 *  the rebuilt generation, and re-establish a live fold there — the sustain
 *  condition of the field loop (66 detections, not one). Returns the refs the
 *  new fold covers plus the refs of the retained tail (still citable after a
 *  suppressed replay, which is what proves no second reset happened). */
async function rebaseThenRefold(rig: Rig, conv: string): Promise<{ foldStart: string; foldEnd: string; tailStart: string; tailEnd: string }> {
    await seedAndFold(rig, conv);
    const gen1 = checkpointCiting(["m00002", "m00005"]);
    const r1 = await fetch(chatUrl(rig), {
        method: "POST",
        headers: dshHeaders(conv),
        // brand-new tail: the field signature is retained=0 — the replayed view
        // shares NO id with the pre-compaction fold.
        body: JSON.stringify({ model: MODEL, messages: [gen1, retainedTail("A"), retainedTail("B")] }),
    });
    assert.equal(r1.status, 200);
    await r1.text();
    const s1 = getSession(conv)!;
    assert.equal(conflictEventsOf(s1).filter((e) => e.kind === "native-compaction").length, 1, "iteration 1 rebases and records exactly one native-compaction entry");
    assert.equal(s1.metadata.dshCompactionFingerprint, dshCheckpointFingerprint(gen1.content), "the rebase persists the consumed checkpoint's fingerprint");

    // The session keeps running on the rebuilt generation: the client resends
    // the compacted view and the conversation continues on top of it (blocks
    // are empty right after the reset, so no rewrite is misread here), and the
    // agent compresses again — the fold the next replay must not destroy.
    const grown = [
        gen1,
        retainedTail("A"),
        retainedTail("B"),
        ...seedInput(),
    ];
    const reseed = await fetch(chatUrl(rig), {
        method: "POST",
        headers: dshHeaders(conv),
        body: JSON.stringify({ model: MODEL, messages: grown }),
    });
    assert.equal(reseed.status, 200);
    await reseed.text();
    // byRaw maps rawId → refId; the VALUES are the refs in first-seen order, so
    // the rebase's re-based view comes first (floor + the re-anchored turn) and
    // the messages that landed after it take the last refs.
    const vals = Object.values(getSession(conv)!.state.messageRefs.byRaw);
    const fresh = vals.slice(-14);
    const foldStart = fresh[0];
    const foldEnd = fresh[8];
    assert.ok(/^m\d{5}$/.test(foldStart) && /^m\d{5}$/.test(foldEnd), `post-rebase refs available (${foldStart}..${foldEnd} of ${vals.length})`);
    assert.equal(Number(foldEnd.slice(1)) - Number(foldStart.slice(1)), 8, "the folded run is contiguous");
    const refold = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: foldStart, endId: foldEnd, summary: FOLD_SUMMARY }] } }),
    });
    const refoldJson = (await refold.json()) as { ok: boolean; result?: string };
    assert.ok(refoldJson.ok, `post-rebase fold accepted (${refold.status})`);
    assert.ok(!refoldJson.result?.includes("[Compression FAILED"), `post-rebase fold succeeded: ${refoldJson.result?.slice(0, 200)}`);
    assert.ok(getSession(conv)!.state.blocks.length > 0, "the rebuilt generation carries a live fold — the detector path is armed");
    return { foldStart, foldEnd, tailStart: vals[2], tailEnd: vals[3] };
}

test("e2e #3033: the loop's SECOND iteration — a re-minted replay of the already-rebased checkpoint does not reset again", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-openai-replay";
    try {
        const { foldStart, foldEnd, tailStart, tailEnd } = await rebaseThenRefold(rig, conv);
        // Iteration 2: the SAME compaction replayed with its citations re-minted
        // by the rebase's ref re-issue — a fresh id, identical normalized content.
        const r2 = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL, messages: [checkpointCiting(["m00007", "m00011"]), retainedTail("A"), retainedTail("B")] }),
        });
        assert.equal(r2.status, 200, "the re-minted replay is served");
        await r2.text();

        const s2 = getSession(conv)!;
        assert.equal(conflictEventsOf(s2).filter((e) => e.kind === "native-compaction").length, 1, "NO second rebase — the loop is broken (#3033)");
        assert.equal(conflictEventsOf(s2).filter((e) => e.kind === "unannounced-rewrite").length, 0, "the replay is a WITNESSED rewrite, not a silent one");
        // A second rebase would resetImageFullState(createInitialState()) and wipe
        // the ref space (that re-issue is what manufactures the next detection);
        // the refs the post-rebase fold used must still be citable.
        assert.ok(foldStart in s2.state.messageRefs.byRef && foldEnd in s2.state.messageRefs.byRef, `the ref space was NOT restarted (${foldStart}..${foldEnd} still citable) — no second reset (#3033)`);

        // The session keeps working afterwards (and its refs stay citable): the
        // conversation continues on the rebuilt generation, pushing the retained
        // tail out of the kernel's protected zone so the agent can compress it.
        const r3 = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL, messages: [checkpointCiting(["m00007", "m00011"]), retainedTail("A"), retainedTail("B"), ...Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `Post-replay message ${i}. ` + `FILLER_post_${i}_content_`.repeat(230) }))] }),
        });
        assert.equal(r3.status, 200, "post-replay turn succeeds");
        await r3.text();
        // The recovery mechanism is ref stability: the retained tail is still
        // citable, so the agent's next compress anchors instead of failing
        // "cannot be anchored" (the #2432 spiral).
        const compress = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: tailStart, endId: tailEnd, summary: FOLD_SUMMARY }] } }),
        });
        const compressJson = (await compress.json()) as { ok: boolean; result?: string };
        assert.ok(compressJson.ok && !compressJson.result?.includes("[Compression FAILED"), `post-replay compress is answerable: ${compressJson.result?.slice(0, 200)}`);
    } finally {
        await rig.close();
    }
});

test("control #3033: a replay of a DIFFERENT checkpoint still rebases (suppression is per-fingerprint)", async () => {
    const rig = await startRig({ injectTool: true, injectNudge: false });
    const conv = "dshc-openai-replay-control";
    try {
        await rebaseThenRefold(rig, conv);
        // A genuinely NEW compaction: different prose ⇒ different fingerprint.
        const fresh = checkpointCiting(["m00007", "m00011"], "A later compaction covering different ground.");
        const r2 = await fetch(chatUrl(rig), {
            method: "POST",
            headers: dshHeaders(conv),
            body: JSON.stringify({ model: MODEL, messages: [fresh, retainedTail("A"), retainedTail("B")] }),
        });
        assert.equal(r2.status, 200);
        await r2.text();
        const s = getSession(conv)!;
        assert.equal(conflictEventsOf(s).filter((e) => e.kind === "native-compaction").length, 2, "a DIFFERENT checkpoint still rebases");
        assert.equal(s.metadata.dshCompactionFingerprint, dshCheckpointFingerprint(fresh.content), "and the rebase persists ITS fingerprint");
    } finally {
        await rig.close();
    }
});
