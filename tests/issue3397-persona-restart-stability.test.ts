// #3397: "压缩失败.新会话反而没事" — a long dsh session's compress calls keep
// failing ("every ref is unknown to this session") while brand-new sessions
// work fine. Two mechanisms, one symptom family (owner policy 2026-10-13):
//   F1 (root): the session-order resolver's recorded skeletons were PROCESS
//      MEMORY. Every proxy restart re-ran the cold-start race: whichever lane
//      arrived first under the host id — the main conversation or a tagged
//      shallow sidecar request (dsh's auto-review blob carries its own
//      system) — claimed the raw key, and the winner FLIPPED across restarts.
//      When the main conversation lost, all accumulated compression state
//      (refs/blocks) stayed under the key it lost; the resends cite refs that
//      exist only in the orphaned generation → compress fails forever, new
//      sessions untouched. Fix: persist the skeletons (session-order.json,
//      affinity-persist mechanics) so resolution is restart-stable.
//   F2: #2601's no-witness management-call follow picked the MOST RECENTLY
//      ACTIVE `|sub:` descendant. dsh's chatty sidecar persona fires every
//      few seconds while the owner conversation idles, so the follow chased
//      the sidecar's small ref space and died there. Fix: when the tool args
//      cite refs (`mNNNNN`), prefer a descendant whose minted ref space can
//      contain them; no citation / no fit → recency (pre-fix behavior).
// Part A pins F1 at the resolver level through the REAL persistence round
// trip (flush → simulated restart → hydrate). Part B pins F2 end-to-end
// through the proxy, mirroring the #2601 lineage rig.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Hermetic state dirs BEFORE importing the server modules (#7.2 / #2668).
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-3397-persona-"));
process.env.XDG_STATE_HOME = path.join(xdgRoot, "state");
process.env.XDG_CACHE_HOME = path.join(xdgRoot, "cache");
process.env.XDG_DATA_HOME = path.join(xdgRoot, "data");
process.env.XDG_CONFIG_HOME = path.join(xdgRoot, "config");

// Imported AFTER the XDG env above.
const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");
const { resetToolRingForTest } = await import("../src/tool-ring.ts");
const { _resetPluginStateForTest } = await import("../src/plugin.ts");
const { forwardTool } = await import("../src/agent/shared.ts");
const { resolveSessionOrder, resetSessionOrderForTest, orderSnapshot, applyOrderSnapshot } = await import("../src/session-resolve.ts");
const { flushOrderSkeletons, hydrateOrderSkeletons } = await import("../src/order-persist.ts");
const { stateDir } = await import("../src/paths.ts");

after(() => {
    delete process.env.XDG_STATE_HOME;
    delete process.env.XDG_CACHE_HOME;
    delete process.env.XDG_DATA_HOME;
    delete process.env.XDG_CONFIG_HOME;
});

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const long = (s: string): string => `${s}-` + "z".repeat(120);
/** Deep main-shaped history (≥3 turns incl. an assistant turn). */
const mainMsgs = (n: number, tag: string): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: long(`${tag}-${i + 1}`) }));
/** Shallow sidecar shape: one user message + its OWN system (dsh auto-review
 *  blob — self-carried persona text, no assistant turns yet). */
const blobMsgs = (tag: string): { role: string; content: string }[] =>
    [{ role: "user", content: long(`blob-${tag}`) }];

const SYS_MAIN = "You are Stronghold, the main coding agent.\nLane: primary.";
const SYS_BLOB = "Review policy: classify the risk of the pending tool call and answer briefly.";
const SYS_AUX = "Auxiliary summarizer: condense the transcript tail into three bullets.";

// ───────────────────── Part A: F1 — restart-stable resolution ─────────────────────

test("#3397 F1: main keeps its fork key across a restart after a tagged shallow sidecar claimed the raw id", () => {
    resetSessionOrderForTest();
    const id = "c-3397-s1";
    // Lifetime 1: the sidecar blob (tagged, shallow) arrives FIRST and claims
    // the virgin raw id; the main conversation then forks onto its lane.
    const claim = resolveSessionOrder(id, blobMsgs("l1"), SYS_BLOB);
    assert.deepEqual(claim, { key: id, action: "claim" }, "tagged first sight claims the raw id");
    const r1 = resolveSessionOrder(id, mainMsgs(6, "l1-main"), SYS_MAIN);
    assert.equal(r1.action, "derived-persona");
    const K = `${id}|sub:${fp16(SYS_MAIN)}`;
    assert.equal(r1.key, K, "main forks onto its stable persona lane");

    // Simulated restart: durable snapshot out, in-memory registry wiped,
    // snapshot back in — exactly the shutdown/boot wiring added by the fix.
    flushOrderSkeletons();
    resetSessionOrderForTest();
    hydrateOrderSkeletons();

    // Lifetime 2, RACE WINNER FLIPPED: the main conversation now arrives
    // first under the id. Pre-fix the cold registry let it CLAIM the raw key
    // (orphaning everything under K); post-fix the hydrated sidecar record
    // still sits under the raw id, so main forks onto the SAME lane K.
    const r2 = resolveSessionOrder(id, [...mainMsgs(6, "l1-main"), { role: "user", content: long("l1-main-7") }], SYS_MAIN);
    assert.equal(r2.key, K, "post-restart main lands on its PRE-restart key — no state orphaning");
    assert.equal(r2.action, "derived-persona");

    // Characterization of the pre-fix failure mode on a COLD registry
    // (no snapshot): main-first claims raw — the orphaning itself.
    resetSessionOrderForTest();
    const r3 = resolveSessionOrder(id, mainMsgs(6, "l1-cold"), SYS_MAIN);
    assert.equal(r3.key, id, "without the snapshot the race winner flips to main-on-raw (pre-fix behavior)");
    assert.equal(r3.action, "claim");
});

test("#3397 F1: aux lanes stay isolated across a restart (deep record keeps the blob off the raw key)", () => {
    resetSessionOrderForTest();
    const id = "c-3397-s2";
    // Lifetime 1: main claims raw FIRST (deep, tagged); the blob forks away.
    assert.equal(resolveSessionOrder(id, mainMsgs(6, "l2-main"), SYS_MAIN).action, "claim");
    const rb = resolveSessionOrder(id, blobMsgs("l2-blob"), SYS_AUX);
    const KB = `${id}|sub:${fp16(SYS_AUX)}`;
    assert.equal(rb.key, KB, "blob forks onto its own lane");
    assert.equal(rb.action, "derived-persona");

    flushOrderSkeletons();
    resetSessionOrderForTest();
    hydrateOrderSkeletons();

    // Lifetime 2: the blob arrives first. The hydrated DEEP main skeleton
    // makes headAligns false (recorded kinds[1]=assistant vs undefined), so
    // the blob cannot migrate the raw key — it returns to its own lane.
    const rb2 = resolveSessionOrder(id, blobMsgs("l2-blob"), SYS_AUX);
    assert.equal(rb2.key, KB, "post-restart blob keeps its lane — no raw-key theft");
    const rm2 = resolveSessionOrder(id, [...mainMsgs(6, "l2-main"), { role: "user", content: long("l2-main-7") }], SYS_MAIN);
    assert.equal(rm2.key, id, "main keeps the raw key");
    assert.equal(rm2.action, "continue");
});

test("#3397 F1: snapshot hygiene — newer lastSeen wins per id; corrupt file degrades to a warning", () => {
    resetSessionOrderForTest();
    const id = "c-3397-s3";
    resolveSessionOrder(id, mainMsgs(4, "l3-a"), SYS_MAIN);
    const snapA = orderSnapshot();
    assert.ok(snapA.some((e) => e.id === id), "snapshot captures the recorded skeleton");

    // Older duplicate loses, newer duplicate wins (fresher-lastSeen-wins merge).
    const stale = { ...snapA.find((e) => e.id === id)!, lastSeen: Date.now() - 10_000 };
    assert.equal(applyOrderSnapshot([stale]), 0, "an older record never overwrites a fresher one");
    const fresh = { ...snapA.find((e) => e.id === id)!, kinds: ["user"], frags: [], lastSeen: Date.now() + 10_000 };
    assert.equal(applyOrderSnapshot([fresh]), 1, "a newer record replaces the stored skeleton");

    // Corrupt file: hydrate must warn-and-continue, never throw.
    const file = path.join(stateDir(), "session-order.json");
    writeFileSync(file, "{ not json");
    assert.doesNotThrow(() => hydrateOrderSkeletons(), "corrupt snapshot degrades to an empty import");
    // A subsequent flush heals the file with valid content.
    flushOrderSkeletons();
    const healed = JSON.parse(readFileSync(file, "utf8")) as { version: number; entries: unknown[] };
    assert.equal(healed.version, 1, "flush rewrites a valid snapshot over the corrupt file");
    assert.ok(Array.isArray(healed.entries));
});

// ───────────────────── Part B: F2 — ref-fit routing e2e ─────────────────────

type Rig = { baseUrl: string; chatUrl: string; proxy: http.Server; relay: http.Server };

function startRelay(): http.Server {
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

async function dshTurn(rig: Rig, system: string, history: { role: string; content: string }[]): Promise<void> {
    const res = await fetch(rig.chatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "dshc-3397" },
        body: JSON.stringify({ model: "gpt-test", max_tokens: 64_000, messages: [{ role: "system", content: system }, ...history] }),
    });
    assert.equal(res.status, 200, "dsh turn must succeed");
    await res.json();
}

test("#3397 F2: among several live forks, cited refs route to the fork whose ref space holds them", async () => {
    const rig = await startRig();
    const CONV = "dshc-3397";
    const OWNER = `${CONV}|sub:${fp16(SYS_MAIN)}`;
    const CHATTY = `${CONV}|sub:${fp16(SYS_AUX)}`;
    try {
        // Raw key claimed by the short-lived parent generation, then two
        // legitimate persona forks: the OWNER (long history → high minted-ref
        // frontier) and the CHATTY sidecar (short history → small frontier,
        // but the most recently active — dsh's per-tool-call review persona).
        await dshTurn(rig, SYS_BLOB, mainMsgs(2, "parent"));
        await dshTurn(rig, SYS_MAIN, mainMsgs(40, "owner"));
        await dshTurn(rig, SYS_AUX, mainMsgs(3, "chatty"));

        // Control: NO refs cited → recency pick (pre-fix behavior, unchanged):
        // the chatty sidecar, being newest, is followed.
        resetToolRingForTest();
        const outCtrl = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(outCtrl.failed, false);
        assert.ok(outCtrl.text.includes(CHATTY), "uncited call keeps the recency fallback (chatty fork)");

        // Fit: args cite refs above the chatty fork's frontier → the follow
        // must land on the owner fork whose ref space can hold them. Pre-fix
        // this call chased CHATTY and died with "every ref is unknown".
        resetToolRingForTest();
        const outFit = await forwardTool(rig.baseUrl, CONV, "acp_cache", { topic: "wrap-up m00020-m00035" }, undefined, true);
        assert.equal(outFit.failed, false);
        assert.ok(outFit.text.includes(OWNER), "cited refs route to the fork whose minted ref space contains them");
        assert.ok(!outFit.text.includes(CHATTY), "the chatty fork is no longer chased when its ref space cannot hold the cited refs");
    } finally {
        await stopRig(rig);
    }
});
