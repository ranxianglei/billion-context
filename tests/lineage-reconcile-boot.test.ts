import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest, getStore } from "../src/persist.ts";
import { listSessions } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

/**
 * lineage-reconcile on boot (#2807): `metadata.derivedFromSessionId` is
 * persisted, but before #2807 it was write-only. Both fork adoption paths read
 * process-local state — `prefixAffinity.trackedChains` for the byte-prefix
 * strong path, the plugin register table for the derived weak path — so a bili
 * restart orphans every forked child: it keeps the full raw history while its
 * parent's fold ledger sits on disk. This is the restart case the weak-path
 * adoption cannot cover (the register table is empty).
 *
 * reconcileDerivedLineage() runs after boot and re-adopts by raw-id set,
 * gated on `resumeInheritance`.
 */

let scenarioSeq = 0;
function nextRunTag(): string {
    scenarioSeq += 1;
    return `lrec${scenarioSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function proxyOpts(relayUrl: string, resumeInheritance?: boolean): ProxyOptions {
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
        ...(resumeInheritance !== undefined ? { resumeInheritance } : {}),
    } as ProxyOptions;
}

/** Grow a parent past the mock's one-shot fold trigger, then fork a child the
 *  way pi does: register the lineage, then replay full history + a new tail
 *  under a fresh session id. The child's request body is NOT a byte-exact
 *  continuation (position-dependent mock echoes), so the byte-prefix strong
 *  path fails and only lineage knows the pair. */
type ForkSetup = {
    run: string;
    parentId: string;
    childId: string;
    history: ChatMsg[];
    parentBlockIds: string[];
    parentRefs: Record<string, string>;
};

async function setupForkOnDisk(resumeInheritance?: boolean): Promise<ForkSetup> {
    const run = nextRunTag();
    const parentId = `${run}-A`;
    const childId = `${run}-B`;
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const opts = proxyOpts(`http://127.0.0.1:${relayPort}/v1/chat/completions`, resumeInheritance);
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;
    try {
        const history: ChatMsg[] = [];
        for (let i = 1; i <= 8; i++) {
            history.push({ role: "user", content: userText(run, i) });
            const reply = await chat(url, history, parentId);
            assert.ok(reply.length > 0, `parent turn ${i} must produce a reply`);
            history.push({ role: "assistant", content: reply });
        }
        const parent = listSessions().find((s) => s.id === parentId);
        assert.ok(parent, "parent session must exist");
        const activeBlocks = parent.state.blocks.filter((b) => b.active);
        assert.ok(activeBlocks.length >= 1, `parent must have folded a block (got ${activeBlocks.length})`);

        const registerRes = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: childId, agent: "pi", parentConversationId: parentId }),
        });
        assert.equal(registerRes.status, 200, `register must succeed: ${await registerRes.text()}`);

        const reply1 = await chat(url, [...history, { role: "user", content: userText(`${run}-fork`, 1) }], childId);
        assert.ok(reply1.length > 0, "fork first turn must produce a reply");
        const child = listSessions().find((s) => s.id === childId);
        assert.ok(child, "fork child session must exist");
        assert.equal(child.metadata.derivedFromSessionId, parentId, "child must record its lineage");
        // The weak-path adoption may already have seeded the child. Strip the
        // blocks so we can measure what the BOOT reconcile does on its own —
        // that is the path a restart exercises (register table empty).
        for (const b of child.state.blocks) child.blockContents.delete(b.blockId);
        child.state.blocks.length = 0;
        delete child.metadata.derivedBlocksAdopted;
        // Pin the post-strip shape synchronously (#3336): an armed debounce
        // timer from the request above would otherwise fire later and persist
        // whichever in-memory snapshot it finds at fire time, leaking pre-strip
        // state into the simulated restart below. Same for the parent's ledger.
        assert.ok(getStore().flushSync(child), "post-strip persist of the fork child must land");
        assert.ok(getStore().flushSync(parent), "parent's folded ledger must be on disk before the restart");

        return {
            run,
            parentId,
            childId,
            history,
            parentBlockIds: activeBlocks.map((b) => b.blockId),
            parentRefs: { ...parent.state.messageRefs.byRaw },
        };
    } finally {
        await close(proxy);
        await close(relay);
    }
}

test("AC9: boot reconcile adopts the parent's blocks into a restarted fork child", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lrec-"));
    process.env.XDG_STATE_HOME = stateDir;
    // Stand up the fork with persistence on so both sessions land on disk, then
    // tear the proxy down: the child is exactly the post-restart state.
    _setStoreForTest(new SessionStore({ enabled: true, dir: path.join(stateDir, "sessions") }));
    setRegistryForTest({});
    const setup = await setupForkOnDisk(true);

    // Simulate the restart: a brand-new store (empty in-memory map), then boot.
    _setStoreForTest(new SessionStore({ enabled: true, dir: path.join(stateDir, "sessions") }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const opts = proxyOpts(`http://127.0.0.1:${relayPort}/v1/chat/completions`, true);
    const proxy = await startServer(opts); // boot runs reconcileDerivedLineage
    await listen(proxy);
    try {
        const child = listSessions().find((s) => s.id === setup.childId);
        assert.ok(child, "fork child must be loaded from disk");
        assert.ok(child.state.blocks.length > 0, "boot reconcile must seed the child with the parent's blocks");
        assert.ok(child.blockContents.size > 0, "adopted blocks must carry their summaries");
        assert.equal(child.metadata.derivedFromSessionId, setup.parentId, "lineage link must survive");

        const parent = listSessions().find((s) => s.id === setup.parentId);
        assert.ok(parent, "parent must also be loaded");
        // Copy-on-fork: the parent keeps every block and ref it had.
        for (const id of setup.parentBlockIds) {
            assert.ok(parent.state.blocks.some((b) => b.blockId === id), `parent must still own block ${id}`);
        }
        assert.ok(
            Object.keys(setup.parentRefs).every((k) => k in parent.state.messageRefs.byRaw),
            "parent must keep all of its refs",
        );
    } finally {
        await close(proxy);
        await close(relay);
    }
});

test("AC10: reconcile is idempotent across repeated boots", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lrec-"));
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: true, dir: path.join(stateDir, "sessions") }));
    setRegistryForTest({});
    // Leaves the child orphaned (no blocks, no marker) — the post-restart state.
    const setup = await setupForkOnDisk(true);

    // First boot: must adopt.
    _setStoreForTest(new SessionStore({ enabled: true, dir: path.join(stateDir, "sessions") }));
    setRegistryForTest({});
    const relay1 = startMockUpstream({ upstreamReqs: [], compressed: false });
    await listen(relay1);
    const port1 = (relay1.address() as { port: number }).port;
    const proxy1 = await startServer(proxyOpts(`http://127.0.0.1:${port1}/v1/chat/completions`, true));
    await listen(proxy1);
    let blocksAfterFirstBoot: string[] = [];
    let contentsAfterFirstBoot = 0;
    try {
        const child = listSessions().find((s) => s.id === setup.childId);
        assert.ok(child, "fork child must load from disk");
        assert.ok(child.state.blocks.length > 0, "first boot must adopt the parent's blocks");
        blocksAfterFirstBoot = child.state.blocks.map((b) => b.blockId);
        contentsAfterFirstBoot = child.blockContents.size;
    } finally {
        await close(proxy1);
        await close(relay1);
    }

    // Second boot: the marker is set and blocks are seeded, so the sweep skips.
    _setStoreForTest(new SessionStore({ enabled: true, dir: path.join(stateDir, "sessions") }));
    setRegistryForTest({});
    const relay2 = startMockUpstream({ upstreamReqs: [], compressed: false });
    await listen(relay2);
    const port2 = (relay2.address() as { port: number }).port;
    const proxy2 = await startServer(proxyOpts(`http://127.0.0.1:${port2}/v1/chat/completions`, true));
    await listen(proxy2);
    try {
        const child = listSessions().find((s) => s.id === setup.childId);
        assert.ok(child, "fork child must still load from disk");
        assert.deepEqual(
            child.state.blocks.map((b) => b.blockId),
            blocksAfterFirstBoot,
            "a second boot must not re-adopt or reorder blocks",
        );
        assert.equal(child.blockContents.size, contentsAfterFirstBoot, "block contents must not be duplicated");

        // A child whose parent is not on disk must survive without crashing and
        // without consuming the marker, so a later boot can still try.
        const { reconcileDerivedLineage } = await import("../src/fork-adoption.ts");
        const logs: Array<[string, string]> = [];
        const orphan = {
            ...child,
            id: `${setup.childId}-orphan`,
            state: {
                ...child.state,
                blocks: [],
                messageRefs: { byRaw: { ...child.state.messageRefs.byRaw }, byRef: {} },
            },
            metadata: {
                ...child.metadata,
                derivedFromSessionId: `${setup.run}-GONE`,
                derivedBlocksAdopted: undefined,
            },
        } as typeof child;
        reconcileDerivedLineage([orphan], { log: (lvl, msg) => logs.push([lvl, msg]), adoptionEnabled: true });
        assert.equal(orphan.state.blocks.length, 0, "an unreachable parent must seed nothing");
        assert.notEqual(orphan.metadata.derivedBlocksAdopted, true, "an unreachable parent must not close the door");
        assert.ok(
            logs.some(([lvl, msg]) => lvl === "info" && msg.includes("not on disk")),
            "an unreachable parent must be logged, not silently dropped",
        );
    } finally {
        await close(proxy2);
        await close(relay2);
    }
});

test("AC11: resumeInheritance:false disables boot reconcile", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lrec-"));
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: true, dir: path.join(stateDir, "sessions") }));
    setRegistryForTest({});
    // Build the fork with adoption ON so the lineage link is recorded, then
    // strip the child's blocks: we want to see only what a gated-off boot does.
    const setup = await setupForkOnDisk(true);
    _setStoreForTest(new SessionStore({ enabled: true, dir: path.join(stateDir, "sessions") }));
    setRegistryForTest({});
    const relay = startMockUpstream({ upstreamReqs: [], compressed: false });
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(`http://127.0.0.1:${relayPort}/v1/chat/completions`, false));
    await listen(proxy);
    try {
        const child = listSessions().find((s) => s.id === setup.childId);
        assert.ok(child, "fork child must load from disk");
        assert.equal(child.metadata.derivedFromSessionId, setup.parentId, "lineage link must survive the gate");
        assert.notEqual(child.metadata.derivedBlocksAdopted, true, "gate-off must not consume the marker");
    } finally {
        await close(proxy);
        await close(relay);
    }
});

// Upstream review finding 2: the sweep walks sessions by lastSeen descending,
// so in a P→C→G chain the grandchild is often reached before the child has
// adopted from its own parent. If G closed its gate while C was still empty,
// G could never retry (the weak derived path also skips once the lineage link
// is persisted) and would depend on preflight compression alone. Every
// non-success branch must leave the marker unset so the next boot retries.
test("AC12: a multi-hop grandchild stays eligible when its intermediate parent has nothing to adopt yet", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "lrec-hop-"));
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: true, dir: path.join(stateDir, "sessions") }));
    setRegistryForTest({});
    const setup = await setupForkOnDisk(true);
    const { run, parentId, childId, history } = setup;

    // Build the third generation off the (now block-less) child.
    const grandchildId = `${run}-C`;
    // compressed:true so this relay answers the grandchild's request directly
    // instead of spending its one fold turn on it.
    const relay = startMockUpstream({ upstreamReqs: [], compressed: true });
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(`http://127.0.0.1:${relayPort}/v1/chat/completions`, true));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const registerRes = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: grandchildId, agent: "pi", parentConversationId: childId }),
        });
        assert.equal(registerRes.status, 200, `register must succeed: ${await registerRes.text()}`);
        const reply = await chat(
            `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`,
            [...history, { role: "user", content: userText(`${run}-hop`, 1) }],
            grandchildId,
        );
        assert.ok(reply.length > 0, "grandchild first turn must produce a reply");

        const grandchild = listSessions().find((s) => s.id === grandchildId);
        assert.ok(grandchild, "grandchild session must exist");
        assert.equal(grandchild.metadata.derivedFromSessionId, childId, "grandchild must record its lineage");

        // Post-restart shape: both generations stripped, as a restart leaves them
        // (the register table and prefixAffinity chains are process-local).
        for (const id of [childId, grandchildId]) {
            const s = listSessions().find((x) => x.id === id);
            assert.ok(s, `${id} must be on disk`);
            for (const b of s.state.blocks) s.blockContents.delete(b.blockId);
            s.state.blocks.length = 0;
            delete s.metadata.derivedBlocksAdopted;
            // Same #3336 pin as in setupForkOnDisk: the boot reconcile above
            // adopted the child from the root and armed its debounce; without a
            // sync flush here the final boot below could load the child WITH
            // blocks and legally adopt the grandchild, closing its gate.
            assert.ok(getStore().flushSync(s), `post-strip persist of ${id} must land`);
        }
        // The scenario under test needs the sweep to reach the grandchild
        // BEFORE the child adopts. listSessions() orders by lastSeen desc, and
        // the two turns' timestamps are ambient wall-clock: a coarse clock or
        // a reload path restamping lastSeen can tie or flip them (observed
        // deterministically on the windows-latest CI lanes). Once the child is
        // visited first it legitimately adopts from the root, and the
        // grandchild's adoption from a now-block-bearing parent is CORRECT
        // behavior (#2807 contract) — failing this assertion for the wrong
        // reason. Pin the order instead of leaning on clock luck.
        const pinnedChild = listSessions().find((x) => x.id === childId)!;
        const pinnedGrandchild = listSessions().find((x) => x.id === grandchildId)!;
        pinnedGrandchild.lastSeen = Math.max(pinnedGrandchild.lastSeen, pinnedChild.lastSeen + 60_000);
    } finally {
        await close(proxy);
        await close(relay);
    }

    // Boot: the grandchild has a later lastSeen, so the sweep reaches it first.
    _setStoreForTest(new SessionStore({ enabled: true, dir: path.join(stateDir, "sessions") }));
    setRegistryForTest({});
    const relay2 = startMockUpstream({ upstreamReqs: [], compressed: false });
    await listen(relay2);
    const port2 = (relay2.address() as { port: number }).port;
    const proxy2 = await startServer(proxyOpts(`http://127.0.0.1:${port2}/v1/chat/completions`, true));
    await listen(proxy2);
    try {
        const child = listSessions().find((s) => s.id === childId);
        const grandchild = listSessions().find((s) => s.id === grandchildId);
        assert.ok(child && grandchild, "both generations must load from disk");
        assert.ok(child.state.blocks.length > 0, "the child must adopt the root's blocks on boot");
        assert.notEqual(
            grandchild.metadata.derivedBlocksAdopted,
            true,
            "a grandchild whose parent was empty at visit time must stay eligible, not close its gate",
        );
    } finally {
        await close(proxy2);
        await close(relay2);
    }
});
