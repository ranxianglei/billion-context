/**
 * Storage-corpus fixture generator (storage-refactor pre-work, S5).
 *
 * Produces committed legacy-format session files — one directory per case —
 * by driving the REAL persistence path (SessionStore.writeNow →
 * buildRecord → kernel StateStore codec write). The corpus pins the CURRENT
 * on-disk format + its loadSync round-trip semantics; when the unified
 * storage lands, the same corpus drives old-load → migrate → new-load and
 * the digests must not move (see tests/storage-corpus.test.ts).
 *
 * Regenerate: node --import tsx scripts/update-storage-corpus.ts
 * (regeneration is itself a migration-relevant event — commit the diff with
 * a reason, exactly like the wire-contract goldens).
 *
 * Cases cover every persisted-record branch in buildRecord/buildSession:
 *  folded        — active T1 block + blockContents(one:null) + message tail
 *  tier2         — superseded T1 (active:false) + distinct `one` summary view
 *                  + a byte-identical one/full pair (pins #401 normalize)
 *  deadrefs      — #2362/#2370 tombstones + ghost refs after a client edit
 *  fork-receipt  — publicForkReceipt: pluginSnapshot + forkContentStore +
 *                  publicSnapshotStoredRefs union (the full fork contract)
 *  fork-retained — publicSnapshotRetained only: snapshot persisted, store
 *                  NOT (the #2675 ② asymmetry, pinned as-is)
 *  image         — base64 image content + image stats/metadata
 *  ccr           — content-store.json sibling (CCR originals, #1097)
 *  twinfile      — namespaced v2 file + stale flat v1 twin (#2671 ①)
 *  zstd          — BILIZSTD1-framed twin of `folded` (identical digest)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createCore, createInitialState, defaultConfig, assignRefs, type CompressionState, type CoreMessage, type MessageContentStore } from "acp-kernel";
import { flatFileNameFor } from "acp-kernel/persist";
import { SessionStore, relPathFor, type Session } from "../src/persist.ts";
import { canonicalize, sha256 } from "../tests/golden-canonical.ts";

const CORPUS_ROOT = path.resolve(import.meta.dirname, "../tests/golden/storage-corpus");
const CREATED_AT = 1_700_000_000_000;

// Corpus default is PLAIN JSON (the recoverability default, #1080): a machine
// with persist.zstd=true in its config file must not silently re-frame every
// case. The `zstd` case flips this on for its own writes.
process.env.BILI_PERSIST_ZSTD = "0";

// ── kernel engine (idioms lifted from tests/pins-storage-refactor.test.ts) ──

interface Engine {
    core: ReturnType<typeof createCore>;
    config: ReturnType<typeof defaultConfig>;
    state: CompressionState;
    messages: CoreMessage[];
    nextIndex: number;
}

function newEngine(): Engine {
    return { core: createCore(), config: defaultConfig(200000), state: createInitialState(), messages: [], nextIndex: 0 };
}

function makeMsgs(n: number, tag = "raw"): CoreMessage[] {
    return Array.from({ length: n }, (_, i) => ({
        id: `${tag}${i + 1}`,
        role: i % 2 ? "assistant" : "user",
        contentType: "text",
        text: `message body ${tag}${i + 1} lorem ipsum dolor sit amet `.repeat(20),
    })) as unknown as CoreMessage[];
}

function syncRefs(e: Engine): void {
    const { map, nextIndex } = assignRefs(e.messages, { existing: e.state.messageRefs, nextIndex: e.nextIndex });
    e.state.messageRefs = map;
    e.nextIndex = nextIndex;
}

function refFor(e: Engine, raw: string): string | undefined {
    return e.state.messageRefs.byRaw[raw];
}

function fold(e: Engine, startRef: string, endRef: string, summary: string): number {
    const r = e.core.applyCompression({ ranges: [{ startRef, endRef, summary }], messages: e.messages, state: e.state, config: e.config });
    e.state = r.state; // take even on refusal — tombstones are state transitions
    if (r.result.blocksCreated === 0) throw new Error(`fold refused: ${r.result.errors.join("; ")}`);
    return r.result.blocksCreated;
}

// ── Session construction (shape mirrors buildSession output exactly) ────────

type SessionLike = Omit<Session,
    "stats" | "state" | "blockContents" | "pendingRetrievals" | "inFlight"
> & {
    stats: Partial<Session["stats"]> & Pick<Session["stats"], "requests" | "tokensSaved" | "inputTokens" | "cachedTokens" | "outputTokens" | "cacheSamples" | "lastInputTokens" | "contextTokens">;
    state: CompressionState;
    blockContents: Session["blockContents"];
    pendingRetrievals: Session["pendingRetrievals"];
    inFlight: number;
};

function baseSession(id: string, protocol: Session["meta"]["protocol"], e: Engine, patch: Partial<SessionLike> = {}): Session {
    const s: SessionLike = {
        id,
        meta: { protocol, upstreamOrigin: "http://127.0.0.1:8199", label: `corpus-${id}`, title: `Corpus ${id}`, activePack: undefined, hostTitle: undefined },
        stats: {
            requests: 7, tokensSaved: 12345, inputTokens: 234567, cachedTokens: 123456, outputTokens: 3456,
            cacheSamples: 7, lastInputTokens: 45678, contextTokens: 45678, contextTokensSource: "usage",
            localInputEstimate: 45000, lastUsageGradeTokens: 44000, lastInputTokensOrigin: "http://127.0.0.1:8199",
            retrieveCalls: 3, retrieveHits: 2, retrieveMisses: 1, retrieveDelivered: 3,
            imageShrunkCount: 0, imageBytesSaved: 0, imageTokensSaved: 0,
        },
        metadata: { corpus: id },
        state: e.state,
        createdAt: CREATED_AT,
        lastSeen: CREATED_AT,
        restored: false,
        ccrReconcilePending: false,
        blockContents: new Map(),
        lastMessages: undefined,
        lastMessagesFolded: false,
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
        ...patch,
    };
    return s as unknown as Session;
}

async function writeSessionAwaited(dir: string, session: Session): Promise<string[]> {
    const store = new SessionStore({ dir, debounceMs: 1, enabled: true });
    await store.writeNow(session);
    const files: string[] = [];
    const walk = (d: string): void => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else files.push(path.relative(dir, full));
        }
    };
    walk(dir);
    files.sort();
    return files;
}

/** Digest over an in-memory session (pre-write reference — NOT the pin). */
function sessionDigest(loaded: Session): string {
    const view = {
        id: loaded.id,
        meta: loaded.meta,
        stats: loaded.stats,
        metadata: loaded.metadata,
        state: loaded.state,
        blockContents: [...loaded.blockContents.entries()],
        lastMessages: loaded.lastMessages,
        lastMessagesFolded: loaded.lastMessagesFolded,
        pluginSnapshot: loaded.pluginSnapshot,
        contentStore: loaded.contentStore,
    };
    return sha256(JSON.stringify(canonicalize(view)));
}

interface CaseResult { description: string; files: string[]; digest: string; notes?: Record<string, unknown> }

/** The PIN: write → loadSync → digest. Everything the load path normalizes
 *  (#401 one/full collapse, biliVersion stamp, savedAt→lastSeen) is part of
 *  the pinned round-trip contract — the unified store must reproduce this
 *  digest bit-for-bit after migration. */
async function writeAndPin(name: string, session: Session, meta: { protocol?: string; upstreamOrigin?: string } = {}): Promise<CaseResult> {
    const dirOf = (n: string): string => path.join(CORPUS_ROOT, n);
    const caseDir = dirOf(name);
    fs.mkdirSync(caseDir, { recursive: true });
    const files = await writeSessionAwaited(caseDir, session);
    const readStore = new SessionStore({ dir: caseDir, debounceMs: 1, enabled: true });
    const loaded = readStore.loadSync(session.id, meta);
    if (!loaded) throw new Error(`${name}: loadSync returned null`);
    return { description: "", files, digest: sessionDigest(loaded) };
}

async function main(): Promise<void> {
    // Byte-stable fixtures: freeze the wall clock for the whole run so
    // savedAt (and anything else Date.now-derived) is identical across
    // regenerations — a no-op regen must leave git untouched.
    const realNow = Date.now;
    Date.now = () => CREATED_AT + 1;
    const manifest: Record<string, CaseResult> = {};
    try {
    if (fs.existsSync(CORPUS_ROOT)) fs.rmSync(CORPUS_ROOT, { recursive: true });
    fs.mkdirSync(CORPUS_ROOT, { recursive: true });
    const dir = (name: string): string => path.join(CORPUS_ROOT, name);

    // ── folded ──────────────────────────────────────────────────────────────
    {
        const e = newEngine();
        e.messages = makeMsgs(40);
        syncRefs(e);
        fold(e, refFor(e, "raw2")!, refFor(e, "raw20")!, "corpus folded summary of raw2..raw20 ".repeat(8));
        const block = e.state.blocks.find((b) => b.active)!;
        const session = baseSession("corpus-folded", "anthropic", e, {
            blockContents: new Map([[block.blockId, { one: null, full: { text: "corpus folded summary of raw2..raw20 ".repeat(8), count: 19 } }]]),
            lastMessages: e.messages.slice(-10),
            lastMessagesFolded: true,
        });
        const res = await writeAndPin("folded", session, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        manifest["folded"] = { ...res, description: "active T1 block, blockContents one:null, folded message tail" };
    }

    // ── tier2 (superseded T1 + distinct `one` + byte-identical pair) ────────
    {
        const e = newEngine();
        e.messages = makeMsgs(60);
        syncRefs(e);
        fold(e, refFor(e, "raw2")!, refFor(e, "raw20")!, "tier1 summary text for the superseded block ".repeat(8));
        fold(e, refFor(e, "raw21")!, refFor(e, "raw40")!, "tier1 summary text for the second block ".repeat(8));
        const b1 = e.state.blocks[0]!;
        fold(e, b1.blockId, b1.blockId, "tier-2 distillation replacing the first block ".repeat(8));
        const t2 = e.state.blocks.find((b) => b.active && b.directBlockIds.includes(b1.blockId))!;
        const contents = new Map<string, { one: { text: string; count: number } | null; full: { text: string; count: number } }>();
        const t1Full = { text: "tier1 summary text for the superseded block ".repeat(8), count: 19 };
        contents.set(b1.blockId, {
            one: { text: "tier1 summary text for the superseded block ".repeat(8), count: 19 }, // byte-identical pair → must normalize to one:null on load (#401)
            full: t1Full,
        });
        for (const b of e.state.blocks) {
            if (b.blockId === b1.blockId) continue;
            const full = { text: `summary ${b.blockId} `.repeat(40), count: b.effectiveMessageIds.length };
            const one = b.active ? { text: `one-line ${b.blockId} view`, count: 1 } : full; // distinct one for the ACTIVE T2; identical for inactive
            contents.set(b.blockId, { one, full });
        }
        const session = baseSession("corpus-tier2", "chat", e, { blockContents: contents, lastMessages: e.messages.slice(-6), lastMessagesFolded: true });
        const res = await writeAndPin("tier2", session, { protocol: "chat", upstreamOrigin: "http://127.0.0.1:8199" });
        manifest["tier2"] = {
            ...res,
            description: "superseded T1 + active T2, distinct `one` views, byte-identical pair pins #401 normalize-on-load",

            notes: { t2Block: t2.blockId },
        };
    }

    // ── deadrefs (#2362/#2370 tombstones + ghost refs) ──────────────────────
    {
        const e = newEngine();
        e.messages = makeMsgs(30);
        syncRefs(e);
        fold(e, refFor(e, "raw2")!, refFor(e, "raw20")!, "deadrefs fixture fold over raw2..raw20 ".repeat(8));
        const ghostRef = refFor(e, "raw10")!;
        e.messages = [...e.messages.slice(0, 9), ...e.messages.slice(16)]; // client rewrite drops raw10..raw15
        syncRefs(e);
        const r = e.core.applyCompression({ ranges: [{ startRef: ghostRef, endRef: refFor(e, "raw14")!, summary: "attempt over dead range ".repeat(8) }], messages: e.messages, state: e.state, config: e.config });
        e.state = r.state; // refusal path still mints tombstones
        if (!(e.state.deadRefs ?? []).includes(ghostRef)) throw new Error("deadrefs: tombstone not minted");
        const block = e.state.blocks.find((b) => b.active)!;
        const session = baseSession("corpus-deadrefs", "anthropic", e, {
            blockContents: new Map([[block.blockId, { one: null, full: { text: "deadrefs fixture fold over raw2..raw20 ".repeat(8), count: 19 } }]]),
        });
        const res = await writeAndPin("deadrefs", session, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        manifest["deadrefs"] = {
            ...res,
            description: "deadRefs tombstones + ghost raw ids after client edit (#2362/#2370)",

            notes: { ghostRef },
        };
    }

    // ── fork-receipt (full fork contract) ───────────────────────────────────
    {
        const e = newEngine();
        e.messages = makeMsgs(30);
        syncRefs(e);
        fold(e, refFor(e, "raw2")!, refFor(e, "raw20")!, "fork fixture fold over raw2..raw20 ".repeat(8));
        const block = e.state.blocks.find((b) => b.active)!;
        const contentStore: MessageContentStore = {
            version: 1,
            byHash: { [sha256("original tool output corpus-1")]: "original tool output corpus-1" },
            byRef: {
                [refFor(e, "raw4")!]: { kind: "tool_result", rawId: "raw4", ref: refFor(e, "raw4")!, text: "original tool output corpus-1", tokens: 40, chars: 27, head: "original tool output c" },
            },
        };
        const session = baseSession("corpus-fork-receipt", "chat", e, {
            blockContents: new Map([[block.blockId, { one: null, full: { text: "fork fixture fold over raw2..raw20 ".repeat(8), count: 19 } }]]),
            pluginSnapshot: e.messages,
            contentStore,
            metadata: {
                corpus: "corpus-fork-receipt",
                publicForkReceipt: { childId: "corpus-fork-child", cutAtRef: refFor(e, "raw15")!, revision: sha256("corpus-fork-receipt-parent-rev"), at: CREATED_AT },
                publicSnapshotRetained: true,
            },
        });
        const res = await writeAndPin("fork-receipt", session, { protocol: "chat", upstreamOrigin: "http://127.0.0.1:8199" });
        manifest["fork-receipt"] = {
            ...res,
            description: "publicForkReceipt: pluginSnapshot + forkContentStore + publicSnapshotStoredRefs union",

        };
    }

    // ── fork-retained (the #2675 ② asymmetry: snapshot kept, store dropped) ─
    {
        const e = newEngine();
        e.messages = makeMsgs(30);
        syncRefs(e);
        fold(e, refFor(e, "raw2")!, refFor(e, "raw20")!, "retained fixture fold over raw2..raw20 ".repeat(8));
        const block = e.state.blocks.find((b) => b.active)!;
        const session = baseSession("corpus-fork-retained", "chat", e, {
            blockContents: new Map([[block.blockId, { one: null, full: { text: "retained fixture fold over raw2..raw20 ".repeat(8), count: 19 } }]]),
            pluginSnapshot: e.messages,
            contentStore: { version: 1, byHash: {}, byRef: {} },
            metadata: { corpus: "corpus-fork-retained", publicSnapshotRetained: true },
        });
        const res = await writeAndPin("fork-retained", session, { protocol: "chat", upstreamOrigin: "http://127.0.0.1:8199" });
        manifest["fork-retained"] = {
            ...res,
            description: "publicSnapshotRetained only — pluginSnapshot persisted, forkContentStore DROPPED (pins the #2675 ② asymmetry verbatim)",

            notes: { expectContentStoreOnLoad: "absent" },
        };
    }

    // ── image ───────────────────────────────────────────────────────────────
    {
        const e = newEngine();
        e.messages = makeMsgs(20);
        const imageMsg = {
            id: "rawimg1", role: "user" as const, contentType: "image" as const,
            text: "look at this", media: "aGVsbG8gaW1hZ2UgY29ycHVz", // "hello image corpus" base64
        } as unknown as CoreMessage;
        e.messages = [...e.messages, imageMsg];
        syncRefs(e);
        const session = baseSession("corpus-image", "anthropic", e, {
            lastMessages: e.messages.slice(-8),
            lastMessagesFolded: false,
            stats: {
                requests: 3, tokensSaved: 0, inputTokens: 99000, cachedTokens: 1000, outputTokens: 500,
                cacheSamples: 3, lastInputTokens: 99000, contextTokens: 99000, contextTokensSource: "estimate",
                imageShrunkCount: 1, imageBytesSaved: 4096, imageTokensSaved: 1024, imageFullCalls: 1, imageFullRestores: 1,
            },
            metadata: { corpus: "corpus-image", imageShrinks: [{ ref: refFor(e, "rawimg1")!, from: 8192, to: 4096 }] },
        });
        const res = await writeAndPin("image", session, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        manifest["image"] = {
            ...res,
            description: "base64 image message + image stats + imageShrinks metadata",

        };
    }

    // ── ccr (content-store.json sibling) ────────────────────────────────────
    {
        const e = newEngine();
        e.messages = makeMsgs(24);
        syncRefs(e);
        const contentStore: MessageContentStore = {
            version: 1,
            byHash: {
                [sha256("ccr original one")]: "ccr original one",
                [sha256("ccr original two")]: "ccr original two",
            },
            byRef: {
                [refFor(e, "raw6")!]: { kind: "tool_result", rawId: "raw6", ref: refFor(e, "raw6")!, text: "ccr original one", tokens: 33, chars: 16, head: "ccr original one" },
                [refFor(e, "raw8")!]: { kind: "tool_result", rawId: "raw8", ref: refFor(e, "raw8")!, text: "ccr original two", tokens: 33, chars: 16, head: "ccr original two" },
            },
        };
        const session = baseSession("corpus-ccr", "responses", e, {
            contentStore,
            contentStoreDirty: true,
            stats: {
                requests: 2, tokensSaved: 6000, inputTokens: 50000, cachedTokens: 0, outputTokens: 200,
                cacheSamples: 2, lastInputTokens: 50000, contextTokens: 50000, contextTokensSource: "estimate",
                storedBytes: 32, storeBytesSaved: 64,
            },
        });
        const res = await writeAndPin("ccr", session, { protocol: "responses", upstreamOrigin: "http://127.0.0.1:8199" });
        manifest["ccr"] = {
            ...res,
            description: "content-store.json sibling with two CCR originals (#1097 envelope)",

        };
    }

    // ── twinfile (namespaced v2 + stale flat v1, #2671 ①) ───────────────────
    {
        const e = newEngine();
        e.messages = makeMsgs(16);
        syncRefs(e);
        const session = baseSession("corpus-twin", "openai", e);
        session.stats.requests = 42;
        const res = await writeAndPin("twinfile", session, { protocol: "openai", upstreamOrigin: "http://127.0.0.1:8199" });
        const files = res.files;
        // Hand-write the stale flat v1 twin (pre-namespacing format): the SAME
        // session id at an older generation. v1 shape: flat fields, minimal —
        // this is exactly what pre-v2 bili files look like on disk today.
        const v1 = {
            id: "corpus-twin", savedAt: CREATED_AT - 60_000, createdAt: CREATED_AT - 60_000,
            protocol: "openai", upstreamOrigin: "http://127.0.0.1:8199", label: "corpus-corpus-twin", requests: 1,
            tokensSaved: 0, inputTokens: 1000, cachedTokens: 0, outputTokens: 50,
            state: { version: 1, blocks: [], messageRefs: { byRaw: {}, byRef: {}, nextIndex: 1 }, nextBlockId: 1, deadRefs: [] },
            blockContents: {}, metadata: { legacyFlatTwin: true },
        };
        const flatRel = flatFileNameFor("corpus-twin");
        fs.writeFileSync(path.join(dir("twinfile"), flatRel), JSON.stringify(v1) + "\n");
        files.push(flatRel);
        files.sort();
        // Without meta the reader must fall back through the kernel flat-name
        // probe and find the STALE twin — pin that digest separately.
        const flatStore = new SessionStore({ dir: dir("twinfile"), debounceMs: 1, enabled: true });
        const flatLoaded = flatStore.loadSync("corpus-twin");
        manifest["twinfile"] = {
            ...res,
            description: "namespaced v2 record + stale FLAT v1 twin for the same id (#2671 ① twin-namespace)",
            files,
            digest: res.digest,
            notes: {
                flatTwinRequests: 1, namespacedRequests: 42,
                flatFallbackDigest: flatLoaded ? sessionDigest(flatLoaded) : null,
                flatFallbackRequests: flatLoaded ? flatLoaded.stats.requests : null,
            },
        };
    }

    // ── zstd (BILIZSTD1 twin of folded) ─────────────────────────────────────
    {
        process.env.BILI_PERSIST_ZSTD = "1";
        const e = newEngine();
        e.messages = makeMsgs(40);
        syncRefs(e);
        fold(e, refFor(e, "raw2")!, refFor(e, "raw20")!, "corpus folded summary of raw2..raw20 ".repeat(8));
        const block = e.state.blocks.find((b) => b.active)!;
        const session = baseSession("corpus-folded", "anthropic", e, {
            blockContents: new Map([[block.blockId, { one: null, full: { text: "corpus folded summary of raw2..raw20 ".repeat(8), count: 19 } }]]),
            lastMessages: e.messages.slice(-10),
            lastMessagesFolded: true,
        });
        const res = await writeAndPin("zstd", session, { protocol: "anthropic", upstreamOrigin: "http://127.0.0.1:8199" });
        if (res.digest !== manifest["folded"]!.digest) throw new Error(`zstd twin digest drifted from folded: ${res.digest} vs ${manifest["folded"]!.digest}`);
        manifest["zstd"] = {
            ...res,
            description: "BILIZSTD1-framed write of the `folded` session — must load to the IDENTICAL digest",

        };
        process.env.BILI_PERSIST_ZSTD = "0";
    }

    } finally {
        Date.now = realNow;
    }
    fs.writeFileSync(path.join(CORPUS_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`corpus written to ${CORPUS_ROOT}`);
    for (const [name, c] of Object.entries(manifest)) console.log(`  ${name}: ${c.files.length} file(s), digest ${c.digest.slice(0, 12)} — ${c.description}`);
}

void main().catch((err) => { console.error(err); process.exit(1); });
