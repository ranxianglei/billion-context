// #4975: after resident-pool eviction + cold-load, an ordinary session reads
// back with refs/blocks intact but NO message view (transient dropped on
// eviction; pluginSnapshot persists for fork sessions only). Both acp_status
// surfaces then rendered "0 tool / 0 text" + max-compressible 0 —
// indistinguishable from a fresh session — while upstream kept billing the
// full history (report: billed 173069 vs est-view 26239, 6.6×). This suite
// pins both directions of the fix (#3617 gate discipline):
//   1. store has readable tail rows → status is served the SAME stored view
//      the compress lane recovers with (#3982) — receipt/panel byte-identical
//      to the resident case, no false marker;
//   2. store cannot read the view → explicit "view unavailable" marker names
//      the missing view (retained ref/block counts) instead of presenting
//      zeros as a reliable whole-session conclusion; the #2366 CJK divergence
//      note and the PRESSURE NOTE are suppressed there because their premises
//      (tokenizer gap / exhausted mass) are uncomputable with no view;
//   3. genuinely fresh session (no refs, no blocks) → NO marker, today's
//      exact output preserved.
// Storage-family discipline (#4076/#4077): the recovery tests are full-mode
// stories; pin the mode so a CI runner's legacy preload cannot flip them.

process.env.BILI_STORAGE_UNIFIED = "full";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, createCore, createInitialState, defaultConfig, emptyRefMap, type CompressionCore, type Config } from "acp-kernel";
import { handleAcpStatus } from "../src/acp-status.ts";
import { _resetPluginStateForTest, handlePluginStatus, handlePluginTool, rememberPluginMessages, type PluginToolDeps } from "../src/plugin.ts";
import { getSession, zeroStats, _resetSessionsForTest, type Session } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

type AcpCtx = Parameters<typeof handleAcpStatus>[1];

function makeAcpSession(id: string, opts?: { refs?: boolean; lastInput?: number; sysTokens?: number }): Session {
    const session = {
        id,
        meta: { protocol: "anthropic" },
        stats: { ...zeroStats(), ...(opts?.lastInput !== undefined ? { lastInputTokens: opts.lastInput, lastInputTokensSource: "usage" as const } : {}) },
        metadata: opts?.sysTokens !== undefined ? { systemPromptTokens: opts.sysTokens } : {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as unknown as Session;
    if (opts?.refs) session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return session;
}

function makeAcpCtx(session: Session, messages: CoreMessage[], compressMessages?: CoreMessage[]): AcpCtx {
    return { core: createCore(), config: defaultConfig(200_000), messages, compressMessages, session };
}

test("#4975: acp_status with retained refs but no readable view → explicit unavailable marker, CJK note + pressure note suppressed", () => {
    // 180k billed vs 50k system-only est view → ratio 3.6× (≥1.5 branch);
    // 90% of the 200k limit → pressure-note band. Pre-fix this exact shape
    // printed zeros + the CJK tokenizer-gap note + PRESSURE NOTE.
    const ctx = makeAcpCtx(makeAcpSession("s-4975-u", { refs: true, lastInput: 180_000, sysTokens: 50_000 }), []);
    const out = handleAcpStatus({}, ctx);
    assert.ok(out.text.includes("LIVE MESSAGE VIEW UNAVAILABLE"), "marker present");
    assert.ok(out.text.includes("retains 80 ref(s) and 0 active block(s)"), "retained counts named");
    assert.ok(out.text.includes("Any model request restores the view (#3126)"), "recovery path named");
    assert.ok(!out.text.includes("Judge context pressure from BILLED INPUT"), "misleading CJK divergence attribution suppressed");
    assert.ok(!out.text.includes("PRESSURE NOTE"), "pressure note suppressed (maxPending=0 is an artifact here)");
});

test("#4975: fresh session (no refs, no blocks, no view) → no marker, output unchanged", () => {
    const out = handleAcpStatus({}, makeAcpCtx(makeAcpSession("s-4975-fresh", {}), []));
    assert.ok(!out.text.includes("LIVE MESSAGE VIEW UNAVAILABLE"), "no false alarm for a genuinely empty session");
});

test("#4975: live view with high billed/est ratio keeps the #2366 CJK note (no regression)", () => {
    const ctx = makeAcpCtx(makeAcpSession("s-4975-live", { refs: true, lastInput: 180_000, sysTokens: 50_000 }), MESSAGES, MESSAGES);
    const out = handleAcpStatus({}, ctx);
    assert.ok(out.text.includes("Judge context pressure from BILLED INPUT"), "CJK note preserved with a real view");
    assert.ok(!out.text.includes("LIVE MESSAGE VIEW UNAVAILABLE"), "no marker while the live view exists");
});

// ---- plugin surfaces -------------------------------------------------------

function mockRes(): { res: http.ServerResponse; status(): number; body(): string } {
    let body = "";
    let status = 0;
    const res = {
        writeHead: (code: number) => { status = code; return undefined; },
        end: (chunk: unknown) => { body = String(chunk ?? ""); },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, body: () => body };
}

const DEPS: PluginToolDeps = { core: createCore(), config: defaultConfig(200_000), log: () => {} };

function makeStoredSession(id: string, lastMessages: CoreMessage[]) {
    const base = makeAcpSession(id, {});
    return {
        ...base,
        lastMessages: lastMessages as never,
        lastMessagesFolded: false,
        pluginSnapshot: undefined,
        contentStore: undefined,
    } as never;
}

async function withStore<T>(fn: (store: SessionStore) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "s4975-store-"));
    process.env.BILI_PERSIST_ZSTD = "0";
    const store = new SessionStore({ enabled: true, dir, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        return await fn(store);
    } finally {
        await store.closeQuietly();
        rmSync(dir, { recursive: true, force: true });
        _setStoreForTest(new SessionStore({ enabled: false }));
        delete process.env.BILI_PERSIST_ZSTD;
    }
}

function resetWorld(): void {
    _resetSessionsForTest();
    _resetPluginStateForTest();
}

test("#4975: evicted panel recovers the stored view — byte-identical to the resident panel, no unreadable marker", async () => {
    resetWorld();
    try {
        await withStore(async (store) => {
            const id = "s4975-panel-a";
            const session = getSession(id, { protocol: "anthropic" });
            session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
            rememberPluginMessages(id, MESSAGES, MESSAGES);
            await store.writeNow(makeStoredSession(id, MESSAGES));

            const r0 = mockRes();
            handlePluginStatus(id, r0.res, DEPS);
            assert.equal(r0.status(), 200, "resident status answered");
            assert.ok(!r0.body().includes("LIVE VIEW UNREADABLE"), "resident panel carries no marker");

            // Simulate the post-eviction/cold-load state: transient view gone,
            // persisted state (refs/blocks) intact.
            session.transient = undefined;

            const r1 = mockRes();
            handlePluginStatus(id, r1.res, DEPS);
            assert.equal(r1.status(), 200, "evicted status answered");
            assert.ok(!r1.body().includes("LIVE VIEW UNREADABLE"), "recoverable view must not read as unreadable");
            // contextView.at is a wall-clock stamp — normalize it, everything
            // else (panel text, ranges, accounting) must match the resident read.
            const norm = (body: string): Record<string, unknown> => {
                const j = JSON.parse(body) as Record<string, unknown> & { contextView?: { at?: number } };
                if (j.contextView) j.contextView.at = 0;
                return j;
            };
            assert.deepEqual(norm(r1.body()), norm(r0.body()), "recovered panel equals the resident panel modulo the wall-clock stamp");
        });
    } finally {
        resetWorld();
    }
});

test("#4975: evicted panel with no readable store copy → LIVE VIEW UNREADABLE marker + null ranges", async () => {
    resetWorld();
    _setStoreForTest(new SessionStore({ enabled: false }));
    try {
        const id = "s4975-panel-b";
        const session = getSession(id, { protocol: "anthropic" });
        session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
        rememberPluginMessages(id, MESSAGES, MESSAGES);
        session.transient = undefined;

        const r = mockRes();
        handlePluginStatus(id, r.res, DEPS);
        assert.equal(r.status(), 200);
        const json = JSON.parse(r.body()) as { compressibleRanges: unknown; panel: string | null };
        assert.equal(json.compressibleRanges, null, "no ranges derivable from a missing view");
        assert.ok(json.panel !== null && json.panel.includes("LIVE VIEW UNREADABLE"), "panel names the missing view");
        assert.ok(json.panel!.includes("80 ref(s), 0 active block(s) retained"), "retained counts named in panel");
    } finally {
        resetWorld();
    }
});

test("#4975: evicted acp_status tool call recovers the stored view — receipt byte-identical to the resident one", async () => {
    resetWorld();
    try {
        await withStore(async (store) => {
            const evictedId = "s4975-tool-a";
            const residentId = "s4975-tool-b";
            for (const [id, resident] of [[evictedId, false], [residentId, true]] as const) {
                const session = getSession(id, { protocol: "anthropic" });
                session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
                if (resident) rememberPluginMessages(id, MESSAGES, MESSAGES);
            }
            await store.writeNow(makeStoredSession(evictedId, MESSAGES));

            const call = async (id: string): Promise<string> => {
                const out = mockRes();
                await handlePluginTool(JSON.stringify({ conversationId: id, tool: "acp_status", args: {} }), out.res, DEPS);
                assert.equal(out.status(), 200);
                const json = JSON.parse(out.body()) as { ok: boolean; result: string };
                assert.equal(json.ok, true);
                return json.result;
            };
            const evicted = await call(evictedId);
            const resident = await call(residentId);
            assert.ok(!evicted.includes("LIVE MESSAGE VIEW IS UNAVAILABLE") && !evicted.includes("LIVE MESSAGE VIEW UNAVAILABLE"), "no false marker when the store view was served");
            // default scope renders CONTEXT BREAKDOWN — the text share must be
            // non-zero (the zeros of the incident are exactly what this pins out)
            assert.match(evicted, /CONTEXT BREAKDOWN[\s\S]*\| [1-9][0-9.]*[KM]? text \(\d+%\)/, "recovered report shows the real uncompressed mass");
            assert.equal(evicted, resident, "recovered receipt is byte-identical to the resident receipt");
        });
    } finally {
        resetWorld();
    }
});

test("#4975: evicted acp_status with no readable store copy → explicit marker through the endpoint, CJK note suppressed", async () => {
    resetWorld();
    _setStoreForTest(new SessionStore({ enabled: false }));
    try {
        const id = "s4975-tool-c";
        const session = getSession(id, { protocol: "anthropic" });
        session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
        session.stats.lastInputTokens = 180_000;
        session.stats.lastInputTokensSource = "usage";
        session.metadata.systemPromptTokens = 50_000;

        const out = mockRes();
        await handlePluginTool(JSON.stringify({ conversationId: id, tool: "acp_status", args: {} }), out.res, DEPS);
        assert.equal(out.status(), 200);
        const result = String((JSON.parse(out.body()) as { result: string }).result);
        assert.ok(result.includes("LIVE MESSAGE VIEW UNAVAILABLE"), "marker present through the endpoint");
        assert.ok(result.includes("retains 80 ref(s) and 0 active block(s)"), "retained counts named");
        assert.ok(!result.includes("Judge context pressure from BILLED INPUT"), "CJK attribution suppressed");
    } finally {
        resetWorld();
    }
});

test("#4975: fresh session acp_status through the endpoint → no marker (negative gate)", async () => {
    resetWorld();
    _setStoreForTest(new SessionStore({ enabled: false }));
    try {
        const id = "s4975-tool-d";
        getSession(id, { protocol: "anthropic" });
        const out = mockRes();
        await handlePluginTool(JSON.stringify({ conversationId: id, tool: "acp_status", args: {} }), out.res, DEPS);
        assert.equal(out.status(), 200);
        const result = String((JSON.parse(out.body()) as { result: string }).result);
        assert.ok(!result.includes("LIVE MESSAGE VIEW UNAVAILABLE"), "no false alarm for a session with nothing retained");
    } finally {
        resetWorld();
    }
});
