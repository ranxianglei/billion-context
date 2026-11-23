import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore } from "../src/persist.ts";
import { Session, cacheBlockContent } from "../src/session.ts";
import { exportSession, listSessions } from "../src/export.ts";
import { SUBAGENT_PROMPT_PREFIX } from "../src/session-title.js";
import { createInitialState } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

// #7595: the export surface (handoff + list) must apply the same display-title
// fallback as the web — a stored subagent dispatch boilerplate title falls back
// to the first block topic, a host-provided name still wins, and a normal title
// is never replaced. The JSONL dump stays as-is (data, not display).

const BOILER = SUBAGENT_PROMPT_PREFIX;
const TOPIC = "Fix the login bug";

function makeSession(id: string, title: string, hostTitle?: string): Session {
    return {
        id,
        meta: { protocol: "responses", upstreamOrigin: "https://api.openai.com/v1", title, ...(hostTitle ? { hostTitle } : {}) },
        stats: { requests: 12, tokensSaved: 0, inputTokens: 100, cachedTokens: 0, outputTokens: 50, cacheSamples: 1, lastInputTokens: 100, contextTokens: 99000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: Date.now() - 1000,
        lastSeen: Date.now(),
        state: createInitialState(),
        pendingRetrievals: [],
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function addBlock(s: Session, blockId: string, topic: string): void {
    s.state.blocks.push({
        blockId, runId: "r0", tier: 1, topic,
        summary: `summary for ${topic}`,
        directMessageIds: ["m1", "m2"], effectiveMessageIds: ["m1", "m2"], directBlockIds: [],
        compressedTokens: 4200, createdAt: Date.now(), survivedCount: 2, generation: "young", active: true,
    });
    cacheBlockContent(s, blockId, {
        one: { text: "summary text", count: 1 },
        full: { text: "user: task\nassistant: working", count: 2 },
    });
}

async function withStore(id: string, title: string, hostTitle: string | undefined, topic: string | null, fn: (store: SessionStore, dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-export-subagent-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    const s = makeSession(id, title, hostTitle);
    if (topic !== null) {
        addBlock(s, "b0", topic);
        s.lastMessages = [{ id: "m9", role: "user", contentType: "text", text: "later question" }];
    }
    await store.writeNow(s);
    try {
        await fn(store, dir);
    } finally {
        store.closeQuietly();
        rmrf(dir);
    }
}

test("#7595 handoff: a stored subagent boilerplate title falls back to the first block topic", async () => {
    await withStore("sub1", BOILER, undefined, TOPIC, async (_store, dir) => {
        const md = await exportSession("sub1", { dir });
        assert.match(md, new RegExp(`- title: ${TOPIC}`), "handoff title line shows the block topic");
        assert.doesNotMatch(md, new RegExp(`- title: ${BOILER}`), "boilerplate title is not shown");
    });
});

test("#7595 list: a stored subagent boilerplate title falls back to the first block topic", async () => {
    await withStore("sub2", BOILER, undefined, TOPIC, async (_store, dir) => {
        const list = await listSessions({ dir });
        assert.equal(list.length, 1);
        assert.equal(list[0]!.title, TOPIC, "list title shows the block topic");
    });
});

test("#7595 handoff: a host-provided name wins over the boilerplate", async () => {
    await withStore("sub3", BOILER, "my custom name", TOPIC, async (_store, dir) => {
        const md = await exportSession("sub3", { dir });
        assert.match(md, /- title: my custom name/, "host name wins");
        assert.doesNotMatch(md, new RegExp(`- title: ${TOPIC}`));
    });
});

test("#7595 handoff: a normal (non-boilerplate) stored title is never replaced", async () => {
    await withStore("sub4", "Fix the login bug", undefined, "Some other topic", async (_store, dir) => {
        const md = await exportSession("sub4", { dir });
        assert.match(md, /- title: Fix the login bug/, "normal title unchanged");
        assert.doesNotMatch(md, /- title: Some other topic/);
    });
});

test("#7595 handoff: a boilerplate title with no block keeps the stored title (v2 fallback path)", async () => {
    await withStore("sub5", BOILER, undefined, null, async (_store, dir) => {
        const md = await exportSession("sub5", { dir });
        assert.match(md, new RegExp(`- title: ${BOILER}`), "no block topic → stored boilerplate kept");
    });
});

test("#7595 JSONL dump stays as-is: it exports the stored title, not the display fallback", async () => {
    await withStore("sub6", BOILER, undefined, TOPIC, async (_store, dir) => {
        const jsonl = await exportSession("sub6", { dir, jsonl: true });
        // The session header records the stored (boilerplate) title, not the
        // block-topic display fallback — the dump is data, not a display surface.
        const header = jsonl.split("\n").find((l) => l.includes('"type":"session"'))!;
        assert.match(header, new RegExp(`"title":"${BOILER}"`), "JSONL keeps the stored title");
        assert.doesNotMatch(header, new RegExp(`"title":"${TOPIC}"`));
    });
});
