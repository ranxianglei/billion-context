// #4778: dsh goal auto-continuation forks the MAIN conversation onto an
// empty `|sub:` lane. DSH NEXT stamps a DIFFERENT system prompt on every
// turn, and on a goal continuation its log rewrite materializes the prior
// turns' system prompts as persisted EMPTY entries that ride along in every
// later resend. The mid-history rewrite breaks BOTH tag-change migration
// rungs (head fragments, byte-exact chain) while the persona tag keeps
// drifting, so the whole main conversation was re-keyed onto `<id>|sub:<fp>`
// — orphaning the root lane's fold state and forcing a multi-million-token
// preflight on every request until a restart minted yet another lane.
//
// Fix (src/session-resolve.ts): a third tag-change rung — when the recorded
// body still sits verbatim inside the incoming (≥ CONTINUATION_MIN_RUN
// consecutive same-index content-cell fragment agreements, harness-state
// cells excluded from both sequences before alignment) AND the incoming
// extends past the recorded, the anchor migrates instead of forking.
//
// Gate discipline (#3617): the bug shape migrates, and EACH guardrail leg
// (overlap, length, mainShaped, threshold) keeps its designed fork alive.

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
import { orderSkeletonOf, resetSessionOrderForTest, resolveSessionOrder, sessionOrderSkeletonOf } from "../src/session-resolve.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession, peekSession, _resetSessionsForTest } from "../src/session.ts";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST = "0";

// Hermetic state dirs (#7.2: no environmental luck) — a shared prefix-
// affinity snapshot from another run would noise the chain rung.
const testRoot = mkdtempSync(join(tmpdir(), "bili-4778-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

type M = {
    role: string;
    content?: string | null;
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
    tool_call_id?: string;
};
const fp16 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const forkKey = (id: string, tag: string): string => `${id}|sub:${fp16(tag)}`;

/** Persona tag as handle.ts computes it on the openai lane: every non-empty
 *  system text joined "\n\n" (openaiSystemTextForPersona). */
const tagOf = (history: M[]): string =>
    history.filter((m) => m.role === "system" && typeof m.content === "string" && m.content !== "").map((m) => m.content as string).join("\n\n");

/** One persisted coding turn: user → tool call → tool result → final
 *  answer (four projected cells, unambiguously main-shaped). The per-turn
 *  system entry is HOST bookkeeping — absent until the goal rewrite below. */
const turn = (i: number, label: string): M[] => {
    const callId = `call-${label}-${i}`;
    return [
        { role: "user", content: `${label}-u${i}-` + "u".repeat(120) },
        { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: `${label}-cmd-${i}` }) } }] },
        { role: "tool", tool_call_id: callId, content: `${label}-out-${i}-` + "o".repeat(120) },
        { role: "assistant", content: `${label}-a${i}-` + "a".repeat(120) },
    ];
};

/** One wire request: the CURRENT leading system prompt + the persisted
 *  transcript + the current turn's user prompt. */
const request = (currentSys: string, tail: M[]): M[] => [
    { role: "system", content: currentSys },
    ...tail,
];

/** The goal rewrite: every prior turn gains its (now EMPTY) system entry. */
const withClearedSystems = (perTurn: M[][]): M[] =>
    perTurn.flatMap((t) => [{ role: "system", content: "" }, ...t]);

const plain = (n: number, label: string): M[] =>
    Array.from({ length: n }, (_, i): M => ({ role: i % 2 === 0 ? "user" : "assistant", content: `${label}-${i + 1}-` + "x".repeat(120) }));

// ---------------------------------------------------------------------------
// Unit: the resolver state machine against the issue's exact topology.
// ---------------------------------------------------------------------------
test("#4778 regression: goal continuation (cleared mid-history systems + per-turn system drift) keeps the RAW key", () => {
    resetSessionOrderForTest();
    const id = "sess-4778-goal";
    // Turns 0..4 settle on the raw key — per-turn system drift rides the
    // pre-existing head-fragment rung (the session's lifetime steady state:
    // append-only transcript, drifting leading system).
    const done: M[][] = [];
    let transcript: M[] = [];
    for (let i = 0; i < 5; i++) {
        const t = turn(i, "main");
        const req = request(`sys-prompt-v${i}`, [...transcript, t[0]]);
        assert.equal(resolveSessionOrder(id, req, tagOf(req)).key, id, `turn ${i} lands on the raw key`);
        done.push(t);
        transcript = [...transcript, ...t];
    }
    // THE GOAL TURN: the log rewrite materializes the prior turns' system
    // prompts as persisted EMPTY entries (resent from here on) and appends
    // the continuation's user message under yet another system prompt.
    // Pre-fix this request returned `{ key: |sub:<fp>, action:
    // "derived-persona" }`.
    const goalUser: M = { role: "user", content: "continue the goal-" + "g".repeat(120) };
    const rewritten = withClearedSystems(done);
    const goalReq = request("sys-prompt-goal", [...rewritten, goalUser]);
    const goalRes = resolveSessionOrder(id, goalReq, tagOf(goalReq));
    assert.equal(goalRes.key, id, "goal turn keeps the RAW key");
    assert.equal(goalRes.action, "reanchor");
    assert.match(goalRes.reason ?? "", /#4778/);
    // The skeleton re-anchored to the host's living truth (empty system
    // entries included) so the next request resolves off the healed shape.
    assert.deepEqual(sessionOrderSkeletonOf(id), orderSkeletonOf(goalReq));

    // Steady state: the next turn appends under a fresh system prompt —
    // raw key again even though the goal turn's own (empty) system entry
    // shifted the raw index alignment.
    const goalAsst: M = { role: "assistant", content: "goal-answer-" + "a".repeat(120) };
    const afterGoal: M[] = [...rewritten, { role: "system", content: "" }, goalUser, goalAsst, ...turn(5, "main")];
    const nextReq = request("sys-prompt-v5", afterGoal);
    assert.equal(resolveSessionOrder(id, nextReq, tagOf(nextReq)).key, id, "post-goal turn keeps the raw key");
});

test("#4778 control: a self-contained stranger under the same id still forks (overlap gate)", () => {
    resetSessionOrderForTest();
    const id = "sess-4778-stranger";
    resolveSessionOrder(id, plain(8, "main"), "sys-A");
    const stranger = plain(10, "stranger");
    const res = resolveSessionOrder(id, stranger, "sys-B");
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, forkKey(id, "sys-B"));
});

test("#4778 control: a STALE shorter replay must not rewind the live skeleton (length gate)", () => {
    resetSessionOrderForTest();
    const id = "sess-4778-stale";
    resolveSessionOrder(id, plain(12, "main"), "sys-A");
    // Verbatim first ten cells (agreement run 10 ≥ 8) but the server holds
    // two NEWER turns — the replay is stale, not a continuation.
    const res = resolveSessionOrder(id, plain(12, "main").slice(0, 10), "sys-B");
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, forkKey(id, "sys-B"));
});

test("#4778 control: a shallow review blob with a different tag still forks (mainShaped gate)", () => {
    resetSessionOrderForTest();
    const id = "sess-4778-blob";
    resolveSessionOrder(id, plain(8, "main"), "sys-A");
    const blob: M[] = [{ role: "user", content: "Conversation transcript (flattened):\nuser: build it\nDecide: risky?" }];
    const res = resolveSessionOrder(id, blob, "review-policy");
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, forkKey(id, "review-policy"));
});

test("#4778 control: scattered agreement below the threshold stays a fork (threshold gate)", () => {
    resetSessionOrderForTest();
    const id = "sess-4778-thresh";
    resolveSessionOrder(id, plain(8, "main"), "sys-A");
    // Three middle cells rewritten: agreement runs of 2 and 3, both below
    // CONTINUATION_MIN_RUN — extended or not, this is not provably the
    // same conversation.
    const edited = plain(10, "main").map((m, i) => (i >= 2 && i <= 4 ? { ...m, content: `edited-${i}-` + "e".repeat(120) } : m));
    const res = resolveSessionOrder(id, edited, "sys-B");
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, forkKey(id, "sys-B"));
});

test("#4778: a full byte-exact resend under a drifted system migrates (interaction guard)", () => {
    resetSessionOrderForTest();
    const id = "sess-4778-resend";
    resolveSessionOrder(id, plain(10, "main"), "sys-A");
    const res = resolveSessionOrder(id, plain(10, "main"), "sys-B");
    assert.equal(res.key, id);
    assert.equal(res.action, "reanchor");
});

// ---------------------------------------------------------------------------
// Cross-wire provider switch (second #4778 trigger reported in-thread: a
// mid-session anthropic→openai provider switch re-keyed the conversation
// onto an empty `|sub:` lane). The two lanes feed the SAME resolver
// DIFFERENT WIRE SHAPES of the same logical transcript — the #2791
// wire-neutral projection (src/affinity-neutral.ts) exists precisely so the
// shapes project to identical turns. Pinned at resolver level:
//   T-A  clean re-render on the new wire          → head-fragment rung migrates
//   T-B  + per-turn system cells resent ONLY on the new wire
//        (dsh NEXT persists them in its log)      → the #4778 continuation
//                                                   rung migrates (red pre-fix)
//   T-D  + reasoning asymmetry (thinking rides the old wire only) → honest
//        fork: the identity hash stays byte-exact per cell; making it
//        think-blind is an owner decision (see #4778 checklist), not a
//        silent formula change here.
// ---------------------------------------------------------------------------

type Block = Record<string, unknown>;
type AM = { role: string; content?: string | null | Block[] };

/** One logical turn rendered on the ANTHROPIC wire (tool_use / tool_result
 *  blocks). `thinking` models a reasoning model whose thinking blocks ride
 *  the anthropic render only. */
const athTurn = (i: number, label: string, thinking: boolean): AM[] => {
    const cid = `cu-${label}-${i}`;
    return [
        { role: "user", content: `${label}-u${i}-` + "u".repeat(120) },
        { role: "assistant", content: [
            ...(thinking ? [{ type: "thinking", thinking: `${label}-think-${i}-` + "t".repeat(80) }] : []),
            { type: "tool_use", id: cid, name: "bash", input: { cmd: `${label}-cmd-${i}` } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: cid, content: `${label}-out-${i}-` + "o".repeat(120) }] },
        { role: "assistant", content: [
            ...(thinking ? [{ type: "thinking", thinking: `${label}-final-think-${i}-` + "t".repeat(80) }] : []),
            { type: "text", text: `${label}-a${i}-` + "a".repeat(120) },
        ] },
    ];
};

/** The SAME logical turn re-rendered on the OPENAI wire (no reasoning
 *  fields — the renderer-divergence shape documented in #2791). */
const oaiTurn = (i: number, label: string): M[] => {
    const cid = `cu-${label}-${i}`;
    return [
        { role: "user", content: `${label}-u${i}-` + "u".repeat(120) },
        { role: "assistant", content: null, tool_calls: [{ id: cid, type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: `${label}-cmd-${i}` }) } }] },
        { role: "tool", tool_call_id: cid, content: `${label}-out-${i}-` + "o".repeat(120) },
        { role: "assistant", content: `${label}-a${i}-` + "a".repeat(120) },
    ];
};

test("#4778 family: clean cross-wire provider switch (anthropic→openai) keeps the RAW key (head-fragment rung)", () => {
    resetSessionOrderForTest();
    const id = "sess-4778-xwire-clean";
    // Anthropic lane: the system prompt rides the TOP-LEVEL field (passed as
    // the tag argument, as handle.ts does with systemTextsForSplit), never
    // the messages array — so the recorded skeleton is pure conversation.
    let msgs: AM[] = [];
    for (let i = 0; i < 4; i++) {
        const t = athTurn(i, "main", false);
        assert.equal(resolveSessionOrder(id, [...msgs, t[0]], `ath-sys-v${i}`).key, id, `settle ${i} lands on the raw key`);
        msgs = [...msgs, ...t];
    }
    // THE SWITCH: the whole transcript re-rendered on the openai wire under
    // a new leading system + the continuation prompt.
    const switched: M[] = [
        { role: "system", content: "oai-sys-switch" },
        ...[0, 1, 2, 3].flatMap((i) => oaiTurn(i, "main")),
        { role: "user", content: "after the switch-" + "s".repeat(120) },
    ];
    const res = resolveSessionOrder(id, switched, tagOf(switched));
    assert.equal(res.key, id, "the switched request keeps the RAW key");
    assert.equal(res.action, "reanchor");
});

test("#4778 family: cross-wire switch WITH per-turn system cells resent only on the new wire keeps the RAW key (continuation rung)", () => {
    resetSessionOrderForTest();
    const id = "sess-4778-xwire-midsys";
    let msgs: AM[] = [];
    for (let i = 0; i < 4; i++) {
        const t = athTurn(i, "main", false);
        assert.equal(resolveSessionOrder(id, [...msgs, t[0]], `ath-sys-v${i}`).key, id, `settle ${i} lands on the raw key`);
        msgs = [...msgs, ...t];
    }
    // dsh NEXT persists its per-turn system prompts in its OWN log and
    // resents them as mid-history system messages on the new wire — cells
    // the anthropic lane never carried in-array. Pre-fix this request
    // returned `{ key: |sub:<fp>, action: "derived-persona" }`.
    const switched: M[] = [
        { role: "system", content: "oai-sys-switch" },
        ...[0, 1, 2, 3].flatMap((i) => [{ role: "system", content: `persisted-sys-v${i}` }, ...oaiTurn(i, "main")] as M[]),
        { role: "user", content: "after the switch-" + "s".repeat(120) },
    ];
    const res = resolveSessionOrder(id, switched, tagOf(switched));
    assert.equal(res.key, id, "the switched request keeps the RAW key despite the new-wire-only system cells");
    assert.equal(res.action, "reanchor");
    assert.match(res.reason ?? "", /#4778/);
});

test("#4778 family control: reasoning asymmetry across the switch still forks (documented boundary)", () => {
    resetSessionOrderForTest();
    const id = "sess-4778-xwire-think";
    // The pre-switch model was a thinker: its thinking blocks ride the
    // anthropic render and are ABSENT from the openai re-render (the
    // #2791-documented renderer divergence). Assistant-cell fragments then
    // disagree on every turn, so no same-index agreement run reaches
    // CONTINUATION_MIN_RUN — the resolver must stay honest and fork rather
    // than guess. (Making the identity hash think-blind is an owner
    // decision registered on #4778; this row pins the current bar.)
    let msgs: AM[] = [];
    for (let i = 0; i < 4; i++) {
        const t = athTurn(i, "main", true);
        assert.equal(resolveSessionOrder(id, [...msgs, t[0]], `ath-sys-v${i}`).key, id, `settle ${i} lands on the raw key`);
        msgs = [...msgs, ...t];
    }
    const switched: M[] = [
        { role: "system", content: "oai-sys-switch" },
        ...[0, 1, 2, 3].flatMap((i) => [{ role: "system", content: `persisted-sys-v${i}` }, ...oaiTurn(i, "main")] as M[]),
        { role: "user", content: "after the switch-" + "s".repeat(120) },
    ];
    const res = resolveSessionOrder(id, switched, tagOf(switched));
    assert.equal(res.action, "derived-persona");
    assert.equal(res.key, forkKey(id, tagOf(switched)));
});

// ---------------------------------------------------------------------------
// e2e: the issue's literal topology through the wired dsh openai lane.
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

test("e2e dsh openai lane #4778: goal continuation with cleared mid-history systems stays on the RAW session", async () => {
    const rig = await startRig();
    const CONV = "dshc-4778";
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`;
        const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV };
        const tools = [{ type: "function", function: { name: "bash", description: "run", parameters: { type: "object", properties: {} } } }];
        const post = (messages: M[]): Promise<Response> =>
            fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-6-astra", max_tokens: 64_000, tools, messages }) });

        // Four ordinary turns settle the raw session (append-only
        // transcript, drifting leading system — same model as the unit block).
        const done: M[][] = [];
        let transcript: M[] = [];
        for (let i = 0; i < 4; i++) {
            const t = turn(i, "main");
            const r = await post(request(`e2e-sys-v${i}`, [...transcript, t[0]]));
            assert.equal(r.status, 200);
            await r.text();
            done.push(t);
            transcript = [...transcript, ...t];
        }
        assert.ok(getSession(CONV), "raw session exists");
        assert.equal(getSession(CONV).stats.requests, 4, "settle turns ride the raw session");
        const refsAfterSettle = Object.keys(getSession(CONV).state.messageRefs.byRaw).length;

        // THE GOAL TURN: the log rewrite materializes the prior turns'
        // system prompts as persisted EMPTY entries, a new leading system,
        // the continuation's user message appended.
        const goalUser: M = { role: "user", content: "continue the goal-" + "g".repeat(120) };
        const rewritten = withClearedSystems(done);
        const goalReq = request("e2e-sys-goal", [...rewritten, goalUser]);
        const rg = await post(goalReq);
        assert.equal(rg.status, 200);
        await rg.text();
        assert.equal(getSession(CONV).stats.requests, 5, "goal turn rides the RAW session (pre-fix: fork + stuck preflight)");
        assert.equal(peekSession(forkKey(CONV, tagOf(goalReq))), undefined, "no `|sub:` session was minted for the main lane");
        assert.ok(Object.keys(getSession(CONV).state.messageRefs.byRaw).length > refsAfterSettle, "refs keep accumulating on the raw session");

        // Steady state: the next turn appends under yet another system.
        const afterGoal: M[] = [...rewritten, { role: "system", content: "" }, goalUser, { role: "assistant", content: "ok" }, ...turn(4, "main")];
        const rn = await post(request("e2e-sys-v6", afterGoal));
        assert.equal(rn.status, 200);
        await rn.text();
        assert.equal(getSession(CONV).stats.requests, 6, "post-goal turn keeps riding the raw session");
        assert.equal(peekSession(forkKey(CONV, tagOf(request("e2e-sys-v6", afterGoal)))), undefined, "still no fork session");
    } finally {
        await closeRig(rig);
    }
});
