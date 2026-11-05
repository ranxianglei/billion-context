import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { rmrf } from "./tmp-rm.ts";

/** #3157: a Windows kernel crash left a session state file size-correct but
 *  all-zero (VDL=0) — metadata journaled by NTFS, user data never flushed
 *  because tmp+rename has no fsync. The read side then threw on EVERY load
 *  ("cannot be decoded; refusing an empty resume"), 502-ing the whole lane
 *  until a human deleted the file. The fix has two halves; this file pins the
 *  read-side half: an undecodable state file must be quarantined beside the
 *  original and yield a fresh start, not a permanent throw. */

type LogLine = { level: string; msg: string };

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

function filePath(dir: string, id: string): string {
    return join(dir, "openai", "upstream_" + createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24) + ".json");
}

const META = { protocol: "openai", upstreamOrigin: "http://upstream" };

test("#3157: an undecodable session state file is quarantined, not fatal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-3157-"));
    const logs: LogLine[] = [];
    try {
        const store = new SessionStore({ dir, debounceMs: 0, enabled: true, log: (level, msg) => logs.push({ level, msg }) });
        const file = filePath(dir, "s-corrupt");
        await store.writeNow(makeSession("s-corrupt"));
        assert.ok(existsSync(file), "valid state file written first");

        // Simulate the crash artifact: same size, all-zero content (VDL=0).
        const size = statSync(file).size;
        assert.ok(size > 0, "state file has content before corruption");
        writeFileSync(file, Buffer.alloc(size));

        let threw = false;
        let loaded: Session | null = null;
        try {
            loaded = store.loadSync("s-corrupt", META);
        } catch {
            threw = true;
        }
        assert.equal(threw, false, "loadSync must not throw on an undecodable file");
        assert.equal(loaded, null, "undecodable file yields a fresh start, not a resume");

        assert.ok(!existsSync(file), "corrupt file moved out of the way");
        const siblings = readdirSync(join(dir, "openai")).filter((n) => n.includes(".corrupt-"));
        assert.equal(siblings.length, 1, "exactly one .corrupt-* sibling kept for forensics");
        assert.equal(statSync(join(dir, "openai", siblings[0])).size, size, "quarantined copy preserves the original bytes");

        let threwAgain = false;
        let reloaded: Session | null = null;
        try {
            reloaded = store.loadSync("s-corrupt", META);
        } catch {
            threwAgain = true;
        }
        assert.equal(threwAgain, false, "second load does not throw");
        assert.equal(reloaded, null);
        assert.equal(readdirSync(join(dir, "openai")).filter((n) => n.includes(".corrupt-")).length, 1, "no duplicate quarantine");

        assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("quarantined") && l.msg.includes("s-corrupt")), "warn log emitted naming the session");
    } finally {
        rmrf(dir);
    }
});

/** Second self-heal branch: the file DECODES fine but the record fails
 *  isValidRecord (e.g. a truncated rewrite that left parseable-but-wrong
 *  JSON). Same contract: isolate once, warn, start fresh. */
test("#3157: a decodable but invalid record is quarantined too (validation branch)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-3157-"));
    const logs: LogLine[] = [];
    try {
        const store = new SessionStore({ dir, debounceMs: 0, enabled: true, log: (level, msg) => logs.push({ level, msg }) });
        const file = filePath(dir, "s-badrec");
        await store.writeNow(makeSession("s-badrec"));
        writeFileSync(file, JSON.stringify({ id: "s-badrec", foo: 1 }));

        assert.doesNotThrow(() => {
            assert.equal(store.loadSync("s-badrec", META), null);
        }, "loadSync must not throw on an invalid record");
        assert.ok(!existsSync(file), "invalid file moved out of the way");
        const siblings = readdirSync(join(dir, "openai")).filter((n) => n.includes(".corrupt-"));
        assert.equal(siblings.length, 1, "exactly one .corrupt-* sibling kept for forensics");
        assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("quarantined") && l.msg.includes("s-badrec")), "warn log emitted naming the session");
    } finally {
        rmrf(dir);
    }
});
