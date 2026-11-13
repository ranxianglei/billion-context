// #2241: continuity-aware dsh persona anchor. The original fingerprint
// (db21309d) forked on ANY system-text change under the id — built on the
// assumption that dsh composes its main system once per session. `/model`
// breaks that assumption: dsh rebuilds the main system per model, so every
// model switch forked the MAIN lane off the raw key while the host kept
// stamping the bare id — compression then hit a frozen 7-message husk
// forever (#2241). The fix swaps the fork trigger for prefix-affinity
// semantics (#1106/#1148: content is identity): a system change whose
// history BYTE-EXACTLY CONTINUES the raw key's chain migrates the anchor
// (same conversation — compression state stays); a history-discontinuous
// MAIN-LANE request still forks onto `<id>|sub:<fp>`. (The auto-review
// blob itself no longer reaches this resolver: since #4438 it rides the
// stateless side passthrough.)
//
// #2989 dual-run: since the #2815 wiring swap the PRODUCTION path is
// src/session-resolve.ts (order+id claim, fragment guard rails) — the
// e2e rigs below already exercise it through startServer. The unit block
// pins the RETIRED ladder as a characterization 瞄点; its live twin runs
// the SAME corpus through resolveSessionOrder and shares one key
// expectation wherever the two agree (they do on every row here — the
// designed differences are action vocabulary and evidence source: v2
// reaches the migrated raw key through order+head-fragments, not through
// prefix-affinity chains).

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { prefixAffinity } from "../src/prefix-affinity.ts";
// retired-module pin: persona-anchor — characterization 瞄点 only; production
// routes through src/session-resolve.ts since #2815 (gate: scripts/check-test-import-graph.mjs).
import { personaAnchorOf, resolvePersonaKey, resetPersonaAnchorsForTest } from "../src/persona-anchor.ts";
import { resetSessionOrderForTest, resolveSessionOrder } from "../src/session-resolve.ts";
import { _rememberedForTest, _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, peekSession, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

// Hermetic state dirs (#7.2: no environmental luck). Without these, each rig
// hydrates the shared prefix-affinity snapshot left by the PREVIOUS run of
// this file — whose deeper dshc-* chains make chainContinues reject the
// shorter replay and fork instead of migrate, failing the second run while
// the first (and CI, fresh container) passes.
const testRoot = mkdtempSync(join(tmpdir(), "bili-dsh-cont-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const MODEL = "claude-sonnet-4-5";
const SYSTEM_A = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-A.\nWorkspace: /tmp.";
const SYSTEM_B = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-B.\nWorkspace: /tmp.";
const REVIEW_SYSTEM = "You are the final authorization reviewer for exactly one pending tool call.\nAnswer with one word.";

const forkKey = (conv: string, system: string): string =>
    `${conv}|sub:${createHash("sha256").update(system, "utf8").digest("hex").slice(0, 16)}`;

const msgs = (n: number, tag = "main"): { role: string; content: string }[] =>
    Array.from({ length: n }, (_, i): { role: string; content: string } => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `${tag}-${i + 1}-` + "z".repeat(6000),
    }));

// ---------------------------------------------------------------------------
// Unit: the resolver state machine against a hand-noted affinity chain.
// ---------------------------------------------------------------------------
test("resolvePersonaKey: claim → match → migrate (continuing history) → fork (discontinuous)", () => {
    resetPersonaAnchorsForTest();
    prefixAffinity.forget("unit-conv");
    const chain = msgs(6, "u");
    const fp0 = prefixAffinity.chainFingerprint(chain);
    assert.ok(fp0, "chain fingerprint exists");
    prefixAffinity.note("unit-conv", fp0.depth, fp0.tailHash, fp0.itemHashes, true);

    const idA = createHash("sha256").update(SYSTEM_A, "utf8").digest("hex").slice(0, 16);
    const idB = createHash("sha256").update(SYSTEM_B, "utf8").digest("hex").slice(0, 16);

    // first arrival claims
    assert.deepEqual(resolvePersonaKey("unit-conv", SYSTEM_A, chain), { key: "unit-conv", action: "claim" });
    assert.equal(personaAnchorOf("unit-conv"), idA);
    // same system keeps the raw key
    assert.deepEqual(resolvePersonaKey("unit-conv", SYSTEM_A, chain), { key: "unit-conv", action: "match" });
    // empty system is non-anchoring passthrough (kernel semantics)
    assert.deepEqual(resolvePersonaKey("unit-conv", "", chain), { key: "unit-conv", action: "passthrough" });
    assert.equal(personaAnchorOf("unit-conv"), idA, "passthrough does not touch the anchor");
    // model switch: same conversation, one new turn — history CONTINUES the
    // chain → migrate, raw key, compression state stays (#2241)
    const extended = [...chain, { role: "user", content: "u-new-" + "z".repeat(64) }];
    assert.deepEqual(resolvePersonaKey("unit-conv", SYSTEM_B, extended), { key: "unit-conv", action: "migrate" });
    assert.equal(personaAnchorOf("unit-conv"), idB, "anchor migrated to the new system fingerprint");
    // a review-shaped request (single fresh blob) does NOT continue the chain → fork
    const reviewList = [{ role: "user", content: "Conversation transcript (flattened):\nuser: build it\nDecide: risky?" }];
    assert.deepEqual(resolvePersonaKey("unit-conv", REVIEW_SYSTEM, reviewList), {
        key: forkKey("unit-conv", REVIEW_SYSTEM),
        action: "fork",
    });
    assert.equal(personaAnchorOf("unit-conv"), idB, "a fork never moves the raw anchor");
    // after migration the OLD system is now the stranger: a diverged tail
    // under SYSTEM_A does not continue the migrated chain → fork (conservative)
    const diverged = chain.map((m, i) => (i === chain.length - 1 ? { ...m, content: "rewritten-tail-" + "z".repeat(64) } : m));
    assert.equal(resolvePersonaKey("unit-conv", SYSTEM_A, diverged).action, "fork");
    // but a byte-exact replay at equal depth under the OLD system after the
    // chain was re-noted at the longer depth is not a continuation either
    // (the tracked chain moved past it) — replaying the SAME depth continues.
    const reNoted = prefixAffinity.chainFingerprint(extended);
    assert.ok(reNoted);
    prefixAffinity.note("unit-conv", reNoted.depth, reNoted.tailHash, reNoted.itemHashes, true);
    assert.equal(resolvePersonaKey("unit-conv", SYSTEM_A, extended).action, "migrate", "equal-depth byte-exact replay continues the chain");
});

// #2989 live twin: the SAME corpus through the wired resolver (what
// handle.ts calls since #2815). Every row shares one KEY expectation with
// the retired-ladder block above; the designed differences are action
// vocabulary (claim/match/migrate/fork → claim/continue/reanchor/
// derived-persona) and evidence source (v2: order + head fragments, not
// prefix-affinity chains — the persona lane is chain-free).
test("live twin: same corpus through resolveSessionOrder — every row lands on the same key", () => {
    resetSessionOrderForTest();
    const chain = msgs(6, "u");

    // first arrival claims (shared key)
    assert.deepEqual({ key: resolveSessionOrder("unit-twin", chain, SYSTEM_A).key }, { key: "unit-twin" });
    // same system keeps the raw key (old: match → new: continue)
    assert.equal(resolveSessionOrder("unit-twin", chain, SYSTEM_A).key, "unit-twin");
    // empty tag is non-anchoring at the library level too (shared key). In
    // PRODUCTION an empty system never reaches the resolver — handle.ts
    // routes it verbatim upstream of this call (see the anthropic/openai
    // personaSystemText === "" branches) — so the retired ladder's
    // passthrough action has no wired counterpart to pin here.
    assert.equal(resolveSessionOrder("unit-twin", chain, "").key, "unit-twin");
    // model switch on a CONTINUING history → raw key (old: migrate via
    // chainContinues; new: reanchor via order+head-fragments — shared key)
    const extended = [...chain, { role: "user", content: "u-new-" + "z".repeat(64) }];
    const migrated = resolveSessionOrder("unit-twin", extended, SYSTEM_B);
    assert.equal(migrated.key, "unit-twin");
    assert.equal(migrated.action, "reanchor");
    // a review-shaped request does NOT continue → fork onto its own lane
    // (SHARED key: both implementations mint |sub:<sha256(tag)[0..16]>)
    const reviewList = [{ role: "user", content: "Conversation transcript (flattened):\nuser: build it\nDecide: risky?" }];
    const forkRes = resolveSessionOrder("unit-twin", reviewList, REVIEW_SYSTEM);
    assert.equal(forkRes.key, forkKey("unit-twin", REVIEW_SYSTEM));
    assert.equal(forkRes.action, "derived-persona");
    // a diverged tail under the OLD system after the migration forks in BOTH
    // (old: conservative chain break; new: no head-fragment evidence) —
    // shared key, different fork lane from the review's
    const diverged = chain.map((m, i) => (i === chain.length - 1 ? { ...m, content: "rewritten-tail-" + "z".repeat(64) } : m));
    const divRes = resolveSessionOrder("unit-twin", diverged, SYSTEM_A);
    assert.equal(divRes.key, forkKey("unit-twin", SYSTEM_A));
    assert.notEqual(divRes.key, forkRes.key, "distinct personas get distinct lanes");
    // byte-exact replay of the migrated history under the OLD system: the
    // recorded skeleton IS that history (tag B), so order+fragments prove
    // continuation → raw again (old: migrate via equal-depth chain replay;
    // SHARED key)
    assert.equal(resolveSessionOrder("unit-twin", extended, SYSTEM_A).key, "unit-twin");
});

// ---------------------------------------------------------------------------
// e2e rigs (openai + anthropic lanes), mirroring dsh-persona-fingerprint.
// ---------------------------------------------------------------------------
type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server };

async function startRig(): Promise<Rig> {
    const upstream = http.createServer((req, res) => {
        let b = "";
        req.on("data", (c: Buffer) => (b += c.toString("utf8")));
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "chatcmpl-1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
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
    // #2989: live-module hygiene — the e2e path resolves through
    // session-resolve; the retired anchor map is no longer on it.
    resetSessionOrderForTest();
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
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
    return { proxyPort: (proxy.address() as { port: number }).port, upstreamPort, proxy, upstream };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

test("e2e openai lane #2241/#4438: model switch keeps the raw key (anchor migration); review rides stateless passthrough; switch back migrates again", async () => {
    const rig = await startRig();
    const CONV = "dshc-openai";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        const tools = [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: {} } } }];

        // Model A main turn (12 messages) claims the raw key.
        const r1 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools, messages: [{ role: "system", content: SYSTEM_A }, ...msgs(12)] }),
        });
        await r1.text();
        const main = getSession(CONV);
        assert.ok(main, "main session exists under the raw key");
        const refsA = Object.keys(main.state.messageRefs.byRaw).length;
        assert.ok(refsA >= 12, "refs assigned to the main history");

        // /model switch: SAME conversation replayed + one new turn, new system.
        // Pre-fix behavior: fork onto `|sub:` (compression lost, #2241).
        // Post-fix: history continues the raw chain → anchor migrates → raw key.
        const switched = [...msgs(12), { role: "user", content: "after the switch-" + "z".repeat(64) }];
        const r2 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools, messages: [{ role: "system", content: SYSTEM_B }, ...switched] }),
        });
        await r2.text();
        assert.equal(getSession(CONV).stats.requests, 2, "switched turn keeps riding the RAW key");
        assert.equal(peekSession(forkKey(CONV, SYSTEM_B)), undefined, "no `|sub:` session was minted for the main lane");
        assert.ok(Object.keys(getSession(CONV).state.messageRefs.byRaw).length > refsA, "refs keep accumulating on the same session (compression state preserved)");
        assert.ok((_rememberedForTest().get(CONV)?.processed.length ?? 0) >= 13, "remembered snapshot tracks the switched history");

        // A review request under the SAME id rides the stateless side
        // passthrough (#4438 supersedes the #2241-era fork): nothing minted,
        // main session byte-for-byte untouched.
        const refsBeforeReview = Object.keys(getSession(CONV).state.messageRefs.byRaw).length;
        const r3 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 384_000,
                messages: [
                    { role: "system", content: REVIEW_SYSTEM },
                    { role: "user", content: "Conversation transcript (flattened):\nuser: build it\nDecide: risky?" },
                ],
            }),
        });
        assert.equal(r3.status, 200, "the review forwarded through the side passthrough");
        await r3.text();
        assert.equal(peekSession(forkKey(CONV, REVIEW_SYSTEM)), undefined, "review request minted NO forked session (#4438 stateless passthrough)");
        assert.equal(getSession(CONV).stats.requests, 2, "main session untouched by the review");
        assert.equal(Object.keys(getSession(CONV).state.messageRefs.byRaw).length, refsBeforeReview, "main refs untouched by the review");

        // Switch BACK to model A (history continues) → migrate again, raw key.
        const back = [...switched, { role: "user", content: "back on A-" + "z".repeat(64) }];
        const r4 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools, messages: [{ role: "system", content: SYSTEM_A }, ...back] }),
        });
        await r4.text();
        assert.equal(getSession(CONV).stats.requests, 3, "switch-back turn also keeps the raw key");
        assert.equal(peekSession(forkKey(CONV, SYSTEM_A)), undefined, "no fork session for the main lane on switch-back either");

        // A diverged replay under a THIRD system (tail rewritten, not a
        // continuation) still forks — conservative by design.
        const diverged = msgs(12).map((m, i) => (i === 11 ? { ...m, content: "rewritten-" + "z".repeat(64) } : m));
        const r5 = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ model: MODEL, max_tokens: 64_000, tools, messages: [{ role: "system", content: SYSTEM_B }, ...diverged] }),
        });
        await r5.text();
        assert.equal(getSession(CONV).stats.requests, 3, "diverged history did NOT ride the raw key");
        assert.ok(peekSession(forkKey(CONV, SYSTEM_B)), "diverged + system change forks (conservative)");
    } finally {
        await closeRig(rig);
    }
});

test("e2e anthropic lane #2241: the same anchor migration applies to dsh-over-anthropic", async () => {
    const rig = await startRig();
    const CONV = "dshc-anthropic";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        const turn = (system: string, n: number, tag = "main") => ({
            model: MODEL,
            max_tokens: 64_000,
            system: [{ type: "text", text: system }],
            messages: msgs(n, tag),
        });
        const r1 = await fetch(url, { method: "POST", headers, body: JSON.stringify(turn(SYSTEM_A, 8)) });
        await r1.text();
        assert.ok(getSession(CONV), "main session exists under the raw key (anthropic)");

        const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify(turn(SYSTEM_B, 9)) });
        await r2.text();
        assert.equal(getSession(CONV).stats.requests, 2, "model switch keeps the raw key on the anthropic lane");
        assert.equal(peekSession(forkKey(CONV, SYSTEM_B)), undefined, "no fork session minted");
    } finally {
        await closeRig(rig);
    }
});
