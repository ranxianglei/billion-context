import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { assignRefs, createInitialState, emptyRefMap } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// #3573 (diagnostic half): after the v0.1.198 upgrade incident, a folded
// session re-entered as raw history (1820 messages, usage 0%, ref=0) with NO
// fold-reconcile logs at all — reconcileFoldCoverage early-exits silently
// when the loaded state has no active blocks, and nothing logged WHAT the
// lazy cold load actually carried. Was the state ever loaded? Did it carry
// refs without blocks (identity survived, every fold missing)? Or did the
// request key onto a ghost fork id? All three were indistinguishable in the
// field. This pins the load-side answer: every on-disk cold load now reports
// its carried refs/blocks/baseline at info level, and the incident signature
// specifically (refs mapped, ZERO persisted blocks) escalates to a warning
// naming the consequence (raw replay + rebuild-from-scratch preflight), so
// the next occurrence is a one-line diagnosis instead of a post-mortem.
// Runs under the default storage mode (unified shadow double-ingest — what
// the incident machine ran); the same assertions hold on the plain-legacy
// branch, whose source label differs ("legacy file" vs "unified store").

type LogLine = { level: string; msg: string };

const META = { protocol: "openai", upstreamOrigin: "http://upstream" };

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://upstream" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    };
}

/** Seed message refs the way the stream path does after each turn (#387). */
function seedRefs(session: Session, n: number): void {
    const msgs = Array.from({ length: n }, (_, i) => ({ id: `raw${i}`, role: i % 2 === 0 ? ("user" as const) : ("assistant" as const), contentType: "text" as const, text: `message ${i}` }));
    session.state.messageRefs = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 }).map;
}

function storeIn(dir: string, logs: LogLine[]): SessionStore {
    return new SessionStore({ dir, debounceMs: 0, enabled: true, log: (level, msg) => logs.push({ level, msg }) });
}

test("#3573: cold load carrying refs but NO persisted blocks warns loudly (the incident signature)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-3573-coldload-"));
    try {
        // Persist a refs-only state: identity survived, every fold gone —
        // the on-disk end-state the incident left behind, whatever produced it.
        const writerLogs: LogLine[] = [];
        const writer = storeIn(dir, writerLogs);
        const s = makeSession("s-ghost");
        seedRefs(s, 6);
        s.stats.lastInputTokens = 119_940;
        // The incident session HAD been folded — compressions>0 is what makes
        // the zero-blocks signature diagnosable (folds existed, now missing).
        // state.stats.compressionCount is the kernel's live counter
        // (incremented on every fold); the legacy stats.tokensSaved used
        // here pre-#2734 has no writer left and always logged 0.
        s.state.stats.compressionCount = 42;
        await writer.writeNow(s);

        const logs: LogLine[] = [];
        const reader = storeIn(dir, logs);
        const loaded = reader.loadSync("s-ghost", META);
        assert.ok(loaded, "a refs-only state still loads (nothing to quarantine)");
        assert.equal(Object.keys(loaded.state.messageRefs.byRef ?? {}).length, 6, "refs survived the round trip");
        assert.equal(loaded.state.blocks.length, 0, "blocks are genuinely absent, not dropped by the loader");

        const info = logs.find((l) => l.level === "info" && l.msg.includes("cold-loaded s-ghost"));
        assert.ok(info, `an info line records what the cold load carried (logs: ${JSON.stringify(logs)})`);
        assert.match(info!.msg, /6 ref\(s\), 0 block\(s\) \(0 active\)/);
        assert.match(info!.msg, /baseline 119940 tok, compressions 42/);

        const warn = logs.find((l) => l.level === "warn" && l.msg.includes("s-ghost"));
        assert.ok(warn, "refs-without-blocks must WARN — silence is exactly what made #3573 un-diagnosable");
        assert.match(warn!.msg, /6 mapped ref\(s\) but NO persisted blocks \(compressions=42\)/);
        assert.match(warn!.msg, /#3573/);
    } finally {
        rmrf(dir);
    }
});

test("#3573: a healthy cold load reports its counts without warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-3573-coldload-"));
    try {
        const writerLogs: LogLine[] = [];
        const writer = storeIn(dir, writerLogs);
        const s = makeSession("s-healthy");
        seedRefs(s, 8);
        s.stats.lastInputTokens = 119_940;
        s.state.blocks = [{
            blockId: "blk-1",
            runId: "run-1",
            tier: 1,
            summary: "folded segment",
            directMessageIds: ["raw0", "raw1", "raw2", "raw3"],
            effectiveMessageIds: ["raw0", "raw1", "raw2", "raw3"],
            directBlockIds: [],
            compressedTokens: 16,
            createdAt: Date.now(),
            survivedCount: 0,
            generation: "young",
            active: true,
            startRef: "m00001",
            endRef: "m00004",
        }];
        await writer.writeNow(s);

        const logs: LogLine[] = [];
        const reader = storeIn(dir, logs);
        const loaded = reader.loadSync("s-healthy", META);
        assert.ok(loaded, "healthy state loads");
        assert.equal(loaded.state.blocks.length, 1, "the block survived the round trip");

        const info = logs.find((l) => l.level === "info" && l.msg.includes("cold-loaded s-healthy"));
        assert.ok(info, `an info line records the healthy cold load (logs: ${JSON.stringify(logs)})`);
        assert.match(info!.msg, /8 ref\(s\), 1 block\(s\) \(1 active\)/);
        assert.ok(!logs.some((l) => l.level === "warn" && l.msg.includes("s-healthy")), "no warning on a healthy load");
    } finally {
        rmrf(dir);
    }
});

test("#3573: a fresh empty state logs its counts and does not false-positive the warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-3573-coldload-"));
    try {
        const writerLogs: LogLine[] = [];
        const writer = storeIn(dir, writerLogs);
        await writer.writeNow(makeSession("s-empty"));

        const logs: LogLine[] = [];
        const reader = storeIn(dir, logs);
        const loaded = reader.loadSync("s-empty", META);
        assert.ok(loaded, "an empty state loads");
        const info = logs.find((l) => l.level === "info" && l.msg.includes("cold-loaded s-empty"));
        assert.ok(info, `an info line records the empty cold load (logs: ${JSON.stringify(logs)})`);
        assert.match(info!.msg, /0 ref\(s\), 0 block\(s\) \(0 active\)/);
        assert.match(info!.msg, /compressions 0/);
        assert.ok(!logs.some((l) => l.level === "warn" && l.msg.includes("s-empty")), "zero refs must NOT trigger the no-blocks warning");
    } finally {
        rmrf(dir);
    }
});
