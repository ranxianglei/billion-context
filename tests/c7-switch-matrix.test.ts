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
 *   3. pinned host ids survive (the op-log swap matched by id — no
 *      "pin rejected" drift line for the cell);
 *   4. the op log stayed alive (the session still has a live view);
 *   5. no cross-lane rendering crash (the response came back shaped).
 *
 *  Fold-active cells first force a REAL kernel fold (tiny window, long
 *  history) and verify the flow shrank — then switch on top of the fold.
 *  Fork cells fork the egress snapshot (point copy) and drive the CHILD's
 *  first turn on the target wire.
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

        /** One openai-lane turn with an agentic 3-element history. Returns
         *  the element ids (host-stamped). */
        const openaiTurn = async (sid: string, n: number, model: string, ids: string[]): Promise<void> => {
            const r = await post("/v1/chat/completions", sid, {
                model,
                stream: false,
                max_tokens: 1024,
                messages: [
                    { role: "user", content: `q${n}` },
                    { role: "assistant", content: "talking", tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "t", arguments: "{}" } }] },
                    { role: "tool", tool_call_id: `call_${n}`, content: "result" },
                ],
                biliMsgIds: ids,
            });
            assert.equal(r.status, 200, `openai turn ${n} -> ${r.status}: ${r.body.slice(0, 200)}`);
            await settle(sid);
        };
        /** The switched turn on the target wire. */
        const switchTurn = async (kind: Kind, sid: string, ids: string[]): Promise<void> => {
            const t = TARGETS[kind];
            const body: Record<string, unknown> = { model: t.model, stream: false, max_tokens: 1024, biliMsgIds: ids };
            if (t.path === "/v1/messages") {
                body.messages = [
                    { role: "user", content: [{ type: "text", text: `q${ids.length}` }] },
                    { role: "assistant", content: [{ type: "text", text: "talking" }, { type: "tool_use", id: `call_${ids.length}`, name: "t", input: {} }] },
                    { role: "user", content: [{ type: "tool_result", tool_use_id: `call_${ids.length}`, content: "result" }] },
                ];
            } else if (t.path === "/v1/responses") {
                body.input = [
                    { role: "user", content: `q${ids.length}` },
                    { type: "function_call", name: "t", arguments: "{}", call_id: `call_${ids.length}` },
                    { type: "function_call_output", call_id: `call_${ids.length}`, output: "result" },
                ];
            } else {
                body.messages = [
                    { role: "user", content: `q${ids.length}` },
                    { role: "assistant", content: "talking", tool_calls: [{ id: `call_${ids.length}`, type: "function", function: { name: "t", arguments: "{}" } }] },
                    { role: "tool", tool_call_id: `call_${ids.length}`, content: "result" },
                ];
            }
            const r = await post(t.path, sid, body);
            assert.equal(r.status, 200, `${kind} switch -> ${r.status}: ${r.body.slice(0, 300)}`);
            assert.ok(r.body.includes("ok"), `${kind} switch: the response came back shaped (${r.body.slice(0, 120)})`);
            await settle(sid);
        };

        const cell = async (kind: Kind, phase: Phase): Promise<void> => {
            let sid = `c7-${kind}-${phase}`;
            const logMark = logs.length;
            const seenMark = seen.length;
            const ids = ["h0", "h1", "h2"];
            let switched: string[] = [];
            let switchOnFold = false;
            switch (phase) {
                case "bootstrap":
                    await openaiTurn(sid, 1, MODEL_A, ["b0", "b1", "b2"]);
                    switched = ids;
                    break;
                case "steady":
                    await openaiTurn(sid, 1, MODEL_A, ["s0", "s1", "s2"]);
                    await openaiTurn(sid, 2, MODEL_A, ["s3", "s4", "s5"]);
                    switched = ids;
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
                    const view = store!.egressOpLogStore()?.egressStateView(sid) ?? [];
                    const liveMsgs = view.filter((v) => v.msgid !== "egress-system").length;
                    if (liveMsgs >= 20) console.log("FOLD2-DEBUG", logs.filter((l) => /iterable|error|warn|egress|fold|record|blocks/.test(l)).slice(-40).join("\n").slice(-4000));
                    assert.ok(liveMsgs < 20, `the fold shrank the flow via D-ops (${liveMsgs} live rows vs 100 sent; tail: ${view.slice(-5).map((v) => v.msgid).join(",")})`);
                    switchOnFold = true;
                    break;
                }
                case "fork": {
                    await openaiTurn(sid, 1, MODEL_A, ["p0", "p1", "p2"]);
                    const child = `${sid}-child`;
                    const forked = await (store as unknown as { forkEgressSnapshot: (s: string, c?: string) => Promise<{ childId: string }> }).forkEgressSnapshot(sid, child);
                    assert.equal(forked.childId, child);
                    const r = await post(TARGETS[kind].path, child, {
                        model: TARGETS[kind].model,
                        stream: false,
                        max_tokens: 1024,
                        biliMsgIds: ["p0", "p1", "p2", "p3"],
                        ...(TARGETS[kind].path === "/v1/messages"
                            ? { messages: [
                                { role: "user", content: [{ type: "text", text: "q1" }] },
                                { role: "assistant", content: [{ type: "text", text: "talking" }, { type: "tool_use", id: "call_1", name: "t", input: {} }] },
                                { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }] },
                                { role: "user", content: [{ type: "text", text: "after fork" }] },
                            ] }
                            : TARGETS[kind].path === "/v1/responses"
                                ? { input: [
                                    { role: "user", content: "q1" },
                                    { type: "function_call", name: "t", arguments: "{}", call_id: "call_1" },
                                    { type: "function_call_output", call_id: "call_1", output: "result" },
                                    { role: "user", content: "after fork" },
                                ] }
                                : { messages: [
                                    { role: "user", content: "q1" },
                                    { role: "assistant", content: "talking", tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{}" } }] },
                                    { role: "tool", tool_call_id: "call_1", content: "result" },
                                    { role: "user", content: "after fork" },
                                ] }),
                    });
                    assert.equal(r.status, 200, `${kind}/fork child turn -> ${r.status}: ${r.body.slice(0, 300)}`);
                    await settle(child);
                    sid = child;
                    switched = ["p0", "p1", "p2", "p3"];
                    break;
                }
            }
            if (phase !== "fork" && !switchOnFold) await switchTurn(kind, sid, switched);

            // ---- the contract assertions ---------------------------------
            const tailLogs = logs.slice(logMark);
            assert.ok(!tailLogs.some((l) => l.includes("pin rejected")), `${kind}/${phase}: no pin rejection (drift class never rejects, but the pin must have hit): ${tailLogs.filter((l) => l.includes("pin")).join(" | ").slice(0, 400)}`);
            assert.ok(!tailLogs.some((l) => l.includes("unreadable")), `${kind}/${phase}: no egress-unreadable degradation`);
            assert.ok(!tailLogs.some((l) => l.includes("kernel transform failed")), `${kind}/${phase}: the kernel transform must not crash (a crash means the turn was forwarded raw, unrecorded): ${tailLogs.filter((l) => l.includes("kernel transform")).join(" | ").slice(0, 300)}`);
            const t = TARGETS[kind];
            const last = seen.slice(seenMark).at(-1);
            const wantUrl = t.path === "/v1/messages" ? "/v1/messages" : t.path === "/v1/responses" ? "/v1/responses" : "/v1/chat";
            assert.ok(last && last.url.includes(wantUrl), `${kind}/${phase}: the upstream saw the target wire (${last?.url}); seen tail: ${JSON.stringify(seen.slice(seenMark).map((e) => e.url))}`);
            const live = store!.snapPinLiveIds(sid);
            assert.ok(live.length > 0, `${kind}/${phase}: the op log stayed alive (${live.length} ids)`);
            const view = store!.egressOpLogStore()?.egressStateView(sid) ?? [];
            assert.ok(view.length > 0, `${kind}/${phase}: the live view exists`);
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
