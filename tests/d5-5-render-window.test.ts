// D5-5 — render-lane read amplification. The snapshot-render source loads
// EVERY transcript row with content bytes + media hydration on EVERY request
// (store.getMessages), while covered rows' bytes never ride the outbound —
// they are suppressed behind summary anchors. On big folded sessions this is
// thousands of rows × content + base64 media hydration per request.
//
// Contract staked BEFORE the fix (打桩):
//
//  1. On a render turn (mid-list fold + live tail), the buildView path must
//     load ONLY the uncovered window: the full-content loader
//     (unifiedTailViewRows) must NOT be called during the request; the
//     windowed reads (identity rows + uncovered content rows) must be.
//  2. Covered rows' bytes are never read — corrupting a COVERED row's content
//     in the store (bad JSON in the CAS) must NOT degrade the render: the
//     turn still renders server-authoritative (summary anchor + original
//     prefix + tail). Before the fix this degrades (row-unparsable) because
//     the loader parses every row including covered ones.
//  3. The rendered outbound stays complete: original uncovered prefix rows,
//     the mid-list summary anchor, suppressed covered rows, live tail.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BILI_PERSIST_ZSTD = "0";
// The D-lane renders from the unified store's tail view — its sidecar must be
// open (see tests/snapshot-render.test.ts for the #3771 note on ambient env).
process.env.BILI_STORAGE_UNIFIED = "shadow";
process.env.BILI_CONFIG_FILE = path.join(mkdtempSync(path.join(tmpdir(), "bili-d55-hermetic-")), "no-config.json");

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { rmrf } from "./tmp-rm.ts";

const SUMMARY = "MID-HISTORY-SUMMARY-OF-THE-MIDDLE-REGION-LONG-ENOUGH-FOR-THE-KERNEL-MINIMUM-LENGTH-CHECK";

function sse(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

// Same shape as the #4241 fixture: 46 messages × ~375 tok under a 30k window,
// mid-list fold m00017..m00030 (the shape that actually exercises the prefix
// walk — a head fold free-passes everything).
function conversation(tail: { role: string; content: string }[] = []): { role: string; content: string }[] {
    const out: { role: string; content: string }[] = [];
    for (let i = 0; i < 46; i++) {
        out.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(88) });
    }
    return [...out, ...tail];
}

type Harness = {
    proxy: http.Server;
    upstream: http.Server;
    bodies: string[];
    openaiUrl: string;
    store: SessionStore;
    sessionOf: (label: string) => { meta: { label: string }; state: { blocks: { id: string; active: boolean }[] }; metadata: Record<string, unknown> } | undefined;
};

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
    const bodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            bodies.push(Buffer.concat(chunks).toString("utf8"));
            const n = bodies.length;
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            if (n === 1) {
                const args = JSON.stringify({ content: [{ startId: "m00017", endId: "m00030", topic: "middle region", summary: SUMMARY }] });
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "compress", arguments: args } }] } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
            } else {
                const text = n === 2 ? "done compressing" : `ok ${n}`;
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sse({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
            }
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const dir = mkdtempSync(path.join(tmpdir(), "bili-d55-store-"));
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    _resetSessionsForTest();
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 30_000 } } } },
        modelContextLimit: 30_000,
        kernelConfig: defaultConfig(30_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: Boolean(process.env.SNAP_DEBUG),
        debug: Boolean(process.env.SNAP_DEBUG),
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: true,
        releaseNotesCheck: true,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as unknown as ProxyOptions);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    const h: Harness = {
        proxy,
        upstream,
        bodies,
        openaiUrl: `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
        store,
        sessionOf: (label) => listSessions().find((x) => x.meta.label === label) as never,
    };
    try {
        await fn(h);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        delete process.env.BILI_ROLLOUT_SNAPSHOT_RENDER;
        store.closeQuietly();
        void rmrf(dir);
    }
}

type Msg = { role: string; content: string };

async function turn(h: Harness, messages: unknown[], label: string): Promise<{ status: number; body: string; idx: number }> {
    const r = await fetch(h.openaiUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": label },
        body: JSON.stringify({ model: "gpt-test", messages, stream: true }),
    });
    const body = await r.text();
    await settleRows(h, label);
    return { status: r.status ?? 0, body, idx: h.bodies.length - 1 };
}

const rowsSeen = new Map<string, number>();
async function settleRows(h: Harness, label: string): Promise<void> {
    const prev = rowsSeen.get(label) ?? 0;
    for (let i = 0; i < 200; i++) {
        const n = h.store.unifiedTailSeqs(label)?.length ?? 0;
        if (n !== prev && n > 0) {
            rowsSeen.set(label, n);
            return;
        }
        await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`settleRows: store tail view never changed for ${label} (still ${prev})`);
}

function sent(bodies: string[], i: number): { role: string; content: unknown }[] {
    return JSON.parse(bodies[i]).messages as { role: string; content: unknown }[];
}

function textOf(m: { role: string; content: unknown }): string {
    return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

test("D5-5: render loads only the uncovered window — no full-content load, covered corruption tolerated", async () => {
    process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "100";
    await withHarness(async (h) => {
        const label = "s-d55";
        const history = conversation();
        // turn 1: mid-list fold lands (m17..m30) → covered rows exist.
        const r1 = await turn(h, history, label);
        assert.equal(r1.status, 200, r1.body);
        if (process.env.D55_DEBUG) {
            const fs = await import("node:fs");
            fs.writeFileSync("/tmp/d55-r1-body.txt", r1.body);
            fs.writeFileSync("/tmp/d55-sent1.json", JSON.stringify(JSON.parse(h.bodies[0]), null, 1));
            fs.writeFileSync("/tmp/d55-sent2.json", h.bodies[1] ?? "NO-SECOND");
            const sess = h.sessionOf(label);
            fs.writeFileSync("/tmp/d55-sess.json", JSON.stringify(sess?.state.blocks ?? [], null, 1));
        }
        assert.ok(h.sessionOf(label)!.state.blocks.some((b) => b.active), "block armed");

        // Instrument the store's read surface for the render turn.
        let fullLoads = 0;
        let idLoads = 0;
        let windowLoads = 0;
        const proto = SessionStore.prototype as unknown as Record<string, unknown>;
        const origFull = proto["unifiedTailViewRows"] as (this: SessionStore, id: string) => unknown;
        const origIds = proto["unifiedMessageIdRows"] as ((this: SessionStore, id: string) => unknown) | undefined;
        const origWindow = proto["unifiedUncoveredRows"] as ((this: SessionStore, id: string, iv: unknown) => unknown) | undefined;
        proto["unifiedTailViewRows"] = function (this: SessionStore, id: string) {
            fullLoads++;
            return origFull.call(this, id);
        };
        if (typeof origIds === "function") {
            proto["unifiedMessageIdRows"] = function (this: SessionStore, id: string) {
                idLoads++;
                return origIds.call(this, id);
            };
        }
        if (typeof origWindow === "function") {
            proto["unifiedUncoveredRows"] = function (this: SessionStore, id: string, iv: unknown) {
                windowLoads++;
                return origWindow.call(this, id, iv);
            };
        }
        try {
            // T2 precondition: corrupt a COVERED row's content bytes in the
            // CAS (refs m00017..m00030 == store seq 16..29, 0-based).
            const coveredSeq = 20;
            const { DatabaseSync } = await import("node:sqlite");
            const db = new DatabaseSync(path.join((h.store as unknown as { dir?: string }).dir ?? "", "index.db"), { readOnly: false });
            try {
                db.exec(`UPDATE content SET bytes = CAST('{"broken' AS BLOB) WHERE hash = (SELECT content_hash FROM messages WHERE session_id = '${label}' AND seq = ${coveredSeq})`);
            } finally {
                db.close();
            }

            // turn 2: the render turn.
            const full2 = [...conversation(), { role: "user", content: "Message 46 tail question. " + "TAIL_A_".repeat(80) }];
            const r2 = await turn(h, full2, label);
            assert.equal(r2.status, 200, r2.body);

            const out2 = sent(h.bodies, r2.idx);
            const joined2 = out2.map(textOf).join("\n");
            // T3: the rendered outbound stays complete.
            assert.ok(joined2.includes(SUMMARY), "mid-list anchor rendered");
            assert.ok(joined2.includes("WORK_2_content_"), "uncovered prefix rows render from the store");
            assert.ok(!joined2.includes("WORK_17_content_"), "covered middle rows suppressed");
            assert.ok(joined2.includes("TAIL_A_"), "live tail present");
            const meta = h.sessionOf(label)!.metadata;
            const renderTurns = meta["snapshotRenderTurns"] as number | undefined;
            assert.ok(typeof renderTurns === "number" && renderTurns >= 1, `D lane active on turn 2 (renderTurns=${String(renderTurns)}), covered-row corruption must not degrade the render`);

            // T1: the window discipline.
            assert.equal(fullLoads, 0, `unifiedTailViewRows (full content load) must not run on a render turn — got ${fullLoads}`);
            assert.ok(idLoads >= 1, "identity rows were read through the windowed path");
            assert.ok(windowLoads >= 1, "uncovered content rows were read through the windowed path");
        } finally {
            proto["unifiedTailViewRows"] = origFull;
            if (typeof origIds === "function") proto["unifiedMessageIdRows"] = origIds;
            if (typeof origWindow === "function") proto["unifiedUncoveredRows"] = origWindow;
        }
    });
});
