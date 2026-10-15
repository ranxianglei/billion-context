import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest, listSessions, SPLIT_CANARY_FRESH_MS, splitSessionWarnings, type Session } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import * as ac from "../src/async-compress.ts";

// #2170 measure 2: behavioral invariants of the #388 side lane, on the dsh
// plugin wire (the host whose regression started this — #2156/#2157/#2164).
//   (A) transparency: side requests are OBSERVATION-transparent — upstream hit,
//       kernel state (requests / parentRevision / usage baseline / snapshot
//       contents) bit-for-bit unchanged.
//   (B) ordering-independence: interleavings of main and side traffic converge
//       to the same kernel state as the main-only baseline (#2164 class: the
//       bug only manifested when a side request arrived AFTER a fork anchor).
//   (C) split-session canary unit: the #2165 detection helper fires only on a
//       genuinely live split.
process.env.NODE_ENV = "test";
const testRoot = mkdtempSync(join(tmpdir(), "bili-side-inv-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;

const FORK_MARK = "Background compression pass (job ";
const ASYNC_SUMMARY = "ASYNC-SIDE-SUMMARY: the early main turns repeated the main-turn filler text.";
type ForkReply = (forkBody: string) => Record<string, unknown>;

async function harness(forkReply?: ForkReply) {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const forks: string[] = [];
    const upstream = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                const parsed = JSON.parse(raw) as Record<string, unknown>;
                const items = (parsed.messages ?? parsed.input ?? []) as unknown[];
                if (forkReply && JSON.stringify(items.slice(-1)).includes(FORK_MARK)) {
                    forks.push(raw);
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify(forkReply(raw)));
                    return;
                }
                forwarded.push(parsed);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(req.url?.endsWith("/chat/completions")
                    ? { id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }
                    : req.url?.endsWith("/v1/responses")
                      ? { id: "resp_test", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }], usage: { input_tokens: 10000, output_tokens: 10, total_tokens: 10010 } }
                      : { id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.close(); } }));
    });
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstream.url, routes: { [upstream.url]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const request = async (path: string, body?: unknown) => {
        const r = await fetch(origin + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
    };
    // dsh-shaped request sender (anthropic wire: system TOP-LEVEL, messages replay raw)
    const dshSend = async (conversationId: string, msgs: unknown[], agent: string | undefined, system: string, maxTokens = 1024, extra: Record<string, unknown> = {}) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        if (agent !== undefined) headers["x-bili-plugin-agent"] = agent;
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: "claude-test", max_tokens: maxTokens, stream: false, system, messages: msgs, ...extra }) });
        assert.equal(response.status, 200, await response.text());
    };
    // dsh-shaped request sender (responses wire: instructions is the system carrier)
    const dshRespSend = async (conversationId: string, input: unknown[], instructions: string, maxTokens = 1024) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "claude-test", max_output_tokens: maxTokens, instructions, input }) });
        assert.equal(response.status, 200, await response.text());
    };
    return { request, forwarded, forks, dshSend, dshRespSend, origin, upstreamUrl: upstream.url, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); } };
}

const mainMsg = (n: number) => ({ role: "user", content: `main turn ${n} `.repeat(120) });

test("(A) side requests are observation-transparent: kernel state and upstream traffic", async () => {
    const h = await harness();
    try {
        const conv = "plain";
        await h.dshSend(conv, [mainMsg(0)], "main", "MAIN OPERATING SYSTEM", 256);
        const session = resolveConversation(conv).session!;
        const requests0 = session.stats.requests;
        const rev0 = ((await h.request("/__bili/plugin/snapshot?conversationId=" + conv)).body as { parentRevision: string }).parentRevision;
        const status0 = (await h.request("/__bili/plugin/status?conversationId=" + conv)).body as { contextTokens: number | null; inputTokens: number };

        // side shape 1: declared side agent, full-history replay (dsh title-gen)
        const hits0 = h.forwarded.length;
        await h.dshSend(conv, [mainMsg(0), { role: "user", content: "Generate a title." }], "title", "You generate short titles.", 1024);
        assert.equal(h.forwarded.length, hits0 + 1, "title request reaches the upstream");
        // side shape 2: budget heuristic, NO agent header (max_tokens <= 200)
        await h.dshSend(conv, [mainMsg(0), { role: "user", content: "summarize" }], undefined, "MAIN OPERATING SYSTEM", 64);
        assert.equal(h.forwarded.length, hits0 + 2, "tiny-budget side request reaches the upstream");
        // side shape 3: title again after the second main turn (post-anchor ordering)
        await h.dshSend(conv, [mainMsg(0), { role: "assistant", content: "a" }, mainMsg(1), { role: "user", content: "Generate a title." }], "title", "You generate short titles.", 1024);
        assert.equal(h.forwarded.length, hits0 + 3, "second title request reaches the upstream");

        const requests1 = session.stats.requests;
        const rev1 = ((await h.request("/__bili/plugin/snapshot?conversationId=" + conv)).body as { parentRevision: string }).parentRevision;
        const status1 = (await h.request("/__bili/plugin/status?conversationId=" + conv)).body as { contextTokens: number | null; inputTokens: number };
        assert.equal(requests1, requests0, `side requests must not count as main requests (${requests0} -> ${requests1})`);
        assert.equal(rev1, rev0, `side requests must not grow the snapshot (${rev0} -> ${rev1})`);
        assert.equal(status1.inputTokens, status0.inputTokens, "side requests must not touch the usage baseline");
        assert.equal(status1.contextTokens, status0.contextTokens, "side requests must not touch the context estimate");
        assert.ok(!JSON.stringify(session.pluginSnapshot).includes("Generate a title."), "title instruction never lands in the kernel session");
        const titleForward = h.forwarded.at(-1)! as { messages?: { content: unknown }[] };
        assert.ok(titleForward.messages?.some((m) => JSON.stringify(m.content).includes("Generate a title.")), "the forwarded title request carries the title instruction");
        // the side-effect canary (#2170 measure 4) stays silent: no leak counted
        assert.equal(session.metadata.sideEffectLeaks, undefined, "no side-effect leak may be counted on a healthy lane");
    } finally {
        await h.close();
    }
});

test("(B) main/side interleavings converge to the main-only baseline (ordering independence)", async () => {
    // deterministic LCG so a failure is reproducible from the seed in the log
    const runScenario = async (seed: number, includeSide: boolean) => {
        const h = await harness();
        try {
            let s = seed;
            const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
            const conv = "fuzz";
            // main turn stream = fixed; side pool = 3 requests; rnd only picks
            // WHEN each side request fires (between main turns), not its shape.
            const sidePool = [
                () => h.dshSend(conv, [mainMsg(0), { role: "user", content: "Generate a title." }], "title", "You generate short titles.", 1024),
                () => h.dshSend(conv, [mainMsg(0), { role: "user", content: "summarize" }], undefined, "MAIN OPERATING SYSTEM", 64),
                () => h.dshSend(conv, [mainMsg(0), mainMsg(1), { role: "user", content: "Generate a title." }], "title", "You generate short titles.", 1024),
            ];
            let sideCursor = 0;
            const mainTurn = async (n: number) => {
                await h.dshSend(conv, [mainMsg(n)], "main", "MAIN OPERATING SYSTEM", 256);
                if (includeSide && sideCursor < sidePool.length && rnd() < 0.45) {
                    await sidePool[sideCursor++]();
                }
            };
            await mainTurn(0);
            await mainTurn(1);
            // drain any remaining side requests so every scenario forwards 4 main + 3 side
            if (includeSide) while (sideCursor < sidePool.length) await sidePool[sideCursor++]();
            await mainTurn(2);
            await mainTurn(3);
            const session = resolveConversation(conv).session!;
            const rev = ((await h.request("/__bili/plugin/snapshot?conversationId=" + conv)).body as { parentRevision: string }).parentRevision;
            const status = (await h.request("/__bili/plugin/status?conversationId=" + conv)).body as { contextTokens: number | null; inputTokens: number };
            return { requests: session.stats.requests, rev, inputTokens: status.inputTokens, contextTokens: status.contextTokens, forwards: h.forwarded.length, expectedForwards: includeSide ? 7 : 4 };
        } finally {
            await h.close();
        }
    };
    const baseline = await runScenario(1, false);
    assert.deepEqual({ requests: baseline.requests, forwards: baseline.forwards, expectedForwards: baseline.expectedForwards }, { requests: 4, forwards: 4, expectedForwards: 4 }, "baseline sanity: 4 main turns, 4 forwards");
    for (const seed of [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37]) {
        const r = await runScenario(seed, true);
        assert.equal(r.forwards, 7, `seed ${seed}: every side request still reaches the upstream`);
        assert.equal(r.requests, baseline.requests, `seed ${seed}: side traffic must not change the request count (${baseline.requests} != ${r.requests})`);
        assert.equal(r.rev, baseline.rev, `seed ${seed}: side traffic must not change the snapshot revision`);
        assert.equal(r.inputTokens, baseline.inputTokens, `seed ${seed}: side traffic must not change the usage baseline`);
        assert.equal(r.contextTokens, baseline.contextTokens, `seed ${seed}: side traffic must not change the context estimate`);
    }
});

test("(C) splitSessionWarnings: design persona forks excluded, drift shapes fire (#2165 shape)", () => {
    const now = 1_000_000;
    const mk = (id: string, requests: number, ageMs: number, persona = false): Session => ({ id, lastSeen: now - ageMs, createdAt: now - ageMs - 1000, stats: { requests }, metadata: persona ? { personaNamespace: true } : {} } as unknown as Session);
    const mkSub = (base: string, sub: string, requests: number, ageMs: number, persona = false) => mk(`${base}|sub:${sub}`, requests, ageMs, persona);
    // drift split: raw id + unmarked fork, both carried traffic, both fresh → warns
    const drift = splitSessionWarnings([mk("A", 3, 60_000), mkSub("A", "fp1", 5, 60_000)], now);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].base, "A");
    assert.equal(drift[0].sessions.length, 2);
    // #2165's exact reported shape: traffic-less raw twin + LIVE fork → warns
    // (the raw twin held the anchor/compressions while the fork carried turns)
    assert.equal(splitSessionWarnings([mk("A", 0, 60_000), mkSub("A", "fp1", 5, 60_000)], now).length, 1, "empty raw + live unmarked fork is the #2165 shape");
    // single session: never warns
    assert.equal(splitSessionWarnings([mk("B", 3, 60_000)], now).length, 0);
    // design persona fork (marked): NEVER warns, whatever the traffic mix
    assert.equal(splitSessionWarnings([mk("P", 3, 60_000), mkSub("P", "fp", 5, 60_000, true)], now).length, 0, "a persona-marked child is a designed split (#970/#1916)");
    assert.equal(splitSessionWarnings([mk("P", 0, 60_000), mkSub("P", "fp", 5, 60_000, true)], now).length, 0);
    // split but stale (older than the freshness window)
    assert.equal(splitSessionWarnings([mk("D", 3, SPLIT_CANARY_FRESH_MS + 1), mkSub("D", "fp1", 5, 60_000)], now).length, 0, "stale twins are history, not a live split");
    // fully idle group (nothing ever carried traffic)
    assert.equal(splitSessionWarnings([mk("I", 0, 60_000), mkSub("I", "fp", 0, 60_000)], now).length, 0, "an idle pair never carried traffic — not a live split");
    // unrelated sessions never group together
    assert.equal(splitSessionWarnings([mk("E", 3, 1_000), mkSub("F", "x", 3, 1_000)], now).length, 0);
    // mixed: one marked + one UNMARKED child beside the raw → the unmarked pair still warns
    const mixed = splitSessionWarnings([mk("M", 3, 60_000), mkSub("M", "design", 9, 60_000, true), mkSub("M", "drift", 1, 60_000)], now);
    assert.equal(mixed.length, 1, "a marked sibling must not hide a drifting twin");
    assert.ok(!mixed[0].sessions.some((s) => s.id.includes("design")), "the marked child itself stays out of the warning");
});

test("(D) a design dsh persona fork (auto-review) does NOT trip the split canary", async () => {
    const h = await harness();
    try {
        const conv = "persona";
        // main turn anchors the raw key
        await h.dshSend(conv, [mainMsg(0)], "main", "MAIN OPERATING SYSTEM", 256);
        // dsh auto-review classifyRisk shape: same conversation id, fixed
        // REVIEW_POLICY system, full-budget model turn (NOT a side request —
        // budget 300, no tools, no side agent) → keyed by design onto
        // `|sub:<fp>` (#1916/#1307/#1314) and rides the main pipeline there.
        // #2241: the blob is the FLATTENED transcript as a single fresh user
        // message — it does NOT byte-exactly continue the raw key's chain, so
        // the continuity-aware anchor still forks it (a replay that DID
        // continue the chain is the same conversation evolving, not a persona).
        await h.dshSend(conv, [{ role: "user", content: "Conversation transcript (flattened):\nuser: main turn 0\nassistant: ok\nProposed tool call: bash rm -rf /tmp/x. Decide SAFE or UNSAFE." }], undefined, "REVIEW_POLICY: classify the risk of the proposed tool call. Answer SAFE or UNSAFE.", 300);
        const all = listSessions();
        const kids = all.filter((s) => s.id.startsWith(conv + "|") || s.id.includes(conv + "|sub:"));
        assert.equal(kids.length, 1, `expected exactly one persona-fork child, got ${all.map((s) => s.id).join(", ")}`);
        assert.ok((kids[0].stats?.requests ?? 0) >= 1, "the review turn rode the child's main pipeline");
        assert.equal(kids[0].metadata.personaNamespace, true, "the child is stamped as a designed split");
        assert.equal(splitSessionWarnings(all).length, 0, "healthy persona traffic must not cry wolf");
        const status = (await h.request("/__bili/status")).body as { splitSessions?: unknown[] };
        assert.deepEqual(status.splitSessions, [], "/__bili/status stays clean for design persona forks");
    } finally {
        await h.close();
    }
});

test("(E) side requests never claim the persona anchor on the responses wire (#2203 parity)", async () => {
    const h = await harness();
    try {
        const conv = "persona-resp";
        // main turn anchors the raw key (instructions is the system carrier here)
        await h.dshRespSend(conv, [mainMsg(0)], "MAIN OPERATING SYSTEM", 256);
        const main = resolveConversation(conv).session!;
        assert.ok(Object.keys(main.state.messageRefs.byRaw).length >= 1, "main refs under the raw key");
        // side shape: tiny budget, no tools, own utility instructions —
        // sideRequestLike suppresses the persona split (#2203: the responses
        // wire gained the same `!sideRequestLike` gate as openai/anthropic):
        // rides the raw key verbatim, mints no |sub:<fp> session, touches no state.
        await h.dshRespSend(conv, [{ role: "user", content: "Generate a title." }], "You generate short titles.", 100);
        let all = listSessions();
        let kids = all.filter((s) => s.id.startsWith(conv + "|"));
        assert.equal(kids.length, 0, `side request must not mint a persona fork, got ${all.map((s) => s.id).join(", ")}`);
        assert.equal(main.stats.requests, 1, "side request counts nowhere");
        // full-budget review shape still forks (the #2203 fix itself) and stays canary-clean
        await h.dshRespSend(conv, [{ role: "user", content: "REVIEW: tool call risk assessment" }], "REVIEW_POLICY: classify the risk of the proposed tool call. Answer SAFE or UNSAFE.", 300);
        all = listSessions();
        kids = all.filter((s) => s.id.startsWith(conv + "|"));
        assert.equal(kids.length, 1, `expected exactly one persona-fork child, got ${all.map((s) => s.id).join(", ")}`);
        assert.equal(kids[0].metadata.personaNamespace, true, "fork stamped as a designed split");
        assert.equal(splitSessionWarnings(all).length, 0, "healthy persona traffic must not cry wolf");
    } finally {
        await h.close();
    }
});

test("(E2) empty-persona dsh traffic rides the raw key — no persona machine, no aux mint (codex #316 guard)", async () => {
    const h = await harness();
    try {
        const conv = "persona-empty";
        // Anthropic wire, empty system text: the call-site guard skips
        // personaConversationOrder entirely (empty system = the kernel's
        // non-anchoring semantics) — the id stays verbatim and no |sub:*
        // session may appear, on any wire, for the whole conversation.
        await h.dshSend(conv, [mainMsg(0)], undefined, "", 256);
        await h.dshSend(conv, [mainMsg(0), { role: "assistant", content: "answer" }, mainMsg(1)], undefined, "", 256);
        let all = listSessions();
        assert.ok(all.some((s) => s.id === conv), "raw key claimed verbatim");
        assert.equal(all.filter((s) => s.id.startsWith(conv + "|")).length, 0,
            `empty-persona traffic must not mint lanes, got ${all.map((s) => s.id).join(", ")}`);
        // Responses wire, empty instructions: same contract.
        const conv2 = "persona-empty-resp";
        await h.dshRespSend(conv2, [mainMsg(0)], "", 256);
        all = listSessions();
        assert.ok(all.some((s) => s.id === conv2), "raw key claimed verbatim (responses)");
        assert.equal(all.filter((s) => s.id.startsWith(conv2 + "|")).length, 0,
            `empty-instructions traffic must not mint lanes, got ${all.map((s) => s.id).join(", ")}`);
        // And a NON-empty persona on the same harness still forks (guard does
        // not over-suppress): reuse (E)'s shapes once.
        const conv3 = "persona-live";
        await h.dshSend(conv3, [mainMsg(0)], undefined, "MAIN OPERATING SYSTEM", 256);
        await h.dshSend(conv3, [{ role: "user", content: "Generate a title." }], undefined, "You generate short titles.", 256);
        all = listSessions();
        assert.equal(all.filter((s) => s.id.startsWith(conv3 + "|")).length, 1,
            `non-empty persona side traffic still forks, got ${all.map((s) => s.id).join(", ")}`);
    } finally {
        await h.close();
    }
});

// (#1440 P2 cut 2): the extracted protocol-preparation / tool-injection modules
// sit on EVERY main-wire turn; they must never reach into the #388 side-lane
// engine — neither by importing side-request.js nor by its gate symbols. That
// direction of coupling is exactly how lane behavior leaks into normal turns.
test("(F) extracted protocol modules keep the side-lane boundary (#1440 P2 cut 2)", () => {
    const mod = (name: string) => readFileSync(fileURLToPath(new URL(`../src/server/${name}`, import.meta.url)), "utf8");
    const laneInternals = /\bfrom\s*["'](?:\.\.?\/)*side-request\.js["']|\bresolveSideLane\b|\bdemoteGate\b|\bSideLaneDecision\b|\bdemotedSide\b|\bsideRequestLike\b|\bSIDE_REQUEST_MAX_TOKENS\b/;
    for (const f of ["prepare-anthropic.ts", "prepare-openai.ts", "prepare-google.ts", "prepare-responses.ts", "inject.ts"]) {
        assert.doesNotMatch(mod(f), laneInternals, `${f} must stay decoupled from the side-lane engine`);
    }
});

// (#1440 P2 cut 3): the extracted pipeline module OWNS the mid-pipeline lane
// gates, so it legitimately imports side-request.js — unlike (F)'s modules.
// What must not move or appear: the engine's internals (threshold constants,
// signal shapes, decision types, output-budget plumbing). restoreOutputBudget
// and sideRequestGuard are allowlisted because their call sites already lived
// in handle() before the extraction (moved, not newly coupled). #2500 adds
// isServerToolUtilityCall — a pure structural predicate (no threshold, no
// session state) that handle() consults for the restoreOutputBudget skip and
// the side-lane reason label, same category as isSideRequest itself. #2503
// adds isDshTitleRequest — same category: a pure dsh title-sidecar predicate
// (no threshold, no session state) consulted only to set sideIntent.
test("(G) extracted pipeline module keeps the side-lane boundary (#1440 P2 cut 3)", () => {
    const text = readFileSync(fileURLToPath(new URL("../src/server/handle.ts", import.meta.url)), "utf8");
    const laneInternals = /\bSIDE_REQUEST_MAX_TOKENS\b|\bSIDE_REQUEST_AGENTS\b|\bDemoteGateSignals\b|\bSideLaneSignals\b|\bSideLaneDecision\b|\bBILI_TOOL_NAMES\b|\bOutputBudgetField\b|\boutputBudgetField\b|\breadOutputBudget\b|\bwriteOutputBudget\b|\b_resetNoOutputCeilingWarningsForTest\b/;
    assert.doesNotMatch(text, laneInternals, "handle.ts must stay decoupled from the side-lane engine internals");
    const allowlist = new Set(["hasLeakedBiliToolsOnly", "isDshTitleRequest", "isServerToolUtilityCall", "isSideRequest", "resolveSideLane", "demoteGate", "stripLeakedBiliTools", "restoreOutputBudget", "sideRequestGuard"]);
    let sawImport = false;
    for (const m of text.matchAll(/\{([^}]*)\}\s*from\s*["'][^"']*side-request\.js["']/g)) {
        sawImport = true;
        for (const raw of m[1].split(",")) {
            const name = raw.trim().replace(/^type\s+/, "");
            if (!name) continue;
            assert.ok(allowlist.has(name), `handle.ts imports ${name} from side-request.js (out-of-allowlist lane symbol)`);
        }
    }
    assert.ok(sawImport, "handle.ts is expected to import its lane gates from side-request.js (the boundary under test)");
});

// (#1440 P2 cut 4): the extracted relay module (forward) is the wire tail — it
// consumes already-made lane DECISIONS through the Prepared it receives and
// must not touch the side-lane engine at all: no direct import, no gate
// symbols. `prepared.sidePassthrough` field reads and "side requests" prose
// are deliberately ALLOWED (not in the regexes) — they are pre-made decision
// reads / comments that moved verbatim, not new coupling.
test("(H) extracted relay module keeps the side-lane boundary (#1440 P2 cut 4)", () => {
    const text = readFileSync(fileURLToPath(new URL("../src/server/relay.ts", import.meta.url)), "utf8");
    assert.doesNotMatch(text, /\bfrom\s*["'](?:\.\.?\/)*side-request\.js["']/, "relay.ts must not import the side-lane engine directly");
    assert.doesNotMatch(
        text,
        /\b(resolveSideLane|demoteGate|SideLaneDecision|demotedSide|sideRequestLike|SIDE_REQUEST_MAX_TOKENS|isSideRequest|stripLeakedBiliTools|hasLeakedBiliToolsOnly|restoreOutputBudget|sideRequestGuard)\b/,
        "relay.ts must stay decoupled from the side-lane engine symbols",
    );
});

function refsOf(body: string): string[] {
    const ids: string[] = [];
    const re = /\x3cacp[^\x3e]*\x3e\s*(m\d+)\s*\x3c\/acp\x3e/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) if (!ids.includes(m[1]!)) ids.push(m[1]!);
    return ids;
}

async function until(cond: () => boolean, what: string, ms = 5000, detail?: () => string): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}${detail ? ` (${detail()})` : ""}`);
        await new Promise((r) => setTimeout(r, 5));
    }
}

const forkCompress: ForkReply = (body) => {
    const msgs = (JSON.parse(body) as { messages: unknown[] }).messages;
    const refs = refsOf(JSON.stringify(msgs.slice(0, -1)));
    assert.ok(refs.length >= 4, `fork body carries refs (${refs.length})`);
    return { id: "msg_fork", role: "assistant", content: [{ type: "tool_use", id: "toolu_fork", name: "compress", input: { content: [{ startId: refs[0], endId: refs[2], summary: ASYNC_SUMMARY }] } }], stop_reason: "tool_use", usage: { input_tokens: 9000, output_tokens: 40 } };
};

const TOOLS = { tools: [{ name: "compress", description: "compress", input_schema: { type: "object", properties: { content: {} } } }, { name: "bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }] };

const sideShapes = (history: unknown[]) => [
    { label: "title-gen (declared side agent)", msgs: [...history, { role: "user", content: "Generate a title." }], agent: "title" as string | undefined, system: "You generate short titles.", maxTokens: 1024 },
    { label: "tiny budget (no agent header)", msgs: [...history, { role: "user", content: "summarize" }], agent: undefined, system: "MAIN OPERATING SYSTEM", maxTokens: 64 },
];

test("(I) background compression ignores side requests: no capture, apply or note on the side lane; the next main request does each", async () => {
    ac.configureAsyncCompress({});
    try {
        const h = await harness(forkCompress);
        try {
            const conv = "async-side";
            const base = [mainMsg(0), { role: "assistant", content: "a0" }, mainMsg(1), { role: "assistant", content: "a1" }, mainMsg(2), { role: "assistant", content: "a2" }, mainMsg(3)];
            await h.dshSend(conv, base, "main", "MAIN OPERATING SYSTEM", 256, TOOLS);
            const session = resolveConversation(conv).session!;
            const sessionIds0 = listSessions().map((s) => s.id).sort();
            const state = ac._asyncCompressStateForTest();

            const queued = ac.triggerAsyncCompress(session)!.text;
            const job = state.jobs.get(session.id)!;
            assert.equal(job.phase, "awaiting-capture");
            const withResult = [...base,
                { role: "assistant", content: [{ type: "tool_use", id: "toolu_q", name: "compress", input: { content: [] } }] },
                { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_q", content: queued }] }];

            // (I-1) side requests that replay the trigger result must not capture the job
            const requests0 = session.stats.requests;
            const rev0 = ((await h.request("/__bili/plugin/snapshot?conversationId=" + conv)).body as { parentRevision: string }).parentRevision;
            for (const side of sideShapes(withResult)) {
                const hits = h.forwarded.length;
                await h.dshSend(conv, side.msgs, side.agent, side.system, side.maxTokens);
                assert.equal(h.forwarded.length, hits + 1, `${side.label}: reaches the upstream once`);
                const sent = JSON.stringify(h.forwarded.at(-1));
                assert.ok(sent.includes(job.tag), `${side.label}: the forwarded side body does carry the trigger result`);
                assert.ok(!sent.includes(FORK_MARK) && !sent.includes(ac.ASYNC_COMPRESS_TOOL_NOTE.trim().slice(0, 60)), `${side.label}: no directive or async tool note`);
                assert.equal(h.forks.length, 0, `${side.label}: no background request`);
                assert.equal(state.jobs.get(session.id), job, `${side.label}: same job still pending`);
                assert.equal(job.phase, "awaiting-capture", `${side.label}: not captured`);
            }
            assert.equal(state.jobs.size, 1, "no job under any other key");
            assert.deepEqual(listSessions().map((s) => s.id).sort(), sessionIds0, "side requests mint no session");
            assert.equal(resolveConversation(conv).session, session, "the conversation stays bound to the main session");
            assert.equal(session.stats.requests, requests0, "side requests do not count as main requests");
            assert.equal(((await h.request("/__bili/plugin/snapshot?conversationId=" + conv)).body as { parentRevision: string }).parentRevision, rev0, "snapshot unchanged");

            // positive control: the main request carrying the same result captures it
            await h.dshSend(conv, withResult, "main", "MAIN OPERATING SYSTEM", 256, TOOLS);
            await until(() => job.phase === "ready", "the job to become ready", 5000, () => `phase=${job.phase} forks=${h.forks.length} jobs=${state.jobs.size} note=${state.notes.get(session.id)?.text ?? ""}`);
            assert.equal(h.forks.length, 1, "exactly one background request");

            // (I-2) a side request must not apply the ready result
            const blocks0 = structuredClone(session.state.blocks);
            const refs0 = structuredClone(session.state.messageRefs);
            const afterResult = [...withResult, { role: "assistant", content: "a3" }, mainMsg(4)];
            for (const side of sideShapes(afterResult)) {
                await h.dshSend(conv, side.msgs, side.agent, side.system, side.maxTokens);
                assert.deepEqual(h.forwarded.at(-1), { model: "claude-test", max_tokens: side.maxTokens, stream: false, system: side.system, messages: side.msgs }, `${side.label}: the side body is forwarded exactly as the client sent it`);
                assert.ok(!JSON.stringify(h.forwarded.at(-1)).includes(ASYNC_SUMMARY), `${side.label}: no summary on the side wire`);
                assert.deepEqual(session.state.blocks, blocks0, `${side.label}: no block committed`);
                assert.deepEqual(session.state.messageRefs, refs0, `${side.label}: refs untouched`);
                assert.equal(state.jobs.get(session.id), job, `${side.label}: result still pending`);
                assert.equal(job.phase, "ready");
            }
            // positive control: the next main request applies it
            await h.dshSend(conv, afterResult, "main", "MAIN OPERATING SYSTEM", 256, TOOLS);
            assert.equal(session.state.blocks.filter((b) => b.active).length, 1, `applied on the main request (jobs=${state.jobs.size} phase=${job.phase} note=${state.notes.get(session.id)?.text ?? /did not apply \(([^)]*)\)/.exec(JSON.stringify(h.forwarded.at(-1)))?.[1] ?? "none"})`);
            assert.ok(JSON.stringify(h.forwarded.at(-1)).includes(ASYNC_SUMMARY), "the main wire carries the summary");
            assert.equal(state.jobs.size, 0, "job consumed");

            // (I-3) an owed note must not ride a side request
            const queued2 = ac.triggerAsyncCompress(session)!.text;
            const tag2 = state.jobs.get(session.id)!.tag;
            const declined = [...afterResult,
                { role: "assistant", content: [{ type: "tool_use", id: "toolu_q2", name: "compress", input: { content: [] } }] },
                { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_q2", content: queued2 }] }];
            const res = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": conv, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv, "x-bili-plugin-agent": "main" },
                body: JSON.stringify({ model: "claude-test", max_tokens: 256, stream: false, system: "MAIN OPERATING SYSTEM", messages: declined, ...TOOLS, context_management: { edits: [{ type: "clear_tool_uses_20250919" }] } }) });
            assert.equal(res.status, 200, await res.text());
            assert.equal(state.jobs.size, 0, "the non-replayable capture is declined");
            const note = state.notes.get(session.id);
            assert.ok(note && note.text.includes(tag2), "a note is owed");
            const noteNeedle = `job ${tag2} did not apply`;
            const nextTurn = [...declined, { role: "assistant", content: "a4" }, mainMsg(5)];
            for (const side of sideShapes(nextTurn)) {
                await h.dshSend(conv, side.msgs, side.agent, side.system, side.maxTokens);
                assert.ok(!JSON.stringify(h.forwarded.at(-1)).includes(noteNeedle), `${side.label}: note not attached`);
                assert.equal(state.notes.get(session.id), note, `${side.label}: note still owed`);
            }
            // positive control: the next main request carries it exactly once
            await h.dshSend(conv, nextTurn, "main", "MAIN OPERATING SYSTEM", 256, TOOLS);
            assert.ok(JSON.stringify(h.forwarded.at(-1)).includes(noteNeedle), "the main request carries the note");
            assert.equal(state.notes.get(session.id), undefined, "note consumed");
            await h.dshSend(conv, [...nextTurn, { role: "assistant", content: "a5" }, mainMsg(6)], "main", "MAIN OPERATING SYSTEM", 256, TOOLS);
            assert.ok(!JSON.stringify(h.forwarded.at(-1)).includes(noteNeedle), "and not again");
        } finally {
            await h.close();
        }
    } finally {
        ac.configureAsyncCompress(false);
        ac.disposeAsyncCompress("test end");
    }
});
