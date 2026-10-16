// #3033: the dsh native-compaction REBASE itself became the failure. The
// detector's corrective action (resetSessionCompression) wipes
// session.state.messageRefs.byRaw — the very map the #2621 id-novelty gate reads
// to know "this checkpoint already landed". Against an unstable resent history
// (dsh desktop re-serializes → content-hash id churns every replay) the SAME
// landed checkpoint therefore looks novel on every turn: detect → rebase → reset
// wipes the novelty memory → next replay looks novel again. Self-sustaining: the
// reporter's field report shows dsh landing 2 real compactions while the loop fired
// 66 resets in 84 min, bricking the session (every later compress then fails
// "no ref resolved").
//
// Fix under test: two independent convergence guards in performNativeCompactionRebase
// (src/session.ts), both persisted in session.metadata so they survive BOTH the
// reset and a proxy restart (the ref-map memory does neither):
//   ① fingerprint dedup — a checkpoint whose TEXT fingerprint equals the one we
//      last rebased onto is a re-detection of ONE landing → skip the second reset.
//   ② consecutive-rebase circuit breaker — more than NATIVE_REBASE_MAX_CONSECUTIVE
//      rebases inside one cooldown window (regardless of cause) arms a longer
//      suppression window → bounded degrade instead of a brick.
// Neither changes the wire nor the config surface (#3033 owner direction).

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
import { getSession, _resetSessionsForTest, NATIVE_REBASE_MAX_CONSECUTIVE, type NativeRebaseLedger } from "../src/session.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { conflictEventsOf } from "../src/conflict-watch.ts";
import { dshCheckpointFingerprint, DSH_CHECKPOINT_OPEN_TAG, DSH_CHECKPOINT_PREAMBLE_PREFIX } from "../src/server/dsh-compaction-guard.ts";

const MODEL = "deepseek-flash";

type Rig = {
    proxyPort: number;
    upstreamPort: number;
    close: () => Promise<void>;
};

async function startRig(): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
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
        compress: { injectTool: true, injectNudge: false },
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

// 14 messages sized like the codex #2372 fixture: the kernel protects the last 5,
// so folding m00001–m00009 covers 9 ids (> the 8-id floor).
function seedInput() {
    return Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} of the folded conversation. ` + `FILLER_${i}_content_`.repeat(230),
    }));
}

// A LANDED dsh checkpoint: one user/text message opening with the preamble and
// carrying the open tag mid-message. `tag` lets a caller churn the bytes (→ new
// content-hash id → novelty holds again) to simulate an unstable resend.
function checkpointMessage(tag = "") {
    return {
        role: "user",
        content: `${DSH_CHECKPOINT_PREAMBLE_PREFIX} of the conversation so far, as context for continuing.${tag} Continue the task directly.\n\n${DSH_CHECKPOINT_OPEN_TAG}\n## Primary Request and Intent\n- drive a fold, then replay the compacted view`,
    };
}

const FOLD_SUMMARY = "MAIN-SUMMARY-SETUP-CONTEXT-FOLDED-BY-COMPRESSION-LONG-ENOUGH-FOR-KERNEL-MIN-LENGTH-CHECK";

async function seedAndFold(rig: Rig, conv: string): Promise<void> {
    const r1 = await fetch(chatUrl(rig), { method: "POST", headers: dshHeaders(conv), body: JSON.stringify({ model: MODEL, messages: seedInput() }) });
    assert.equal(r1.status, 200, "seed request succeeds");
    await r1.text();
    const r2 = await fetch(`http://127.0.0.1:${rig.proxyPort}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [{ startId: "m00001", endId: "m00009", summary: FOLD_SUMMARY }] } }),
    });
    const j = (await r2.json()) as { ok: boolean; result?: string };
    assert.ok(j.ok, `fold accepted (${r2.status})`);
    assert.ok(!j.result?.includes("[Compression FAILED"), `fold succeeded: ${j.result?.slice(0, 200)}`);
    const s = getSession(conv)!;
    const covered = new Set((s!.state.blocks ?? []).flatMap((b) => (b.active ? b.effectiveMessageIds : [])));
    assert.ok(covered.size >= 8, `fold covers >=8 ids (got ${covered.size})`);
}

const retainedTail = () => [seedInput()[12], seedInput()[13]];

test("#3033: a single legitimate dsh compaction landing STILL rebases (happy path preserved)", async () => {
    const rig = await startRig();
    const conv = "bc3033-happy";
    try {
        await seedAndFold(rig, conv);
        const r = await fetch(chatUrl(rig), { method: "POST", headers: dshHeaders(conv), body: JSON.stringify({ model: MODEL, messages: [checkpointMessage(), ...retainedTail()] }) });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        assert.equal((s.state.blocks ?? []).filter((b) => b.active).length, 0, "live fold wiped by the rebase reset");
        const boundary = s.metadata.nativeCompactionBoundary as { pendingRebase?: boolean } | undefined;
        assert.ok(boundary, "native-compaction boundary recorded");
        assert.equal(boundary?.pendingRebase, false, "rebase consumed within the same request");
        assert.ok(s.metadata.nativeCompactionAt, "nativeCompactionAt stamped by the reset");
        assert.ok(conflictEventsOf(s).some((e) => e.kind === "native-compaction"), "classified as native-compaction");
        const ledger = s.metadata.nativeRebaseLedger as NativeRebaseLedger | undefined;
        assert.ok(ledger?.lastAt, "convergence ledger records the rebase");
        assert.equal(ledger?.consecutive, 1, "first rebase counts as one consecutive");
    } finally {
        await rig.close();
    }
});

test("#3033: re-detecting the SAME landed checkpoint does NOT reset a second time (fingerprint dedup)", async () => {
    const rig = await startRig();
    const conv = "bc3033-dedup";
    try {
        await seedAndFold(rig, conv);
        // Simulate "we already rebased onto exactly this checkpoint": pre-stamp the
        // ledger with this checkpoint's text fingerprint (as a prior rebase would).
        const s0 = getSession(conv)!;
        const cp = checkpointMessage();
        s0.metadata.nativeRebaseLedger = { fingerprint: dshCheckpointFingerprint([cp]), lastAt: Date.now(), consecutive: 1 };

        const r = await fetch(chatUrl(rig), { method: "POST", headers: dshHeaders(conv), body: JSON.stringify({ model: MODEL, messages: [cp, ...retainedTail()] }) });
        assert.equal(r.status, 200);
        await r.text();
        const s = getSession(conv)!;
        // A decimated replay deactivates the drifted fold via ordinary syncBlocks
        // churn regardless of any rebase — so assert on REBASE-specific state, not
        // block liveness: a suppressed re-detection leaves the boundary unmarked,
        // the conflict ledger clean, and the rebase counter untouched.
        assert.ok(s.metadata.nativeCompactionBoundary === undefined, "no boundary marked for a re-detected checkpoint");
        assert.ok(!conflictEventsOf(s).some((e) => e.kind === "native-compaction"), "no duplicate native-compaction conflict entry");
        assert.equal((s.metadata.nativeRebaseLedger as NativeRebaseLedger)?.consecutive, 1, "rebase counter untouched by the suppressed re-detection");
    } finally {
        await rig.close();
    }
});

test("#3033: a self-retriggering loop arms the circuit breaker and stops resetting (bounded degrade)", async () => {
    const rig = await startRig();
    const conv = "bc3033-breaker";
    try {
        await seedAndFold(rig, conv);
        // Simulate "we've already rebased MAX times within the cooldown window"
        // with a DIFFERENT fingerprint (so the ① dedup does not fire first and the
        // ③ timing breaker is what's exercised).
        const s0 = getSession(conv)!;
        s0.metadata.nativeRebaseLedger = { fingerprint: "unrelated-fp", lastAt: Date.now(), consecutive: NATIVE_REBASE_MAX_CONSECUTIVE };

        // First replay: consecutive would become MAX+1 → breaker ARMS, no reset.
        const r1 = await fetch(chatUrl(rig), { method: "POST", headers: dshHeaders(conv), body: JSON.stringify({ model: MODEL, messages: [checkpointMessage(), ...retainedTail()] }) });
        assert.equal(r1.status, 200);
        await r1.text();
        const s1 = getSession(conv)!;
        const led1 = s1.metadata.nativeRebaseLedger as NativeRebaseLedger;
        assert.ok(typeof led1.breakerArmedUntil === "number" && led1.breakerArmedUntil > Date.now(), "breaker armed for the suppression window");
        assert.ok(s1.metadata.nativeCompactionBoundary === undefined, "no rebase marked while the breaker arms");
        assert.ok(!conflictEventsOf(s1).some((e) => e.kind === "native-compaction"), "no conflict entry for a suppressed rebase");

        // Second replay (churned bytes → fresh id → novelty still holds): the armed
        // breaker keeps suppressing — this is the 66x loop, now bounded.
        const r2 = await fetch(chatUrl(rig), { method: "POST", headers: dshHeaders(conv), body: JSON.stringify({ model: MODEL, messages: [checkpointMessage("-loop-turn-2"), ...retainedTail()] }) });
        assert.equal(r2.status, 200);
        await r2.text();
        const s2 = getSession(conv)!;
        assert.ok(typeof (s2.metadata.nativeRebaseLedger as NativeRebaseLedger)?.breakerArmedUntil === "number", "breaker still armed on the second replay");
        assert.ok(s2.metadata.nativeCompactionBoundary === undefined, "still no rebase marked while the breaker is armed");
        assert.ok(!conflictEventsOf(s2).some((e) => e.kind === "native-compaction"), "still no conflict entry while the breaker is armed");
    } finally {
        await rig.close();
    }
});

