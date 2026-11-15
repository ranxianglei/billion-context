import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
const { join } = path;
import { CORRUPT_SIBLING_CAP, SessionStore, isAllocationFailureError } from "../src/persist.ts";
import type { StateStoreCodec } from "acp-kernel/persist";
import type { Session } from "../src/session.ts";
import { createInitialState } from "acp-kernel";
import { loadConversations } from "../src/plugin.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

/** #5779: the .corrupt-<ts> quarantine copies (#3157 self-heal) accumulated
 *  without bound — one ~0.6 GiB forensic copy per failed load of a hot
 *  session (273 copies / ~157 GiB in a single user tree). Two defects:
 *  nothing ever pruned the copies, and an out-of-memory decode failure was
 *  misclassified as corruption, quarantining a HEALTHY envelope and burning
 *  its fold state so the eviction/cold-load loop rebuilt and re-quarantined
 *  it. This file pins both halves: retention capped at the newest copy per
 *  base file, and allocation failures leaving the file in place for retry.
 *
 *  The quarantine path is legacy-file behavior: under unified-full reads are
 *  served from index.db and a corrupt JSON envelope is never even probed, so
 *  pin the same tier the CI non-storage corpus baseline uses
 *  (tests/preload-storage-baseline.mjs). */
process.env.BILI_STORAGE_UNIFIED = "legacy";

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

function corruptZeroFill(file: string): number {
    const size = statSync(file).size;
    assert.ok(size > 0, "state file has content before corruption");
    writeFileSync(file, Buffer.alloc(size));
    return size;
}

function corruptSiblingsOf(file: string): string[] {
    return readdirSync(path.dirname(file)).filter((n) => n.startsWith(path.basename(file) + ".corrupt-")).sort();
}

test("#5779: pre-existing older .corrupt-* copies are pruned to the cap on quarantine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5779-"));
    const logs: LogLine[] = [];
    try {
        const store = new SessionStore({ dir, debounceMs: 0, enabled: true, log: (level, msg) => logs.push({ level, msg }) });
        const file = filePath(dir, "s-cap");
        await store.writeNow(makeSession("s-cap"));
        // Simulate the historical accumulation: older forensic copies already
        // sitting beside the live file (the user had 273 of these).
        const base = path.basename(file);
        writeFileSync(join(dir, "openai", `${base}.corrupt-1000000`), "old forensic copy A");
        writeFileSync(join(dir, "openai", `${base}.corrupt-2000000`), "old forensic copy B");
        const size = corruptZeroFill(file);

        assert.equal(store.loadSync("s-cap", META), null, "undecodable file yields a fresh start");
        const siblings = corruptSiblingsOf(file);
        assert.equal(siblings.length, CORRUPT_SIBLING_CAP, "only the newest forensic copy survives the sweep");
        assert.equal(statSync(join(dir, "openai", siblings[0])).size, size, "the survivor is the just-created quarantine copy, not a stale one");
        assert.ok(logs.some((l) => l.level === "warn" && l.msg.includes("quarantined") && l.msg.includes("removed 2 older forensic copies")), "warn log reports the sweep");
    } finally {
        rmrf(dir);
    }
});

test("#5779: repeated quarantine rounds never accumulate copies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5779-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 0, enabled: true, log: () => {} });
        const file = filePath(dir, "s-loop");
        for (let round = 0; round < 3; round++) {
            await store.writeNow(makeSession("s-loop"));
            corruptZeroFill(file);
            assert.equal(store.loadSync("s-loop", META), null, `round ${round}: undecodable file yields a fresh start`);
            const count = corruptSiblingsOf(file).length;
            assert.equal(count, CORRUPT_SIBLING_CAP, `round ${round}: retention stays at the cap`);
        }
    } finally {
        rmrf(dir);
    }
});

test("#5779: an allocation failure during decode does NOT quarantine the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5779-"));
    const logs: LogLine[] = [];
    try {
        const store = new SessionStore({ dir, debounceMs: 0, enabled: true, log: (level, msg) => logs.push({ level, msg }) });
        const file = filePath(dir, "s-oom");
        await store.writeNow(makeSession("s-oom"));
        corruptZeroFill(file);
        // The plaintext attempt fails first (NUL bytes), then the codec
        // attempt runs out of memory allocating the decoded payload.
        (store as unknown as { readCodec: StateStoreCodec }).readCodec = {
            encode: (d: string) => d,
            decode: () => { throw new RangeError("Array buffer allocation failed"); },
        };

        assert.equal(store.loadSync("s-oom", META), null, "load yields a fresh start this round");
        assert.ok(existsSync(file), "healthy-bytes file left in place for retry");
        assert.equal(corruptSiblingsOf(file).length, 0, "no forensic copy created for an OOM failure");
        assert.ok(logs.some((l) => l.level === "error" && l.msg.includes("out of memory")), "error log explains the non-corruption verdict");
    } finally {
        rmrf(dir);
    }
});

test("#5779: a genuine decode error still quarantines (gate negative direction)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5779-"));
    try {
        const store = new SessionStore({ dir, debounceMs: 0, enabled: true, log: () => {} });
        const file = filePath(dir, "s-synerr");
        await store.writeNow(makeSession("s-synerr"));
        corruptZeroFill(file);
        (store as unknown as { readCodec: StateStoreCodec }).readCodec = {
            encode: (d: string) => d,
            decode: () => { throw new SyntaxError("Unexpected end of JSON input"); },
        };

        assert.equal(store.loadSync("s-synerr", META), null);
        assert.ok(!existsSync(file), "genuine decode failure still moves the file out of the way");
        assert.equal(corruptSiblingsOf(file).length, CORRUPT_SIBLING_CAP, "exactly one forensic copy kept");
    } finally {
        rmrf(dir);
    }
});

test("#5779: isAllocationFailureError classifies only V8 allocation failures", () => {
    assert.equal(isAllocationFailureError(new RangeError("Array buffer allocation failed")), true, "buffer allocation failure");
    assert.equal(isAllocationFailureError(new RangeError("JavaScript heap out of memory")), true, "heap exhaustion");
    assert.equal(isAllocationFailureError(new RangeError("Maximum call stack size exceeded")), false, "stack overflow is structural pathology, stays corruption-side");
    assert.equal(isAllocationFailureError(new SyntaxError("Unexpected token")), false, "syntax errors stay corruption-side");
    assert.equal(isAllocationFailureError(new Error("boom")), false, "plain errors stay corruption-side");
    assert.equal(isAllocationFailureError("RangeError-ish string"), false, "non-Error values stay corruption-side");
});

test("#5779: plugin-conversations.json quarantine copies are capped too", () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-5779-"));
    const logged: string[] = [];
    const prev = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    setLogCapture((_level, msg) => logged.push(msg));
    try {
        const stateDir = join(dir, "billion-context");
        mkdirSync(stateDir, { recursive: true });
        const file = join(stateDir, "plugin-conversations.json");
        for (let round = 0; round < 2; round++) {
            writeFileSync(file, "{corrupt-bytes");
            loadConversations();
            const backups = readdirSync(join(dir, "billion-context")).filter((f) => f.startsWith("plugin-conversations.json.corrupt-"));
            assert.equal(backups.length, CORRUPT_SIBLING_CAP, `round ${round}: exactly one backup kept`);
        }
        assert.ok(logged.some((m) => m.includes("plugin-conversations.json is corrupt")));
    } finally {
        setLogCapture(null);
        if (prev === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prev;
        rmrf(dir);
    }
});
