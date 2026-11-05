// #3399: a provider switch mid-conversation leaves the fold ledger under its
// OLD route name (<protocol>/<oldHost>_<sha>.json); the cold load after a
// restart probed only the NEW route → empty session → full unfolded history
// re-sent → refold from scratch or a local 413 at the doomed-probe gate.
// Namespaced files for a conversation id must resolve as ONE candidate pool
// arbitrated by fold progress (requests → nextBlockId), never by probe order
// or savedAt — a fresh-but-empty current-route twin must lose to the richer
// old-route ledger, and a successfully continued branch must never be rolled
// back by a stale one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { SessionStore, _setStoreForTest, relPathFor } from "../src/persist.ts";
import { createSession, _resetSessionsForTest } from "../src/session.ts";
import type { WireProtocol } from "../src/util.ts";
import { rmrf } from "./tmp-rm.ts";

const ID = "01a12b4a-conv-native-id";
const ORIGIN_A = "https://a.example.com/v1";
const ORIGIN_B = "https://b.example.com/v1";
const PROTO: WireProtocol = "responses";
const BOOT_LIMITS = { maxSessions: 8, maxBytes: 67_108_864 };

interface SeedOpts {
    origin?: string;
    protocol?: WireProtocol;
    requests: number;
    blockText: string;
}

async function seedOnce(dir: string, opts: SeedOpts): Promise<void> {
    _resetSessionsForTest(256, 512 * 1024 * 1024);
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _setStoreForTest(store);
    try {
        const s = createSession(ID, { protocol: opts.protocol ?? PROTO, upstreamOrigin: opts.origin ?? ORIGIN_A, label: ID });
        s.stats.requests = opts.requests;
        s.state.blocks.push({ id: "b1", startRef: "m00001", endRef: "m00120", tokens: 12_000, createdAt: Date.now() } as never);
        s.blockContents.set("b1", { one: null, full: { text: opts.blockText, count: 1 } });
        await store.writeNow(s);
    } finally {
        store.closeQuietly();
        _resetSessionsForTest(256, 512 * 1024 * 1024);
        _setStoreForTest(new SessionStore({ enabled: false }));
    }
}

function bootStore(dir: string): SessionStore {
    _resetSessionsForTest(256, 512 * 1024 * 1024);
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _setStoreForTest(store);
    return store;
}

function teardown(store: SessionStore | null, root: string): void {
    store?.closeQuietly();
    _resetSessionsForTest(256, 512 * 1024 * 1024);
    _setStoreForTest(new SessionStore({ enabled: false }));
    rmrf(root);
}

function readRecord(dir: string, rel: string): Record<string, unknown> {
    const raw = JSON.parse(readFileSync(path.join(dir, rel), "utf8")) as Record<string, unknown>;
    return raw && typeof raw.payload === "object" && raw.payload !== null ? raw.payload as Record<string, unknown> : raw;
}

function blockTextOf(sessionOrRecord: unknown): string {
    const bc = (sessionOrRecord as { blockContents?: unknown }).blockContents;
    if (bc instanceof Map) return (bc.get("b1") as { full?: { text?: string } } | undefined)?.full?.text ?? "";
    const rec = bc as Record<string, { full?: { text?: string } }> | undefined;
    return rec?.b1?.full?.text ?? "";
}

test("#3399 production shape: degraded current-route twin loses to the richer old-route ledger (shadow default)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-twin-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 3697, blockText: "intact A-era folded originals" });
        await seedOnce(dir, { origin: ORIGIN_B, requests: 2, blockText: "fresh B-era rebuild" });

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.ok(reloaded, "cross-route cold load must recover the ledger");
        assert.equal(reloaded.stats.requests, 3697, "richer old-route ledger must win over the degraded twin");
        assert.equal(blockTextOf(reloaded), "intact A-era folded originals");
        // Route adoption: the restored session serves the requested route so
        // the next save converges instead of re-forking under the old host.
        assert.equal(reloaded.meta.upstreamOrigin, ORIGIN_B, "restored session must adopt the requesting route");
        assert.equal(reloaded.meta.label, ID, "identity (label) must stay put");
    } finally {
        teardown(store, root);
    }
});

test("#3399 convergence: save after cross-route restore lands under the requested route with full content", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-converge-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 3697, blockText: "intact A-era folded originals" });
        await seedOnce(dir, { origin: ORIGIN_B, requests: 2, blockText: "fresh B-era rebuild" });

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.ok(reloaded);
        await store.writeNow(reloaded);
        const relB = relPathFor(ID, PROTO, ORIGIN_B);
        assert.ok(existsSync(path.join(dir, relB)), "post-restore save must land under the requested route");
        const recB = readRecord(dir, relB);
        assert.equal((recB.stats as { requests?: number })?.requests ?? (recB.requests as number | undefined), 3697);
        assert.equal(blockTextOf(recB), "intact A-era folded originals", "degraded twin must be overwritten with the restored content");
    } finally {
        teardown(store, root);
    }
});

test("#3399 normal continuation: a successfully continued current-route branch is never rolled back by the stale old ledger", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-norollback-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 2, blockText: "stale A-era fragment" });
        await seedOnce(dir, { origin: ORIGIN_B, requests: 3697, blockText: "continued B-era ledger" });

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.ok(reloaded);
        assert.equal(reloaded.stats.requests, 3697, "the branch with more fold progress must win");
        assert.equal(blockTextOf(reloaded), "continued B-era ledger");
    } finally {
        teardown(store, root);
    }
});

test("#3399 pure miss: only the old route exists when the daemon reboots on the new route", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-puremiss-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 3697, blockText: "intact A-era folded originals" });

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.ok(reloaded, "pure-miss cold load must recover the ledger");
        assert.equal(reloaded.stats.requests, 3697);
        assert.equal(blockTextOf(reloaded), "intact A-era folded originals");
    } finally {
        teardown(store, root);
    }
});

test("#3399 same-route control: unchanged behavior for the exact route", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-sameroute-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 3697, blockText: "same-route ledger" });

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_A });
        assert.ok(reloaded);
        assert.equal(reloaded.stats.requests, 3697);
        assert.equal(blockTextOf(reloaded), "same-route ledger");
    } finally {
        teardown(store, root);
    }
});

test("#3399 fail-closed: corrupt richer sibling quarantines (#3157) and the degraded twin serves", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-corrupt-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 3697, blockText: "intact A-era folded originals" });
        await seedOnce(dir, { origin: ORIGIN_B, requests: 2, blockText: "fresh B-era rebuild" });
        const relA = relPathFor(ID, PROTO, ORIGIN_A);
        writeFileSync(path.join(dir, relA), "{ not json");

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.ok(reloaded, "corruption of one twin must not nuke the other");
        assert.equal(reloaded.stats.requests, 2, "degraded twin serves when the richer one is undecodable");
        assert.ok(!existsSync(path.join(dir, relA)), "corrupt file must be isolated from the live name");
        const quarantined = readdirSync(dir).length >= 0 && readdirSync(path.join(dir, PROTO)).filter(f => f.includes(".corrupt-")).length;
        assert.equal(quarantined, 1, "exactly one .corrupt- forensics copy beside the original");
    } finally {
        teardown(store, root);
    }
});

test("#3399 fail-closed: every candidate corrupt → honest fresh start (null)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-allcorrupt-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 3697, blockText: "intact A-era folded originals" });
        await seedOnce(dir, { origin: ORIGIN_B, requests: 2, blockText: "fresh B-era rebuild" });
        writeFileSync(path.join(dir, relPathFor(ID, PROTO, ORIGIN_A)), "{ not json");
        writeFileSync(path.join(dir, relPathFor(ID, PROTO, ORIGIN_B)), "{ not json");

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.equal(reloaded, null, "no surviving candidate means a fresh start, not a guess");
        const quarantined = readdirSync(path.join(dir, PROTO)).filter(f => f.includes(".corrupt-")).length;
        assert.equal(quarantined, 2, "both corrupt twins quarantined for forensics");
    } finally {
        teardown(store, root);
    }
});

test("#3399 tie-break: equal fold progress prefers the requested route deterministically", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-tie-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 50, blockText: "tie-A" });
        await seedOnce(dir, { origin: ORIGIN_B, requests: 50, blockText: "tie-B" });

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.ok(reloaded);
        assert.equal(blockTextOf(reloaded), "tie-B", "indistinguishable progress → the live route owns the slot");
    } finally {
        teardown(store, root);
    }
});

test("#3399 cross-protocol isolation: the same id under another protocol dir is never picked", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-xproto-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, protocol: "anthropic", requests: 3697, blockText: "anthropic-era ledger" });

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.equal(reloaded, null, "different protocol = different wire shape; no silent adoption");
    } finally {
        teardown(store, root);
    }
});

test("#3399 CCR sidecar follows the restored source file (originals survive the route switch)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-ccr-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 3697, blockText: "intact A-era folded originals" });
        const relA = relPathFor(ID, PROTO, ORIGIN_A);
        const sidecar = { version: 1, byHash: { h1: { text: "original bytes", count: 1 } }, byRef: { m00001: "h1" } };
        writeFileSync(path.join(dir, relA.slice(0, -".json".length) + ".content-store.json"), JSON.stringify(sidecar));

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.ok(reloaded);
        const cs = store.loadContentStore(reloaded);
        assert.ok(cs, "content store must resolve through the restored source file");
        assert.deepEqual(cs?.byRef, { m00001: "h1" });
    } finally {
        teardown(store, root);
    }
});

test("#3399 legacy storage mode: same recovery on the explicit legacy lane", async () => {
    const prevUnified = process.env.BILI_STORAGE_UNIFIED;
    const prevCfg = process.env.BILI_CONFIG_FILE;
    process.env.BILI_STORAGE_UNIFIED = "legacy";
    delete process.env.BILI_CONFIG_FILE;
    const root = mkdtempSync(path.join(tmpdir(), "bili-3399-legacy-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 3697, blockText: "intact A-era folded originals" });
        await seedOnce(dir, { origin: ORIGIN_B, requests: 2, blockText: "fresh B-era rebuild" });

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.ok(reloaded, "legacy mode must recover the ledger too");
        assert.equal(reloaded.stats.requests, 3697);
        assert.equal(blockTextOf(reloaded), "intact A-era folded originals");
    } finally {
        teardown(store, root);
        if (prevUnified === undefined) delete process.env.BILI_STORAGE_UNIFIED; else process.env.BILI_STORAGE_UNIFIED = prevUnified;
        if (prevCfg !== undefined) process.env.BILI_CONFIG_FILE = prevCfg;
    }
});

// #3765 review (@darkness-A): the sidecar must follow the WINNING source, not
// the request's current route — adoption rewrites meta.upstreamOrigin before
// the lazy CCR load, so a degraded current-route twin with a valid-but-
// incomplete CCR must not shadow the richer ledger's originals.
test("#3765 CCR: degraded current-route twin's sidecar must not shadow the winning ledger's originals", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3765-ccr-shadow-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 3697, blockText: "intact A-era folded originals" });
        await seedOnce(dir, { origin: ORIGIN_B, requests: 2, blockText: "fresh B-era rebuild" });
        const ccrA = { version: 1, byHash: { hA: { text: "A original bytes", count: 2 } }, byRef: { m00001: "hA", m00002: "hA" } };
        const ccrB = { version: 1, byHash: { hB: { text: "B partial bytes", count: 1 } }, byRef: { m00001: "hB" } };
        const relA = relPathFor(ID, PROTO, ORIGIN_A);
        const relB = relPathFor(ID, PROTO, ORIGIN_B);
        writeFileSync(path.join(dir, relA.slice(0, -".json".length) + ".content-store.json"), JSON.stringify(ccrA));
        writeFileSync(path.join(dir, relB.slice(0, -".json".length) + ".content-store.json"), JSON.stringify(ccrB));

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.ok(reloaded, "cross-route cold load must recover the richer ledger");
        assert.equal(reloaded.stats.requests, 3697, "richer old-route ledger must win");
        const cs = store.loadContentStore(reloaded);
        assert.ok(cs, "content store must resolve");
        assert.deepEqual(cs?.byRef, ccrA.byRef, "originals must come from the winning source, not the degraded current-route twin");
        assert.notDeepEqual(cs?.byRef, ccrB.byRef, "must not be shadowed by the new-route sidecar");
    } finally {
        teardown(store, root);
    }
});

// #3765 review (@darkness-A): a .fb.json fallback source keeps its canonical
// <base>.content-store.json name — deriving *.fb.content-store.json would miss.
test("#3765 CCR: a .fb.json fallback source resolves its canonical content-store, not *.fb.content-store.json", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-3765-ccr-fb-"));
    const dir = path.join(root, "sessions");
    let store: SessionStore | null = null;
    try {
        await seedOnce(dir, { origin: ORIGIN_A, requests: 3697, blockText: "intact A-era folded originals" });
        await seedOnce(dir, { origin: ORIGIN_B, requests: 2, blockText: "fresh B-era rebuild" });
        // Demote A's ledger to its .fb.json fallback name; its CCR stays canonical.
        const relA = relPathFor(ID, PROTO, ORIGIN_A);
        const absA = path.join(dir, relA);
        renameSync(absA, absA.slice(0, -".json".length) + ".fb.json");
        const ccrA = { version: 1, byHash: { hA: { text: "A original bytes", count: 2 } }, byRef: { m00001: "hA", m00002: "hA" } };
        const ccrB = { version: 1, byHash: { hB: { text: "B partial bytes", count: 1 } }, byRef: { m00001: "hB" } };
        writeFileSync(path.join(dir, relA.slice(0, -".json".length) + ".content-store.json"), JSON.stringify(ccrA));
        const relB = relPathFor(ID, PROTO, ORIGIN_B);
        writeFileSync(path.join(dir, relB.slice(0, -".json".length) + ".content-store.json"), JSON.stringify(ccrB));

        store = bootStore(dir);
        await store.boot(BOOT_LIMITS);
        const reloaded = store.loadSync(ID, { protocol: PROTO, upstreamOrigin: ORIGIN_B });
        assert.ok(reloaded, "fallback-name ledger must still recover");
        assert.equal(reloaded.stats.requests, 3697);
        const cs = store.loadContentStore(reloaded);
        assert.ok(cs, "content store must resolve through the .fb.json source's canonical sidecar");
        assert.deepEqual(cs?.byRef, ccrA.byRef, "must read the canonical <base>.content-store.json, not a *.fb.content-store.json");
    } finally {
        teardown(store, root);
    }
});
