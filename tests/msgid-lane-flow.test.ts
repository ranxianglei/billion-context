// #4491 lane-flow stakes for msgid pinning: the msgid-pin/msgid-algebra/
// plugin-render-endpoint suites pin validation, the pure algebra and the
// render endpoint in isolation; this file pins the FULL turn flow with
// client ids riding the body (`msgIds` parallel array) — the behaviors the
// 409-loop contract and the #4390 historian row discipline depend on.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { __resetIncrementalLaneForTests } from "../src/incremental-lane.ts";

const testRoot = mkdtempSync(join(tmpdir(), "msgid-lane-"));
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

interface Turn {
    sinceSeq: number;
    messages: unknown[];
    msgIds?: string[];
    resync?: boolean;
}

interface Harness {
    turn: (t: Turn) => Promise<{ status: number; body: unknown; appliedSeq?: number }>;
    forwarded: Record<string, unknown>[];
    rows: () => { seq: number; msgId: string; content: string }[];
    close: () => Promise<void>;
}

async function harness(pin: boolean): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    // #4491: the rollout gate (default 0%). The lane accepts msgIds and pins
    // the in-memory canonical either way; only with the feature ON does the
    // assembled body re-stamp biliMsgIds so the pipeline session (and the
    // unified rows) carry the client ids too — the full end-to-end pin.
    if (pin) process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY = "1";
    else delete process.env.BILI_ROLLOUT_PLUGIN_LANE_SERVER_HISTORY;
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = "full";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetIncrementalLaneForTests();
    const store = new SessionStore({ dir: dir + "/sessions", enabled: true, debounceMs: 60000 });
    _setStoreForTest(store);
    _setForTest({});
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 10000, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: 400000 } } } }, modelContextLimit: 400000, kernelConfig: defaultConfig(400000), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const turn = async (t: Turn) => {
        const response = await fetch(`${proxyUrl}/__bili/plugin/turn`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin": "dsh", "x-bili-plugin-conversation": "conv-msgid-1" },
            body: JSON.stringify({ conversationId: "conv-msgid-1", sinceSeq: t.sinceSeq, ...(t.resync ? { resync: true } : {}), ...(t.msgIds !== undefined ? { msgIds: t.msgIds } : {}), path: "/v1/messages", request: { model: "claude-test", max_tokens: 1024 }, messages: t.messages }),
        });
        const body: unknown = await response.json().catch(() => null);
        const applied = response.headers.get("x-bili-applied-seq");
        return { status: response.status, body, appliedSeq: applied !== null && /^\d+$/.test(applied) ? Number(applied) : undefined };
    };
    // the lane acks after its own immediate flush, so rows are on disk by
    // the time the turn responds; message bytes live in the CAS (content
    // table) keyed by messages.content_hash — the messages table has no
    // content column (#4390 schema shape).
    const rows = (): { seq: number; msgId: string; content: string }[] => {
        const db = new DatabaseSync(join(dir, "sessions", "index.db"), { readOnly: true });
        try {
            const stmt = db.prepare("SELECT m.seq AS seq, m.msg_id AS msg_id, c.bytes AS bytes FROM messages m JOIN content c ON c.hash = m.content_hash WHERE m.session_id = ? ORDER BY m.seq");
            const raw = stmt.all("conv-msgid-1") as unknown as { seq: number; msg_id: string; bytes: Uint8Array }[];
            return raw.map((r) => ({ seq: r.seq, msgId: r.msg_id, content: Buffer.from(r.bytes).toString("utf8") }));
        } finally {
            db.close();
        }
    };
    return { turn, forwarded, rows, close: async () => { await new Promise<void>((resolve) => proxy.close(() => resolve())); store.closeQuietly(); await new Promise<void>((resolve) => upstream.close(() => resolve())); } };
}

const wmsg = (text: string) => ({ role: "user", content: [{ type: "text", text: text.repeat(200) }] });
const umsg = (text: string) => ({ role: "user", content: [{ type: "text", text: text }] });
const amsg = (text: string) => ({ role: "assistant", content: [{ type: "text", text: text }] });

test("msgid lane flow: pin carries client ids into rows; edits append fresh rows (no swap, no 409)", async () => {
    const h = await harness(true);
    try {
        // seed with client ids
        const seed = await h.turn({ sinceSeq: 0, resync: true, msgIds: ["u1", "a1", "u2"], messages: [umsg("alpha"), amsg("beta"), umsg("gamma")] });
        assert.equal(seed.status, 200);
        assert.equal(seed.appliedSeq, 3);
        let rows = h.rows();
        assert.equal(rows.length, 3, "seed lands three rows");
        assert.deepEqual(rows.map((r) => r.msgId).sort(), ["a1", "u1", "u2"], "rows carry the CLIENT ids (pin), not content hashes");
        const seqU1 = rows.find((r) => r.msgId === "u1")?.seq;

        // resync #2: u1 EDITED (same id, new bytes), u2 deleted
        const second = await h.turn({ sinceSeq: 3, resync: true, msgIds: ["u1", "a1"], messages: [umsg("alpha-edited"), amsg("beta")] });
        assert.equal(second.status, 200, "edit resync must not 409");
        assert.equal(second.appliedSeq, 2);
        rows = h.rows();
        assert.equal(rows.length, 4, "an edit lands as a FRESH row (append-only discipline; the old generation stays)");
        const editedRow = rows.find((r) => r.msgId === "u1" && r.content.includes("alpha-edited"));
        assert.ok(editedRow, "fresh row carries the edited bytes under the same client id");
        assert.notEqual(editedRow.seq, seqU1, "fresh row gets a NEW seq — never a swap onto the old one (409-loop contract)");
        assert.ok(rows.some((r) => r.seq === seqU1 && r.content.includes("alpha")), "old generation row keeps its original bytes (historian)");

        // the upstream body never leaks the pin transport
        const last = h.forwarded.at(-1) as { biliMsgIds?: unknown; messages: unknown[] } | undefined;
        assert.ok(last, "forward happened");
        assert.equal(last.biliMsgIds, undefined, "biliMsgIds is stripped before the upstream (pipeline-owned transport)");
        assert.equal(last.messages.length, 2, "assembled body = the new branch");
    } finally {
        await h.close();
    }
});

test("msgid lane flow: undo→redo with identical content revives at the original seq (identity join, zero new rows)", async () => {
    const h = await harness(true);
    try {
        const seed = await h.turn({ sinceSeq: 0, resync: true, msgIds: ["u1", "a1", "u2"], messages: [umsg("alpha"), amsg("beta"), umsg("gamma")] });
        assert.equal(seed.status, 200);
        const rows0 = h.rows();
        assert.equal(rows0.length, 3);

        // undo: the client's view drops the tail
        const undo = await h.turn({ sinceSeq: 3, resync: true, msgIds: ["u1"], messages: [umsg("alpha")] });
        assert.equal(undo.status, 200);
        // redo: the SAME ids and bytes come back
        const redo = await h.turn({ sinceSeq: 1, resync: true, msgIds: ["u1", "a1", "u2"], messages: [umsg("alpha"), amsg("beta"), umsg("gamma")] });
        assert.equal(redo.status, 200);
        assert.equal(redo.appliedSeq, 3);
        const rows2 = h.rows();
        assert.equal(rows2.length, 3, "identical content re-observed under the same ids joins the ORIGINAL rows — no duplicates (#4390 discipline)");
        assert.deepEqual(rows2.map((r) => r.seq).sort(), rows0.map((r) => r.seq).sort(), "seqs unchanged across undo→redo");
    } finally {
        await h.close();
    }
});

test("msgid lane flow: a delta re-claiming a live canonical id hard-fails (400), fresh ids append", async () => {
    const h = await harness(true);
    try {
        const seed = await h.turn({ sinceSeq: 0, resync: true, msgIds: ["u1"], messages: [wmsg("seed")] });
        assert.equal(seed.status, 200);
        // delta tries to re-claim u1 (already in the canonical) — a non-resync
        // delta appends, so an existing id means the client is confused or the
        // ids collide; poison refuses rather than misattribute.
        const bad = await h.turn({ sinceSeq: 1, msgIds: ["u1"], messages: [amsg("reply")] });
        assert.equal(bad.status, 400);
        assert.ok(JSON.stringify(bad.body).includes("reuse"), `body explains the refusal: ${JSON.stringify(bad.body)}`);
        // the canonical survives the refused turn intact
        const good = await h.turn({ sinceSeq: 1, msgIds: ["a1", "u2"], messages: [amsg("reply"), umsg("next")] });
        assert.equal(good.status, 200);
        assert.equal(good.appliedSeq, 3);
        const rows = h.rows();
        assert.deepEqual(rows.map((r) => r.msgId).sort(), ["a1", "u1", "u2"], "delta ids append onto the pinned canonical");
    } finally {
        await h.close();
    }
});

test("msgid lane flow: divergent resync with ids then a delta — no 409 loop (branch tip stays monotonic)", async () => {
    const h = await harness(true);
    try {
        const seed = await h.turn({ sinceSeq: 0, resync: true, msgIds: ["u1", "a1", "u2"], messages: [umsg("alpha"), amsg("beta"), umsg("gamma")] });
        assert.equal(seed.status, 200);
        // divergent branch: only an edited u1
        const divergent = await h.turn({ sinceSeq: 3, resync: true, msgIds: ["u1"], messages: [umsg("alpha-edited")] });
        assert.equal(divergent.status, 200, "divergent resync accepted");
        // the very next delta must NOT hit seq-mismatch: the edited message
        // appended past the recorded base-seq, so the rebuilt tip moves
        // forward, never backward (the swap-onto-old-seq trap is gone).
        const delta = await h.turn({ sinceSeq: 1, msgIds: ["u3"], messages: [umsg("carrying on")] });
        assert.equal(delta.status, 200, "no 409 loop after a divergent resync with ids");
        assert.ok((delta.appliedSeq ?? 0) >= 1, "tip is monotonic");
        const rows = h.rows();
        assert.equal(rows.filter((r) => r.msgId === "u1").length, 2, "both u1 generations live in the durable log (historian)");
    } finally {
        await h.close();
    }
});

test("msgid lane flow: turns without msgIds stay on content-derived identities (control case)", async () => {
    const h = await harness(false);
    try {
        const seed = await h.turn({ sinceSeq: 0, resync: true, messages: [umsg("alpha"), amsg("beta")] });
        assert.equal(seed.status, 200);
        const rows = h.rows();
        assert.equal(rows.length, 2);
        for (const r of rows) assert.ok(!["alpha", "beta", "u1", "a1"].includes(r.msgId), `unpinned ids stay content-derived: ${r.msgId}`);
        const last = h.forwarded.at(-1) as { biliMsgIds?: unknown } | undefined;
        assert.equal(last?.biliMsgIds, undefined, "no pin transport on id-less turns");
    } finally {
        await h.close();
    }
});
