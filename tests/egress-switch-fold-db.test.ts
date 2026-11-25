/**
 * egress-switch-fold-db.test.ts — PR #7684 items 6-8 (deterministic e2e).
 *
 * One session, three wires, two folds, then the DB-level ledger audit:
 *
 *   turn 1  /v1/chat/completions  (MA)  bootstrap c0..c3
 *   turn 2  /v1/chat/completions  (MA)  30 long d0..d29 (each carries all 12
 *            GATE-MARK-xx markers — a content-survival canary)
 *   FOLD 1  plugin tool channel: refs of d0..d14  -> flow-space [5,19]
 *   turn 3  /v1/messages          (MB)  post-fold view (summary + tail + z0)
 *            -> the SWITCH turn: model AND wire change; D-ops delete d0..d14
 *   FOLD 2  plugin tool channel: refs of c0..c3   -> flow-space [1,4]
 *            -> a fold on PRE-SWITCH rows while the lane is already on wire B
 *   turn 4  /v1/responses         (MC)  post-fold-2 view (+ z1)
 *   turn 5  /v1/chat/completions  (MA)  full post view (+ z2) — third switch
 *   rollback (plane OFF, chat MA) -> unified ingest runs again
 *
 * DB-level expectations (owner items 6/7/8: the tables change exactly as
 * expected, no more, no less; folds happen both before and after switches,
 * and switching keeps working after every fold):
 *   - after each turn: the egress live set is EXACT (no missing pins, no
 *     undeleted rows)
 *   - every switch turn's upstream body still carries all 12 markers (the
 *     surviving history physically reached the new wire)
 *   - exactly 3 [lane-switch] lines, correct directions, 0 for the
 *     model-only turn
 *   - the blocks table AND the egress block table hold EXACTLY two rows:
 *     [5,19] and [1,4] — the two folds, nothing else
 */
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
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { peekSession } from "../src/session.ts";

const MA = "sfdb-chat-model";
const MB = "sfdb-msgs-model";
const MC = "sfdb-resp-model";
const SID = "sfdb-sess";
const WINDOW = 100_000;
const MARKERS = Array.from({ length: 12 }, (_, i) => `GATE-MARK-${String(i + 1).padStart(2, "0")}`);

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

/** ACP refs of `markers` (strings) read from the <acp> tags the proxy rendered
 *  into the upstream body. Refs appear immediately before their content. */
function refsByMarkers(body: string, markers: string[]): Map<string, string> {
    const out = new Map<string, string>();
    const refRe = /<acp[^>]*>\s*(m\d+)\s*<\/acp>/g;
    type Ev = { pos: number; ref?: string; marker?: string };
    const evs: Ev[] = [];
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(body)) !== null) evs.push({ pos: m.index, ref: m[1] });
    for (const mk of markers) {
        const re = new RegExp(mk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const mm = body.match(re);
        if (mm && mm.index !== undefined) evs.push({ pos: mm.index, marker: mk });
    }
    evs.sort((a, b) => a.pos - b.pos);
    let lastRef: string | undefined;
    for (const e of evs) {
        if (e.ref) lastRef = e.ref;
        else if (e.marker && lastRef) out.set(e.marker, lastRef);
    }
    return out;
}

test("switch + fold across three wires: exact live sets, folds before AND after switches, DB tables exactly right (#7684 items 6-8)", { timeout: 300_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "sfdb-"));
    test.after(() => { if (!process.env.SFDB_KEEP) rmSync(dir, { recursive: true, force: true }); else console.log(`SFDB_KEEP ${dir}`); });
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_CONFIG_FILE = join(dir, "no-config.json");
    process.env.BILI_STORAGE_UNIFIED = "full";
    process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
    process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = "1";
    const logs: string[] = [];
    setLogCapture((_lvl, m) => { logs.push(m); });
    let store: SessionStore | null = null;
    let srv: http.Server | null = null;
    let upstream: http.Server | null = null;
    let lastUpstreamBody = "";
    try {
        setRegistryForTest({});
        store = new SessionStore({ dir: join(dir, "sessions"), enabled: true, debounceMs: 15 });
        _setStoreForTest(store);
        upstream = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => {
                lastUpstreamBody = Buffer.concat(chunks).toString("utf8");
                const seen = MARKERS.filter((mk) => lastUpstreamBody.includes(mk)).length;
                const model = (() => { try { return (JSON.parse(lastUpstreamBody)?.model as string) ?? "?"; } catch { return "?"; } })();
                const json = req.url.includes("/v1/messages")
                    ? { id: "sfdb-m", type: "message", role: "assistant", model, content: [{ type: "text", text: `MARKERS: ${seen}` }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } }
                    : req.url.startsWith("/v1/responses")
                        ? { id: "sfdb-r", object: "response", model, status: "completed", output: [{ type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: `MARKERS: ${seen}`, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2 } }
                        : { id: "sfdb-c", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: `MARKERS: ${seen}` }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify(json));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: llmUrl,
            routes: { [llmUrl]: { models: { [MA]: { context: WINDOW }, [MB]: { context: WINDOW }, [MC]: { context: WINDOW } } } },
            modelContextLimit: WINDOW, kernelConfig: defaultConfig(WINDOW, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
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
        const post = async (path: string, body: Record<string, unknown>): Promise<{ status: number; body: string }> => {
            const resp = await fetch(`${base}${path}`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": SID, "x-acp-session": SID },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(120_000),
            });
            return { status: resp.status, body: await resp.text() };
        };
        const settle = async (): Promise<void> => {
            const race = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
            assert.equal(await race(store!.afterNextFlush(SID), 20_000), true, "first debounced flush landed");
            assert.equal(await race(store!.afterNextFlush(SID), 20_000), true, "second flush settled");
        };
        let lastFoldText = "";
        const fold = async (startRef: string, endRef: string, topic: string, summary: string): Promise<void> => {
            const r = await fetch(`${base}/__bili/plugin/tool`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": SID },
                body: JSON.stringify({ conversationId: SID, tool: "compress", args: { content: [{ startId: startRef, endId: endRef, topic, summary }] } }),
                signal: AbortSignal.timeout(60_000),
            });
            lastFoldText = await r.text();
            assert.equal(r.status, 200, `plugin tool channel fold -> ${r.status}: ${lastFoldText.slice(0, 300)}`);
            await settle();
        };
        const live = () => (store!.egressOpLogStore()?.egressStateView(SID) ?? []).filter((v) => v.msgid !== "egress-system").map((v) => v.msgid);
        const expectLive = (expected: string[], label: string): void => {
            const now = live();
            const missing = expected.filter((id) => !now.includes(id));
            const extra = now.filter((id) => !expected.includes(id));
            assert.deepEqual(missing, [], `${label}: missing ids (live: ${now.join(",")})`);
            assert.deepEqual(extra, [], `${label}: undeleted rows (live: ${now.join(",")})`);
        };
        const switchLines = (mark: number): string[] => logs.slice(mark).filter((l) => l.includes("[lane-switch]") && l.includes(SID));
        const switchMark = () => logs.length;

        const short: Array<{ role: string; content: string }> = [];
        for (let i = 0; i < 4; i++) short.push({ role: i % 2 ? "assistant" : "user", content: `short ${i}: ${"a".repeat(1500)}` });
        const long: Array<{ role: string; content: string }> = [];
        for (let i = 0; i < 30; i++) long.push({ role: i % 2 ? "assistant" : "user", content: `long ${i}: ${"x".repeat(500)} ${MARKERS.join(" ")}` });
        const tail = long.slice(15); // d15..d29
        const summaryText = (what: string) => `fold summary ${what}; surviving markers: ${MARKERS.join(" ")}`;

        // ---- turn 1: chat wire bootstrap ----------------------------------
        const r1 = await post("/v1/chat/completions", { model: MA, stream: false, max_tokens: 1024, messages: short, biliMsgIds: ["c0", "c1", "c2", "c3"] });
        assert.equal(r1.status, 200, `turn 1 -> ${r1.status}: ${r1.body.slice(0, 200)}`);
        await settle();
        expectLive(["c0", "c1", "c2", "c3"], "after turn 1");

        // ---- turn 2: 30 long marker-bearing d-messages --------------------
        const r2 = await post("/v1/chat/completions", { model: MA, stream: false, max_tokens: 1024, messages: [...short, ...long], biliMsgIds: ["c0", "c1", "c2", "c3", ...long.map((_, i) => `d${i}`)] });
        assert.equal(r2.status, 200, `turn 2 -> ${r2.status}: ${r2.body.slice(0, 200)}`);
        const turn2Body = lastUpstreamBody;
        await settle();
        expectLive(["c0", "c1", "c2", "c3", ...long.map((_, i) => `d${i}`)], "after turn 2");
        assert.equal(switchLines(0).length, 0, `model-only stays silent (no lane-switch lines: ${switchLines(0)})`);

        // ---- FOLD 1: d0..d14 (flow [5,19]) via the plugin channel ---------
        const refs2 = refsByMarkers(lastUpstreamBody, ["long 0: ", "long 14: "]);        assert.ok(refs2.get("long 0: ") && refs2.get("long 14: "), `refs for the fold ends rendered on the upstream body`);
        const m1 = switchMark();
        await fold(refs2.get("long 0: ")!, refs2.get("long 14: ")!, "pre-switch fold", summaryText("d0..d14"));
        const peekBlocks = (): Array<{ blockId: string; startSeq?: number; endSeq?: number }> =>
            (peekSession(SID)?.state?.blocks ?? []) as Array<{ blockId: string; startSeq?: number; endSeq?: number }>;
        const kf1 = peekBlocks().find((b) => b.startSeq === 5 && b.endSeq === 19);
        assert.ok(kf1, `fold 1 attested [5,19] (kernel blocks: ${JSON.stringify(peekBlocks().map((b) => [b.startSeq, b.endSeq]))}) | fold resp: ${lastFoldText.slice(0, 500)} | logs: ${logs.filter((l) => /fold|compress|block|ingest|egress|ref|stamp/i.test(l)).slice(-16).join(" | ").slice(0, 2500)}`);
        console.log(`  ✓ fold 1 (pre-switch) attested [5,19]`);

        // ---- turn 3: THE SWITCH — anthropic wire + model B, post-fold view -
        // the host's post-fold view keeps everything it still holds: c0..c3
        // (fold 1 did NOT cover them) + the fold summary + the tail + z0.
        const m2 = switchMark();
        const a3msgs: Array<Record<string, unknown>> = [
            ...short.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] })),
            { role: "user", content: [{ type: "text", text: summaryText("d0..d14") }] },
            ...tail.map((m) => ({ role: m.role, content: [{ type: "text", text: m.content }] })),
            { role: "user", content: [{ type: "text", text: `z0 recall: ${MARKERS.join(" ")}` }] },
        ];
        const r3 = await post("/v1/messages", { model: MB, stream: false, max_tokens: 1024, messages: a3msgs, biliMsgIds: ["c0", "c1", "c2", "c3", "s0", ...tail.map((_, i) => `d${15 + i}`), "z0"] });
        assert.equal(r3.status, 200, `switch turn (anthropic, MB) -> ${r3.status}: ${r3.body.slice(0, 300)}`);
        await settle();
        expectLive(["c0", "c1", "c2", "c3", "s0", ...tail.map((_, i) => `d${15 + i}`), "z0"], "after the switch turn (D-ops deleted d0..d14, c0..c3 survived fold 1)");
        assert.ok(r3.body.includes("MARKERS: 12"), `all 12 markers physically reached the anthropic wire (${r3.body.slice(0, 120)})`);
        const ls2 = switchLines(m2);
        assert.equal(ls2.length, 1, `exactly one [lane-switch] line for the switch turn: ${ls2}`);
        assert.ok(ls2[0].includes("anthropic"), `the line names the target wire: ${ls2[0]}`);

        // ---- FOLD 2: the PRE-SWITCH rows c0..c3 (flow [1,4]) ---------------
        // their refs were minted when turn 2 (chat wire) rendered them; flow
        // numbers are stable kernel citations, so they stay valid cross-turn.
        const refs3 = refsByMarkers(turn2Body, ["short 0: ", "short 3: "]);
        assert.ok(refs3.get("short 0: ") && refs3.get("short 3: "), `refs for c0..c3 rendered on the ANTHROPIC upstream body`);
        await fold(refs3.get("short 0: ")!, refs3.get("short 3: ")!, "post-switch fold", summaryText("c0..c3"));
        const kf2 = peekBlocks().find((b) => b.startSeq === 1 && b.endSeq === 4);
        assert.ok(kf2, `fold 2 (on pre-switch rows, post-switch lane) attested [1,4] (kernel blocks: ${JSON.stringify(peekBlocks().map((b) => [b.startSeq, b.endSeq]))}) | fold resp: ${lastFoldText.slice(0, 500)}`);
        console.log(`  ✓ fold 2 (post-switch, pre-switch rows) attested [1,4]`);

        // ---- turn 4: responses wire + model C, post-fold-2 view -----------
        const m3 = switchMark();
        const r4input: Array<Record<string, unknown>> = [
            { role: "user", content: summaryText("c0..c3") },
            { role: "user", content: summaryText("d0..d14") },
            ...tail.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: "z0 recall" },
            { role: "user", content: `z1 recall: ${MARKERS.join(" ")}` },
        ];
        const r4 = await post("/v1/responses", { model: MC, stream: false, max_output_tokens: 1024, input: r4input, biliMsgIds: ["s1", "s0", ...tail.map((_, i) => `d${15 + i}`), "z0", "z1"] });
        assert.equal(r4.status, 200, `second switch turn (responses, MC) -> ${r4.status}: ${r4.body.slice(0, 300)}`);
        await settle();
        expectLive(["s1", "s0", ...tail.map((_, i) => `d${15 + i}`), "z0", "z1"], "after turn 4 (fold 2's D-ops deleted c0..c3)");
        assert.ok(r4.body.includes("MARKERS: 12"), `markers survived onto the responses wire (${r4.body.slice(0, 120)})`);
        assert.equal(switchLines(m3).length, 1, `one [lane-switch] line for the second switch`);

        // ---- turn 5: back to the chat wire, full post view ----------------
        const m4 = switchMark();
        const r5 = await post("/v1/chat/completions", {
            model: MA, stream: false, max_tokens: 1024,
            messages: [
                { role: "user", content: summaryText("c0..c3") },
                { role: "user", content: summaryText("d0..d14") },
                ...tail, { role: "user", content: "z0 recall" }, { role: "user", content: `z1 recall: ${MARKERS.join(" ")}` },
                { role: "user", content: `z2 final: ${MARKERS.join(" ")}` },
            ],
            biliMsgIds: ["s1", "s0", ...tail.map((_, i) => `d${15 + i}`), "z0", "z1", "z2"],
        });
        assert.equal(r5.status, 200, `third switch turn (back to chat) -> ${r5.status}: ${r5.body.slice(0, 300)}`);
        await settle();
        expectLive(["s1", "s0", ...tail.map((_, i) => `d${15 + i}`), "z0", "z1", "z2"], "after turn 5");
        assert.ok(r5.body.includes("MARKERS: 12"), `markers survived the round trip back to chat (${r5.body.slice(0, 120)})`);
        assert.equal(switchLines(m4).length, 1, `one [lane-switch] line for the third switch`);
        assert.equal(switchLines(0).length, 3, `exactly 3 lane-switch lines over the whole session: ${switchLines(0)}`);

        // ---- rollback: plane OFF -> unified ingest, then audit the tables -
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
        const r6 = await post("/v1/chat/completions", {
            model: MA, stream: false, max_tokens: 1024,
            messages: [
                { role: "user", content: summaryText("c0..c3") },
                { role: "user", content: summaryText("d0..d14") },
                ...tail, { role: "user", content: "z0 recall" }, { role: "user", content: `z1 recall: ${MARKERS.join(" ")}` }, { role: "user", content: `z2 final: ${MARKERS.join(" ")}` },
                { role: "user", content: `rb0 after rollback: ${MARKERS.join(" ")}` },
            ],
            biliMsgIds: ["s1", "s0", ...tail.map((_, i) => `d${15 + i}`), "z0", "z1", "z2", "rb0"],
        });
        assert.equal(r6.status, 200, `rollback turn -> ${r6.status}: ${r6.body.slice(0, 300)}`);
        await settle();

        const dbv = openSqliteDatabase(join(dir, "sessions", "index.db")).db;
        const blockRows = dbv.prepare("SELECT start_seq, end_seq, active FROM blocks WHERE session_id = ? ORDER BY start_seq").all(SID) as Array<{ start_seq: number; end_seq: number; active: number }>;
        dbv.close();
        assert.deepEqual(blockRows.map((r) => [r.start_seq, r.end_seq]), [[1, 4], [5, 19]], `the blocks table holds EXACTLY the two fold rows, nothing else (rows: ${JSON.stringify(blockRows)})`);
        // active: the kernel deactivates a block whose folded messages are gone
        // AND whose summary is not visible under the kernel's summary binding
        // (kernel/src/sync.ts stillPresent check). A synthetic host re-sends its
        // own summary ids (s0/s1), not the kernel-bound summary messages, so
        // both blocks legitimately report active=0 here while their rows stay
        // for decompress. Real plugin-channel hosts bind the summary and keep
        // the block active — that interleave is the gate Lane W / real-agent
        // territory. Coordinates are the audited fact either way.
        console.log(`  ✓ blocks table: exactly ${JSON.stringify(blockRows.map((r) => [r.start_seq, r.end_seq, r.active]))}`);

        const eview = [...(store!.egressOpLogStore()!.egressBlockView(SID).values())].map((b) => [b.startSeq, b.endSeq] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        assert.deepEqual(eview, [[1, 4], [5, 19]], `the egress block table matches: exactly the two folds (rows: ${JSON.stringify(eview)})`);
        console.log(`  ✓ egress block table: exactly ${JSON.stringify(eview)}`);
    } finally {
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
        setLogCapture(null);
        store?.closeQuietly();
        srv?.closeAllConnections?.();
        await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
        await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    }
});
