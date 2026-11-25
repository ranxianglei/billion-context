/** C6 e2e (PR #7684): the flow-space seq authority over the REAL pipeline.
 *
 *  The unit test (c6-egress-seq-authority) drives the seam directly; this file
 *  drives a live proxy the way a real pinned plugin host does: plane ON,
 *  wire-aligned host ids, and a REAL fold through the production plugin
 *  channel — the model answers turn 2 with a `compress` tool call, the host
 *  relays it to POST /__bili/plugin/tool, and the proxy (the single
 *  compression authority) executes it on the stamped cores. Then it checks
 *  the two surfaces a switching host and a rollback actually read:
 *
 *   1. the egress flow numbers the messages 1-based (system row = 1, first
 *      real message = 2) — the same space ledgerSeq always used;
 *   2. the committed fold block carries the EXACT flow-space interval of
 *      what it covered (startSeq/endSeq = the covered messages' flow
 *      numbers — pre-fix the covered ids never existed in the frozen
 *      unified-index table, so the coordinates degraded to [-1,-1]);
 *   3. when the plane flips OFF (rollback), unified ingest runs again and
 *      the sqlite `blocks` table row lands on the SAME coordinates.
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
import { openSqliteDatabase } from "../src/storage/driver.ts";
import { peekSession } from "../src/session.ts";

const MODEL = "fold-coords-model";
const SID = "fold-coords-sess";
const WINDOW = 100_000;
const FOLD_N = 15; // d0..d14 get folded (flow numbers 6..20); d15..d29 stay as the recency buffer

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

/** Map the "long <i>:" messages to their ACP refs, read from the <acp> tags
 *  the proxy rendered into the request body (the same way the model/host
 *  reads them). Refs appear immediately before their message's content. */
function refByLongMarker(body: string): Map<number, string> {
    const out = new Map<number, string>();
    const refRe = /<acp[^>]*>\s*(m\d+)\s*<\/acp>/g;
    const msgRe = /long (\d+): [x]{10}/g;
    type Ev = { pos: number; ref?: string; i?: number };
    const evs: Ev[] = [];
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(body)) !== null) evs.push({ pos: m.index, ref: m[1] });
    while ((m = msgRe.exec(body)) !== null) evs.push({ pos: m.index, i: Number(m[1]) });
    evs.sort((a, b) => a.pos - b.pos);
    let lastRef: string | undefined;
    for (const e of evs) {
        if (e.ref) lastRef = e.ref;
        else if (e.i !== undefined && lastRef) out.set(e.i, lastRef);
    }
    return out;
}

test("egress flow: a fold carries its EXACT flow-space coordinates through the real pipeline — 1-based numbering, kernel-attested fold bounds, and the rollback re-ingest (#7439)", { timeout: 180_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-fold-coords-"));
    test.after(() => { if (!process.env.FOLD_COORDS_KEEP) rmSync(dir, { recursive: true, force: true }); else console.log(`FOLD_COORDS_KEEP ${dir}`); });
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
                const raw = Buffer.concat(chunks).toString("utf8");
                lastUpstreamBody = raw;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "c6e", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
            });
        });
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const llmUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        const opts: ProxyOptions = {
            port: 0, host: "127.0.0.1", upstream: llmUrl,
            routes: { [llmUrl]: { models: { [MODEL]: { context: WINDOW } } } },
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
        const post = async (body: Record<string, unknown>): Promise<{ status: number; body: string }> => {
            const resp = await fetch(`${base}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": SID, "x-acp-session": SID },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(60_000),
            });
            return { status: resp.status, body: await resp.text() };
        };
        const settle = async (): Promise<void> => {
            const race = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), ms))]);
            assert.equal(await race(store!.afterNextFlush(SID), 20_000), true, "first debounced flush landed");
            assert.equal(await race(store!.afterNextFlush(SID), 20_000), true, "second flush settled");
        };
        const live = () => (store!.egressOpLogStore()?.egressStateView(SID) ?? []);

        // ---- turn 1: a small pinned history (4 messages) ------------------
        const t1: Array<{ role: string; content: string }> = [];
        for (let i = 0; i < 4; i++) t1.push({ role: i % 2 ? "assistant" : "user", content: `short ${i}: ${"a".repeat(60)}` });
        const r1 = await post({ model: MODEL, stream: false, max_tokens: 1024, messages: t1, biliMsgIds: ["c0", "c1", "c2", "c3"] });
        assert.equal(r1.status, 200, `turn 1 -> ${r1.status}: ${r1.body.slice(0, 200)}`);
        await settle();
        const v1 = live().filter((v) => v.msgid !== "egress-system");
        assert.deepEqual(v1.map((v) => v.msgid), ["c0", "c1", "c2", "c3"], `the pinned ids are the flow (${v1.map((v) => v.msgid).join(",")})`);
        const sys = live().find((v) => v.msgid === "egress-system");
        assert.equal(sys?.num, 1, `the system row holds num 1 (got ${sys?.num})`);
        assert.deepEqual(v1.map((v) => v.num), [2, 3, 4, 5], `messages are numbered 1-based right after the system row (got ${v1.map((v) => v.num).join(",")})`);

        // ---- turn 2: the full history arrives; the MODEL asks for a fold --
        // (a real switching/compacting host relays the model's compress
        // call to the plugin tool channel)
        const big: Array<{ role: string; content: string }> = [];
        for (let i = 0; i < 30; i++) big.push({ role: i % 2 ? "assistant" : "user", content: `long ${i}: ${"x".repeat(690)}` });
        const r2 = await post({ model: MODEL, stream: false, max_tokens: 1024, messages: [...t1, ...big], biliMsgIds: ["c0", "c1", "c2", "c3", ...big.map((_, i) => `d${i}`)] });
        assert.equal(r2.status, 200, `turn 2 -> ${r2.status}: ${r2.body.slice(0, 300)}`);
        await settle();

        const refs = refByLongMarker(lastUpstreamBody);
        const startRef = refs.get(0);
        const endRef = refs.get(FOLD_N - 1);
        assert.ok(startRef && endRef, `the proxy rendered ACP refs onto the folded messages (got ${[...refs.entries()].slice(0, 4).map(([i, r]) => `${i}:${r}`).join(",")})`);

        // The host relays the model's compress call through the plugin tool
        // channel — the production fold path for cooperative plugin hosts.
        const fold = await fetch(`${base}/__bili/plugin/tool`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": SID },
            body: JSON.stringify({
                conversationId: SID,
                tool: "compress",
                args: { content: [{ startId: startRef, endId: endRef, topic: "fold coords", summary: "Folded the fifteen long d-messages d0 through d14; their ledger-audit filler carries no decisions, only volume, so the rest of the conversation stays authoritative." }] },
            }),
            signal: AbortSignal.timeout(60_000),
        });
        const foldText = await fold.text();
        assert.equal(fold.status, 200, `plugin tool channel fold -> ${fold.status}: ${foldText.slice(0, 300)}`);
        await settle();

        // The fold covered d0..d14 — whose FLOW numbers are 6..20
        // (system=1, c0..c3 = 2..5, d0 = 6). The kernel attested exactly
        // that interval onto the block when it executed the call on the
        // stamped cores. Pre-fix the same fold landed [-1,-1] because
        // those ids never existed in the frozen unified-index table.
        const v3 = live().filter((v) => v.msgid !== "egress-system");
        const numOf = new Map(v3.map((v) => [v.msgid, v.num]));
        assert.equal(numOf.get("d0"), 6, `d0 holds flow number 6 (got ${numOf.get("d0")})`);
        assert.equal(numOf.get("d14"), 20, `d14 holds flow number 20 (got ${numOf.get("d14")})`);

        // While the plane is ON the session's live authority is the kernel
        // state itself (the unified-index projection is FROZEN — #7474 P2):
        // the fold's block lives there, and the flow-space stamp is what the
        // kernel used to attest its interval. Pre-fix the covered ids never
        // existed in the frozen unified-index table, so no seq space was left
        // on the block (startSeq/endSeq unset).
        const kernelBlocks = (peekSession(SID)?.state?.blocks ?? []) as Array<{ blockId: string; startSeq?: number; endSeq?: number; active: boolean; directMessageIds: string[] }>;
        if (kernelBlocks.length === 0 || (kernelBlocks[0]?.startSeq ?? -1) < 2) {
            console.log("FOLD-COORDS-DEBUG kernel blocks:", JSON.stringify(kernelBlocks.map((b) => [b.blockId, b.startSeq, b.endSeq, b.active, b.directMessageIds?.length])));
        }
        const kblk = kernelBlocks.find((b) => b.startSeq === 6 && b.endSeq === 20);
        assert.ok(kblk, `the fold attested the EXACT flow-space interval of d0..d14 — [6,20] (kernel blocks: ${JSON.stringify(kernelBlocks.map((b) => [b.blockId, b.startSeq, b.endSeq]))})`);
        console.log(`  ✓ plugin-channel fold attested flow-space interval [${kblk.startSeq},${kblk.endSeq}] over ${kblk.directMessageIds.length} direct messages`);

        // ---- turn 3: the host resends the post-fold view (summary + tail) -
        // (the production interleave: the NEXT egress turn is what lands the
        // fold's D batch + summary I row in the flow — and the block's row in
        // the egress block table lands at the next unified save, which for an
        // egress-on session is the rollback turn below)
        const tail = big.slice(FOLD_N);
        const r3 = await post({
            model: MODEL, stream: false, max_tokens: 1024,
            messages: [
                { role: "user", content: "The fifteen long messages d0-d14 were folded into a summary." },
                ...tail,
                { role: "user", content: "next" },
            ],
            biliMsgIds: ["s0", ...tail.map((_, i) => `d${FOLD_N + i}`), "z0"],
        });
        assert.equal(r3.status, 200, `turn 3 (post-fold view) -> ${r3.status}: ${r3.body.slice(0, 300)}`);
        await settle();

        // ---- rollback: plane OFF → unified ingest runs again --------------
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "0";
        const r4 = await post({ model: MODEL, stream: false, max_tokens: 1024, messages: [{ role: "user", content: "after rollback" }], biliMsgIds: ["rb0"] });
        assert.equal(r4.status, 200, `rollback turn -> ${r4.status}: ${r4.body.slice(0, 300)}`);
        await settle();
        const readBlocksTable = (): Array<{ start_seq: number; end_seq: number; active: number }> => {
            const dbv = openSqliteDatabase(join(dir, "sessions", "index.db")).db;
            const rows = dbv.prepare("SELECT start_seq, end_seq, active FROM blocks WHERE session_id = ?").all(SID) as Array<{ start_seq: number; end_seq: number; active: number }>;
            dbv.close();
            return rows;
        };
        const rows = readBlocksTable();
        assert.ok(rows.length >= 1, `the rollback re-ingest kept the fold block in the blocks table (rows: ${JSON.stringify(rows)})`);
        assert.ok(rows.some((r) => r.start_seq === 6 && r.end_seq === 20), `the table row carries the SAME flow-space coordinates the fold attested ([6,20]; rows: ${JSON.stringify(rows)})`);
        console.log(`  ✓ rollback re-ingest: blocks table keeps the flow-space coordinates (${JSON.stringify(rows)})`);
        const eview = [...(store!.egressOpLogStore()!.egressBlockView(SID).values())];
        if (eview.length === 0) {
            console.log("FOLD-COORDS-DEBUG egressBlockView empty | logs:", logs.filter((l) => /fold|compress|block|ingest|egress/i.test(l)).slice(-12).join(" | ").slice(0, 1400));
        }
        const blk = eview.find((b) => b.startSeq === 6 && b.endSeq === 20);
        assert.ok(blk, `the rollback unified save landed the fold block in the egress block table with the SAME flow-space coordinates ([6,20]; egress blocks: ${JSON.stringify(eview.map((b) => [b.startMsgid, b.startSeq, b.endMsgid, b.endSeq]))})`);
    } finally {
        process.env.BILI_ROLLOUT_EGRESS_PLANE = "1";
        setLogCapture(null);
        store?.closeQuietly();
        srv?.closeAllConnections?.();
        await new Promise<void>((r) => (srv ? srv.close(() => r()) : r()));
        await new Promise<void>((r) => (upstream ? upstream.close(() => r()) : r()));
    }
});
