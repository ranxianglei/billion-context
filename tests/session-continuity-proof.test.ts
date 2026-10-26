// Session-continuity proof: the TWO-SCENARIO contract for how a bili plugin
// lane (dsh) keeps compression state across the two ways a conversation can
// branch (#2601 lineage / #2676 fork adoption).
//
//   SCENARIO A — a model switch is ONE session. dsh switches models
//   mid-conversation: the system's model-identity line changes AND the
//   host stamps a new x-bili-plugin-model header. When the resent history
//   ALSO stops continuing the stored chain (dsh local compaction rewrote
//   the recorded bytes in the same window — the #2601 residual
//   conjunction), the lane must still ABSORB the switch: the persona
//   anchor migrates, the session keeps its RAW conversation key, no
//   `|sub:<fp>` fork is minted, and the kernel machinery on that session
//   keeps working (compress → decompress round-trip after the switch).
//   Control: the same system drift WITHOUT the header corroborating
//   (header still names the old model) still forks — absorption is a
//   two-declaration rule, not a blanket one.
//
//   SCENARIO B — a fork (subagent/branch WITH context) is a NEW session
//   that COPIES the parent's state. The child inherits the parent's fold
//   blocks (ids + summaries + original content), the seeded raw→ref map
//   (parent's exact refs), and the durable-guard lane stays adoptable when
//   the parent's history carries dsh durable-state messages (AGENTS.md
//   workspace instructions → kernel BLOCKED sentinel refs, #2676): the
//   child decompresses the parent's folded block, and the parent is
//   untouched (copy-on-fork).
//
// Teeth (verified by A/B worktrees when authored): scenario B fails on
// pre-#2625 master with HTTP 409 SNAPSHOT_UNAVAILABLE (the #2676 silent
// degrade); scenario A fails on pre-#2719/#2727 master by minting a
// `|sub:<fp>` fork and stranding the compression state on the stale parent.
//
// WIRE MATRIX: both scenarios run on chat (/v1/chat/completions), anthropic
// (/v1/messages, system as a top-level field) and responses (/v1/responses,
// instructions) — the persona wiring is per-call-site in src/server/handle.ts
// (anthropic :811 / openai :821 / responses :843,:880) and each site has its
// own system-text extractor, so the contract is proven per wire, not assumed
// protocol-neutral (#377 lesson: correct-in-one-lane is not correct-in-all).
// google is deliberately absent: the google lane has NO persona call site
// (issue #2730 — wire it or document the exclusion before proving it).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// Hermetic state dirs BEFORE importing the server modules (prefix-affinity
// chain snapshots persist across runs otherwise — #2719 idiom).
const testRoot = mkdtempSync(path.join(tmpdir(), "bc-continuity-proof-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = testRoot;
process.env.NODE_ENV = "test";
test.after(() => rmSync(testRoot, { recursive: true, force: true }));

const { defaultConfig } = await import("acp-kernel");
const { startServer } = await import("../src/server.ts");
const { SessionStore, _setStoreForTest } = await import("../src/persist.ts");
const { _resetSessionsForTest, getSession, listSessions } = await import("../src/session.ts");
const { _resetPluginStateForTest, resolveConversation } = await import("../src/plugin.ts");
const { _setForTest: setRegistryForTest } = await import("../src/registry.ts");

const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const SYSTEM_A = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-4.6.\nWorkspace: /tmp.";
const SYSTEM_B = "You are DeepSeek Harness, the main coding agent.\nModel: GLM-5.3.\nWorkspace: /tmp.";
const GUARD_TEXT = "Instructions from: /repo/AGENTS.md\n# repo rules\nbehave conservatively and keep diffs minimal.";

const FILLER = "the quick brown fox jumps over the lazy dog, again and again, folding context away. ";

type Wire = "chat" | "anthropic" | "responses";
const WIRES: readonly Wire[] = ["chat", "anthropic", "responses"];

function userText(run: string, i: number): string {
    return `${run} user turn ${i}: ${FILLER.repeat(6)}`;
}

type ChatMsg = { role: string; content: string };

interface SnapshotMessage { rawId: string; ref: string; identityHash: string }
interface SnapshotBody { sessionId: string; parentRevision: string; orderedMessages: SnapshotMessage[] }

async function harness(wire: Wire) {
    const dir = mkdtempSync(path.join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    _resetSessionsForTest();
    _resetPluginStateForTest();
    setRegistryForTest({});
    const store = new SessionStore({ dir: dir + "/sessions", enabled: false, debounceMs: 60000 });
    _setStoreForTest(store);
    const forwarded: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            forwarded.push(body);
            res.writeHead(200, { "content-type": "application/json" });
            if (req.url?.endsWith("/v1/messages")) {
                res.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "glm-test", content: [{ type: "text", text: "answer" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10000, output_tokens: 10 } }));
            } else if (req.url?.endsWith("/v1/responses")) {
                res.end(JSON.stringify({ id: "resp_test", object: "response", created_at: 0, status: "completed", model: "glm-test", output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "answer", annotations: [] }] }], usage: { input_tokens: 10000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, total_tokens: 10010 } }));
            } else {
                res.end(JSON.stringify({ id: "chat_test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 10, total_tokens: 10010 } }));
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: {},
        modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] },
    } as Parameters<typeof startServer>[0]);
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const wireUrl = wire === "anthropic" ? `${origin}/bili/${upstreamUrl}/v1/messages` : wire === "responses" ? `${origin}/bili/${upstreamUrl}/v1/responses` : `${origin}/bili/${upstreamUrl}/v1/chat/completions`;

    /** A dsh-lane model request on `wire`: plugin announce + conversation +
     * model header; the system rides each wire's native slot. */
    const dshChat = async (conv: string, model: string | undefined, system: string, messages: ChatMsg[]): Promise<void> => {
        const headers: Record<string, string> = { "content-type": "application/json", "x-acp-session": conv, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": conv };
        if (model !== undefined) headers["x-bili-plugin-model"] = model;
        const body = wire === "anthropic"
            ? { model: "glm-test", max_tokens: 4096, system, messages, stream: false }
            : wire === "responses"
              ? { model: "glm-test", max_output_tokens: 64_000, instructions: system, input: messages, stream: false }
              : { model: "glm-test", stream: false, messages: [{ role: "system", content: system }, ...messages] };
        const r = await fetch(wireUrl, { method: "POST", headers, body: JSON.stringify(body) });
        const text = await r.text();
        assert.equal(r.status, 200, `dsh ${wire} failed: ${text}`);
    };
    const pluginTool = async <T>(conv: string, tool: string, args: unknown): Promise<{ status: number; body: T & { result?: string } }> => {
        const r = await fetch(`${origin}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: conv, tool, args }) });
        return { status: r.status, body: (await r.json()) as T & { result?: string } };
    };
    const snapshot = async (conv: string): Promise<{ status: number; body: SnapshotBody & { error?: string } }> => {
        const r = await fetch(`${origin}/__bili/plugin/snapshot?conversationId=${conv}`);
        return { status: r.status, body: (await r.json()) as SnapshotBody & { error?: string } };
    };
    const fork = async (parent: string, child: string, snap: SnapshotBody) => {
        const orderedMessages = snap.orderedMessages;
        const body = { protocolVersion: 1, parentConversationId: parent, childConversationId: child, parentRevision: snap.parentRevision, branchPoint: { messageCount: orderedMessages.length, orderHash: hash(orderedMessages) }, orderedMessages, idempotencyKey: `proof-${child}` };
        const r = await fetch(`${origin}/__bili/plugin/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: (await r.json()) as { childConversationId?: string; inheritedBlocks?: { id: string; active: boolean }[]; error?: string } };
    };
    return {
        dshChat, pluginTool, snapshot, fork, forwarded, store,
        close: async () => { store.cancelAll(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); },
    };
}

const subForkOf = (conv: string): string[] => listSessions().map((s) => s.id).filter((id) => id.startsWith(`${conv}|sub:`));

for (const wire of WIRES) test(`scenario A (${wire}): a model switch (header + system line) stays ONE session despite a compacted history (#2601/#2719/#2727)`, async () => {
    const h = await harness(wire);
    try {
        const run = `sw-${Date.now()}`;
        const conv = `${run}-main`;
        // Phase 1 — establish the persona anchor on the raw key with model A.
        const turns: ChatMsg[] = [];
        for (let i = 1; i <= 6; i++) {
            turns.push({ role: "user", content: userText(run, i) });
            turns.push({ role: "assistant", content: `${run} reply ${i}: ${FILLER.repeat(4)}` });
        }
        await h.dshChat(conv, "glm-4.6", SYSTEM_A, turns);
        assert.equal(resolveConversation(conv).session!.id, conv, "phase 1 must key the raw conversation");
        assert.deepEqual(subForkOf(conv), [], "no fork before the switch");

        // Phase 2 — SWITCH THE MODEL in the same window as a dsh local
        // compaction: the resent history no longer continues the stored
        // chain (mid-list bytes replaced by a carrier, fresh tail). The
        // system's model line changes AND the header names the new model:
        // both host declarations corroborate → absorb (migrate-model).
        const carrier = `${run} session summary of folded early turns: the user asked numbered questions; the assistant answered with filler prose. No decisions were made.`;
        const compacted: ChatMsg[] = [
            turns[0]!,
            { role: "user", content: carrier },
            turns[4]!, turns[5]!,
            { role: "user", content: userText(run, 7) },
        ];
        await h.dshChat(conv, "glm-5.3", SYSTEM_B, compacted);
        assert.equal(resolveConversation(conv).session!.id, conv, "the absorbed switch must keep the RAW key");
        assert.deepEqual(subForkOf(conv), [], "no |sub: fork may be minted by a corroborated model switch");

        // Phase 3 — the SAME session still owns working kernel machinery:
        // fold a block now, then decompress it back.
        const snap1 = await h.snapshot(conv);
        assert.equal(snap1.status, 200, snap1.body.error ?? JSON.stringify(snap1.body));
        const refs = snap1.body.orderedMessages.map((m) => m.ref);
        const mRefs = refs.filter((r) => /^m\d+$/.test(r));
        assert.ok(mRefs.length >= 4, `need compressible refs, got ${JSON.stringify(refs)}`);
        const startId = mRefs[1]!;
        const endId = mRefs[4]!;
        const foldedTexts = snap1.body.orderedMessages.slice(1, 5).map((m) => m.rawId);
        const compressed = await h.pluginTool(conv, "compress", { content: [{ startId, endId, topic: "proof topic A", summary: "folded for the continuity proof: numbered questions and filler answers." }] });
        assert.equal(compressed.status, 200);
        assert.ok(!compressed.body.result?.includes("FAILED"), compressed.body.result);
        const dec = await h.pluginTool<{ result: string }>(conv, "decompress", { blockId: "b1", full: true });
        assert.equal(dec.status, 200, JSON.stringify(dec.body));
        const session = getSession(conv);
        for (const raw of foldedTexts) {
            const stored = session.state.messageRefs.byRaw[raw];
            if (stored === undefined) continue;
            assert.ok(dec.body.result!.includes(stored), `decompress must return the folded original ${stored}`);
        }
        assert.ok(session.state.blocks.some((b) => b.active), "the post-switch session folds blocks");
        assert.deepEqual(subForkOf(conv), [], "still no fork after post-switch compression");
    } finally {
        await h.close();
    }
});

for (const wire of WIRES) test(`scenario A control (${wire}): system drift WITHOUT header corroboration still forks`, async () => {
    const h = await harness(wire);
    try {
        const run = `ctl-${Date.now()}`;
        const conv = `${run}-main`;
        const turns: ChatMsg[] = [];
        for (let i = 1; i <= 6; i++) {
            turns.push({ role: "user", content: userText(run, i) });
            turns.push({ role: "assistant", content: `${run} reply ${i}: ${FILLER.repeat(4)}` });
        }
        await h.dshChat(conv, "glm-4.6", SYSTEM_A, turns);
        // Same compacted shape and the same changed system line, but the
        // header still names the OLD model: the conjunction is not
        // corroborated, so this is a genuine persona drift → fork.
        const carrier = `${run} session summary of folded early turns: uncorroborated drift control.`;
        await h.dshChat(conv, "glm-4.6", SYSTEM_B, [
            turns[0]!,
            { role: "user", content: carrier },
            turns[4]!, turns[5]!,
            { role: "user", content: userText(run, 9) },
        ]);
        assert.ok(subForkOf(conv).length === 1, `uncorroborated drift must fork exactly once (got ${JSON.stringify(subForkOf(conv))})`);
        assert.ok(listSessions().some((s) => s.id === conv), "the raw-key parent session still exists (stale but intact)");
    } finally {
        await h.close();
    }
});

for (const wire of WIRES) test(`scenario B (${wire}): a fork with context COPIES the parent's compression state, guards included (#629/#2620/#2625/#2676)`, async () => {
    const h = await harness(wire);
    try {
        const run = `fk-${Date.now()}`;
        const parent = `${run}-parent`;
        const child = `${run}-child`;
        const history: ChatMsg[] = [
            { role: "user", content: `${run} opener: ${FILLER.repeat(3)}` },
            { role: "user", content: GUARD_TEXT },
            { role: "assistant", content: `${run} ack: ${FILLER.repeat(3)}` },
        ];
        for (let i = 1; i <= 6; i++) {
            history.push({ role: "user", content: userText(`${run}-p`, i) });
            history.push({ role: "assistant", content: `${run} reply ${i}: ${FILLER.repeat(3)}` });
        }
        await h.dshChat(parent, "glm-4.6", SYSTEM_A, history);

        // Fold a block that sits AFTER the guard message (guards are
        // protected from folding by design).
        const snap = await h.snapshot(parent);
        assert.equal(snap.status, 200, snap.body.error ?? JSON.stringify(snap1Error(snap.body)));
        const refs = snap.body.orderedMessages.map((m) => m.ref);
        assert.equal(refs.length, history.length, "conversation messages (the system rides outside the ref space)");
        // #2676 lane: the durable guard message is protected — unaddressable
        // on the wire (null ref; the kernel BLOCKED sentinel itself never
        // crosses it — #2620 final contract).
        assert.equal(refs[1], null, `guard must be a null ref, got ${JSON.stringify(refs)}`);
        assert.ok(!refs.includes("BLOCKED"), "the sentinel must never cross the wire");
        const foldFrom = refs[3]!;
        const foldTo = refs[8]!;
        const foldedRawIds = snap.body.orderedMessages.slice(3, 9).map((m) => m.rawId);
        const compressed = await h.pluginTool(parent, "compress", { content: [{ startId: foldFrom, endId: foldTo, topic: "proof topic B", summary: "folded mid-history turns for the fork-copy proof: numbered user questions and filler assistant answers, no decisions made." }] });
        assert.equal(compressed.status, 200);
        assert.ok(!compressed.body.result?.includes("FAILED"), compressed.body.result);
        const parentBlocks = getSession(parent).state.blocks.map((b) => b.blockId);
        assert.ok(parentBlocks.length >= 1, "parent must hold a fold block");

        // FORK the full conversation from the post-fold revision: the child
        // must inherit everything.
        const snap2 = await h.snapshot(parent);
        assert.equal(snap2.status, 200, snap2.body.error ?? JSON.stringify(snap2.body));
        const forkRes = await h.fork(parent, child, snap2.body);
        assert.equal(forkRes.status, 201, forkRes.body.error ?? JSON.stringify(forkRes.body));
        const inherited = forkRes.body.inheritedBlocks ?? [];
        for (const id of parentBlocks) assert.ok(inherited.some((b) => b.id === id && b.active), `child must inherit active block ${id} (got ${JSON.stringify(inherited)})`);

        const childSession = resolveConversation(child).session!;
        assert.notEqual(childSession.id, getSession(parent).id, "the child is a NEW session");
        assert.deepEqual(childSession.state.messageRefs.byRef["BLOCKED"], undefined, "#2620: BLOCKED never enters byRef");
        assert.ok(Object.values(childSession.state.messageRefs.byRaw).includes("BLOCKED"), "#2620: BLOCKED stays addressable by raw");
        // Seeded refs: the child's mapping for every inherited raw id must
        // equal the parent's exact ref (#629 copy-on-fork).
        const parentSession = getSession(parent);
        for (const b of childSession.state.blocks.filter((x) => x.active)) {
            for (const raw of b.effectiveMessageIds) {
                assert.equal(childSession.state.messageRefs.byRaw[raw], parentSession.state.messageRefs.byRaw[raw], `child ref for ${raw} must equal the parent's seeded ref`);
            }
            assert.ok(childSession.blockContents.has(b.blockId), `child must carry the summary for ${b.blockId}`);
        }

        // The child DECOMPRESSES the parent's folded block — the copied
        // state must include the ORIGINAL content, not just the summary.
        const dec = await h.pluginTool<{ result: string }>(child, "decompress", { blockId: inherited[0]!.id, full: true });
        assert.equal(dec.status, 200, JSON.stringify(dec.body));
        for (const raw of foldedRawIds) {
            const ref = childSession.state.messageRefs.byRaw[raw];
            if (ref === undefined || ref === "BLOCKED") continue;
            assert.ok(dec.body.result!.includes(ref), `child decompress must return parent original ${ref}`);
        }

        // The child keeps talking on its own lane — refs stay stable and no
        // new session appears for it.
        const childHistory: ChatMsg[] = [...history, { role: "assistant", content: `${run} child continuation` }];
        await h.dshChat(child, "glm-4.6", SYSTEM_A, [...childHistory, { role: "user", content: userText(`${run}-c`, 1) }]);
        assert.equal(resolveConversation(child).session!.id, childSession.id, "child continuation must stay on the child session");

        // Copy-on-fork: the parent is untouched by everything the child did.
        const parentAfter = getSession(parent);
        assert.deepEqual(parentAfter.state.blocks.map((b) => b.blockId), parentBlocks, "parent blocks must be untouched");
        const parentDec = await h.pluginTool<{ result: string }>(parent, "decompress", { blockId: parentBlocks[0]!, full: true });
        assert.equal(parentDec.status, 200, "parent decompress still works after the fork");
    } finally {
        await h.close();
    }
});

function snap1Error(body: unknown): string {
    return JSON.stringify(body);
}
