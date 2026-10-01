// #1341: fork adoption carries CCR content-store entries. Adopted block
// summaries cite their covered refs as retrievable, so the fork must inherit
// the originals behind those refs (union seed: covered refs of adopted
// blocks ∪ refs cited by placeholder-shaped incoming messages). Covers the
// issue's acceptance criteria: true-original retrieve hits, no placeholder-
// shaped payloads, parent untouched, own companion survives restart, CCR-less
// fork unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    buildStoredPlaceholder,
    createContentStore,
    createCore,
    defaultConfig,
    STORED_PLACEHOLDER_MARKER,
    type Config,
    type CoreMessage,
    type MessageContentStore,
} from "acp-kernel";
import { openaiToCore } from "acp-kernel/wire";
import { applyCompressSettings } from "../src/compress-settings.ts";
import {
    adoptContentStore,
    cloneStoreForRefs,
    contentStoreOf,
    drainPendingRetrievals,
    executeRetrieve,
    storeEffectiveCcr,
} from "../src/store.ts";
import { dropSessionForGc, getSession, type Session } from "../src/session.ts";
import { getStore, SessionStore, _setStoreForTest } from "../src/persist.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { maybeAdoptForkBlocks } from "../src/fork-adoption.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST = "0";

const LIMIT = 200_000;
const META = { protocol: "openai" as const, upstreamOrigin: "http://upstream.example/v1" };
const BIG_A = "line of build output ".repeat(700);
const BIG_B = "stack trace frame ".repeat(700);
type Body = Parameters<typeof openaiToCore>[0];

let seq = 0;
const sid = (p: string) => `${p}-${++seq}-${Math.random().toString(36).slice(2, 8)}`;

function ccrConfig(on: boolean): Config {
    return applyCompressSettings(
        // preserve zones off: they are a production guard orthogonal to
        // #1341, and on these short fixtures the token walk would swallow the
        // whole fold range nondeterministically.
        defaultConfig(LIMIT, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 10, minSummaryLength: 20, maxSummaryLength: 5000 } }),
        LIMIT,
        { absorb: { enabled: true, minToolTokens: 50 }, ccr: { enabled: on, minToolTokens: 50 } },
    ) as Config;
}

function toolPair(callId: string, output: string): Body["messages"] {
    return [
        { role: "assistant", content: "", tool_calls: [{ id: callId, type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: callId, content: output },
    ];
}

interface Armed {
    parent: Session;
    core: ReturnType<typeof createCore>;
    config: Config;
    blockId: string;
    turnMsgs: CoreMessage[];
}

/** One arming pass mirroring the host request path: processTurn (arrival-time
 *  storing) + a host-driven fold (fold-time storing, stream.ts applyRanges). */
function armParent(body: Body, fold: { startId: string; endId: string }, ccr: boolean): Armed {
    const core = createCore();
    const config = ccrConfig(ccr);
    const parent = getSession(sid("parent"), META);
    if (ccr) storeEffectiveCcr(parent, { enabled: true, minToolTokens: 50 });
    const turn = core.processTurn({
        messages: openaiToCore(body).msgs,
        state: parent.state,
        config,
        tokenCount: 9999,
        renderTags: "text-only",
    });
    parent.state = turn.state;
    adoptContentStore(parent, turn.contentStore);
    applyRanges(
        parseCompressInput({ content: [{ startId: fold.startId, endId: fold.endId, summary: "Folded phase: setup work captured.", topic: "Setup phase" }] }),
        { core, config, messages: turn.messages, session: parent, log: () => {} },
    );
    const block = [...parent.state.blocks].find((b) => b.active);
    assert.ok(block, "parent fold produced an active block");
    return { parent, core, config, blockId: block.blockId, turnMsgs: turn.messages };
}

function forkChild(a: Armed, forkBody: Body, log?: (level: string, msg: string) => void): Session {
    const child = getSession(sid("child"), META);
    maybeAdoptForkBlocks({
        session: child,
        parentId: a.parent.id,
        protocol: "openai",
        parsed: forkBody,
        upstreamOrigin: META.upstreamOrigin,
        enabled: true,
        log: log ?? (() => {}),
    });
    return child;
}

test("cloneStoreForRefs: ref-filtered independent clone", () => {
    const entry = (hash: string, rawId: string) => ({ hash, rawId, kind: "shell output", tokens: 100, chars: 500, head: "head line" });
    const src: MessageContentStore = {
        version: 1,
        byHash: { h1: "AAA", h2: "BBB" },
        byRef: { m00001: entry("h1", "r1"), m00002: entry("h1", "r2"), m00003: entry("h2", "r3") },
    };
    const clone = cloneStoreForRefs(src, ["m00001", "m00003"]);
    assert.ok(clone);
    assert.deepEqual(Object.keys(clone.byRef).sort(), ["m00001", "m00003"]);
    assert.deepEqual(Object.keys(clone.byHash).sort(), ["h1", "h2"]);
    assert.equal(clone.byHash["h1"], "AAA");
    clone.byRef["m00001"].head = "MUTATED";
    clone.byHash["h1"] = "Z";
    assert.equal(src.byRef["m00001"].head, "head line");
    assert.equal(src.byHash["h1"], "AAA");
    // Two refs sharing a hash copy exactly one payload.
    const dedup = cloneStoreForRefs(src, ["m00001", "m00002"]);
    assert.ok(dedup);
    assert.deepEqual(Object.keys(dedup.byHash), ["h1"]);
    assert.equal(dedup.byRef["m00002"].hash, "h1");
    assert.equal(cloneStoreForRefs(src, ["m99999"]), null);
    assert.equal(cloneStoreForRefs(createContentStore(), []), null);
});

test("fork of armed parent resolves adopted covered refs via acp_retrieve (#1341)", () => {
    const body: Body = {
        model: "test-model",
        messages: [
            { role: "user", content: "setup question" },
            ...toolPair("call_a", BIG_A),
            { role: "user", content: "follow-up question" },
            { role: "assistant", content: "answer A" },
            { role: "user", content: "next task" },
            ...toolPair("call_b", BIG_B),
        ],
    };
    const armed = armParent(body, { startId: "m00001", endId: "m00005" }, true);
    const { parent } = armed;
    const pstore = contentStoreOf(parent);
    // Arrival: m00003 (BIG_A), m00008 (BIG_B). Fold-time: m00001..m00005 minus
    // the already-stored m00003.
    assert.deepEqual(Object.keys(pstore.byRef).sort(), ["m00001", "m00002", "m00003", "m00004", "m00005", "m00008"]);
    assert.match(pstore.byHash[pstore.byRef["m00003"]!.hash]!, /line of build output/);
    const parentBefore = JSON.stringify(parent.contentStore);

    const forkBody = structuredClone(body);
    forkBody.messages[7] = { role: "tool", tool_call_id: "call_b", content: `${BIG_B}\n(edited branch)` };
    const child = forkChild(armed, forkBody);

    assert.equal(child.state.blocks.length, 1);
    assert.ok(child.state.blocks[0].active);
    assert.equal(child.state.blocks[0].blockId, armed.blockId);
    assert.equal(child.state.messageRefs.byRef["m00003"], parent.state.messageRefs.byRef["m00003"]);

    const cstore = contentStoreOf(child);
    assert.ok(cstore.byRef["m00003"], "covered ref adopted into child store");
    // AC1: hit with the true original text (GHSA jc6g v2: the tool result
    // itself carries the framed original — nothing queues).
    const ack = executeRetrieve({ ref: "m00003" }, child);
    assert.match(ack, /acp-retrieved #m00003/);
    assert.ok(ack.includes(BIG_A.slice(0, 200)), "the tool result carries the true original");
    assert.ok(!ack.includes(STORED_PLACEHOLDER_MARKER));
    assert.equal(drainPendingRetrievals(child).length, 0, "v2 delivers inline — nothing queued");
    // Ref-filtered: the edited message's ref (m00008) is NOT carried — the
    // child will self-heal its own m00008 on its next turn.
    assert.equal(cstore.byRef["m00008"], undefined);
    assert.match(executeRetrieve({ ref: "m00008" }, child), /not found/);
    // AC2: no placeholder-shaped payloads.
    for (const payload of Object.values(cstore.byHash)) {
        assert.ok(!payload.includes(STORED_PLACEHOLDER_MARKER));
    }
    // AC3: parent untouched, independent objects.
    assert.equal(JSON.stringify(parent.contentStore), parentBefore);
    assert.notEqual(cstore, parent.contentStore);
    cstore.byRef["m00003"].head = "MUTATED";
    assert.notEqual(parent.contentStore!.byRef["m00003"].head, "MUTATED");
    assert.ok(child.stats.storedBytes > 0);
    assert.equal(child.contentStoreDirty, true);
});

test("refs cited by placeholder-shaped incoming messages are adopted too (#1341)", () => {
    // Small tool output in the shared prefix (never placeholderized, so the
    // block stays adoptable); the big result sits OUTSIDE the fold span and
    // is stored at arrival time as m00007.
    const body: Body = {
        model: "test-model",
        messages: [
            { role: "user", content: "setup question" },
            ...toolPair("call_a", "build ok"),
            { role: "assistant", content: "answer A" },
            { role: "user", content: "follow-up" },
            ...toolPair("call_b", BIG_B),
            { role: "user", content: "next task" },
            { role: "assistant", content: "plan: run tests" },
            { role: "user", content: "go ahead" },
        ],
    };
    const armed = armParent(body, { startId: "m00001", endId: "m00004" }, true);
    const pstore = contentStoreOf(armed.parent);
    // Fold-time storing covers every message in the span (size-independent);
    // m00007 arrived big enough to be stored at arrival time.
    assert.deepEqual(Object.keys(pstore.byRef).sort(), ["m00001", "m00002", "m00003", "m00004", "m00007"]);
    assert.equal(pstore.byHash[pstore.byRef["m00007"]!.hash], BIG_B);

    const placeholderText = String(armed.turnMsgs[6].text);
    assert.ok(placeholderText.includes(STORED_PLACEHOLDER_MARKER));
    assert.match(placeholderText, /#m00007/);

    // Branch fork: shared prefix verbatim + a regenerate branch whose tool
    // result is the agent's own placeholder citing the parent's m00007.
    const forkBody: Body = {
        model: "test-model",
        messages: [
            body.messages[0],
            body.messages[1],
            body.messages[2],
            body.messages[3],
            body.messages[4],
            { role: "user", content: "regenerate: different approach" },
            { role: "assistant", content: "will try a cleaner path" },
            { role: "user", content: "yes go" },
            ...toolPair("call_c", placeholderText),
            { role: "user", content: "continue please" },
            { role: "assistant", content: "continuing" },
            { role: "user", content: "did it work?" },
            { role: "assistant", content: "yes, fixed" },
        ],
    };
    const child = forkChild(armed, forkBody);

    const cstore = contentStoreOf(child);
    assert.ok(cstore.byRef["m00007"], "cited ref adopted into child store");
    assert.equal(cstore.byHash[cstore.byRef["m00007"]!.hash], BIG_B, "true original, exact bytes");
    // Pre-turn: only the covered refs m00001..m00004 are seeded into
    // messageRefs; the store index is deliberately independent of it.
    assert.equal(child.state.messageRefs.byRef["m00007"], undefined);
    const ack = executeRetrieve({ ref: "m00007" }, child);
    assert.match(ack, /acp-retrieved #m00007/);
    assert.ok(ack.includes(BIG_B.slice(0, 200)), "adopted original rides in the tool result (v2)");

    // The child's own next request + fold must not clobber the adopted entry
    // (append-only, first write wins) — even though the child's own m00007 is
    // a different branch message (ref numbers are session-scoped; the
    // placeholder's promise is what retrieval honors).
    storeEffectiveCcr(child, { enabled: true, minToolTokens: 50 });
    const t2 = armed.core.processTurn({
        messages: openaiToCore(forkBody).msgs,
        state: child.state,
        config: armed.config,
        tokenCount: 9999,
        renderTags: "text-only",
        contentStore: contentStoreOf(child),
    });
    child.state = t2.state;
    adoptContentStore(child, t2.contentStore);
    assert.equal(t2.contentStore.byRef["m00007"].hash, cstore.byRef["m00007"].hash);
    applyRanges(
        parseCompressInput({ content: [{ startId: "m00006", endId: "m00009", summary: "Branch phase folded.", topic: "Branch" }] }),
        { core: armed.core, config: armed.config, messages: t2.messages, session: child, log: () => {} },
    );
    assert.ok([...child.state.blocks].some((b) => b.active && b.blockId !== armed.blockId), "child's own fold created a second block");
    assert.equal(contentStoreOf(child).byRef["m00007"].hash, cstore.byRef["m00007"].hash, "adopted entry survives the child's own fold");
    const reAck = executeRetrieve({ ref: "m00007" }, child);
    assert.match(reAck, /acp-retrieved #m00007/);
    assert.ok(reAck.includes(BIG_B.slice(0, 200)), "still retrievable in the tool result after the fold");
});

test("decision fixture (#1458): parent-only ref cited by a placeholder IS copied + retrievable (Option A semantics)", () => {
    // #1458 (the issue's m00099 fixture at real ref numbering): the cited ref
    // is NOT covered by any adopted block, NOT in the child's ref space, and
    // its raw message is absent from the child's shared history — yet it is
    // copied and retrievable. Pins the DECIDED Option-A semantics: a fork is
    // the same lineage/principal as the parent store, so a valid-looking
    // citation grants access to the named entry; volume is capped separately
    // (see the cap tests below).
    const PARENT_ONLY = "PARENT BRANCH ONLY CONTENT ".repeat(200);
    const body: Body = {
        model: "test-model",
        messages: [
            { role: "user", content: "setup question" },      // m00001
            ...toolPair("call_a", "build ok"),                 // m00002, m00003
            { role: "assistant", content: "answer A" },        // m00004
            { role: "user", content: "follow-up" },            // m00005
            { role: "assistant", content: "plan: run tests" }, // m00006
            { role: "user", content: "go ahead" },             // m00007
            ...toolPair("call_p", PARENT_ONLY),                // m00008, m00009 (parent-only branch)
            { role: "assistant", content: "parent finished" }, // m00010
        ],
    };
    const armed = armParent(body, { startId: "m00001", endId: "m00007" }, true);
    const pstore = contentStoreOf(armed.parent);
    // Fold-time storing covers the whole span; m00009 was stored at arrival.
    assert.deepEqual(Object.keys(pstore.byRef).sort(), ["m00001", "m00002", "m00003", "m00004", "m00005", "m00006", "m00007", "m00009"]);
    assert.equal(pstore.byHash[pstore.byRef["m00009"]!.hash], PARENT_ONLY);
    const parentBefore = JSON.stringify(armed.parent.contentStore);

    // The parent's own view carries the arrival-time placeholder for m00009.
    const ph = armed.turnMsgs.find((m) => String(m.text ?? "").includes(STORED_PLACEHOLDER_MARKER));
    assert.ok(ph, "parent view holds an arrival-time placeholder");
    const placeholderText = String(ph.text);
    assert.match(placeholderText, /#m00009/);

    // Fork: shared prefix verbatim + a regenerate branch whose tool result is
    // that placeholder. The raw PARENT_ONLY bytes are nowhere in the fork.
    const forkBody: Body = {
        model: "test-model",
        messages: [
            ...body.messages.slice(0, 7),
            { role: "user", content: "regenerate: different approach" },
            { role: "assistant", content: "taking a cleaner path" },
            { role: "user", content: "yes go" },
            ...toolPair("call_fork", placeholderText),
            { role: "assistant", content: "continuing" },
            { role: "user", content: "did it work?" },
            { role: "assistant", content: "yes, fixed" },
        ],
    };
    const adopted: string[] = [];
    const child = forkChild(armed, forkBody, (level, msg) => { if (level === "info") adopted.push(msg); });

    assert.equal(child.state.blocks.length, 1);
    assert.ok(child.state.blocks[0].active);
    assert.equal(child.state.blocks[0].blockId, armed.blockId);

    const cstore = contentStoreOf(child);
    // Option A (#1458, decided): the parent-only ref, not covered by any
    // adopted block, is copied because a placeholder in the incoming names it
    // — nothing else links it into the child.
    assert.ok(cstore.byRef["m00009"], "parent-only cited ref copied (Option A semantics, #1458)");
    assert.equal(cstore.byHash[cstore.byRef["m00009"]!.hash], PARENT_ONLY, "true original, exact bytes");
    // ...but it is NOT part of the child's ref space: no incoming message
    // carries that raw id, so messageRefs stays empty of it.
    assert.equal(child.state.messageRefs.byRef["m00009"], undefined);
    // Retrieve honors the citation (store lookup, ref-space independent).
    const retrievedText = executeRetrieve({ ref: "m00009" }, child) as string;
    assert.match(retrievedText, /acp-retrieved #m00009/);
    assert.ok(typeof retrievedText === "string" && retrievedText.includes(PARENT_ONLY.slice(0, 200)), "tool result carries the true original (v2)");
    // Covered refs ride along too (the union, not the citation alone).
    assert.ok(cstore.byRef["m00003"]);
    assert.equal(cstore.byHash[cstore.byRef["m00003"]!.hash], "build ok");
    // Independence: mutating the child's adopted entry leaves the parent intact.
    assert.notEqual(cstore, armed.parent.contentStore);
    cstore.byRef["m00009"].head = "MUTATED";
    assert.notEqual(armed.parent.contentStore!.byRef["m00009"].head, "MUTATED");
    assert.equal(JSON.stringify(armed.parent.contentStore), parentBefore);
    // #1458 observability: the adoption log splits covered vs cited-only.
    const line = adopted.find((m) => m.includes("CCR content-store entr"));
    assert.ok(line, "adoption log line present");
    assert.match(line!, /7 covered by adopted blocks, 1 cited-only \(m00009\)/);
});

test("cited-only copies are capped by count (#1458 Option A hygiene)", () => {
    const body: Body = {
        model: "test-model",
        messages: [
            { role: "user", content: "setup question" },
            ...toolPair("call_a", "build ok"),
            { role: "assistant", content: "answer A" },
            { role: "user", content: "follow-up" },
            ...toolPair("call_b", BIG_B),
            { role: "user", content: "next task" },
            { role: "assistant", content: "plan: run tests" },
            { role: "user", content: "go ahead" },
        ],
    };
    const armed = armParent(body, { startId: "m00001", endId: "m00004" }, true);
    // Fabricate a citation run beyond the count cap (128): 130 stored
    // parent-only entries named m01001..m01130.
    const pstore = contentStoreOf(armed.parent);
    for (let i = 1; i <= 130; i++) {
        const ref = `m${String(1000 + i).padStart(5, "0")}`;
        const text = `fabricated stored output ${i} ` + "x".repeat(200);
        pstore.byHash[`fab-${i}`] = text;
        pstore.byRef[ref] = { hash: `fab-${i}`, rawId: `raw-${i}`, kind: "shell output", tokens: 60, chars: text.length, head: `fabricated ${i}` };
    }
    const msgs: Body["messages"] = [...body.messages.slice(0, 5)];
    for (let i = 1; i <= 130; i++) {
        const ref = `m${String(1000 + i).padStart(5, "0")}`;
        msgs.push({ role: "user", content: buildStoredPlaceholder({ ref, kind: "shell output", tokens: 60, head: `fabricated ${i}`, retrieveToolName: "acp_retrieve" }) });
    }
    const forkBody: Body = { model: "test-model", messages: msgs };
    const warns: string[] = [];
    const child = forkChild(armed, forkBody, (level, msg) => { if (level === "warn") warns.push(msg); });

    const cstore = contentStoreOf(child);
    // First 128 citations in order are honored; the last two are dropped.
    for (let i = 1; i <= 128; i++) {
        const ref = `m${String(1000 + i).padStart(5, "0")}`;
        assert.ok(cstore.byRef[ref], `${ref} copied`);
    }
    for (const ref of ["m01129", "m01130"]) {
        assert.equal(cstore.byRef[ref], undefined, `${ref} beyond the count cap`);
        assert.match(executeRetrieve({ ref }, child), /not found/, `honest miss for ${ref}`);
    }
    // Covered refs are never capped (m00007 is neither covered nor cited here
    // and must NOT ride along — the union seed, not the whole store).
    assert.ok(cstore.byRef["m00003"]);
    assert.equal(cstore.byRef["m00007"], undefined);
    // The skip is logged loudly with the offending refs.
    assert.equal(warns.length, 1);
    assert.match(warns[0], /2 cited-only ref\(s\) beyond the copy cap \(128 refs \/ 4194304 bytes\), not copied: m01129, m01130/);
});

test("cited-only copies are capped by total bytes (#1458 Option A hygiene)", () => {
    const body: Body = {
        model: "test-model",
        messages: [
            { role: "user", content: "setup question" },
            ...toolPair("call_a", "build ok"),
            { role: "assistant", content: "answer A" },
            { role: "user", content: "follow-up" },
            ...toolPair("call_b", BIG_B),
            { role: "user", content: "next task" },
            { role: "assistant", content: "plan: run tests" },
            { role: "user", content: "go ahead" },
        ],
    };
    const armed = armParent(body, { startId: "m00001", endId: "m00004" }, true);
    // Three parent-only entries: 2.5 MiB + 2.5 MiB + 1 KiB against a 4 MiB
    // budget — the second overflows and is skipped without stopping the scan.
    const pstore = contentStoreOf(armed.parent);
    const big = "y".repeat(Math.floor(2.5 * 1024 * 1024));
    const small = "z".repeat(1024);
    pstore.byHash["big-1"] = big;
    pstore.byRef["m02001"] = { hash: "big-1", rawId: "raw-b1", kind: "shell output", tokens: 600_000, chars: big.length, head: "big one" };
    pstore.byHash["big-2"] = big;
    pstore.byRef["m02002"] = { hash: "big-2", rawId: "raw-b2", kind: "shell output", tokens: 600_000, chars: big.length, head: "big two" };
    pstore.byHash["small-3"] = small;
    pstore.byRef["m02003"] = { hash: "small-3", rawId: "raw-s3", kind: "shell output", tokens: 30, chars: small.length, head: "small three" };
    const ph = (ref: string, head: string) => ({ role: "user" as const, content: buildStoredPlaceholder({ ref, kind: "shell output", tokens: 100, head, retrieveToolName: "acp_retrieve" }) });
    const forkBody: Body = {
        model: "test-model",
        messages: [
            ...body.messages.slice(0, 5),
            ph("m02001", "big one"),
            ph("m02002", "big two"),
            ph("m02003", "small three"),
        ],
    };
    const warns: string[] = [];
    const child = forkChild(armed, forkBody, (level, msg) => { if (level === "warn") warns.push(msg); });

    const cstore = contentStoreOf(child);
    assert.ok(cstore.byRef["m02001"], "first entry fits the byte budget");
    assert.equal(cstore.byRef["m02002"], undefined, "second entry overflows the budget");
    assert.ok(cstore.byRef["m02003"], "scan continues past an overflowed entry");
    assert.equal(warns.length, 1);
    assert.match(warns[0], /1 cited-only ref\(s\) beyond the copy cap .* not copied: m02002/);
});

test("child persists its own companion and survives a proxy restart (#1341)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-fork-ccr-"));
    _setStoreForTest(new SessionStore({ dir, debounceMs: 0 }));
    try {
        const body: Body = {
            model: "test-model",
            messages: [
                { role: "user", content: "setup question" },
                ...toolPair("call_a", BIG_A),
                { role: "user", content: "follow-up question" },
                { role: "assistant", content: "answer A" },
                { role: "user", content: "next task" },
                ...toolPair("call_b", BIG_B),
            ],
        };
        const armed = armParent(body, { startId: "m00001", endId: "m00005" }, true);
        const forkBody = structuredClone(body);
        forkBody.messages[7] = { role: "tool", tool_call_id: "call_b", content: `${BIG_B}\n(edited branch)` };
        const child = forkChild(armed, forkBody);
        assert.equal(contentStoreOf(child).byRef["m00003"] ? true : false, true);

        assert.ok(getStore().flushSync(child), "flush wrote the child's records");
        // Companion files are named after the (hashed) envelope path, not the
        // session id; only the child was flushed with a dirty store here.
        const envelopes = listFiles(dir).filter((f) => f.endsWith(".content-store.json"));
        assert.equal(envelopes.length, 1, "exactly one companion envelope for the child");

        assert.equal(dropSessionForGc(child.id), true, "evict from memory (restart)");
        const reloaded = getSession(child.id, META);
        assert.equal(reloaded.state.blocks.length, 1);
        const ack = executeRetrieve({ ref: "m00003" }, reloaded);
        assert.match(ack, /acp-retrieved #m00003/);
        assert.ok(ack.includes(BIG_A.slice(0, 200)), "true original after reload (v2 tool result)");
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmrf(dir);
    }
});

test("fork of a CCR-less parent is unchanged: no store, no artifact (#1341)", () => {
    const body: Body = {
        model: "test-model",
        messages: [
            { role: "user", content: "setup question" },
            ...toolPair("call_a", "build ok"),
            { role: "assistant", content: "answer A" },
            { role: "user", content: "follow-up question" },
            { role: "assistant", content: "answer B" },
            { role: "user", content: "next task" },
            { role: "assistant", content: "done" },
        ],
    };
    const armed = armParent(body, { startId: "m00001", endId: "m00005" }, false);
    assert.equal(Object.keys(contentStoreOf(armed.parent).byRef).length, 0, "CCR off: nothing stored");
    const child = forkChild(armed, structuredClone(body));
    assert.equal(child.state.blocks.length, 1, "block adoption itself still happens");
    assert.equal(child.state.blocks[0].blockId, armed.blockId);
    assert.equal(child.contentStore, undefined, "no store materialized on the child");
    assert.notEqual(child.contentStoreDirty, true, "no dirty flag, hence no envelope write");
});

test("adoption disabled leaves the fork without blocks or store (#1341)", () => {
    const body: Body = {
        model: "test-model",
        messages: [
            { role: "user", content: "setup question" },
            ...toolPair("call_a", BIG_A),
            { role: "user", content: "follow-up question" },
            { role: "assistant", content: "answer A" },
            { role: "user", content: "next task" },
            ...toolPair("call_b", BIG_B),
        ],
    };
    const armed = armParent(body, { startId: "m00001", endId: "m00005" }, true);
    const child = getSession(sid("child"), META);
    maybeAdoptForkBlocks({
        session: child,
        parentId: armed.parent.id,
        protocol: "openai",
        parsed: structuredClone(body),
        upstreamOrigin: META.upstreamOrigin,
        enabled: false,
        log: () => {},
    });
    assert.equal(child.state.blocks.length, 0);
    assert.equal(child.contentStore, undefined);
    assert.ok(!child.contentStoreDirty);
});

function listFiles(root: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(root, { withFileTypes: true })) {
        const p = path.join(root, e.name);
        if (e.isDirectory()) out.push(...listFiles(p));
        else out.push(p);
    }
    return out;
}


