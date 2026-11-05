import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { maybeAdoptResume, maybeAdoptDerivedFork, incomingCoreMessages } from "../src/fork-adoption.ts";
import type { Session } from "../src/session.ts";
import { listSessions } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

/**
 * derived-fork block inheritance: fork 出的子会话在弱路径 `derived` 命中
 * （身份头已确认父子关系）时，必须按消息 id 交集继承父会话的活跃折叠 block，
 * 不依赖字节精确前缀匹配。
 *
 * 场景模拟 pi fork：
 *  1. 父会话（x-acp-session=A）长到压缩触发，产生 refs + blocks
 *  2. 用 register 端点声明子会话 B 的 parentConversationId=A
 *  3. 子会话（x-acp-session=B）发送 FULL history + 一条新消息
 *  4. 因为父子消息流存在字节差异（fork 重新分配 timestamp），prefix-affinity
 *     字节前缀匹配失败 → 不走 resume-inheritance，走弱路径 derived
 *  5. 弱路径必须按消息 id 交集继承父会话的 refs + blocks + lineage
 */

let scenarioSeq = 0;
function nextRunTag(): string {
    scenarioSeq += 1;
    return `dfork${scenarioSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]);
    return ids;
}

const FILLER = "the quick brown fox jumps over the lazy dog again and again. ";

function userText(run: string, i: number): string {
    return `run ${run} user turn ${i}: ${FILLER.repeat(12)}`;
}

function relayReply(body: string, n: number): string {
    let lastUser = "";
    try {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
        const msgs = parsed.messages ?? [];
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i]!.role === "user") {
                lastUser = msgs[i]!.content;
                break;
            }
        }
    } catch {
        /* fall through with empty echo */
    }
    return `run reply ${n} to <${lastUser.slice(0, 48)}>: ${FILLER.repeat(10)}`;
}

type RelayState = { upstreamReqs: string[]; compressed: boolean };

function startMockUpstream(state: RelayState): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            state.upstreamReqs.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const refIds = parseRefIds(body);
            if (!state.compressed && refIds.length >= 5) {
                state.compressed = true;
                const from = refIds[1]!;
                const to = refIds[refIds.length - 3]!;
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }));
                res.write(sseLine({
                    id: "c1",
                    object: "chat.completion.chunk",
                    choices: [{
                        index: 0,
                        delta: {
                            tool_calls: [{
                                index: 0,
                                id: "call_compress_1",
                                type: "function",
                                function: { name: "compress", arguments: JSON.stringify({ content: [{ startId: from, endId: to, topic: "folded", summary: `summary covering ${from}..${to}` }] }) },
                            }],
                        },
                    }],
                }));
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
            } else {
                const text = relayReply(body, state.upstreamReqs.length);
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text } }] }));
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 50 } }));
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

type ChatMsg = { role: string; content: string };

async function chat(url: string, messages: ChatMsg[], sessionId?: string): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(sessionId ? { "x-acp-session": sessionId } : {}) },
        body: JSON.stringify({ model: "gpt-test", stream: true, messages }),
    });
    if (!res.ok) assert.fail(`HTTP ${res.status}: ${await res.text()}`);
    let raw = "";
    for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
    let reply = "";
    for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
            const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
            reply += parsed.choices?.[0]?.delta?.content ?? "";
        } catch {
            /* ignore keepalives */
        }
    }
    return reply;
}

function proxyOpts(relayUrl: string): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {} as ProxyOptions["routes"],
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000, {
            preserveRecentMessages: 2,
            preserveRecentTokens: 400,
            compress: { minCompressRange: 200, minSummaryLength: 20, maxSummaryLength: 5000 },
        }),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions;
}

type ScenarioResult = {
    parentId: string;
    childId: string;
    parentRefs: Record<string, string>;
    parentBlockIds: string[];
    childRefs: Record<string, string>;
    childBlockIds: string[];
    lineage: string | undefined;
    parentUntouched: boolean;
};

async function runDerivedForkScenario(): Promise<ScenarioResult> {
    const run = nextRunTag();
    const parentId = `${run}-A`;
    const childId = `${run}-B`;
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "derived-fork-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const opts = proxyOpts(`http://127.0.0.1:${relayPort}/v1/chat/completions`);
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;
    try {
        // Parent conversation grown past the mock's one-shot fold trigger.
        const history: ChatMsg[] = [];
        for (let i = 1; i <= 8; i++) {
            history.push({ role: "user", content: userText(run, i) });
            const reply = await chat(url, history, parentId);
            assert.ok(reply.length > 0, `parent turn ${i} must produce a reply`);
            history.push({ role: "assistant", content: reply });
        }
        const parent = listSessions().find((s) => s.id === parentId);
        assert.ok(parent, "parent session must exist");
        const parentRefs = { ...parent.state.messageRefs.byRaw };
        const activeBlocks = parent.state.blocks.filter((b) => b.active);
        const parentBlockIds = activeBlocks.map((b) => b.blockId);
        assert.ok(Object.keys(parentRefs).length >= 5, "parent must have assigned refs");
        assert.ok(parentBlockIds.length >= 1, `parent must have folded a block (got ${parentBlockIds.length})`);
        const parentBlocksBefore = parent.state.blocks.length;

        // Register the child fork — this makes derivedParent known to the server.
        const registerRes = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: childId, agent: "pi", parentConversationId: parentId }),
        });
        assert.equal(registerRes.status, 200, `register must succeed: ${await registerRes.text()}`);

        // Fork: child replays FULL history + one new message under a fresh id.
        // The child's request body is not a byte-exact continuation of the
        // parent's tracked chain (mock relay returns position-dependent
        // echoes), so prefix-affinity's byte-exact match fails and the
        // derived (weak) path is the one that must inherit.
        //
        // To force the WEAK path: append a resume-time decoration to the
        // LAST shared message (mimics #1486's "re-decorated tails"). This
        // breaks the byte-exact prefix match without changing any message
        // id (ids are content-hashed, decoration changes content → new id,
        // but the decoration is on a message OUTSIDE the fold range, so
        // block adoption is unaffected).
        const forkHistory: ChatMsg[] = [
            ...history.slice(0, history.length - 2),
            { role: history[history.length - 2]!.role, content: history[history.length - 2]!.content + "\n\n[resume-time context reminder]" },
            { role: history[history.length - 1]!.role, content: history[history.length - 1]!.content },
            { role: "user", content: userText(`${run}-fork`, 1) },
        ];
        const reply1 = await chat(url, forkHistory, childId);
        assert.ok(reply1.length > 0, "fork first turn must produce a reply");

        const child = listSessions().find((s) => s.id === childId);
        assert.ok(child, "fork child session must exist");
        const childRefs = { ...child.state.messageRefs.byRaw };
        const childBlockIds = child.state.blocks.map((b) => b.blockId);
        const lineage = child.metadata.derivedFromSessionId as string | undefined;

        return {
            parentId,
            childId,
            parentRefs,
            parentBlockIds,
            childRefs,
            childBlockIds,
            lineage,
            parentUntouched: parent.state.blocks.length === parentBlocksBefore && JSON.stringify(parent.state.messageRefs.byRaw) === JSON.stringify(parentRefs),
        };
    } finally {
        await close(proxy);
        await close(relay);
    }
}

test("a derived child whose ids do not overlap the parent inherits nothing (AC4)", async () => {
    // AC4: parent and child sharing no message ids is a genuinely new
    // conversation, not a fork — adoption must seed nothing. The id-intersection
    // gate is what decides this, so an empty intersection has to be pinned
    // independently of the byte-prefix machinery above.
    const parent = {
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            tokenSnapshot: {},
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
    } as unknown as Session;
    const child = {
        state: {
            blocks: [],
            messageRefs: { byRaw: {}, byRef: {} },
            tokenSnapshot: {},
            nextBlockId: 1,
            nextRunId: 1,
        },
        blockContents: new Map(),
    } as unknown as Session;
    const parentRaw: Record<string, string> = { rawA1: "m00001", rawA2: "m00002" };
    const parentRef: Record<string, string> = { m00001: "rawA1", m00002: "rawA2" };
    parent.state.messageRefs.byRaw = parentRaw;
    parent.state.messageRefs.byRef = parentRef;
    parent.state.blocks.push({
        blockId: "b1",
        runId: 1,
        tier: 0,
        active: true,
        summary: "parent summary",
        directMessageIds: ["rawA1"],
        effectiveMessageIds: ["rawA1", "rawA2"],
        directBlockIds: [],
        createdAt: 0,
        compressedTokens: 900,
    } as unknown as (typeof parent.state.blocks)[number]);
    parent.blockContents.set("b1", { full: { text: "parent summary", count: 1 }, one: null });

    const logs: Array<[string, string]> = [];
    maybeAdoptResume({
        session: child,
        parent,
        sharedDepth: 0,
        protocol: "openai",
        // Raw ids are content-hashed by the wire adapters, so an unrelated
        // body cannot collide with the parent's `rawA1`/`rawA2` by accident.
        parsed: { messages: [{ role: "user", content: "an unrelated conversation" }] },
        upstreamOrigin: "http://127.0.0.1",
        blocksEnabled: true,
        log: (level, msg) => logs.push([level, msg]),
    });

    assert.equal(child.state.blocks.length, 0, "no shared message id means no block may be adopted");
    assert.equal(child.blockContents.size, 0, "nothing to copy from the parent");
    assert.deepEqual(Object.keys(child.state.messageRefs.byRaw), [], "the child must keep its own empty ref space");
    assert.ok(
        logs.some(([, msg]) => msg.includes("nothing to inherit")),
        "the no-overlap case must be logged, not silently dropped",
    );
});

test("derived fork inherits parent refs and blocks via message-id intersection", async () => {
    const r = await runDerivedForkScenario();

    // Lineage must link to the parent.
    assert.equal(r.lineage, r.parentId, "derivedFrom lineage must link to the parent");

    // Every parent ref assignment must survive into the child, except
    // the one we deliberately broke (the decorated message's raw id changed
    // because we altered its content).
    const missingKeys = Object.keys(r.parentRefs).filter((k) => !(k in r.childRefs));
    assert.equal(missingKeys.length, 1, `exactly one ref should be missing (the decorated message's new raw id): ${JSON.stringify(missingKeys)}`);
    for (const [raw, ref] of Object.entries(r.parentRefs)) {
        if (missingKeys.includes(raw)) continue;
        assert.equal(r.childRefs[raw], ref, `ref ${ref} for a shared message must be preserved across the fork`);
    }

    // At least one block must be adopted.
    const adopted = r.parentBlockIds.filter((id) => r.childBlockIds.includes(id));
    assert.ok(adopted.length >= 1, `fork child must adopt the parent's block(s) (parent=${JSON.stringify(r.parentBlockIds)} child=${JSON.stringify(r.childBlockIds)})`);

    // Parent session must stay untouched (copy-on-fork).
    assert.ok(r.parentUntouched, "parent session must stay untouched");
});

/**
 * #3351: the weak-link gate must mirror the boot sweep's discipline — close
 * ONLY when blocks were actually adopted. Pre-fix, maybeAdoptDerivedFork set
 * derivedBlocksAdopted=true unconditionally right after maybeAdoptResume, so a
 * multi-hop grandchild whose registered parent was still young (zero folds) at
 * first contact permanently lost eligibility: the link lands exactly once
 * (handle.ts gates it on derivedFromSessionId === undefined) and the
 * prematurely-persisted marker made every later boot sweep skip it. These pin
 * the gate discipline directly at the changed seam; the restart convergence is
 * covered by the lineage-reconcile-boot suite (AC9/AC12).
 */

function sharedWireBody(): { parsed: unknown; ids: string[] } {
    const parsed = {
        messages: [
            { role: "user", content: "shared turn one" },
            { role: "assistant", content: "shared reply one" },
        ],
    };
    const msgs = incomingCoreMessages("openai", parsed);
    assert.ok(msgs && msgs.length === 2, "wire body must yield two core messages");
    return { parsed, ids: msgs!.map((m) => m.id) };
}

function blankSession(id: string): Session {
    return {
        id,
        metadata: {},
        // A real session always carries a content store; supply an empty one so
        // contentStoreOf short-circuits instead of probing the (disabled) store.
        contentStore: { version: 1, byHash: {}, byRef: {} },
        state: { blocks: [], messageRefs: { byRaw: {}, byRef: {} }, tokenSnapshot: {}, nextBlockId: 1, nextRunId: 1 },
        blockContents: new Map(),
    } as unknown as Session;
}

function seedParentRefs(parent: Session, ids: string[]): void {
    parent.state.messageRefs.byRaw = { [ids[0]!]: "m00001", [ids[1]!]: "m00002" };
    parent.state.messageRefs.byRef = { m00001: ids[0]!, m00002: ids[1]! };
}

test("#3351: weak-link gate stays OPEN when the registered parent has no blocks at first contact", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const { parsed, ids } = sharedWireBody();
    const [idA] = [ids[0]!, ids[1]!];
    assert.ok(ids[0] && ids[1] && ids[0] !== ids[1], "core message ids must be distinct");

    const parent = blankSession("P");
    seedParentRefs(parent, ids);
    assert.equal(parent.state.blocks.length, 0, "precondition: parent is young (no folds yet)");

    const child = blankSession("G");
    child.metadata.derivedFromSessionId = "P";
    maybeAdoptDerivedFork({ session: child, parent, protocol: "openai", parsed, upstreamOrigin: "http://127.0.0.1", enabled: true, log: () => {} });

    assert.ok(idA in child.state.messageRefs.byRaw, "refs-only inheritance still happens against a young parent");
    assert.equal(child.state.blocks.length, 0, "no block adopted from a block-less parent");
    assert.notEqual(child.metadata.derivedBlocksAdopted, true, "#3351: gate must stay OPEN so a later boot can adopt once the parent folds");
});

test("#3351: weak-link gate CLOSES when the registered parent has fully-present blocks", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const { parsed, ids } = sharedWireBody();

    const parent = blankSession("P");
    seedParentRefs(parent, ids);
    parent.state.blocks.push({
        blockId: "b1",
        runId: 1,
        tier: 1,
        active: true,
        summary: "summary over the shared prefix",
        directMessageIds: [ids[0]!],
        effectiveMessageIds: [...ids],
        directBlockIds: [],
        createdAt: 0,
        compressedTokens: 900,
    } as unknown as (typeof parent.state.blocks)[number]);
    parent.blockContents.set("b1", { full: { text: "summary over the shared prefix", count: 1 }, one: null } as never);

    const child = blankSession("G");
    child.metadata.derivedFromSessionId = "P";
    maybeAdoptDerivedFork({ session: child, parent, protocol: "openai", parsed, upstreamOrigin: "http://127.0.0.1", enabled: true, log: () => {} });

    assert.equal(child.state.blocks.length, 1, "block adopted from a folded parent");
    assert.equal(child.metadata.derivedBlocksAdopted, true, "gate closes on real block adoption");
    assert.ok(child.blockContents.has("b1"), "adopted block carries its stored content");
});
