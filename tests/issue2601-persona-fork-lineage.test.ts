// #2601: model-switch lineage. A model/provider switch mid-conversation can
// re-serialize the SAME history (thinking inlined vs structured block, tool
// ids re-minted, image placeholder appended/stripped) — byte-exact
// chainContinues then fails, resolvePersonaKey forks the main lane onto
// `<raw>|sub:<fp>`, and the host keeps stamping the RAW id on its management
// calls, so compression state strands on the frozen parent. Root fix, two
// layers:
//   A. prefix-affinity keeps a NORMALIZED tail fingerprint per chain (churn
//      keys dropped, role kept, content-length leaves only, placeholder
//      lines filtered) — chainContinues gets a second chance, so a
//      re-serialized model switch MIGRATES the anchor instead of forking;
//   B. when a fork still legitimately happens, host-stamped (nativeCaller)
//      management calls follow the live `|sub:` descendant — via their own
//      id or via a lineage witness in the conflict branch. Legacy callers
//      and foreign witnesses keep the #2016/#2024 rules exactly.
//
// #2989 dual-run: Part A's chainContinues rows pin src/prefix-affinity.ts,
// which is STILL production code (the anonymous-ladder machinery in
// server.ts) — they are not debt. The one row that pins the RETIRED ladder
// (resolvePersonaKey migrate on a re-serialized switch) keeps its
// characterization 瞄点 and gains a live twin through resolveSessionOrder
// with the parameters PRODUCTION passes (dsh stamps x-bili-plugin-model on
// every request — the twin supplies what handle.ts would supply). Since the
// #2815 wiring swap the persona lane itself is chain-free: v2 reaches the
// migrated raw key through order+fragments or header corroboration, not
// through the normalized chain second chance.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Hermetic state dirs BEFORE importing the server modules (#7.2 / #2668: on
// Node 22 without this, the shared prefix-affinity snapshot left by a
// previous run makes the continuing-history legs fork instead of match).
const xdgRoot = mkdtempSync(path.join(tmpdir(), "bc-e2e-2601-lineage-"));
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
const { prefixAffinity } = await import("../src/prefix-affinity.ts");
// retired-module pin: persona-anchor — characterization 瞄点 only; production
// routes through src/session-resolve.ts since #2815 (gate: scripts/check-test-import-graph.mjs).
const { resolvePersonaKey, personaAnchorOf, resetPersonaAnchorsForTest } = await import("../src/persona-anchor.ts");
const { resetSessionOrderForTest, resolveSessionOrder } = await import("../src/session-resolve.ts");
const { getSession, peekSession, _resetSessionsForTest } = await import("../src/session.ts");

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
const PLACEHOLDER = "(image omitted: model does not support images)";
const forkKey = (conv: string, system: string): string =>
    `${conv}|sub:${createHash("sha256").update(system, "utf8").digest("hex").slice(0, 16)}`;
/** Content-length string (≥32 chars post-normalization) so the normalized
 *  projection keeps the leaf, like real dsh turns. */
const long = (s: string): string => `${s}-` + "z".repeat(120);
const msgs = (n: number, tag: string): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: long(`${tag}-${i + 1}`) }));

// The same tail turn in two provider serializations: openai-flattened
// (reasoning_content field, tool id call_A) vs structured content blocks
// (thinking as a text part, re-minted id, image placeholder appended).
const OLD_FORM = [
    { role: "user", content: long("u1") },
    { role: "assistant", content: long("a1"), reasoning_content: long("think1") },
    { role: "user", content: long("u2") },
];
const RESERIALIZED = [
    { role: "user", content: [{ type: "text", text: long("u1") }] },
    {
        role: "assistant",
        id: "msg_2",
        content: [
            { type: "text", text: long("a1") },
            { type: "text", text: long("think1") },
            { type: "text", text: PLACEHOLDER },
        ],
    },
    { role: "user", content: [{ type: "text", text: long("u2") }] },
];

// ───────────────────── Part A: normalized chain continuity ─────────────────────

test("#2601 unit: chainContinues survives provider re-serialization (normalized tail second chance)", () => {
    // #2989: prefix-affinity-only test — hygiene resets the LIVE registry
    // production consults (session-order), not the retired anchor ladder.
    resetSessionOrderForTest();
    _resetSessionsForTest();
    prefixAffinity.forget("u-2601-a");
    const fp = prefixAffinity.chainFingerprint(OLD_FORM as unknown[]);
    assert.ok(fp, "chain fingerprint exists");
    assert.ok(fp.normTailHash, "chainFingerprint captures a normalized tail hash for content-rich tails");
    prefixAffinity.note("u-2601-a", fp.depth, fp.tailHash, fp.itemHashes, true, undefined, undefined, fp.normTailHash);

    assert.equal(prefixAffinity.chainContinues(RESERIALIZED as unknown[], "u-2601-a"), true,
        "byte-exact hash differs, but the normalized projection of the same tail continues the chain");
});

test("#2601 unit: image placeholder appended to the TAIL projects equal (filter branch)", () => {
    // #2989: prefix-affinity-only test — live-registry hygiene (see above).
    resetSessionOrderForTest();
    _resetSessionsForTest();
    prefixAffinity.forget("u-2601-a2");
    // Same tail turn: the vision-capable replay keeps the image part's
    // placeholder line in the LAST message; the text-only replay drops it.
    // Without the USER_IMAGE_PLACEHOLDER filter the two tails carry different
    // leaf multisets and the second chance would miss the switch.
    const withPh = [
        { role: "user", content: long("t1") },
        { role: "assistant", content: [{ type: "text", text: long("a9") }] },
        { role: "user", content: [{ type: "text", text: PLACEHOLDER }, { type: "text", text: long("img-turn") }] },
    ];
    const withoutPh = [
        { role: "user", content: long("t1") },
        { role: "assistant", content: [{ type: "text", text: long("a9") }] },
        { role: "user", content: long("img-turn") },
    ];
    const fp = prefixAffinity.chainFingerprint(withPh as unknown[]);
    assert.ok(fp?.normTailHash, "tail carrying a placeholder line still yields a normalized fingerprint");
    prefixAffinity.note("u-2601-a2", fp!.depth, fp!.tailHash, fp!.itemHashes, true, undefined, undefined, fp!.normTailHash);
    assert.equal(prefixAffinity.chainContinues(withoutPh as unknown[], "u-2601-a2"), true,
        "placeholder-stripped replay continues the chain (projection filters the placeholder line)");
});

test("#2601 unit: normalized second chance is still content-gated — different tail or shorter history does not continue", () => {
    // #2989: prefix-affinity-only test — live-registry hygiene (see above).
    resetSessionOrderForTest();
    _resetSessionsForTest();
    prefixAffinity.forget("u-2601-b");
    const fp = prefixAffinity.chainFingerprint(OLD_FORM as unknown[]);
    assert.ok(fp, "chain fingerprint exists");
    prefixAffinity.note("u-2601-b", fp.depth, fp.tailHash, fp.itemHashes, true, undefined, undefined, fp.normTailHash);

    const different = [...RESERIALIZED.slice(0, 2), { role: "user", content: [{ type: "text", text: long("OTHER") }] }];
    assert.equal(prefixAffinity.chainContinues(different as unknown[], "u-2601-b"), false,
        "same shape churn but different content must NOT continue (no false adoption)");

    const truncated = RESERIALIZED.slice(0, 2);
    assert.equal(prefixAffinity.chainContinues(truncated as unknown[], "u-2601-b"), false,
        "a shorter history never continues, even when its tail projects equal (#2668 poison discipline)");
});

test("#2601 unit: resolvePersonaKey migrates (not forks) a re-serialized model switch", () => {
    resetPersonaAnchorsForTest();
    _resetSessionsForTest();
    prefixAffinity.forget("u-2601-c");
    const chainA = [...OLD_FORM] as unknown[];
    const fpA = prefixAffinity.chainFingerprint(chainA);
    assert.ok(fpA, "chain fingerprint exists");
    assert.deepEqual(resolvePersonaKey("u-2601-c", SYSTEM_A, chainA), { key: "u-2601-c", action: "claim" });
    // handle.ts notes the identified chain (with the #2601 normalized tail)
    // when the session records its fingerprint — mirror that here.
    prefixAffinity.note("u-2601-c", fpA.depth, fpA.tailHash, fpA.itemHashes, true, undefined, undefined, fpA.normTailHash);

    // Model switch: new system + the SAME history re-serialized by another
    // provider. Pre-#2601: fork (compression state stranded, #2601). Post: migrate.
    const switched = [...RESERIALIZED, { role: "user", content: [{ type: "text", text: long("next") }] }] as unknown[];
    assert.deepEqual(resolvePersonaKey("u-2601-c", SYSTEM_B, switched), { key: "u-2601-c", action: "migrate" },
        "a model switch whose history continues under the normalized fingerprint migrates the anchor");
    const fpB = createHash("sha256").update(SYSTEM_B, "utf8").digest("hex").slice(0, 16);
    assert.equal(personaAnchorOf("u-2601-c"), fpB, "the anchor moved to the new system");
    assert.equal(peekSession(forkKey("u-2601-c", SYSTEM_B)), undefined, "no `|sub:` session was minted");
});

// #2989 live twin: the SAME re-serialized corpus through the wired resolver.
// The old row needed prefix-affinity's normalized-tail second chance; v2's
// persona lane never consults chains — it rides raw on order+fragment
// evidence when the projection agrees, and on the two host declarations
// (id + x-bili-plugin-model) when they corroborate. dsh stamps the model
// header on every request, so the twin supplies declaredModel exactly as
// handle.ts would (pluginReportedModel).
test("#2601 live twin: a re-serialized model switch rides the RAW key through resolveSessionOrder", () => {
    resetSessionOrderForTest();
    _resetSessionsForTest();
    const id = "u-twin-2601";
    const chainA = [...OLD_FORM] as unknown[];
    assert.equal(resolveSessionOrder(id, chainA, SYSTEM_A, "glm-4.6").action, "claim");
    const switched = [...RESERIALIZED, { role: "user", content: [{ type: "text", text: long("next") }] }] as unknown[];
    const res = resolveSessionOrder(id, switched, SYSTEM_B, "glm-5.3");
    assert.equal(res.key, id, "the re-serialized switch keeps the raw key — no fork lane minted");
    assert.equal(res.action, "reanchor");
    // The #2791 projection is built so a provider re-serialization
    // fragments EQUAL (reasoning inline or not, placeholder filtered) —
    // this shape therefore rides raw through the CONTINUATION branch on
    // order+fragment evidence alone; pin that branch precisely.
    assert.match(res.reason ?? "", /#2241\/#2250/);
    assert.equal(peekSession(forkKey(id, SYSTEM_B)), undefined, "no `|sub:` session was minted");

    // Control: the SAME re-serialized prefix with a GENUINELY different tail
    // (not a re-encoding) must not ride raw when nothing corroborates it —
    // the fragment guard rails stay load-bearing (#150 subagent-replay
    // direction: same id, same shape, different conversation).
    resetSessionOrderForTest();
    _resetSessionsForTest();
    const id2 = "u-twin-2601-control";
    resolveSessionOrder(id2, [...OLD_FORM] as unknown[], SYSTEM_A);
    const foreignTail = [...RESERIALIZED.slice(0, 2), { role: "user", content: [{ type: "text", text: long("OTHER-CONVERSATION") }] }] as unknown[];
    const resCtrl = resolveSessionOrder(id2, foreignTail, SYSTEM_B);
    assert.equal(resCtrl.key, forkKey(id2, SYSTEM_B), "unproven switch under a changed persona forks onto its lane");
    assert.equal(resCtrl.action, "derived-persona");
});

test("#2601 unit: affinity snapshot round-trips normTailHash (a restart keeps the second chance)", () => {
    // #2989: prefix-affinity-only test — live-registry hygiene (see above).
    resetSessionOrderForTest();
    _resetSessionsForTest();
    prefixAffinity.forget("u-2601-d");
    const fp = prefixAffinity.chainFingerprint(OLD_FORM as unknown[]);
    assert.ok(fp, "chain fingerprint exists");
    prefixAffinity.note("u-2601-d", fp.depth, fp.tailHash, fp.itemHashes, true, undefined, undefined, fp.normTailHash);
    const snap = prefixAffinity.exportSnapshot();
    const entry = snap.find((e) => e.sessionId === "u-2601-d");
    assert.ok(entry?.normTailHash, "exported snapshot carries normTailHash");

    prefixAffinity.forget("u-2601-d");
    assert.equal(prefixAffinity.chainContinues(RESERIALIZED as unknown[], "u-2601-d"), false,
        "after forget the second chance is gone (control)");
    const imported = prefixAffinity.importSnapshot(snap);
    assert.ok(imported >= 1, "snapshot imports");
    assert.equal(prefixAffinity.chainContinues(RESERIALIZED as unknown[], "u-2601-d"), true,
        "the imported chain keeps matching re-serialized continuations");
});

// ───────────────────── Part B: e2e lineage follow through the real proxy ─────────────────────

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
    // #2989: the e2e path runs through the LIVE session-order resolver — its
    // registry is what must be cleared between rigs (the retired anchor
    // ladder is no longer on this path).
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
        headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "dshc-2601" },
        body: JSON.stringify({ model: "gpt-test", max_tokens: 64_000, messages: [{ role: "system", content: system }, ...history] }),
    });
    assert.equal(res.status, 200, "dsh turn must succeed");
    await res.json();
}

test("#2601 e2e: a legitimately-forked persona — host-stamped tools follow the live lineage; legacy/fail-closed rules unchanged", async () => {
    const rig = await startRig();
    const CONV = "dshc-2601";
    const FORK = forkKey(CONV, SYSTEM_B);
    try {
        // Model A claims the raw key; a /model switch with a DISCONTINUOUS
        // history legitimately forks (system B + unrelated content).
        await dshTurn(rig, SYSTEM_A, msgs(6, "main"));
        assert.ok(getSession(CONV), "main session exists under the raw key");
        await dshTurn(rig, SYSTEM_B, msgs(3, "switched"));
        const fork = peekSession(FORK);
        assert.ok(fork, "the discontinuous switched turn forked onto |sub:");
        assert.equal(fork.stats.requests, 1, "the fork served its turn");

        // (1) The incident shape: the host keeps stamping the RAW id on its
        // management call while the live lane is the fork. Flagged callers
        // must follow the live descendant (#2601), not strand on the parent.
        const out1 = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(out1.failed, false);
        assert.ok(out1.text.includes(FORK), "a host-stamped call naming the stale parent is served from the live fork");
        assert.ok(out1.text.includes("|sub:"), "the served deep link points at the forked session");

        // (2) Legacy (unflagged) caller, no witness: unchanged — served by the
        // session it named (the parent). The lineage follow is nativeCaller-gated.
        resetToolRingForTest();
        const r2 = await fetch(`${rig.baseUrl}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tool: "acp_cache", args: {}, conversationId: CONV }),
        });
        assert.equal(r2.status, 200);
        const j2 = (await r2.json()) as { result?: string };
        assert.ok(!j2.result?.includes("|sub:"), "unflagged callers keep legacy routing (parent)");

        // (3) Unflagged caller vs a fresh unique LINEAGE witness: still fails
        // closed 409 (#2016) — the lineage rescue is not a witness backdoor.
        resetToolRingForTest();
        recordToolWitness(FORK, "acp_cache", {});
        const r3 = await fetch(`${rig.baseUrl}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ tool: "acp_cache", args: {}, conversationId: CONV }),
        });
        assert.equal(r3.status, 409, "unflagged resolvable-id conflict stays fail-closed");
        assert.equal(((await r3.json()) as { code?: string }).code, "TOOL_CONVERSATION_CONFLICT");

        // (4) Flagged caller with that same lineage witness conflict → the
        // witness is followed (it names the same live fork).
        const out4 = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(out4.failed, false);
        assert.ok(out4.text.includes(FORK), "a lineage witness resolves the conflict for host-stamped callers");

        // (5) Flagged caller vs a FOREIGN witness: #2024 native-honor is
        // unchanged — the caller's own (parent) session serves it.
        resetToolRingForTest();
        recordToolWitness("unrelated-2601", "acp_cache", {});
        const out5 = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(out5.failed, false);
        assert.ok(!out5.text.includes("|sub:"), "a foreign witness never drags a native caller off its lineage");
        assert.ok(!out5.text.includes("unrelated-2601"), "the foreign witness's state does not leak");

        // (6) Switch back: system A + history CONTINUING the original chain →
        // migrate back to the raw key (byte-exact), the parent becomes the
        // live lane again, and the same host-stamped call self-heals home.
        resetToolRingForTest();
        await dshTurn(rig, SYSTEM_A, [...msgs(6, "main"), { role: "user", content: long("back-on-a") }]);
        assert.equal(getSession(CONV).stats.requests, 2, "the switch-back turn rode the RAW key");
        const out6 = await forwardTool(rig.baseUrl, CONV, "acp_cache", {}, undefined, true);
        assert.equal(out6.failed, false);
        assert.ok(!out6.text.includes("|sub:"), "once the parent is the live lane again, routing goes home");
    } finally {
        await stopRig(rig);
    }
});
