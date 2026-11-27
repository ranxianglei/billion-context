// #7439 follow-up (cross-lane model/protocol switching): WIRE-granularity
// pinning end-to-end. The unit surface lives in msgid-pin-wire-form.test.ts;
// this drives the full chain over HTTP:
//   A. openai bootstrap turn with an AGENTIC history (assistant
//      text+tool_call splits one wire element into two cores) — the host
//      stamps one id per ELEMENT (3 ids for 5 cores). Pre-fix: the length
//      mismatch rejected the pin (content-derived ids). Post-fix: the wire
//      form pins the group head (host id) + derived sibling (#p1).
//   B. LANE SWITCH on the same session: the very next turn rides the
//      Anthropic wire. The flow's ids (host ids incl. #p1) survive the
//      switch — the op-log swap matches by id, the op-log is served, and
//      the upstream body keeps correct tool_use/tool_result PLACEMENT
//      (the original symptom: 切换后消息错位).
//   C. a declared id array that matches NEITHER form degrades (200, no
//      pin) — drift class, never a 400.
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

const MODEL = "gpt-test";
const CLAUDE_MODEL = "claude-test";

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

test("wire-granularity pin: agentic split + lane switch keeps ids and placement (#7439 follow-up)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crosslane-wire-pin-"));
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
        const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                const url = req.url ?? "";
                const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
                seen.push({ url, body });
                res.writeHead(200, { "content-type": "application/json" });
                if (url.includes("/v1/messages")) {
                    res.end(JSON.stringify({
                        id: "msg-test", type: "message", role: "assistant", model: CLAUDE_MODEL,
                        content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
                        usage: { input_tokens: 10, output_tokens: 5 },
                    }));
                } else {
                    // The conv-reason turn-1 reply carries reasoning_content
                    // (the qwen/sglang shape) so turn 2's history must
                    // re-send it byte-identically for the pin to match.
                    const msgsText = JSON.stringify(body.messages);
                    const isReasonFirst = msgsText.includes("intro yourself") && !msgsText.includes("1 + 1?");
                    res.end(JSON.stringify({
                        id: "chatcmpl-test", object: "chat.completion", model: MODEL,
                        choices: [{ index: 0, message: isReasonFirst ? { role: "assistant", content: "I am the test model.", reasoning_content: "the user asks for an intro" } : { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
                    }));
                }
            });
        });
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: llmUrl,
            routes: { [llmUrl]: { models: { [MODEL]: { context: 400_000 }, [CLAUDE_MODEL]: { context: 400_000 } } } },
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
        const post = async (
            path: string,
            sessionId: string,
            body: Record<string, unknown>,
        ): Promise<{ status: number; body: string }> => {
            const resp = await fetch(`${base}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-acp-session": sessionId },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
            return { status: resp.status, body: await resp.text() };
        };
        const settle = async (sessionId: string): Promise<void> => {
            const race = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
            assert.equal(await race(store!.afterNextFlush(sessionId), 10_000), true, "first debounced flush landed");
            assert.equal(await race(store!.afterNextFlush(sessionId), 10_000), true, "second flush settled");
        };

        // The agentic history: 3 wire elements → 5 cores (element 1 splits
        // into text + tool_call). The host stamps one id per ELEMENT.
        const oaiHist = [
            { role: "user", content: "q" },
            { role: "assistant", content: "talking", tool_calls: [{ id: "call_1", type: "function", function: { name: "t", arguments: "{}" } }] },
            { role: "tool", tool_call_id: "call_1", content: "result" },
        ];
        const elIds = ["host-0", "host-1", "host-2"];

        // A. Bootstrap on the OpenAI wire: the WIRE form pins (3 ids for 5
        //    cores) — the group head takes the host id, the sibling derives
        //    host-1#p1.
        const r1 = await post("/v1/chat/completions", "conv-split", { model: MODEL, stream: false, messages: oaiHist, biliMsgIds: elIds });
        assert.equal(r1.status, 200, `bootstrap turn must succeed (got ${r1.status}: ${r1.body.slice(0, 200)})`);
        await settle("conv-split");
        const pinIds = store!.snapPinLiveIds("conv-split");
        for (const id of ["host-0", "host-1", "host-1#p1", "host-2"]) {
            assert.ok(pinIds.includes(id), `flow ledger must carry ${id} (got: ${JSON.stringify(pinIds)})`);
        }
        assert.ok(!logs.some((l) => l.includes("conv-split") && l.includes("pin rejected")), "the wire-form pin must not hit the reject path");

        // B. LANE SWITCH: the next turn rides the Anthropic wire with the
        //    SAME element ids + one new element. The op-log must be served
        //    (ids match across lanes) and the upstream body must keep the
        //    tool_use/tool_result placement of the switched conversation.
        const anthropicHist = [
            { role: "user", content: "q" },
            { role: "assistant", content: [{ type: "text", text: "talking" }, { type: "tool_use", id: "call_1", name: "t", input: {} }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }] },
            { role: "user", content: "next" },
        ];
        const r2 = await post("/v1/messages", "conv-split", {
            model: CLAUDE_MODEL, stream: false, max_tokens: 1024,
            messages: anthropicHist, biliMsgIds: ["host-0", "host-1", "host-2", "host-3"],
        });
        assert.equal(r2.status, 200, `lane-switch turn must succeed (got ${r2.status}: ${r2.body.slice(0, 300)})`);
        assert.ok(
            logs.some((l) => l.includes("conv-split") && l.includes("existing row(s) served from the op-log")),
            `the lane-switch turn must serve from the op-log (log: ${logs.filter((l) => l.includes("conv-split")).join(" || ")})`,
        );
        await settle("conv-split");
        const pinIds2 = store!.snapPinLiveIds("conv-split");
        for (const id of ["host-0", "host-1", "host-1#p1", "host-2", "host-3"]) {
            assert.ok(pinIds2.includes(id), `post-switch ledger must carry ${id} (got: ${JSON.stringify(pinIds2)})`);
        }
        // Upstream placement: assistant [text, tool_use] ONE message, then a
        // user message carrying the tool_result (not orphaned/reordered).
        const switchedUpstream = seen.filter((s) => s.url.includes("/v1/messages")).at(-1)!;
        const umsgs = switchedUpstream.body.messages as Array<Record<string, unknown>>;
        const blocks = (m: Record<string, unknown>): Array<Record<string, unknown>> =>
            Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
        assert.ok(
            umsgs.some((m) => m.role === "assistant" && blocks(m).some((b) => b.type === "tool_use" && b.id === "call_1")
                && blocks(m).some((b) => b.type === "text" && String(b.text).includes("talking"))),
            `the switched assistant message must keep text+tool_use blocks (got: ${JSON.stringify(umsgs).slice(0, 400)})`,
        );
        // The tool_result must PRECEDE the new client text in the user turns
        // (correct placement after the lane switch — the 切换后消息错位 symptom).
        const toolResultIdx = umsgs.findIndex((m) => m.role === "user" && blocks(m).some((b) => b.type === "tool_result" && b.tool_use_id === "call_1"));
        const newIdx = umsgs.findIndex((m) => m.role === "user" && blocks(m).some((b) => b.type === "text" && String(b.text).includes("next")));
        assert.ok(toolResultIdx >= 0, `the tool_result block must be present (got: ${JSON.stringify(umsgs).slice(0, 400)})`);
        assert.ok(newIdx >= toolResultIdx, `the NEW client message must come after the tool_result (new=${newIdx} toolResult=${toolResultIdx})`);

        // C. Neither form (2 ids for 5 elements / 6 cores): degrade, never
        //    reject.
        const r3 = await post("/v1/chat/completions", "conv-split", { model: MODEL, stream: false, messages: [...oaiHist, { role: "user", content: "again" }], biliMsgIds: ["x1", "x2"] });
        assert.equal(r3.status, 200, `the no-form turn must degrade to 200 (got ${r3.status}: ${r3.body.slice(0, 200)})`);

        // D. The pi/qwen regression shape: a REASONING conversation on the
        //    openai wire (assistant text + reasoning_content from turn 2
        //    on). The client stamps one host id per element — INCLUDING the
        //    turn-1 response, which the server minted itself last turn. The
        //    egress_state rows must carry EXACTLY the declared host ids
        //    (request ↔ database msgid equality, the reported bug: the rows
        //    fell back to content-hash mints from turn 2 onward). Only the
        //    turn-2 RESPONSE may still be a mint — the host has not declared
        //    it yet (it will, on the next turn).
        const reasonHist1 = [{ role: "user", content: "intro yourself" }];
        const rD1 = await post("/v1/chat/completions", "conv-reason", { model: MODEL, stream: false, messages: reasonHist1, biliMsgIds: ["pi-u1"] });
        assert.equal(rD1.status, 200, `reason turn 1 must succeed (got ${rD1.status}: ${rD1.body.slice(0, 200)})`);
        const reasonHist2 = [
            { role: "user", content: "intro yourself" },
            { role: "assistant", content: "I am the test model.", reasoning_content: "the user asks for an intro" },
            { role: "user", content: "1 + 1?" },
        ];
        const rD2 = await post("/v1/chat/completions", "conv-reason", { model: MODEL, stream: false, messages: reasonHist2, biliMsgIds: ["pi-u1", "pi-a1", "pi-u2"] });
        assert.equal(rD2.status, 200, `reason turn 2 must succeed (got ${rD2.status}: ${rD2.body.slice(0, 200)})`);
        await settle("conv-reason");
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(join(dir, "sessions", "index.db"), { readOnly: true });
        try {
            const rows = db.prepare("SELECT pos, msgid FROM egress_state WHERE session_id = ? ORDER BY pos").all("conv-reason") as Array<{ pos: number; msgid: string }>;
            const ids = rows.map((r) => r.msgid);
            for (const want of ["pi-u1", "pi-a1", "pi-u2"]) {
                // Path A (#7836): a split element's parts share the client
                // element id in the log, so a declared id may appear once
                // per part — present, never absent, and never as a #pN id.
                assert.ok(ids.filter((x) => x === want).length >= 1, `egress_state must carry the declared host id ${want} (rows: ${JSON.stringify(rows)})`);
            }
            assert.ok(!ids.some((x) => x.includes("#p")), `egress_state stores element ids only, no #pN core ids (rows: ${JSON.stringify(rows)})`);
            // The turn-1 response was minted by the server; turn 2's pin
            // re-homes it onto the host's own id for that message — no
            // orphaned mint may survive for a message the host declared.
            const mints = ids.filter((x) => /^h_[0-9a-f]+$/.test(x) || (/^[0-9a-f]{16}$/.test(x)));
            assert.ok(mints.length <= 1, `at most the turn-2 response may still be a mint (rows: ${JSON.stringify(rows)})`);
            // Position order must mirror the conversation order (no
            // drift between wire order and database order).
            const posOf = (msgid: string) => rows.find((r) => r.msgid === msgid)!.pos;
            assert.ok(posOf("pi-u1") < posOf("pi-a1") && posOf("pi-a1") < posOf("pi-u2"), `database order must mirror wire order (rows: ${JSON.stringify(rows)})`);
        } finally {
            db.close();
        }
    } finally {
        setLogCapture(null);
        store?.closeQuietly();
        srv?.closeAllConnections?.();
        await new Promise<void>((resolve) => { if (srv) srv.close(() => resolve()); else resolve(); });
        upstream?.closeAllConnections?.();
        await new Promise<void>((resolve) => { if (upstream) upstream.close(() => resolve()); else resolve(); });
    }
});
