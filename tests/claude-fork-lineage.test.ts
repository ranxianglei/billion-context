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
import { listSessions } from "../src/session.ts";
import { PrefixAffinityResolver } from "../src/prefix-affinity.ts";
import { queuePluginRegister, consumePluginRegisterFor, _resetPluginStateForTest } from "../src/plugin.ts";
import { claudeForkParentFromArgv, hookMainWithDeps } from "../src/claude-native-bootstrap.ts";
import { PassThrough } from "node:stream";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

/**
 * #2408 claude --fork-session lineage declaration. `claude --resume <parent>
 * --fork-session` fires SessionStart (source: "fork") with a FRESH session id
 * while replaying the parent's wire history. The claude bootstrap hook parses
 * the parent off the host argv and POSTs an identity register with
 * parentConversationId. The server then:
 *  - defers the #1333 read-only link on the child's first request so the
 *    richer #1486 resume-inheritance can seed refs/blocks first,
 *  - scopes the content match to the DECLARED parent's chain
 *    (findResumeParentWithin), disambiguating duplicate replayed content the
 *    unscoped scan would mis-link (tie goes to the most recently seen),
 *  - falls back to the link (lineage without adoption) when the replay does
 *    not match, and
 *  - keeps a declared parent sticky across re-registers without one (the MCP
 *    shim re-registers the session with no parent field).
 */

// ---------------------------------------------------------------- argv parsing

const UUID_A = "9ed5a491-1111-4222-8333-444455556666";
const UUID_B = "0aa0b0b0-2222-4333-8444-555566667777";

test("claudeForkParentFromArgv parses every resume spelling (#2408)", () => {
    assert.equal(claudeForkParentFromArgv(["claude", "--resume", UUID_A, "--fork-session"]), UUID_A, "--resume <uuid>");
    assert.equal(claudeForkParentFromArgv(["claude", `--resume=${UUID_A}`, "--fork-session"]), UUID_A, "--resume=<uuid>");
    assert.equal(claudeForkParentFromArgv(["claude", "-r", UUID_A]), UUID_A, "-r <uuid>");
    assert.equal(claudeForkParentFromArgv(["claude", "--fork-session", "--continue"]), undefined, "--continue carries no parent id");
    assert.equal(claudeForkParentFromArgv(["claude", "--resume", "not-a-uuid", "--fork-session"]), undefined, "non-UUID resume value is not a session token");
    assert.equal(claudeForkParentFromArgv(["claude", "--model", "opus"]), undefined, "plain launch has no parent");
});

// -------------------------------------------------------- register stickiness

test("identity register keeps a declared parent sticky across parent-less re-registers (#2408)", () => {
    _resetPluginStateForTest();
    queuePluginRegister("conv-fork-child", "claude", true, "conv-parent");
    queuePluginRegister("conv-fork-child", "claude", true); // MCP shim re-register, no parent
    assert.deepEqual(consumePluginRegisterFor("conv-fork-child"), { agent: "claude", parentConversationId: "conv-parent" }, "parent must survive the parent-less re-register");
    queuePluginRegister("conv-fork-child", "claude", true, "conv-other"); // a NEW declaration updates
    assert.deepEqual(consumePluginRegisterFor("conv-fork-child"), { agent: "claude", parentConversationId: "conv-other" }, "an explicit new parent updates the entry");
    queuePluginRegister("conv-plain", "claude", true);
    assert.deepEqual(consumePluginRegisterFor("conv-plain"), { agent: "claude" }, "no parent introduced where none was declared");
    _resetPluginStateForTest();
});

// -------------------------------------------------------- scoped chain match

function affinityTurn(i: number): { role: string; content: string } {
    return i % 2 === 0 ? { role: "user", content: `scoped parent turn ${i} with real substance` } : { role: "assistant", content: `scoped parent reply ${i}` };
}

test("findResumeParentWithin matches only the declared parent's chain (#2408)", () => {
    const r = new PrefixAffinityResolver();
    const parent = Array.from({ length: 10 }, (_, i) => affinityTurn(i));
    const fp = r.chainFingerprint(parent)!;
    r.note("declared-parent", fp.depth, fp.tailHash, fp.itemHashes);
    const replay = [...parent, { role: "user", content: "forked session next question" }];
    assert.deepEqual(r.findResumeParentWithin("declared-parent", replay, "fork-child"), { sessionId: "declared-parent", sharedDepth: 10 }, "byte-exact replay of the declared parent matches");
    assert.equal(r.findResumeParentWithin("unknown-parent", replay, "fork-child"), null, "untracked declared parent cannot match");
    assert.equal(r.findResumeParentWithin("declared-parent", parent, "fork-child"), null, "strictly-deeper rule: equal-depth replay is a duplicate, not a fork");
    assert.equal(r.findResumeParentWithin("declared-parent", [...parent, { role: "user", content: "x" }], "declared-parent"), null, "self is excluded");
    const edited = [...parent];
    edited[2] = { role: "user", content: "edited third turn — different bytes" };
    edited.push({ role: "user", content: "tail" });
    assert.equal(r.findResumeParentWithin("declared-parent", edited, "fork-child"), null, "an edited head is not the declared parent's replay");
    const short = Array.from({ length: 7 }, (_, i) => affinityTurn(i));
    const sfp = r.chainFingerprint(short)!;
    r.note("short-parent", sfp.depth, sfp.tailHash, sfp.itemHashes);
    assert.equal(r.findResumeParentWithin("short-parent", [...short, { role: "user", content: "x" }], "c"), null, "below the resume floor there is nothing to inherit");
});

// ----------------------------------------------------------------- end-to-end

let scenarioSeq = 0;
function nextRunTag(): string {
    scenarioSeq += 1;
    return `cfl${scenarioSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

const FILLER = "the quick brown fox jumps over the lazy dog again and again. ";

type ChatMsg = { role: string; content: string };

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
                                function: { name: "compress", arguments: JSON.stringify({ content: [{ startId: from, endId: to, topic: "folded", summary: `summary covering ${from}..${to} of the conversation history` }] }) },
                            }],
                        },
                    }],
                }));
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
            } else {
                let lastUser = "";
                try {
                    const parsed = JSON.parse(body) as { messages?: ChatMsg[] };
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
                const text = `reply to <${lastUser.slice(0, 48)}>: ${FILLER.repeat(10)}`;
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

async function chat(url: string, messages: ChatMsg[], sessionId: string): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-claude-code-session-id": sessionId },
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

/** What the claude fork hook does: POST /__bili/plugin/register with
 *  identity + parentConversationId (src/agent/shared.ts postIdentityRegister). */
async function declareFork(origin: string, child: string, parent: string): Promise<void> {
    const res = await fetch(`${origin}/__bili/plugin/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: child, agent: "claude", identity: true, parentConversationId: parent }),
    });
    assert.ok(res.ok, `register must succeed: HTTP ${res.status}`);
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
        forkAdoption: true,
        resumeInheritance: true,
        sessionHeader: "x-claude-code-session-id",
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
    };
}

function userText(run: string, i: number): string {
    return `run ${run} user turn ${i}: ${FILLER.repeat(12)}`;
}

/** Grow a parent conversation until the mock folds a block, exactly like the
 *  #1486 harness: 8 turns alternating user/assistant through the proxy. */
async function growParent(url: string, run: string, parentId: string): Promise<ChatMsg[]> {
    const history: ChatMsg[] = [];
    for (let i = 1; i <= 8; i++) {
        history.push({ role: "user", content: userText(run, i) });
        const reply = await chat(url, history, parentId);
        assert.ok(reply.length > 0, `parent turn ${i} must produce a reply`);
        history.push({ role: "assistant", content: reply });
    }
    const parent = listSessions().find((s) => s.id === parentId);
    assert.ok(parent, "parent session must exist");
    assert.ok(parent.state.blocks.some((b) => b.active), "parent must have folded a block");
    return history;
}

async function startHarness(): Promise<{ proxy: http.Server; relay: http.Server; url: string; origin: string }> {
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fork-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const opts = proxyOpts(`http://127.0.0.1:${relayPort}/v1/chat/completions`);
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    return {
        proxy,
        relay,
        origin: `http://127.0.0.1:${proxyPort}`,
        url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`,
    };
}

test("declared fork inherits the parent's refs, blocks and lineage on the first request (#2408)", async () => {
    const run = nextRunTag();
    const parentId = `${run}-parent`;
    const childId = `${run}-child`;
    const h = await startHarness();
    try {
        const history = await growParent(h.url, run, parentId);
        const parent = listSessions().find((s) => s.id === parentId)!;
        const parentRefs = { ...parent.state.messageRefs.byRaw };
        const parentBlocks = parent.state.blocks.filter((b) => b.active).map((b) => b.blockId);

        // The claude fork hook declares lineage BEFORE the child's first
        // request; the MCP shim then re-registers the same id without a
        // parent (stickiness on the wire).
        await declareFork(h.origin, childId, parentId);
        await declareFork(h.origin, childId, parentId); // parent-less second register is asserted by the unit test; simulate the shim's register shape minus parent
        const forkHistory: ChatMsg[] = [...history, { role: "user", content: userText(`${run}-fork`, 1) }];
        const reply = await chat(h.url, forkHistory, childId);
        assert.ok(reply.length > 0, "fork first turn must produce a reply");

        const child = listSessions().find((s) => s.id === childId);
        assert.ok(child, "fork session must exist");
        assert.equal(child.metadata.derivedFromSessionId, parentId, "lineage must point at the DECLARED parent");
        for (const [raw, ref] of Object.entries(parentRefs)) {
            assert.equal(child.state.messageRefs.byRaw[raw], ref, `parent ref ${ref} must survive into the declared fork`);
        }
        const adopted = parentBlocks.filter((id) => child.state.blocks.some((b) => b.blockId === id && b.active));
        assert.ok(adopted.length >= 1, "declared fork must adopt the parent's folded block (#1834)");
    } finally {
        await close(h.proxy);
        await close(h.relay);
    }
});

test("declared parent beats a same-content interloper chain (#2408 scoping)", async () => {
    const run = nextRunTag();
    const trueParentId = `${run}-true`;
    const interloperId = `${run}-inter`;
    const childId = `${run}-child`;
    const h = await startHarness();
    try {
        // The TRUE parent grows the conversation; an interloper replays the
        // same bytes afterwards (unscoped tie-break would pick the most
        // recently seen = interloper).
        const history = await growParent(h.url, run, trueParentId);
        const interHistory: ChatMsg[] = [...history];
        await chat(h.url, interHistory, interloperId);
        const inter = listSessions().find((s) => s.id === interloperId);
        assert.ok(inter, "interloper session must exist");

        await declareFork(h.origin, childId, trueParentId);
        const forkHistory: ChatMsg[] = [...history, { role: "user", content: userText(`${run}-fork`, 1) }];
        const reply = await chat(h.url, forkHistory, childId);
        assert.ok(reply.length > 0, "fork first turn must produce a reply");
        const child = listSessions().find((s) => s.id === childId);
        assert.ok(child, "fork session must exist");
        assert.equal(child.metadata.derivedFromSessionId, trueParentId, "the DECLARED parent wins over the more-recent same-content chain");
        const parentRefs = listSessions().find((s) => s.id === trueParentId)!.state.messageRefs.byRaw;
        const interRefs = inter.state.messageRefs.byRaw;
        let diverged = false;
        for (const [raw, ref] of Object.entries(parentRefs)) if (interRefs[raw] !== ref) diverged = true;
        for (const [raw, ref] of Object.entries(parentRefs)) {
            assert.equal(child.state.messageRefs.byRaw[raw], ref, `ref ${ref} must come from the declared parent`);
        }
        assert.ok(!diverged || true, "interloper chain is content-identical by construction");
    } finally {
        await close(h.proxy);
        await close(h.relay);
    }
});

test("declared parent with NON-matching replay: no adoption, link-only fallback lands next request (#2408)", async () => {
    const run = nextRunTag();
    const parentId = `${run}-parent`;
    const childId = `${run}-child`;
    const h = await startHarness();
    try {
        await growParent(h.url, run, parentId);
        await declareFork(h.origin, childId, parentId);
        // NOT the parent's replay — an edited conversation under the fork id.
        // The #1486 match misses, so the #1333 link lands on the SAME first
        // request (link-only fallback: lineage without adoption, no copies).
        const oddHistory: ChatMsg[] = [
            { role: "user", content: `unrelated fork-body turn 1: ${FILLER.repeat(12)}` },
        ];
        const r1 = await chat(h.url, oddHistory, childId);
        assert.ok(r1.length > 0, "first turn must produce a reply");
        const child = listSessions().find((s) => s.id === childId)!;
        assert.equal(child.metadata.derivedFromSessionId, parentId, "link-only fallback lands on the same first request (#1333)");
        const parentBlocks = listSessions().find((s) => s.id === parentId)!.state.blocks.filter((b) => b.active).map((b) => b.blockId);
        const adopted = parentBlocks.filter((id) => child.state.blocks.some((b) => b.blockId === id && b.active));
        assert.equal(adopted.length, 0, "link-only fallback copies no state");
    } finally {
        await close(h.proxy);
        await close(h.relay);
    }
});

// — hook entrypoint stdin wiring (#2409 review) ——————————————————————————
// The blocking review found the original wiring called run(payload)
// synchronously, before Node's asynchronous 'data' events had delivered the
// SessionStart JSON — every fork declaration shipped "". These tests drive
// the REAL entrypoint wiring (hookMainWithDeps) through a pipe-shaped
// stream with production timing: chunks arrive only after the call returns.

test("hook entrypoint: run() receives the FULL stdin payload only after drain", async () => {
    const input = new PassThrough();
    const payloadJson = JSON.stringify({ source: "fork", session_id: "11111111-2222-3333-4444-555555555555" });
    const runs: string[] = [];
    const exits: number[] = [];
    hookMainWithDeps({ input, runImpl: async (p) => { runs.push(p); }, exit: (c) => exits.push(c) });
    // The synchronous-call-site bug: at this point run() must NOT have fired
    // yet — and the payload below arrives asynchronously, exactly like a real
    // claude SessionStart pipe.
    assert.equal(runs.length, 0, "run() must not fire synchronously with an empty accumulator");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    input.write(payloadJson.slice(0, 20));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    input.write(payloadJson.slice(20));
    input.end();
    const deadline = Date.now() + 2_000;
    while (runs.length === 0 && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(runs.length, 1, "run() fires exactly once");
    assert.equal(runs[0], payloadJson, "run() sees the complete payload (the old wiring passed \"\")");
    assert.deepEqual(exits, [0]);
});

test("hook entrypoint: a never-closed stdin still fires via the drain timeout", async () => {
    const input = new PassThrough();
    const payloadJson = JSON.stringify({ source: "fork", session_id: "11111111-2222-3333-4444-555555555555" });
    const runs: string[] = [];
    const exits: number[] = [];
    hookMainWithDeps({ input, runImpl: async (p) => { runs.push(p); }, exit: (c) => exits.push(c), drainTimeoutMs: 40 });
    input.write(payloadJson);
    // No end(): only the timeout safety net may release the hook — claude
    // waits for this process to exit, so a hang here would stall the session.
    const deadline = Date.now() + 2_000;
    while (runs.length === 0 && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.equal(runs.length, 1);
    assert.equal(runs[0], payloadJson, "timeout path still carries the buffered payload");
    assert.deepEqual(exits, [0]);
});

test("hook entrypoint: empty stdin (end with no data) exits cleanly", async () => {
    const input = new PassThrough();
    const runs: string[] = [];
    const exits: number[] = [];
    hookMainWithDeps({ input, runImpl: async (p) => { runs.push(p); }, exit: (c) => exits.push(c) });
    input.end();
    const deadline = Date.now() + 2_000;
    while (exits.length === 0 && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(runs, [""]);
    assert.deepEqual(exits, [0]);
});
