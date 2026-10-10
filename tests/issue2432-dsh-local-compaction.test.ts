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
import { carriesDshLocalCompactionSummary, DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";

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
            await once(proxy, "close");
            upstream.close();
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

test("unit: carriesDshLocalCompactionSummary matches framing, never ordinary prose", () => {
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
        assert.equal(Object.keys(s.state.messageRefs.byRaw).length, 3, "refs re-seeded onto exactly the compacted view (checkpoint + 2 retained)");

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
        assert.equal(Object.keys(s2.state.messageRefs.byRaw).length, 4, "refs accumulate append-only after the rebase");
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
