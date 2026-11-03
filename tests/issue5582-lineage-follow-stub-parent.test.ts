// #5582: host-stamped management calls stranded on a sidecar-stub parent.
//
// Failure family (#2156/#2160 lineage): at session start a dsh sidecar (title
// gen / auto review) that the recognition gates fail to classify rides the
// full pipeline under the RAW conversation id and CLAIMS the virgin raw-key
// anchor (shallow history + persona tag = claim by design). The first MAIN
// turn then arrives under a different persona with disjoint history: every
// continuity rung fails against the 1-cell shallow recording, so the whole
// conversation forks onto `|sub:<fp>` forever. From then on:
//   - nudge/compress refs minted in the FORK namespace (m00031..m00090);
//   - host-stamped calls (compress/acp_status/decompress, nativeCaller)
//     resolve VERBATIM to the raw key = a stub holding one tiny message;
//   - compress fails "highest allocated ref m00001" / "too small"; breaker.
// The pre-existing #2601 rescue (livePersonaDescendant) requires
// fork.createdAt > parent.lastSeen — but every RECOGNIZED sidecar that keeps
// riding the raw key stamps parent.lastSeen after the fork was born, so the
// birth-order filter excludes the main fork permanently. Restart does not heal
// (#3397 skeleton persistence re-records the claim).
//
// Fix under test (src/plugin.ts): when the resolved parent CANNOT serve the
// cited refs (frontier < maxCited) or is a non-main-shaped STUB (≤8 refs)
// with exactly one deep fresh descendant, follow that descendant — sharp
// membership in state.messageRefs.byRef first (a ref minted there is
// cryptographic ownership, ids are never reused), frontier-fit second.
// Healthy sessions are untouched: a parent that serves its own refs stays
// authoritative (the #2601 fusion-board incident guard), and a YOUNG REAL
// main-shaped conversation (≤8 refs, legitimate root thread) never follows a
// parallel subagent lane (orderIsMainShaped veto).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Hermetic state dirs BEFORE importing the server modules (#7.2 / #2668).
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-issue5582-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

// Imported AFTER the XDG env above.
const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { recordToolWitness, resetToolRingForTest } = await import("../src/tool-ring.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { forwardTool } = await import("../src/agent/shared.ts");
const { resetSessionOrderForTest, resolveSessionOrder } = await import("../src/session-resolve.ts");
const { peekSession, _resetSessionsForTest } = await import("../src/session.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const SYSTEM_A = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-A.\nWorkspace: /tmp.";
const SYSTEM_B = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-B.\nWorkspace: /tmp.";
const SYSTEM_C = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-C.\nWorkspace: /tmp.";
const SYSTEM_X = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-X.\nWorkspace: /tmp.";
const SYSTEM_Y = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-Y.\nWorkspace: /tmp.";
const SYSTEM_Z = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-Z.\nWorkspace: /tmp.";
const forkKey = (conv: string, system: string): string =>
    `${conv}|sub:${createHash("sha256").update(system, "utf8").digest("hex").slice(0, 16)}`;
/** Content-length string (≥32 chars post-normalization) so the normalized
 *  projection keeps the leaf, like real dsh turns; at this size a 64-message
 *  lane sits past the kernel's 5K-token protected zone, so a mid-history
 *  compress range actually folds instead of no-op'ing on the recent tail. */
const long = (s: string): string => `${s}-` + "z".repeat(800);
const msgs = (n: number, tag: string): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: long(`${tag}-${i + 1}`) }));

type Rig = { baseUrl: string; chatUrl: string; proxy: http.Server; relay: http.Server };

function startRelay(): http.Server {
    // Deterministic fake openai upstream: every request gets a plain answer.
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "r1", object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "plain reply" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5 },
            }));
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

async function startRig(): Promise<Rig> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    resetToolRingForTest();
    _resetPluginStateForTest();
    _resetSessionsForTest();
    resetSessionOrderForTest();
    const relay = startRelay();
    await once(relay, "listening");
    const relayPort = (relay.address() as { port: number }).port;
    const opts = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${relayPort}`]: { models: { "gpt-test": { context: 1_000_000 } }, compressProtocol: "marker" } },
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {}),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as unknown as Parameters<typeof startServer>[0];
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        baseUrl: `http://127.0.0.1:${proxyPort}`,
        chatUrl: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`,
        proxy,
        relay,
    };
}

async function stopRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.relay.close();
    rig.relay.closeIdleConnections?.();
    await once(rig.relay, "close");
}

async function dshTurn(rig: Rig, conv: string, system: string, history: { role: string; content: string }[]): Promise<void> {
    const res = await fetch(rig.chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv },
        body: JSON.stringify({ model: "gpt-test", max_tokens: 64_000, messages: [{ role: "system", content: system }, ...history] }),
    });
    assert.equal(res.status, 200, "dsh turn must succeed");
    await res.json();
}

/** Builds the #5582 pathology: an unrecognized-sidecar-shaped single-user
 *  request claims the raw key (shallow + tagged = claim by design), the main
 *  conversation forks onto |sub:, and two same-persona sidecars keep stamping
 *  the stub's lastSeen AFTER the fork was born (birth-order follow dead). */
async function buildStubParentPathology(rig: Rig, conv: string): Promise<{ forkB: string }> {
    await dshTurn(rig, conv, SYSTEM_A, msgs(1, "claim"));
    const FORK_B = forkKey(conv, SYSTEM_B);
    await dshTurn(rig, conv, SYSTEM_B, msgs(64, "main"));
    assert.ok(peekSession(FORK_B), "the main conversation forked onto |sub:");
    await dshTurn(rig, conv, SYSTEM_A, msgs(1, "sidecar-1"));
    await dshTurn(rig, conv, SYSTEM_A, msgs(1, "sidecar-2"));
    return { forkB: FORK_B };
}

test("#5582 stub-parent rescue: acp_status/acp_cache follow the deep descendant; cited-ref compress lands in the owning lane", async () => {
    const rig = await startRig();
    const CONV = "dshc-stub-parent";
    try {
        const { forkB } = await buildStubParentPathology(rig, CONV);
        const stub = peekSession(CONV);
        const fork = peekSession(forkB);
        assert.ok(stub && fork, "both the stub parent and the fork exist");
        // Precondition: the birth-order rule CANNOT fire here — the sidecars
        // kept the stub live past the fork's birth (this is why the user's
        // retries stayed on the stub pre-fix).
        assert.ok((fork!.createdAt ?? 0) < (stub!.lastSeen ?? 0),
            "precondition: stub.lastSeen advanced past fork.createdAt (recognized sidecars ride the raw key)");
        const stubRefs = Object.keys(stub!.state.messageRefs?.byRef ?? {}).length;
        assert.ok(stubRefs <= 8, `precondition: stub holds ${stubRefs} refs (sidecar blobs only)`);

        // Ref-less host-stamped call: follows the unique deep fresh descendant.
        // acp_status renders no session id — assert on the message inventory:
        // the fork holds the 64 main-turn messages, the stub holds one blob.
        const stat = await forwardTool(rig.baseUrl, CONV, "acp_status", { scope: "uncompressed", view: "messages" }, undefined, true);
        assert.equal(stat.failed, false);
        assert.ok(/\b64 msgs\b/.test(stat.text), `acp_status resolves into the fork lane (64 msgs), got: ${stat.text.slice(0, 120)}`);
        assert.ok(!/\b1 msgs\b/.test(stat.text), "acp_status no longer reports the stub's single message");
        assert.ok(!stat.text.includes(`|sub:${createHash("sha256").update(SYSTEM_A, "utf8").digest("hex").slice(0, 16)}`),
            "no |sub: lane of the sidecar persona leaks into the answer");
        const cache = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(cache.failed, false);
        assert.ok(cache.text.includes(forkB), "acp_cache resolves into the fork lane");

        // Cited-ref call: the stub's frontier (≤8) cannot hold m00060 — the
        // sharp byRef-membership tier routes to the lane that minted them.
        const comp = await forwardTool(rig.baseUrl, CONV, "compress", { startId: "m00005", endId: "m00060", summary: "Wrap-up of the early turns: setup, environment notes and the first exploration steps." }, undefined, true);
        assert.equal(comp.failed, false, `compress must land in the owning lane, got: ${comp.text.slice(0, 300)}`);
        // The fatal ghost error reads "...is above this session's highest allocated ref ...";
        // the benign no-op receipt ALSO contains "highest allocated ref" ("Session highest
        // allocated ref is mNNNNN — target older ranges only"), so match the fatal shape only.
        assert.ok(!comp.text.includes("is above this session"), "no ghost 'above highest allocated ref' error");
        assert.ok(!comp.text.includes("Total compressible content too small"), "no ghost 'too small' error");
        assert.equal(peekSession(forkB)!.state.blocks.length, 1, "the fold landed in the owning lane (one block minted there)");
    } finally {
        await stopRig(rig);
    }
});

test("#5582 witness-conflict rescue: a stale lineage witness doesn't block routing to the ref holder", async () => {
    const rig = await startRig();
    const CONV = "dshc-witness-conflict";
    try {
        const { forkB } = await buildStubParentPathology(rig, CONV);
        // A second deep lane under the same base id: every session mints its
        // OWN ref space from m00001, so its byRef also holds m00005/m00060 —
        // sharp-tier overlap. The outbound witness names THIS lane, but it is
        // idle past the lineage freshness window, so the #2601 lineage follow
        // refuses it and only the #5582 evidence rescue can route the call.
        const FORK_C = forkKey(CONV, SYSTEM_C);
        await dshTurn(rig, CONV, SYSTEM_C, msgs(64, "witness"));
        const forkC = peekSession(FORK_C);
        assert.ok(forkC, "the second persona forked onto its own |sub:");
        forkC!.lastSeen = Date.now() - 11 * 60 * 1000; // stale for personaLineageWitness
        const compArgs = { startId: "m00005", endId: "m00060", summary: "Wrap-up of the early turns: setup, environment notes and the first exploration steps." };
        recordToolWitness(FORK_C, "compress", compArgs);
        const comp = await forwardTool(rig.baseUrl, CONV, "compress", compArgs, undefined, true);
        assert.equal(comp.failed, false, `compress must route despite the conflicting stale witness, got: ${comp.text.slice(0, 300)}`);
        // The witness bonus outranks freshness inside the sharp tier: the
        // exact call was minted in the witnessed lane, so it executes THERE
        // even though the fresh owner lane also holds every cited ref.
        assert.equal(peekSession(FORK_C)!.state.blocks.length, 1, "the fold executed in the witnessed lane");
        assert.equal(peekSession(forkB)!.state.blocks.length, 0, "the fresh owner lane was not followed instead");
    } finally {
        await stopRig(rig);
    }
});

test("#5582 overlap ambiguity: two forks both fresh — the deep one wins the ref-less follow", async () => {
    const rig = await startRig();
    const CONV = "dshc-overlap";
    try {
        const { forkB } = await buildStubParentPathology(rig, CONV);
        const FORK_C = forkKey(CONV, SYSTEM_C);
        // A small auxiliary persona conversation under the same base id
        // (~7 refs: below FOLLOW_MIN_DEPTH_REFS).
        await dshTurn(rig, CONV, SYSTEM_C, msgs(6, "auxc"));
        assert.ok(peekSession(FORK_C), "the aux conversation forked onto its own |sub:");
        const cache = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(cache.failed, false);
        assert.ok(cache.text.includes(forkB), "the deep main conversation wins over the shallow aux lane");
        assert.ok(!cache.text.includes(FORK_C), "the aux lane is not followed");
    } finally {
        await stopRig(rig);
    }
});

test("#5582 no false positive: a young REAL main-shaped conversation never follows a parallel fork", async () => {
    const rig = await startRig();
    const CONV = "dshc-young-real";
    try {
        // Root thread claims the raw key MAIN-SHAPED (6 cells) — a legitimate
        // young conversation, not a sidecar stub (frontier ~7 ≤ 8).
        await dshTurn(rig, CONV, SYSTEM_X, msgs(6, "real"));
        const FORK_Y = forkKey(CONV, SYSTEM_Y);
        await dshTurn(rig, CONV, SYSTEM_Y, msgs(40, "other"));
        assert.ok(peekSession(FORK_Y), "the discontinuous persona forked");
        const parent = peekSession(CONV);
        const forkY = peekSession(FORK_Y);
        const stubRefs = Object.keys(parent!.state.messageRefs?.byRef ?? {}).length;
        assert.ok(stubRefs <= 8, `precondition: young root holds ${stubRefs} refs`);
        // Make the parent ACTIVE past the fork's birth (synthetic timestamps,
        // the #2601 case-2 pattern): the birth-order follow dies, so only the
        // #5582 evidence path could move the call — and the orderIsMainShaped
        // veto must keep it on the real conversation.
        const base = Date.now();
        forkY!.createdAt = base - 30_000;
        parent!.lastSeen = base - 10_000;
        forkY!.lastSeen = base - 5_000;
        const cache = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(cache.failed, false);
        assert.ok(!cache.text.includes("|sub:"),
            "orderIsMainShaped veto: an active main-shaped parent stays put even below the stub threshold");
    } finally {
        await stopRig(rig);
    }
});

test("#5582 fail closed: a shallow claim with NO descendants stays on the raw key", async () => {
    const rig = await startRig();
    const CONV = "dshc-solo";
    try {
        await dshTurn(rig, CONV, SYSTEM_Z, msgs(1, "solo"));
        const cache = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(cache.failed, false);
        assert.ok(!cache.text.includes("|sub:"), "no descendants → no follow");
    } finally {
        await stopRig(rig);
    }
});

test("#5582 resolver flag: anchorRace marks a main-shaped arrival forking off a SHALLOW recording only", async () => {
    resetSessionOrderForTest();
    // Pathology shape: shallow tagged claim, then a main conversation under a
    // different persona → derived-persona WITH anchorRace.
    const r1 = resolveSessionOrder("race-id", msgs(1, "claim"), "tagA");
    assert.equal(r1.action, "claim");
    const r2 = resolveSessionOrder("race-id", msgs(6, "main"), "tagB");
    assert.equal(r2.action, "derived-persona");
    assert.equal(r2.anchorRace, true, "shallow recording + main-shaped arrival = sidecar race signature");
    // Negative: the recording is already main-shaped (legitimate root thread)
    // → a later disjoint persona still forks, but WITHOUT the race flag.
    resetSessionOrderForTest();
    const r3 = resolveSessionOrder("clean-id", msgs(6, "root"), "tagX");
    assert.equal(r3.action, "claim");
    const r4 = resolveSessionOrder("clean-id", msgs(6, "other"), "tagY");
    assert.equal(r4.action, "derived-persona");
    assert.notEqual(r4.anchorRace, true, "main-shaped recording is not a sidecar race");
});
