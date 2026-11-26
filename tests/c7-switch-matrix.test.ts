/** C7 (PR #7684): the 12-cell switch matrix — every combination the egress
 *  plane previously had ZERO coverage for, driven end-to-end over HTTP
 *  against a live proxy (plane ON) with a fake upstream that answers all
 *  four wire dialects:
 *
 *    switch kind  ×  phase
 *    ─────────────  ─────────────────────────────────────────
 *    model (A)      bootstrap | steady-state | fold-active | fork
 *    wire (B)       bootstrap | steady-state | fold-active | fork
 *    both   (A+B)   bootstrap | steady-state | fold-active | fork
 *
 *  Every cell asserts the contract a switching host can rely on:
 *   1. the switched turn is 200 (never a 500/unreadable);
 *   2. the upstream saw the target wire's URL shape (the switch happened);
 *   3. EXACT live-set equality on the op log: every pinned host id survives
 *      the switch (the op-log swap matched by id across wires), no row is
 *      lost, no undeleted row survives the fold's D-ops;
 *   4. the [lane-switch] line: exactly one, correct direction, for wire /
 *      both switches — and NONE for a model-only switch on the same wire;
 *   5. no pin rejection, no egress-unreadable degradation, no kernel
 *      transform crash (a crash = raw forward = unrecorded).
 *
 *  Turn shape: every turn re-sends the FULL current history (how pinned
 *  hosts actually behave — 7577/Lane W style) and appends one new element,
 *  reusing the existing host ids. The shared exchange is deliberately
 *  element-aligned across all four wires (user / assistant tool-call /
 *  tool-result — no assistant text, so no per-wire element-count drift and
 *  no split siblings; the split case is covered by
 *  tests/crosslane-wire-pin.test.ts and the pin unit tests).
 *
 *  Fold-active cells model the pinned host's own context management: turn 1
 *  records the long history, the switch turn re-sends the folded view —
 *  compact summary + fresh tail, NEW ids — and the op-log diff must emit
 *  D-ops for every deleted row. Fork cells fork the egress snapshot (point
 *  copy) and drive the CHILD's first turn on the target wire.
 */
process.env.BILI_PERSIST_ZSTD = "0";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

const MODEL_A = "gpt-test";
const MODEL_B = "gpt-test2";
const CLAUDE = "claude-test";
const GEMINI = "gemini-test";

type Kind = "model" | "wire" | "both";
type Phase = "bootstrap" | "steady" | "fold" | "fork";

const TARGETS: Record<Kind, { path: string; model: string; label: string }> = {
    model: { path: "/v1/chat/completions", model: MODEL_B, label: "openai->openai (model A->B)" },
    wire: { path: "/v1/messages", model: CLAUDE, label: "openai->anthropic wire" },
    both: { path: "/v1/responses", model: GEMINI, label: "openai->responses wire + model" },
};

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

test("C7 switch matrix: {model, wire, both} × {bootstrap, steady, fold, fork} all stay pinned and served (#7439 C7)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "c7-matrix-"));
    test.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    let store: SessionStore | null = null;
    let srv: http.Server | null = null;
    let upstream: http.Server | null = null;
    try {
        setRegistryForTest({});
        store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        const seen: Array<{ url: string; model: string }> = [];
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                const url = req.url ?? "";
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
                seen.push({ url, model: String(body.model ?? "") });
                // honest usage: bill what actually arrived (the /4 estimator —
                // the usage-driven fold controller judges on billed input)
                const billed = Math.max(10, Math.round(JSON.stringify(body).length / 4));
                // the preflight summarizer also lands here (no biliMsgIds, big
                // content): answer it with a real ≥50-char summary, not "ok"
                const isSummaryCall = !("biliMsgIds" in body) && JSON.stringify(body).length > 4000;
                res.writeHead(200, { "content-type": "application/json" });
                if (url.includes("/v1/messages")) {
                    res.end(JSON.stringify({ id: "msg-test", type: "message", role: "assistant", model: CLAUDE, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: billed, output_tokens: 5 } }));
                } else if (url.includes("/v1/responses")) {
                    res.end(JSON.stringify({ id: "resp-test", object: "response", status: "completed", model: GEMINI, output: [{ type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: billed, output_tokens: 5 } }));
                } else {
                    res.end(JSON.stringify({ id: "chatcmpl-test", object: "chat.completion", model: String(body.model ?? MODEL_A), choices: [{ index: 0, message: { role: "assistant", content: isSummaryCall ? `folded history ${"z".repeat(240)}` : "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: billed, completion_tokens: 5, total_tokens: billed + 5 } }));
                }
            });
        });
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const allModels = { [MODEL_A]: { context: 400_000 }, [MODEL_B]: { context: 400_000 }, [CLAUDE]: { context: 400_000 }, [GEMINI]: { context: 400_000 } };
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: llmUrl,
            routes: { [llmUrl]: { models: allModels } },
            modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
            log: true, debug: true, passthrough: false, autoUpdate: false,
            compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null,
            autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        };
        srv = await startServer(opts);
        await listen(srv);
        const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
        const post = async (path: string, sessionId: string, body: Record<string, unknown>): Promise<{ status: number; body: string }> => {
            const resp = await fetch(`${base}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-acp-session": sessionId },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(60_000),
            });
            return { status: resp.status, body: await resp.text() };
        };
        const settle = async (sessionId: string): Promise<void> => {
            const race = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
            assert.equal(await race(store!.afterNextFlush(sessionId), 15_000), true, `${sessionId}: first debounced flush landed`);
            assert.equal(await race(store!.afterNextFlush(sessionId), 15_000), true, `${sessionId}: second flush settled`);
        };

        const SLOTS: Record<string, Array<Record<string, unknown>>> = {
            openai: [
                { role: "user", content: "q1" },
                { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{}" } }] },
                { role: "tool", tool_call_id: "call_1", content: "result" },
            ],
            anthropic: [
                { role: "user", content: [{ type: "text", text: "q1" }] },
                { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "t", input: {} }] },
                { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }] },
            ],
            responses: [
                { role: "user", content: "q1" },
                { type: "function_call", name: "t", arguments: "{}", call_id: "call_1" },
                { type: "function_call_output", call_id: "call_1", output: "result" },
            ],
        };
        const wireOf = (p: string) => (p === "/v1/messages" ? "anthropic" : p === "/v1/responses" ? "responses" : "openai");
        /** One full-history turn on any wire: the 3 shared slots (ids
         *  prefix[0..2]), every prior tail element (same ids, same texts),
         *  plus the one NEW tail element (`newTail`). A pinned host re-sends
         *  its whole conversation each turn — this models exactly that. */
        const fullTurn = async (path: string, model: string, sid: string, prefix: string[], tails: string[], newTail: string): Promise<void> => {
            const w = wireOf(path);
            const tailEls = [...tails, newTail].map((id) =>
                w === "anthropic"
                    ? { role: "user", content: [{ type: "text", text: `msg ${id}` }] }
                    : { role: "user", content: `msg ${id}` });
            const body: Record<string, unknown> = {
                model, stream: false, max_tokens: 1024,
                biliMsgIds: [...prefix, ...tails, newTail],
                ...(path === "/v1/responses" ? { input: [...SLOTS[w], ...tailEls], max_output_tokens: 1024 } : { messages: [...SLOTS[w], ...tailEls] }),
            };
            const r = await post(path, sid, body);
            assert.equal(r.status, 200, `${path} turn (new ${newTail}) -> ${r.status}: ${r.body.slice(0, 200)}`);
            assert.ok(r.body.includes("ok"), `the response came back shaped (${r.body.slice(0, 120)})`);
            await settle(sid);
        };

        /** Live (non-system) msgids of the session's egress flow. */
        const liveIds = (sid: string): string[] => (store!.egressOpLogStore()?.egressStateView(sid) ?? []).filter((v) => v.msgid !== "egress-system").map((v) => v.msgid);
        /** Assert the live set CONTAINS the expected host ids and holds NO
         *  id outside the expected set — catches both missing pins and
         *  undeleted rows (e.g. a fold that failed to emit its D-ops). */
        const expectLive = (sid: string, expected: string[], label: string): void => {
            const live = liveIds(sid);
            const missing = expected.filter((id) => !live.includes(id));
            const extra = live.filter((id) => !expected.includes(id));
            assert.deepEqual(missing, [], `${label}: every pinned id must be in the live flow (missing: ${missing}); live: ${live.join(",")}`);
            assert.deepEqual(extra, [], `${label}: no undeleted rows may survive (extra: ${extra}); live: ${live.join(",")}`);
        };
        /** The [lane-switch] lines for `sid` logged since mark, if any. */
        const laneSwitchLines = (mark: number, sid: string): string[] => logs.slice(mark).filter((l) => l.includes("[lane-switch]") && l.includes(sid));

        const cell = async (kind: Kind, phase: Phase): Promise<void> => {
            let sid = `c7-${kind}-${phase}`;
            const logMark = logs.length;
            const seenMark = seen.length;
            let expectedLive: string[] = [];
            let switchStep: { prefix: string[]; tails: string[]; newTail: string } | null = null;
            switch (phase) {
                case "bootstrap":
                    await fullTurn("/v1/chat/completions", MODEL_A, sid, ["a0", "a1", "a2"], [], "a3");
                    expectedLive = ["a0", "a1", "a2", "a3"];
                    switchStep = { prefix: ["a0", "a1", "a2"], tails: ["a3"], newTail: "a4" };
                    break;
                case "steady":
                    await fullTurn("/v1/chat/completions", MODEL_A, sid, ["a0", "a1", "a2"], [], "a3");
                    await fullTurn("/v1/chat/completions", MODEL_A, sid, ["a0", "a1", "a2"], ["a3"], "a4");
                    expectedLive = ["a0", "a1", "a2", "a3", "a4"];
                    switchStep = { prefix: ["a0", "a1", "a2"], tails: ["a3", "a4"], newTail: "a5" };
                    break;
                case "fold": {
                    // A pinned host manages its own context: turn 1 sends the long
                    // history, turn 2 (the SWITCH turn) re-sends the folded view —
                    // compact summary + fresh tail. The op-log diff emits D-ops and
                    // the flow shrinks — exactly how #7577's e2e drives a real fold.
                    const long: Array<{ role: string; content: string }> = [];
                    for (let i = 0; i < 100; i++) long.push({ role: i % 2 === 0 ? "user" : "assistant", content: `message ${i}: ${"x".repeat(2000)}` });
                    const r1 = await post("/v1/chat/completions", sid, { model: MODEL_A, stream: false, max_tokens: 1024, messages: long, biliMsgIds: long.map((_, i) => `f${i}`) });
                    assert.equal(r1.status, 200, `fold-prime turn -> ${r1.status}: ${r1.body.slice(0, 200)}`);
                    await settle(sid);
                    const primedLive = liveIds(sid);
                    assert.ok(primedLive.length >= 100, `the prime turn recorded the full history (${primedLive.length} live rows)`);
                    // the switch turn carries the folded view on the target wire
                    const t = TARGETS[kind];
                    const folded: Record<string, unknown> = { model: t.model, stream: false, max_tokens: 1024, biliMsgIds: ["fs0", "fs1", "fs2"] };
                    if (t.path === "/v1/messages") {
                        folded.messages = [
                            { role: "user", content: [{ type: "text", text: "summary: a hundred long messages about x" }] },
                            { role: "user", content: [{ type: "text", text: "still there?" }] },
                            { role: "user", content: [{ type: "text", text: "after the fold" }] },
                        ];
                    } else if (t.path === "/v1/responses") {
                        folded.input = [{ role: "user", content: "summary: a hundred long messages about x" }, { role: "user", content: "still there?" }, { role: "user", content: "after the fold" }];
                    } else {
                        folded.messages = [{ role: "user", content: "summary: a hundred long messages about x" }, { role: "user", content: "still there?" }, { role: "user", content: "after the fold" }];
                    }
                    const r2 = await post(t.path, sid, folded);
                    assert.equal(r2.status, 200, `fold+switch turn -> ${r2.status}: ${r2.body.slice(0, 200)}`);
                    await settle(sid);
                    const liveAfterFold = liveIds(sid);
                    assert.ok(liveAfterFold.length < 20, `the fold shrank the flow via D-ops (${liveAfterFold.length} live rows vs 100 sent; tail: ${liveAfterFold.slice(-5).join(",")})`);
                    assert.deepEqual(liveAfterFold, ["fs0", "fs1", "fs2"], `EXACT live set after the fold: the 100 prime rows (f0..f99) must all be D-ed, leaving exactly the folded view`);
                    expectedLive = ["fs0", "fs1", "fs2"];
                    break;
                }
                case "fork": {
                    await fullTurn("/v1/chat/completions", MODEL_A, sid, ["p0", "p1", "p2"], [], "p3");
                    const parentBefore = liveIds(sid);
                    assert.deepEqual(parentBefore.sort(), ["p0", "p1", "p2", "p3"].sort(), `fork: the parent's live set must be exactly its pinned ids; got ${parentBefore.join(",")}`);
                    const child = `${sid}-child`;
                    const forked = await (store as unknown as { forkEgressSnapshot: (s: string, c?: string) => Promise<{ childId: string }> }).forkEgressSnapshot(sid, child);
                    assert.equal(forked.childId, child);
                    // the child's FIRST turn is already on the target wire, reusing
                    // every inherited host id and appending one new element
                    await fullTurn(TARGETS[kind].path, TARGETS[kind].model, child, ["p0", "p1", "p2"], ["p3"], "p4");
                    const childLive = liveIds(child);
                    assert.deepEqual(childLive.sort(), ["p0", "p1", "p2", "p3", "p4"].sort(), `${kind}/fork: the child must inherit EVERY parent flow row and add exactly the new element; child live: ${childLive.join(",")}`);
                    const parentAfter = liveIds(sid);
                    assert.deepEqual(parentAfter.sort(), ["p0", "p1", "p2", "p3"].sort(), `${kind}/fork: the parent must be untouched by the child's turn (point copy, not a shared log); parent live: ${parentAfter.join(",")}`);
                    sid = child;
                    expectedLive = ["p0", "p1", "p2", "p3", "p4"];
                    break;
                }
            }
            if (switchStep) {
                const t = TARGETS[kind];
                await fullTurn(t.path, t.model, sid, switchStep.prefix, switchStep.tails, switchStep.newTail);
                expectedLive = [...switchStep.prefix, ...switchStep.tails, switchStep.newTail];
            }

            // ---- the contract assertions ---------------------------------
            const tailLogs = logs.slice(logMark);
            assert.ok(!tailLogs.some((l) => l.includes("pin rejected")), `${kind}/${phase}: no pin rejection (drift class never rejects, but the pin must have hit): ${tailLogs.filter((l) => l.includes("pin")).join(" | ").slice(0, 400)}`);
            assert.ok(!tailLogs.some((l) => l.includes("unreadable")), `${kind}/${phase}: no egress-unreadable degradation`);
            assert.ok(!tailLogs.some((l) => l.includes("kernel transform failed")), `${kind}/${phase}: the kernel transform must not crash (a crash means the turn was forwarded raw, unrecorded): ${tailLogs.filter((l) => l.includes("kernel transform")).join(" | ").slice(0, 300)}`);
            const t = TARGETS[kind];
            const last = seen.slice(seenMark).at(-1);
            const wantUrl = t.path === "/v1/messages" ? "/v1/messages" : t.path === "/v1/responses" ? "/v1/responses" : "/v1/chat";
            assert.ok(last && last.url.includes(wantUrl), `${kind}/${phase}: the upstream saw the target wire (${last?.url}); seen tail: ${JSON.stringify(seen.slice(seenMark).map((e) => e.url))}`);
            const live = liveIds(sid);
            assert.ok(live.length > 0, `${kind}/${phase}: the op log stayed alive (${live.length} ids)`);
            const view = store!.egressOpLogStore()?.egressStateView(sid) ?? [];
            assert.ok(view.length > 0, `${kind}/${phase}: the live view exists`);
            // ---- exact-set + lane-switch log assertions -------------------
            expectLive(sid, expectedLive, `${kind}/${phase}: exact live set — every pinned id survives the switch, nothing extra, nothing lost`);
            const laneLines = laneSwitchLines(logMark, sid);
            if (kind === "model") {
                assert.deepEqual(laneLines, [], `${kind}/${phase}: a MODEL switch on the same wire must NOT log a lane switch: ${laneLines.join(" | ")}`);
            } else {
                // covers the fork cells too: forkEgressSnapshot inherits the
                // parent's lane baseline, so the child's first turn on another
                // wire is ALSO reported as a switch (inherited openai -> target)
                assert.equal(laneLines.length, 1, `${kind}/${phase}: exactly ONE [lane-switch] line for the switch turn: ${laneLines.join(" | ")}`);
                const dir = kind === "wire" ? "openai -> anthropic" : "openai -> responses";
                assert.ok(laneLines[0].includes(dir), `${kind}/${phase}: the lane-switch line must name the direction ${dir}: ${laneLines[0]}`);
            }
            console.log(`  ✓ ${kind}/${phase} — ${t.label}: ${live.length} pinned ids, ${view.length} live rows`);
        };

        for (const kind of ["model", "wire", "both"] as Kind[]) {
            for (const phase of ["bootstrap", "steady", "fold", "fork"] as Phase[]) {
                await cell(kind, phase);
            }
        }
    } finally {
        setLogCapture(null);
        store?.closeQuietly();
        srv?.closeAllConnections?.();
        await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
        await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    }
});
