import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, ABSORB_TOOL_NAME, RULE_TOOL_NAME, RETRIEVE_TOOL_NAME, type CoreMessage } from "acp-kernel";
import { settleUsageReport } from "../src/cache-ledger.ts";
import { startServer, BILI_TOOL_NAMES, effectiveTokenCount } from "../src/server.ts";
import { READ_ORIGINAL_IMAGE_TOOL_NAME } from "../src/compress-tool.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest, resolveConversation } from "../src/plugin.ts";
import { _resetSessionsForTest, listSessions, SPLIT_CANARY_FRESH_MS, splitSessionWarnings, type Session } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";

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

async function harness() {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = await new Promise<{ url: string; close: () => Promise<void>; setFail: (v: boolean) => void }>((resolve) => {
        let fail = false;
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                if (fail) {
                    res.writeHead(500, { "content-type": "application/json" });
                    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "forced failure" } }));
                    return;
                }
                forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(req.url?.endsWith("/chat/completions")
                    ? { id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }
                    : req.url?.endsWith("/v1/responses")
                      ? { id: "resp_test", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }], usage: { input_tokens: 10000, output_tokens: 10, total_tokens: 10010 } }
                      : { id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
            });
        });
        server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.close(); }, setFail: (v: boolean) => { fail = v; } }));
    });
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstream.url, routes: { [upstream.url]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: true, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const request = async (path: string, body?: unknown) => {
        const r = await fetch(origin + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
    };
    // dsh-shaped request sender (anthropic wire: system TOP-LEVEL, messages replay raw)
    const dshSend = async (conversationId: string, msgs: unknown[], agent: string | undefined, system: string, maxTokens = 1024) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        if (agent !== undefined) headers["x-bili-plugin-agent"] = agent;
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model: "claude-test", max_tokens: maxTokens, stream: false, system, messages: msgs }) });
        assert.equal(response.status, 200, await response.text());
    };
    // dsh-shaped request sender (responses wire: instructions is the system carrier)
    const dshRespSend = async (conversationId: string, input: unknown[], instructions: string, maxTokens = 1024) => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conversationId, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conversationId };
        const response = await fetch(`${origin}/bili/${upstream.url}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "claude-test", max_output_tokens: maxTokens, instructions, input }) });
        assert.equal(response.status, 200, await response.text());
    };
    return { request, forwarded, dshSend, dshRespSend, origin, upstreamUrl: upstream.url, setFail: upstream.setFail, close: async () => { store.cancelAll(); proxy.close(); upstream.close(); await new Promise((r2) => setTimeout(r2, 50)); } };
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
// (no threshold, no session state) consulted only to set sideIntent. #4438
// adds isDshAutoReviewRequest — same category again: a pure dsh auto-review
// shape predicate (no threshold, no session state) consulted to set sideIntent
// and to keep stamped reviews off the |sub: fork path.
test("(G) extracted pipeline module keeps the side-lane boundary (#1440 P2 cut 3)", () => {
    const text = readFileSync(fileURLToPath(new URL("../src/server/handle.ts", import.meta.url)), "utf8");
    const laneInternals = /\bSIDE_REQUEST_MAX_TOKENS\b|\bSIDE_REQUEST_AGENTS\b|\bDemoteGateSignals\b|\bSideLaneSignals\b|\bSideLaneDecision\b|\bBILI_TOOL_NAMES\b|\bOutputBudgetField\b|\boutputBudgetField\b|\breadOutputBudget\b|\bwriteOutputBudget\b|\b_resetNoOutputCeilingWarningsForTest\b/;
    assert.doesNotMatch(text, laneInternals, "handle.ts must stay decoupled from the side-lane engine internals");
    const allowlist = new Set(["hasLeakedBiliToolsOnly", "isDshAutoReviewRequest", "isDshTitleRequest", "isServerToolUtilityCall", "isSideRequest", "resolveSideLane", "demoteGate", "stripLeakedBiliTools", "restoreOutputBudget", "sideRequestGuard"]);
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

// (#3293 removed absorb; #3402/#3422 revive it): the kernel's absorb tool name
// is bili-owned again — a session-sidecar request carrying it is demoted by
// #1897 like any other bili-owned tool. Lands alongside the
// src/server/side-request.ts edit per #2170 (lane logic moves ⇔ a dedicated
// side-lane suite moves with it).
test("(I) revival (#3402): the absorb tool name is bili-owned again", () => {
    assert.ok(BILI_TOOL_NAMES.has(ABSORB_TOOL_NAME), "absorb is back in the bili-owned set");
    assert.ok(BILI_TOOL_NAMES.has(RULE_TOOL_NAME), "rules tool still bili-owned");
    assert.ok(BILI_TOOL_NAMES.has(RETRIEVE_TOOL_NAME), "retrieve tool still bili-owned");
});

// (#3400): acp_read_original_image is bili's own context-management tool. A
// session-sidecar request that leaks the armed tool set must still be demoted
// by #1897, so the name joins the bili-owned set in side-request.ts — and per
// #2170 the lane-logic move lands with its dedicated suite pinning the
// membership (same discipline as (I) above for the absorb removal).
test("(J) post-#3400: acp_read_original_image is bili-owned for #1897 demotion", () => {
    assert.ok(BILI_TOOL_NAMES.has(READ_ORIGINAL_IMAGE_TOOL_NAME), "acp_read_original_image is in the bili-owned set");
});

// (#4805/#4720): side-lane usage samples must never pollute the main
// conversation's usage anchor. Reported incident: a 2-message auxiliary
// request under the SAME session id settled a 5100-token sample over a
// 300K-token anchor — nudge growth could then never reach its floor,
// compression froze while real context grew past the window. Time-based
// staleness cannot catch a seconds-old contaminant, so the defense is
// directional SIZE plus credit exemption, at two independent decision
// points (each guard alone breaks the freeze loop; incident regression
// detail in tests/issue4805-anchor-pollution.test.ts).
function anchorSession(anchor: number): Session {
    return {
        id: "s4805",
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: anchor, lastInputTokensSource: "usage", contextTokens: anchor } as never,
        metadata: {},
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as never as Session;
}

function longHistory(count: number): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < count; i++) {
        msgs.push({ id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", contentType: "text", text: "x".repeat(6000) });
    }
    return msgs;
}

test("(K) settle keeps usage-grade truth: a far-smaller usage sample supersedes AND snapshots its payload size (#4805/#1492 B)", () => {
    // #1492 B contract: the next real usage report ALWAYS self-heals the anchor —
    // the settle side must not magnitude-gate (a poisoned 1.2M anchor over a
    // folded 5K conversation is the SAME small-sample shape as side-lane
    // pollution). #4805's protection moved entirely to the meter (K2): settle
    // records WHICH request produced the anchor (lastUsagePayloadUpper) so the
    // meter can refuse anchors written by tiny requests.
    const session = anchorSession(300_000);
    session.stats.localInputEstimate = 2_600; // the side-lane request's own payload upper
    settleUsageReport(session, { total: 5_100, reportedCached: 128, output: 30, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 5_100, "usage-grade samples supersede unconditionally (#1492 B self-heal)");
    assert.equal(session.stats.lastUsagePayloadUpper, 2_600, "the anchor carries its producing request's payload snapshot");
    assert.equal(session.stats.inputTokens, 5_100, "counters accrue");
    // same-lane reports keep writing and re-snapshot
    session.stats.localInputEstimate = 295_000;
    settleUsageReport(session, { total: 290_000, reportedCached: null, protocol: "openai" });
    assert.equal(session.stats.lastInputTokens, 290_000, "main-lane reports keep updating the anchor");
    assert.equal(session.stats.lastUsagePayloadUpper, 295_000, "the snapshot follows the producing request");
    // first settle on an empty anchor always writes
    const fresh = anchorSession(0);
    settleUsageReport(fresh, { total: 5_100, reportedCached: null });
    assert.equal(fresh.stats.lastInputTokens, 5_100, "first settle on an empty anchor always writes");
});

test("(K2) side-lane meter guard: an anchor written by a request far smaller than the payload at hand sizes nothing (#4805/#1820 B)", () => {
    // #4805 shape: anchor 5100 written by a ~2600-upper side request; the main
    // payload towers over BOTH the anchor and its producing request's snapshot.
    const session = anchorSession(5_100);
    session.stats.contextTokens = 5_100;
    (session.stats as { contextTokensSource?: string }).contextTokensSource = "usage";
    session.stats.localInputEstimate = 0; // not cycle-stale: the demotion below must come from the size guard alone
    session.stats.lastUsagePayloadUpper = 2_600;
    const verdict = effectiveTokenCount(session, longHistory(800), 0);
    assert.notEqual(verdict.tokens, 5_100, "a 5100-tok anchor from a 2600-upper request cannot describe a multi-million-char payload");
    assert.equal(verdict.source, "estimate", "falls through to the local measurement (#4805 size guard)");
    // #1820 B shape: an HONEST anchor whose request was this big (its upstream
    // under-reports 8x) keeps the fast path — the snapshot term is the margin.
    const honest = anchorSession(5_100);
    honest.stats.contextTokens = 5_100;
    (honest.stats as { contextTokensSource?: string }).contextTokensSource = "usage";
    honest.stats.localInputEstimate = 0;
    honest.stats.lastUsagePayloadUpper = 220_000;
    // payload at the anchor-producer's own scale (~240k upper over a 220k snapshot)
    const trusted = effectiveTokenCount(honest, longHistory(40), 0);
    assert.equal(trusted.source, "usage", "an anchor written by THIS-size request stays ground truth (#1820 B)");
    assert.equal(trusted.tokens, 5_100, "usage-grade sizing preserved");
    // early-session growth stays anchored (no false trips below the absolute floor)
    const small = anchorSession(800);
    small.stats.contextTokens = 800;
    (small.stats as { contextTokensSource?: string }).contextTokensSource = "usage";
    small.stats.localInputEstimate = 0;
    small.stats.lastUsagePayloadUpper = 900;
    const early = effectiveTokenCount(small, longHistory(3), 0);
    assert.equal(early.tokens, 800, "small payloads keep sizing off the anchor");
});

// (#4974/#388): the relay-side half of the #388 lane contract — a FAILED side
// request must never arm the MAIN session's emergency-shrink meter: its wire
// body describes the ~10KB auxiliary call, not the conversation (incident: one
// failed title-gen pinned lastInputTokens tiny while preflight measured the
// real multi-MB payload — the #4974 livelock's arming leg). Negative direction
// (#3617): a failed MAIN request must still arm, or the #604/#1839 relay-5xx
// rescue dies. Lands alongside the src/server/relay.ts edit per #2170 (lane
// logic moves ⇔ a dedicated side-lane suite moves with it).
test("(L) a FAILED side request must not arm the main session's meter (#4974/#388)", async () => {
    const h = await harness();
    try {
        const conv = "armfail";
        h.setFail(true);
        // side shape 1: declared side agent (dsh title-gen persona)
        await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": conv, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv, "x-bili-plugin-agent": "title" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 1024, system: "MAIN OPERATING SYSTEM", messages: [{ role: "user", content: "Generate a title." }] }),
        }).then((r) => r.text());
        // side shape 2: budget heuristic (no agent header, max_tokens <= 200, no tools)
        await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": conv, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv },
            body: JSON.stringify({ model: "claude-test", max_tokens: 64, system: "MAIN OPERATING SYSTEM", messages: [{ role: "user", content: "summarize" }] }),
        }).then((r) => r.text());
        const s = resolveConversation(conv).session!;
        assert.equal(s.stats.lastInputTokens, 0, "failed side requests must not arm lastInputTokens");
        assert.notEqual(s.stats.lastInputTokensSource, "estimate", "no estimate-grade baseline may exist after side failures");
        assert.equal(s.stats.emergencyShrinkAt, undefined, "side failures must not arm the emergency shrink");
        // negative direction (#3617): a FAILED MAIN request still arms (#604/#1839)
        const conv2 = "mainfail";
        await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": conv2, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv2, "x-bili-plugin-agent": "main" },
            body: JSON.stringify({ model: "claude-test", max_tokens: 256, system: "MAIN OPERATING SYSTEM", messages: [{ role: "user", content: "work ".repeat(500) }, { role: "assistant", content: "ok ".repeat(300) }] }),
        }).then((r) => r.text());
        const m = resolveConversation(conv2).session!;
        assert.ok(m.stats.lastInputTokens > 0, "a failed main request must still arm lastInputTokens");
        assert.equal(m.stats.lastInputTokensSource, "estimate", "the main-lane arm stays estimate-grade");
        assert.ok(m.stats.emergencyShrinkAt !== undefined, "the main-lane arm sets the emergency-shrink marker");
        h.setFail(false);
    } finally {
        await h.close();
    }
});

// (#4352): the header-less claude-code persona gate landed in src/server/handle.ts's
// anthropic ladder with a fresh `!sideRequestLike` conjunct — a lane-symbol edit
// in handle.ts must land with a dedicated lane-suite pin (#2170 discipline). This
// row is that pin, contrast-shaped: the SAME claude-code persona traffic, with
// sideRequestLike=true (tiny tool-less budget, no agent header) stays verbatim on
// the raw key and observation-transparent, while sideRequestLike=false (full
// budget) rides the order resolver and forks its own |sub:<fp> lane.
test("(L) #4352 anthropic persona gate is side-vetoed: side shape stays verbatim, full-budget shape forks", async () => {
    const h = await harness();
    try {
        const conv = "cc4352";
        const ccSend = async (system: string, msgs: unknown[], maxTokens: number) => {
            const r = await fetch(`${h.origin}/bili/${h.upstreamUrl}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-claude-code-session-id": conv },
                body: JSON.stringify({ model: "claude-test", stream: false, max_tokens: maxTokens, system, messages: msgs }),
            });
            assert.equal(r.status, 200, await r.text());
        };
        // main turn anchors the raw key (claude-code main persona)
        await ccSend("You are Claude Code, Anthropic's official CLI for Claude. You are an interactive agent.", [mainMsg(0)], 256);
        const session = resolveConversation(conv).session!;
        assert.equal(session.stats.requests, 1, "main turn counted once on the parent");
        const sessions = listSessions().length;

        // side shape: same raw id, SUB persona system, tool-less tiny budget (<=
        // the #388 heuristic, no agent header) → the new anthropic gate is
        // vetoed by !sideRequestLike: verbatim raw key, counted nowhere, and
        // NO persisted |sub ghost for it.
        const hits = h.forwarded.length;
        await ccSend("You are a file search specialist for the parent session.", [{ role: "user", content: "summarize" }], 100);
        assert.equal(h.forwarded.length, hits + 1, "the side call reaches the upstream");
        assert.equal(resolveConversation(conv).session!.stats.requests, 1, "side call never counts on the parent");
        assert.equal(listSessions().length, sessions, "side call must not fork a |sub lane");

        // full-budget shape: the SAME sub persona system + disjoint history → the
        // resolver DOES engage (proof the verbatim above is the sideRequestLike
        // conjunct, not a dead gate): a |sub:<fp> lane appears, parent untouched.
        await ccSend("You are a file search specialist for the parent session.", [
            { role: "user", content: "sub-user-1" },
            { role: "assistant", content: "sub-assistant-1" },
            { role: "user", content: "sub-user-2" },
        ], 1024);
        assert.equal(listSessions().length, sessions + 1, "full-budget sub persona forks its own |sub lane");
        assert.equal(resolveConversation(conv).session!.stats.requests, 1, "the fork lane counts nowhere on the parent");
    } finally {
        await h.close();
    }
});
