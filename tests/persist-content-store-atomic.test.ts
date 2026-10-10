import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContentStore, storeOriginal, createInitialState } from "acp-kernel";
import { SessionStore, _setStoreForTest, atomicWriteFileSync } from "../src/persist.ts";
import type { Session } from "../src/session.ts";
import { contentStoreOf } from "../src/store.ts";
import { rmrf } from "./tmp-rm.ts";

// Pin the plain-JSON format so companion files are readable without the codec.
process.env.BILI_PERSIST_ZSTD = "0";

const TMP_RE = /\.tmp-enc-\d+-\d+$/;

function errno(code: string): NodeJS.ErrnoException {
    const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
}

function makeSession(id: string): Session {
    const s = {
        id,
        meta: { protocol: "openai", upstreamOrigin: "http://up:1", title: "atomic test" },
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 1000, compressCreditTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        createdAt: Date.now(),
        lastSeen: Date.now(),
        state: createInitialState(),
        blockContents: new Map<string, unknown>(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as unknown as Session;
    s.contentStore = storeOriginal(createContentStore(), { ref: "m00001", rawId: "raw-1", text: "original payload one", kind: "original", tokens: 10, head: "orig" });
    s.contentStoreDirty = true;
    return s;
}

function companionPath(dir: string): string {
    for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
        if (entry.endsWith(".content-store.json")) return path.join(dir, entry);
    }
    throw new Error("no companion content store found");
}

test("atomicWriteFileSync replaces the target and leaves no temp behind", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-atomic-"));
    try {
        const abs = path.join(dir, "store.json");
        writeFileSync(abs, JSON.stringify({ v: 1 }));
        atomicWriteFileSync(abs, JSON.stringify({ v: 2 }));
        assert.deepEqual(JSON.parse(readFileSync(abs, "utf8")), { v: 2 });
        assert.ok(!readdirSync(dir).some((f) => TMP_RE.test(f)), "no orphaned temp");
    } finally { rmrf(dir); }
});

test("atomicWriteFileSync retries a transient rename failure then lands the write", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-atomic-"));
    try {
        const abs = path.join(dir, "store.json");
        writeFileSync(abs, JSON.stringify({ v: 1 }));
        let calls = 0;
        atomicWriteFileSync(abs, JSON.stringify({ v: 2 }), {
            rename: (from, to) => {
                calls++;
                if (calls === 1) throw errno("EPERM");
                return renameSync(from, to);
            },
        });
        assert.equal(calls, 2, "retried once after EPERM");
        assert.deepEqual(JSON.parse(readFileSync(abs, "utf8")), { v: 2 });
        assert.ok(!readdirSync(dir).some((f) => TMP_RE.test(f)), "no orphaned temp after success");
    } finally { rmrf(dir); }
});

test("atomicWriteFileSync non-transient failure keeps the old target byte-intact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-atomic-"));
    try {
        const abs = path.join(dir, "store.json");
        const before = JSON.stringify({ v: 1, refs: ["m00001"] });
        writeFileSync(abs, before);
        assert.throws(
            () => atomicWriteFileSync(abs, JSON.stringify({ v: 2 }), { rename: () => { throw errno("EINVAL"); } }),
            /EINVAL/,
        );
        assert.equal(readFileSync(abs, "utf8"), before, "old bytes untouched — never a truncated target");
        assert.deepEqual(JSON.parse(readFileSync(abs, "utf8")).refs, ["m00001"], "old store still parses");
        assert.ok(!readdirSync(dir).some((f) => TMP_RE.test(f)), "failed temp cleaned up");
    } finally { rmrf(dir); }
});

test("#2675 crash between companion and session writes: boot sweep removes the orphan, store still parses", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-atomic-"));
    try {
        const sessionsDir = path.join(dir, "sessions");
        const store = new SessionStore({ dir: sessionsDir, enabled: true, debounceMs: 0 });
        _setStoreForTest(store);
        const session = makeSession("parent");
        assert.equal(store.flushSync(session), true, "first save lands both files");
        const companion = companionPath(sessionsDir);
        const firstGen = JSON.parse(readFileSync(companion, "utf8"));
        assert.ok(firstGen.byRef["m00001"], "companion persisted with the ref");
        // Simulate a process death mid-write of the NEXT save: the fresh temp
        // holds the new payload, the target still holds the previous one.
        const current = session.contentStore ?? createContentStore();
        session.contentStore = storeOriginal(current, { ref: "m00002", rawId: "raw-2", text: "original payload two", kind: "original", tokens: 10, head: "orig" });
        session.contentStoreDirty = true;
        writeFileSync(`${companion}.tmp-enc-${process.pid}-${Date.now()}`, JSON.stringify({ byRef: { m00001: firstGen.byRef.m00001, m00002: "NEW" }, byHash: {} }));
        // A fresh process boots over the same directory.
        const next = new SessionStore({ dir: sessionsDir, enabled: true, debounceMs: 0 });
        _setStoreForTest(next);
        const booted = await next.boot();
        assert.ok(!readdirSync(sessionsDir, { recursive: true, encoding: "utf8" }).some((f) => TMP_RE.test(f)), "orphaned temp swept at boot");
        const parsed = JSON.parse(readFileSync(companion, "utf8"));
        assert.ok(parsed.byRef["m00001"], "companion still parses — no silent degrade to a fresh store");
        const restored = booted.get("parent");
        assert.ok(restored, "session itself restored");
        assert.ok(contentStoreOf(restored!).byRef["m00001"], "restored session resolves the intact content store from the companion");
    } finally { rmrf(dir); }
});
