import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { Session, cacheBlockContent, snapshotMessages } from "../src/session.ts";
import { renderHandoff } from "../src/export.ts";
import { createInitialState, defaultCountTokens } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// readRecord() inspects raw on-disk session files directly (bypassing the
// store codec), so pin the plain-JSON format: #1080 made BILIZSTD1 the default.
process.env.BILI_PERSIST_ZSTD = "0";

// #401: the persisted record stores a BOUNDED FOLDED-VIEW snapshot —
// prune() renders summaries in place of folded ranges, then the oldest
// messages are dropped until the view fits BILI_PERSIST_TAIL_TOKENS. The raw
// full history (63.2% of the 258MB corpus) is no longer duplicated on disk.

function makeSession(id: string): Session {
    return {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://up:1", title: "tail test" },
        stats: { requests: 3, tokensSaved: 0, inputTokens: 10, cachedTokens: 0, outputTokens: 5, cacheSamples: 0, lastInputTokens: 10, contextTokens: 1000 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function withBlock(s: Session): void {
    s.state.blocks.push({
        blockId: "b0", runId: "r0", tier: 1, topic: "old work",
        summary: "SUMMARY-MARKER: covered early messages about the old work.",
        directMessageIds: ["m1", "m2"], effectiveMessageIds: ["m1", "m2"], directBlockIds: [],
        compressedTokens: 500, createdAt: Date.now(), survivedCount: 2, generation: 1, active: true,
    });
    cacheBlockContent(s, "b0", {
        one: null,
        full: { text: "user: OLD-ORIGINAL-one\nassistant: OLD-ORIGINAL-two", count: 2 },
    });
}

function readRecord(dir: string): Record<string, unknown> {
    const proto = readdirSync(dir).find((d) => d !== ".bili-migration-286.done");
    assert.ok(proto, "no protocol dir written");
    const file = readdirSync(path.join(dir, proto!)).find((f) => f.endsWith(".json"));
    assert.ok(file, "no session file written");
    const envelope = JSON.parse(readFileSync(path.join(dir, proto!, file!), "utf8")) as { payload: Record<string, unknown> };
    return envelope.payload;
}

async function withTailEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.BILI_PERSIST_TAIL_TOKENS;
    if (value === undefined) delete process.env.BILI_PERSIST_TAIL_TOKENS;
    else process.env.BILI_PERSIST_TAIL_TOKENS = value;
    try {
        return await fn();
    } finally {
        if (prev === undefined) delete process.env.BILI_PERSIST_TAIL_TOKENS;
        else process.env.BILI_PERSIST_TAIL_TOKENS = prev;
    }
}

test("#401 persisted messages are a folded snapshot: covered originals dropped, summary + tail kept", async () => {
    await withTailEnv(undefined, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-tail-"));
        try {
            const s = makeSession("tail-folded");
            withBlock(s);
            s.lastMessages = [
                { id: "m1", role: "user", contentType: "text", text: "OLD-ORIGINAL-one" },
                { id: "m2", role: "assistant", contentType: "text", text: "OLD-ORIGINAL-two" },
                { id: "m3", role: "user", contentType: "text", text: "TAIL-QUESTION still here" },
                { id: "m4", role: "assistant", contentType: "text", text: "TAIL-ANSWER also here" },
            ];
            const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
            await store.writeNow(s);

            const rec = readRecord(dir);
            assert.equal(rec.messagesFolded, true, "record must mark the snapshot as pre-folded");
            const msgs = rec.messages as { id: string; text?: string }[];
            assert.ok(msgs.some((m) => m.text?.includes("SUMMARY-MARKER")), "summary missing from persisted snapshot");
            assert.ok(!msgs.some((m) => m.id === "m2"), "covered non-first messages must be dropped");
            // Kernel design: prune() always keeps the FIRST user message even
            // when covered (conversation anchor) — assert that invariant too.
            assert.ok(msgs.some((m) => m.id === "m1"), "first user message must survive as the anchor");
            assert.ok(!msgs.some((m) => m.text?.includes("OLD-ORIGINAL-two")), "covered original text leaked");
            assert.ok(msgs.some((m) => m.text?.includes("TAIL-QUESTION")), "tail dropped");
        } finally {
            rmrf(dir);
        }
    });
});

test("#401 budget truncation keeps the newest whole messages and at least one survivor", async () => {
    await withTailEnv("50", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-tail-"));
        try {
            const s = makeSession("tail-trunc");
            const filler = "x".repeat(100); // defaultCountTokens heuristic: ~25-35 tokens per 100 chars
            s.lastMessages = [
                { id: "m1", role: "user", contentType: "text", text: `oldest ${filler}` },
                { id: "m2", role: "assistant", contentType: "text", text: `middle ${filler}` },
                { id: "m3", role: "user", contentType: "text", text: `newest ${filler}` },
            ];
            const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
            await store.writeNow(s);

            const rec = readRecord(dir);
            const msgs = rec.messages as { id: string; text?: string }[];
            assert.equal(rec.messagesFolded, true);
            assert.ok(msgs.length >= 1, "at least one message must survive truncation");
            assert.ok(msgs.length < 3, `expected truncation (budget=50 tokens), kept ${msgs.length}`);
            assert.ok(!msgs.some((m) => m.id === "m1"), "oldest message should be dropped first");
            assert.equal(msgs[msgs.length - 1]!.id, "m3", "newest message must be kept");
            const total = msgs.reduce((acc, m) => acc + defaultCountTokens(m.text ?? ""), 0);
            assert.ok(total <= defaultCountTokens(`newest ${filler}`) + 1, `kept total ${total} exceeds the single-newest bound`);
        } finally {
            rmrf(dir);
        }
    });
});

test("#401 BILI_PERSIST_TAIL_TOKENS=0 disables message persistence entirely (v2-style record)", async () => {
    await withTailEnv("0", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-tail-"));
        try {
            const s = makeSession("tail-off");
            withBlock(s);
            s.lastMessages = [{ id: "m1", role: "user", contentType: "text", text: "hello" }];
            const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
            await store.writeNow(s);

            const rec = readRecord(dir);
            assert.equal(rec.messages, undefined, "messages must be absent with budget 0");
            assert.equal(rec.messagesFolded, undefined);

            // A restored session then has no snapshot — export falls back to
            // the v2 block-only rendering. (The LIVE in-memory session still
            // exports its full snapshot — that is unaffected by the budget.)
            const restored = (await store.loadAll()).get("tail-off");
            assert.ok(restored, "session not restored");
            assert.equal(restored!.lastMessages, undefined);
            const md = renderHandoff(restored!, false);
            assert.match(md, /SUMMARY-MARKER/);
            assert.doesNotMatch(md, /hello/);
        } finally {
            rmrf(dir);
        }
    });
});

test("#401 restore + export: folded snapshot renders as-is (--full recovers originals from blockContents)", async () => {
    await withTailEnv(undefined, async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "bili-tail-"));
        try {
            const s = makeSession("tail-roundtrip");
            withBlock(s);
            s.lastMessages = [
                { id: "m1", role: "user", contentType: "text", text: "OLD-ORIGINAL-one" },
                { id: "m2", role: "assistant", contentType: "text", text: "OLD-ORIGINAL-two" },
                { id: "m3", role: "user", contentType: "text", text: "TAIL-QUESTION" },
            ];
            const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
            await store.writeNow(s);

            const restored = (await store.loadAll()).get("tail-roundtrip");
            assert.ok(restored, "session not restored");
            assert.equal(restored!.lastMessagesFolded, true);

            const md = renderHandoff(restored!, false);
            assert.match(md, /persisted folded snapshot/);
            assert.match(md, /SUMMARY-MARKER/);
            assert.match(md, /TAIL-QUESTION/);
            assert.doesNotMatch(md, /OLD-ORIGINAL-two/, "covered non-first original leaked (first-user anchor is kept by design)");
            assert.equal(md.match(/SUMMARY-MARKER/g)?.length, 1, "summary must not be duplicated (prune re-run leaked)");

            const full = renderHandoff(restored!, true);
            assert.match(full, /SUMMARY-MARKER/);
            assert.match(full, /TAIL-QUESTION/);
            assert.match(full, /OLD-ORIGINAL-two/, "--full must recover folded originals via blockContents");
            assert.match(full, /Original messages \(2\)/);
        } finally {
            rmrf(dir);
        }
    });
});

test("#401 a live request clears lastMessagesFolded (client re-sends full raw history)", async () => {
    const s = makeSession("tail-live");
    s.lastMessagesFolded = true;
    s.lastMessages = [{ id: "acp_summary_b0", role: "system", contentType: "text", text: "[Compressed conversation section]\nSUMMARY-MARKER" }];
    snapshotMessages(s, [
        { id: "m1", role: "user", contentType: "text", text: "fresh raw history" },
    ]);
    assert.equal(s.lastMessagesFolded, false, "snapshotMessages must clear the folded flag");
    assert.equal(s.lastMessages[0]!.text, "fresh raw history");
});
