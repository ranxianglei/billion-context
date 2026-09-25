import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createCore, createInitialState, defaultConfig, refToIndex } from "acp-kernel";
import { anthropicToCore, type AnthropicRequestBody } from "acp-kernel/wire";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, getSession, type Session } from "../src/session.ts";
import { executeSearchContext, executeSearchContextTarget, inheritedBlockIdsOf, resolveDecompress, type ProxyToolCtx } from "../src/decompress-shared.ts";
import { seedDerivedSession } from "../src/rlm-inherit.ts";
import { _resetPluginStateForTest, consumePluginRegisterFor, handlePluginRegister, queuePluginRegister, takePendingPluginRegister } from "../src/plugin.ts";
import { resolveParentConversationId } from "../src/agent/pi.ts";
import { resolveOpencodeParentId, type V1PluginContext } from "../src/agent/opencode-native.ts";

/**
 * #1333 derived-session inheritance: a host that DECLARES an explicit
 * parent/child relationship (pi RLM `parentSession` header, opencode
 * `parentID`) gets its child's compression archive seeded from the parent on
 * the child's first request — dormant copies (invisible to view rebuild and
 * orphan-gc) that search_context scores via a synthetic-active pass and
 * decompress reaches directly (self-contained via copied blockContents).
 * Also pins the declaration plumbing: register-body parentId, pi header
 * resolution (getHeader fast path / file fallback / cache / LRU), opencode
 * session.get resolution (shapes / this-binding / cache).
 */

function resetWorld(): void {
    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
}

function compressInto(session: Session, topic: string): string {
    const core = createCore();
    const config = defaultConfig(200000);
    const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
    for (let i = 0; i < 40; i++) {
        body.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `${topic} message ${i} ${"y".repeat(2000)}` });
    }
    const { msgs } = anthropicToCore(body);
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    // Refs are assigned per message in the state's ref map — resolve them from
    // the turn's own messages so compression also works on a session whose
    // ref cursor was already advanced by inherited parent entries (#1333).
    const startRef = turn.state.messageRefs.byRaw[turn.messages[0]!.id];
    const endRef = turn.state.messageRefs.byRaw[turn.messages[14]!.id];
    assert.ok(startRef && endRef, "turn messages must carry assigned refs");
    const res = core.applyCompression({
        ranges: [{ startRef, endRef, summary: `${topic} decisions and tradeoffs`.repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.blocksCreated, 1, "compression block should be created");
    session.state = res.state;
    return session.state.blocks[session.state.blocks.length - 1]!.blockId;
}

function seed(session: Session, parentId: string, enabled = true): string[] {
    const logs: string[] = [];
    seedDerivedSession({ session, parentId, protocol: "anthropic", upstreamOrigin: "", enabled, log: (level, msg) => logs.push(`${level}:${msg}`) });
    return logs;
}

test("seeds the parent's compression archive into the derived child as dormant blocks (#1333)", () => {
    resetWorld();
    try {
        const parent = getSession("rlm-parent");
        const parentBlockId = compressInto(parent, "auth token refresh design");
        parent.blockContents.set(parentBlockId, { one: null, full: { text: "the original auth body", count: 40 } });
        const parentBefore = structuredClone(parent.state);

        const child = getSession("rlm-child");
        const logs = seed(child, "rlm-parent");

        assert.equal(child.state.blocks.length, 1, "child must carry exactly the parent's block");
        const b = child.state.blocks[0]!;
        assert.equal(b.blockId, parentBlockId, "inherited block keeps its id");
        assert.equal(b.active, false, "inherited blocks are DORMANT (never rendered into the child's view)");
        assert.equal(b.expanded, true, "expanded pins dormancy through the kernel's syncBlocks resurrection pass");
        assert.match(b.summary, /auth token refresh design/);
        assert.deepEqual(child.blockContents.get(parentBlockId), { one: null, full: { text: "the original auth body", count: 40 } }, "originals copied so decompress is self-contained");

        const derivedFrom = child.metadata.derivedFrom as { parentConversationId?: unknown; declaredParentId?: unknown; at?: unknown; blocks?: unknown };
        assert.equal(derivedFrom.parentConversationId, "rlm-parent");
        assert.equal(derivedFrom.declaredParentId, "rlm-parent");
        assert.equal(typeof derivedFrom.at, "number");
        assert.equal(derivedFrom.blocks, 1);
        assert.deepEqual(child.metadata.inheritedBlockIds, [parentBlockId]);
        assert.deepEqual(inheritedBlockIdsOf(child), [parentBlockId]);
        assert.deepEqual(inheritedBlockIdsOf(parent), [], "parent has no inherited ids of its own");

        assert.ok(child.state.nextBlockId >= parent.state.nextBlockId, "child block-id cursor must not fall behind the parent's");
        assert.ok(child.state.nextRunId >= parent.state.nextRunId, "child run-id cursor must not fall behind the parent's");
        for (const [raw, ref] of Object.entries(parent.state.messageRefs.byRaw)) assert.equal(child.state.messageRefs.byRaw[raw], ref, "byRaw entry inherited");
        for (const [ref, raw] of Object.entries(parent.state.messageRefs.byRef)) assert.equal(child.state.messageRefs.byRef[ref], raw, "byRef entry inherited");

        // Deep-copy proof: mutating the child's copy must not touch the parent.
        b.summary = "MUTATED";
        child.blockContents.get(parentBlockId)!.full.text = "MUTATED";
        assert.notEqual(parent.state.blocks[0]!.summary, "MUTATED", "parent block summary untouched");
        assert.equal(parent.blockContents.get(parentBlockId)!.full.text, "the original auth body", "parent content untouched");
        assert.deepEqual(structuredClone(parent.state), parentBefore, "parent state byte-identical after seeding");

        assert.ok(logs.some((l) => l.startsWith("info:") && l.includes("[rlm-inherit]") && l.includes("inherited 1 block(s)") && l.includes("refs up to m00040") && l.includes("from parent rlm-parent")), `seed log present with true ref ceiling: ${JSON.stringify(logs)}`);
    } finally {
        resetWorld();
    }
});

test("dormancy survives the child's own processTurn turns — expanded pins it against syncBlocks resurrection (#1333)", () => {
    resetWorld();
    try {
        const parent = getSession("rlm-parent");
        const parentBlockId = compressInto(parent, "auth token refresh design");
        const parentMaxRef = Math.max(0, ...Object.values(parent.state.messageRefs.byRaw).map((r) => refToIndex(r) ?? 0));

        const child = getSession("rlm-child");
        seed(child, "rlm-parent");

        // The RLM child's real requests carry ONLY its own fresh history — none
        // of the parent's raw ids are present. The kernel's syncBlocks
        // stillPresent pass would flip a plain inactive block active→inactive on
        // every turn; `expanded: true` must keep the inherited block stably
        // dormant instead (otherwise the archive flaps and orphan-gc-adjacent
        // consumers see churn). Run two turns to prove stability.
        const core = createCore();
        const config = defaultConfig(200000);
        const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
        for (let i = 0; i < 4; i++) body.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `child fresh message ${i}` });
        const { msgs } = anthropicToCore(body);

        let state = child.state;
        for (let turn = 1; turn <= 2; turn++) {
            state = core.processTurn({ messages: msgs, state, config }).state;
            const b = state.blocks.find((x) => x.blockId === parentBlockId);
            assert.ok(b, `inherited block still present after turn ${turn}`);
            assert.equal(b.active, false, `inherited block stays DORMANT after turn ${turn}`);
            assert.equal(b.expanded, true, "expanded pin intact after syncBlocks");
        }
        // Refs continue from the inherited ceiling: the child's own messages must
        // never re-issue a ref the parent used (the id-never-reused contract).
        for (const m of msgs) {
            const ref = state.messageRefs.byRaw[m.id];
            assert.ok(ref !== undefined, "child message got a ref");
            const idx = refToIndex(ref)!;
            assert.ok(idx > parentMaxRef || !parent.state.messageRefs.byRef[ref], `child ref ${ref} does not collide with an inherited parent ref`);
        }
    } finally {
        resetWorld();
    }
});

test("child search sees the dormant archive only through the inherited pass (#1333)", () => {
    resetWorld();
    try {
        const parent = getSession("rlm-parent");
        compressInto(parent, "auth token refresh design");
        const child = getSession("rlm-child");
        seed(child, "rlm-parent");
        const core = createCore();

        const plain = executeSearchContext({ query: "auth token" }, core, child.state);
        assert.match(plain, /^\[No compressed blocks exist yet — nothing to search\.\]$/, "dormant archive invisible without the inherited pass");

        const withArchive = executeSearchContext({ query: "auth token" }, core, child.state, undefined, inheritedBlockIdsOf(child));
        assert.match(withArchive, /^Found 1 block\(s\) for "auth token":/);
        assert.ok(withArchive.includes("(T"), "tier marker present");
        assert.ok(withArchive.includes("auth token refresh design"), "archive summary preview present");
    } finally {
        resetWorld();
    }
});

test("inherited blocks rank alongside the child's own blocks in one scoring pass (#1333)", () => {
    resetWorld();
    try {
        const parent = getSession("rlm-parent");
        compressInto(parent, "billing cache eviction policy");
        const child = getSession("rlm-child");
        seed(child, "rlm-parent");
        compressInto(child, "billing cache migration plan");
        const core = createCore();

        const both = executeSearchContext({ query: "billing cache" }, core, child.state, undefined, inheritedBlockIdsOf(child));
        assert.match(both, /^Found 2 block\(s\) for "billing cache":/, "archive + own block in one ranked list");
        assert.ok(both.includes("eviction policy") && both.includes("migration plan"));
    } finally {
        resetWorld();
    }
});

test("foreign-session search excludes the dormant archive; grandchildren reach it via their own pass (#1333)", () => {
    resetWorld();
    try {
        const greatGrand = getSession("rlm-gg");
        compressInto(greatGrand, "auth token refresh design");
        const grand = getSession("rlm-grand");
        seed(grand, "rlm-gg");
        compressInto(grand, "billing cache migration plan");
        const child = getSession("rlm-child");
        seed(child, "rlm-grand");
        const core = createCore();

        // From the child's context, searching GRAND as a foreign session must
        // see only grand's LIVE blocks — grand's dormant great-grand archive
        // belongs to grand's namespace, not the foreign lookup.
        const foreign = executeSearchContextTarget({ query: "auth token", conversation_id: "rlm-grand" }, core, "rlm-child", child.state, inheritedBlockIdsOf(child));
        // Exact match (no trailing note — the read-only note only rides FOUND
        // results) proves the dormant great-grand archive is invisible here:
        // grand's own live block doesn't match "auth token" either, so ANY
        // hit would have come from the wrongly-leaked archive.
        assert.match(foreign, /^\[No blocks matched "auth token" in session rlm-grand\]$/, `foreign lookup must skip dormant archive: ${foreign}`);

        // The same content IS reachable through the child's OWN inherited pass
        // (grand's live block + grand's dormant archive were all seeded into
        // the child, so the great-grand summary is in the child's archive).
        const selfPath = executeSearchContextTarget({ query: "auth token" }, core, "rlm-child", child.state, inheritedBlockIdsOf(child));
        assert.match(selfPath, /^Found 1 block\(s\) for "auth token":/, `child's own inherited pass must reach it: ${selfPath}`);
    } finally {
        resetWorld();
    }
});

test("decompress reaches the inherited archive from the child (self-contained, no ancestor lookup) (#1333)", () => {
    resetWorld();
    try {
        const parent = getSession("rlm-parent");
        const parentBlockId = compressInto(parent, "auth token refresh design");
        parent.blockContents.set(parentBlockId, { one: null, full: { text: "the original auth body", count: 40 } });
        const child = getSession("rlm-child");
        seed(child, "rlm-parent");

        const core = createCore();
        const ctx: ProxyToolCtx = { core, config: defaultConfig(200000), messages: [], session: child, log: () => {} };
        const out = resolveDecompress({ blockId: parentBlockId }, ctx);
        assert.ok(out.startsWith(`[Block ${parentBlockId} content — 40 item(s)]`), `header present: ${out.slice(0, 80)}`);
        assert.ok(out.includes("the original auth body"), "cached originals served from the CHILD's store");
        assert.match(resolveDecompress({ blockId: "b999" }, ctx), /^\[Block b999 not found\]$/);
    } finally {
        resetWorld();
    }
});

test("replay guards: a second request or an existing derivedFrom never re-seeds (#1333)", () => {
    resetWorld();
    try {
        const parent = getSession("rlm-parent");
        compressInto(parent, "auth token refresh design");

        const child = getSession("rlm-child");
        seed(child, "rlm-parent");
        assert.equal(child.state.blocks.length, 1);
        seed(child, "rlm-parent");
        assert.equal(child.state.blocks.length, 1, "existing derivedFrom must not double-seed");

        const late = getSession("rlm-late");
        late.stats.requests = 1;
        seed(late, "rlm-parent");
        assert.equal(late.state.blocks.length, 0, "requests > 0 must never seed");
        assert.equal(late.metadata.derivedFrom, undefined);
    } finally {
        resetWorld();
    }
});

test("missing parent starts fresh with a log line (#1333)", () => {
    resetWorld();
    try {
        const child = getSession("rlm-child");
        const logs = seed(child, "rlm-ghost");
        assert.equal(child.state.blocks.length, 0);
        assert.equal(child.metadata.derivedFrom, undefined);
        assert.ok(logs.some((l) => l.includes("parent not found") && l.includes("starting fresh")), JSON.stringify(logs));
    } finally {
        resetWorld();
    }
});

test("self-parent declaration is rejected (#1333)", () => {
    resetWorld();
    try {
        const child = getSession("rlm-child");
        const logs = seed(child, "rlm-child");
        assert.equal(child.state.blocks.length, 0);
        assert.ok(logs.some((l) => l.startsWith("warn:") && l.includes("ITSELF")), JSON.stringify(logs));
    } finally {
        resetWorld();
    }
});

test("disabled inheritance leaves the child fresh with a measurement log (#1333)", () => {
    resetWorld();
    try {
        const parent = getSession("rlm-parent");
        compressInto(parent, "auth token refresh design");
        const child = getSession("rlm-child");
        const logs = seed(child, "rlm-parent", false);
        assert.equal(child.state.blocks.length, 0);
        assert.equal(child.metadata.derivedFrom, undefined);
        assert.ok(logs.some((l) => l.includes("rlmInherit disabled")), JSON.stringify(logs));
    } finally {
        resetWorld();
    }
});

test("register queue carries parentId on both lanes (#1333)", () => {
    _resetPluginStateForTest();
    try {
        queuePluginRegister("reg-id-1", "pi", true, "par-1");
        assert.deepEqual(consumePluginRegisterFor("reg-id-1"), { agent: "pi", parentId: "par-1" }, "identity lane carries parentId");
        assert.deepEqual(consumePluginRegisterFor("reg-id-1"), { agent: "pi", parentId: "par-1" }, "identity registration stays consumable (LRU re-touch)");

        queuePluginRegister("reg-pend-1", "codex", false, "par-2");
        const pending = takePendingPluginRegister();
        assert.equal(pending?.conversationId, "reg-pend-1");
        assert.equal(pending?.parentId, "par-2", "headless pending lane carries parentId");

        queuePluginRegister("reg-nopar", "pi", true);
        assert.deepEqual(consumePluginRegisterFor("reg-nopar"), { agent: "pi", parentId: undefined }, "no declaration → no parentId");
    } finally {
        _resetPluginStateForTest();
    }
});

test("handlePluginRegister parses parentId robustly (#1333)", async () => {
    _resetPluginStateForTest();
    const srv = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/register") {
            let body = "";
            req.on("data", (c) => { body += c; });
            req.on("end", () => handlePluginRegister(body, res));
            return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
    });
    srv.listen(0, "127.0.0.1");
    await once(srv, "listening");
    try {
        const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/__bili/plugin/register`;
        const post = async (obj: unknown): Promise<number> => {
            const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
            return r.status;
        };

        assert.equal(await post({ conversationId: "rparse-1", agent: "pi", identity: true, parentId: "good-parent" }), 200);
        assert.equal(consumePluginRegisterFor("rparse-1")?.parentId, "good-parent");

        assert.equal(await post({ conversationId: "rparse-2", agent: "pi", identity: true, parentId: "x".repeat(129) }), 200);
        assert.equal(consumePluginRegisterFor("rparse-2")?.parentId, undefined, ">128 chars dropped");

        assert.equal(await post({ conversationId: "rparse-3", agent: "pi", identity: true, parentId: 42 }), 200);
        assert.equal(consumePluginRegisterFor("rparse-3")?.parentId, undefined, "non-string dropped");

        assert.equal(await post({ conversationId: "rparse-4", agent: "pi", identity: true, parentId: "   " }), 200);
        assert.equal(consumePluginRegisterFor("rparse-4")?.parentId, undefined, "blank dropped");

        assert.equal(await post({ conversationId: "rparse-5", agent: "pi", identity: true }), 200);
        assert.equal(consumePluginRegisterFor("rparse-5")?.parentId, undefined, "absent stays undefined");

        const bad = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
        assert.equal(bad.status, 400);
        const noConv = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "pi" }) });
        assert.equal(noConv.status, 400);
    } finally {
        await new Promise<void>((resolve, reject) => srv.close((e) => (e ? reject(e) : resolve())));
        _resetPluginStateForTest();
    }
});

// --- pi lane: parent-conversation resolution -------------------------------

function writeJsonl(p: string, firstLine: string): void {
    writeFileSync(p, firstLine + "\n" + '{"type":"message","id":"x"}\n', "utf8");
}

test("pi lane: getHeader fast path resolves the parent id without reading the child file (#1333)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-rlm-pi-"));
    try {
        const parentFile = path.join(dir, "parent.jsonl");
        writeJsonl(parentFile, JSON.stringify({ type: "session", version: 3, id: "par-sid", timestamp: "t", cwd: "/w" }));
        const sid = await resolveParentConversationId({
            sessionManager: {
                getSessionId: () => "child-fast",
                getHeader: () => ({ parentSession: parentFile }),
                getSessionFile: () => "/nonexistent/nope.jsonl",
            },
        });
        assert.equal(sid, "par-sid", "own header came from getHeader() — child file deliberately missing");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("pi lane: getSessionFile fallback reads the child session-file header (#1333)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-rlm-pi-"));
    try {
        const parentFile = path.join(dir, "parent.jsonl");
        writeJsonl(parentFile, JSON.stringify({ type: "session", version: 3, id: "par-sid-2", timestamp: "t", cwd: "/w" }));
        const childFile = path.join(dir, "child.jsonl");
        writeJsonl(childFile, JSON.stringify({ type: "session", version: 3, id: "child-fallback", timestamp: "t", cwd: "/w", parentSession: parentFile }));
        const sid = await resolveParentConversationId({
            sessionManager: {
                getSessionId: () => "child-fallback",
                getSessionFile: () => childFile,
            },
        });
        assert.equal(sid, "par-sid-2");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("pi lane: malformed or missing parent degrades to undefined (#1333)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-rlm-pi-"));
    try {
        const badParent = path.join(dir, "bad.jsonl");
        writeJsonl(badParent, "this is not json");
        assert.equal(await resolveParentConversationId({ sessionManager: { getSessionId: () => "child-badline", getHeader: () => ({ parentSession: badParent }) } }), undefined, "malformed parent header line");
        assert.equal(await resolveParentConversationId({ sessionManager: { getSessionId: () => "child-missing", getHeader: () => ({ parentSession: path.join(dir, "missing.jsonl") }) } }), undefined, "missing parent file");
        assert.equal(await resolveParentConversationId({ sessionManager: { getSessionId: () => "child-none", getHeader: () => ({}) } }), undefined, "no parentSession field");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("pi lane: positive and negative results are cached per session id (#1333)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-rlm-pi-"));
    try {
        const parentFile = path.join(dir, "cache-parent.jsonl");
        writeJsonl(parentFile, JSON.stringify({ type: "session", version: 3, id: "cache-par", timestamp: "t", cwd: "/w" }));
        const pos = { sessionManager: { getSessionId: () => "child-cache-pos", getHeader: () => ({ parentSession: parentFile }) } };
        assert.equal(await resolveParentConversationId(pos), "cache-par");
        rmSync(parentFile, { force: true });
        assert.equal(await resolveParentConversationId(pos), "cache-par", "positive result cached — file deletion does not invalidate");

        const negFile = path.join(dir, "neg-parent.jsonl");
        const neg = { sessionManager: { getSessionId: () => "child-cache-neg", getHeader: () => ({ parentSession: negFile }) } };
        assert.equal(await resolveParentConversationId(neg), undefined);
        writeJsonl(negFile, JSON.stringify({ type: "session", version: 3, id: "late-par", timestamp: "t", cwd: "/w" }));
        assert.equal(await resolveParentConversationId(neg), undefined, "negative result cached — later-created file does not change the verdict");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("pi lane: LRU cap evicts the oldest cached session (#1333)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-rlm-pi-"));
    try {
        const sharedParent = path.join(dir, "shared.jsonl");
        writeJsonl(sharedParent, JSON.stringify({ type: "session", version: 3, id: "shared-par", timestamp: "t", cwd: "/w" }));
        const N = 260;
        const makeCtx = (i: number) => ({ sessionManager: { getSessionId: () => `lrw-${i}`, getHeader: () => ({ parentSession: sharedParent }) } });
        for (let i = 1; i <= N; i++) assert.equal(await resolveParentConversationId(makeCtx(i)), "shared-par");

        rmSync(sharedParent, { force: true });
        assert.equal(await resolveParentConversationId(makeCtx(1)), undefined, "oldest entry evicted (cap 256) → re-resolution fails without the file");
        assert.equal(await resolveParentConversationId(makeCtx(N)), "shared-par", "newest entry still cached");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// --- opencode lane: session.get parentID resolution ------------------------

test("opencode lane: session.get shapes (wrapped / bare / missing / error) (#1333)", async () => {
    const okWrapped: V1PluginContext["client"] = { session: { get: async () => ({ data: { id: "oc-1", parentID: "oc-par" } }) } };
    assert.equal(await resolveOpencodeParentId(okWrapped, "oc-1"), "oc-par", "SDK RequestResult data-wrapped shape");

    const bare: V1PluginContext["client"] = { session: { get: async () => ({ id: "oc-2", parentID: "oc-par-2" }) } };
    assert.equal(await resolveOpencodeParentId(bare, "oc-2"), "oc-par-2", "bare session record shape");

    const noParent: V1PluginContext["client"] = { session: { get: async () => ({ data: { id: "oc-3" } }) } };
    assert.equal(await resolveOpencodeParentId(noParent, "oc-3"), undefined, "no parentID → undefined");

    const badType: V1PluginContext["client"] = { session: { get: async () => ({ data: { id: "oc-4", parentID: 123 } }) } };
    assert.equal(await resolveOpencodeParentId(badType, "oc-4"), undefined, "non-string parentID → undefined");

    const boom: V1PluginContext["client"] = { session: { get: async () => { throw new Error("boom"); } } };
    assert.equal(await resolveOpencodeParentId(boom, "oc-5"), undefined, "SDK error degrades to undefined");

    const noClient: V1PluginContext["client"] = undefined;
    assert.equal(await resolveOpencodeParentId(noClient, "oc-6"), undefined, "no client (older host) → undefined");
    assert.equal(await resolveOpencodeParentId({ session: {} }, ""), undefined, "empty sid short-circuits");
});

test("opencode lane: get is invoked bound to the session object (explicit-this trap) (#1333)", async () => {
    let sawThis: unknown;
    const getFn = function (this: unknown, _args: { path: { id: string } }): Promise<unknown> {
        sawThis = this;
        return Promise.resolve({ data: { parentID: "this-ok" } });
    };
    const client: V1PluginContext["client"] = { session: { get: getFn } };
    assert.equal(await resolveOpencodeParentId(client, "oc-this"), "this-ok");
    assert.equal(sawThis, client.session, "`get` must keep its SDK `this` binding (a destructured call throws inside the SDK)");
});

test("opencode lane: result is cached per session id (#1333)", async () => {
    let calls = 0;
    const client: V1PluginContext["client"] = {
        session: {
            get: async () => {
                calls++;
                if (calls === 2) throw new Error("second call must not happen");
                return { data: { parentID: "cache-oc" } };
            },
        },
    };
    assert.equal(await resolveOpencodeParentId(client, "oc-cache"), "cache-oc");
    assert.equal(await resolveOpencodeParentId(client, "oc-cache"), "cache-oc", "second resolution served from cache");
    assert.equal(calls, 1);
});
