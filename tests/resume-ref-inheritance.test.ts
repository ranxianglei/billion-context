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
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

/**
 * #1486 resume-fork inheritance end-to-end. An identified client (x-acp-
 * session) grows a conversation until proxy-mode compress folds a block;
 * then the client RESUMES under a FRESH session id while replaying the full
 * transcript (what Claude Code --resume does on the wire). The resumed
 * session must inherit the parent's ref assignments — including refs outside
 * the folded block (stale model citations resolve to their ORIGINAL messages
 * instead of mis-hitting renumbered ones) — its fully-present blocks
 * (forkAdoption-gated), and the derivedFrom lineage, with fresh messages
 * numbering above the parent's ref space and the parent left untouched.
 * With resumeInheritance disabled the resume keeps the old behavior: no
 * lineage, no adoption, independent numbering.
 */

let scenarioSeq = 0;
function nextRunTag(): string {
    scenarioSeq += 1;
    return `rinh${scenarioSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    let m: RegExp.ExecArray | null = null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

const FILLER = "the quick brown fox jumps over the lazy dog again and again. ";

function userText(run: string, i: number): string {
    return `run ${run} user turn ${i}: ${FILLER.repeat(12)}`;
}

function relayReply(body: string, n: number): string {
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
                                function: { name: "compress", arguments: JSON.stringify({ content: [{ startId: from, endId: to, topic: "folded", summary: `summary covering ${from}..${to} of the conversation history` }] }) },
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

function proxyOpts(relayUrl: string, flags: { forkAdoption: boolean; resumeInheritance: boolean }): ProxyOptions {
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
        forkAdoption: flags.forkAdoption,
        resumeInheritance: flags.resumeInheritance,
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
}

function maxRefIndex(byRaw: Record<string, string>): number {
    let max = 0;
    for (const ref of Object.values(byRaw)) {
        const m = /^m(\d+)$/.exec(ref);
        if (!m) continue;
        const idx = Number(m[1]);
        if (idx > max) max = idx;
    }
    return max;
}

type ScenarioResult = {
    parentId: string;
    parentRefs: Record<string, string>;
    coveredRawIds: Set<string>;
    parentBlockIds: string[];
    childRefs: Record<string, string>;
    childBlockIds: string[];
    lineage: string | undefined;
    parentUntouched: boolean;
    freshAboveParent: boolean;
    parentMaxRef: number;
    childMaxRef: number;
};

async function runResumeScenario(flags: { forkAdoption: boolean; resumeInheritance: boolean }): Promise<ScenarioResult> {
    const run = nextRunTag();
    const parentId = `${run}-A`;
    const childId = `${run}-B`;
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "resume-inh-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const opts = proxyOpts(`http://127.0.0.1:${relayPort}/v1/chat/completions`, flags);
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
        const coveredRawIds = new Set(activeBlocks.flatMap((b) => b.effectiveMessageIds));
        const parentBlockIds = activeBlocks.map((b) => b.blockId);
        assert.ok(Object.keys(parentRefs).length >= 5, "parent must have assigned refs");
        assert.ok(parentBlockIds.length >= 1, `parent must have folded a block (got ${parentBlockIds.length})`);
        const parentMaxRef = maxRefIndex(parentRefs);
        const parentBlocksBefore = parent.state.blocks.length;

        // RESUME: the same transcript plus one new user message, under a
        // FRESH session id (what cc --resume does on the wire).
        const resumeHistory: ChatMsg[] = [...history, { role: "user", content: userText(`${run}-r`, 1) }];
        const reply1 = await chat(url, resumeHistory, childId);
        assert.ok(reply1.length > 0, "resumed first turn must produce a reply");

        const child = listSessions().find((s) => s.id === childId);
        assert.ok(child, "resumed session must exist");
        const childRefs = { ...child.state.messageRefs.byRaw };
        const childBlockIds = child.state.blocks.map((b) => b.blockId);
        const lineage = child.metadata.derivedFromSessionId as string | undefined;

        // The resumed branch keeps talking. THREE extra turns: after the
        // second one the first resume-turn messages leave the protected
        // recent window and get numbered — above the parent's ref space.
        resumeHistory.push({ role: "assistant", content: reply1 });
        resumeHistory.push({ role: "user", content: userText(`${run}-r`, 2) });
        const reply2 = await chat(url, resumeHistory, childId);
        assert.ok(reply2.length > 0, "resume follow-up must produce a reply");
        resumeHistory.push({ role: "assistant", content: reply2 });
        resumeHistory.push({ role: "user", content: userText(`${run}-r`, 3) });
        const reply3 = await chat(url, resumeHistory, childId);
        assert.ok(reply3.length > 0, "resume third turn must produce a reply");

        return {
            parentId,
            parentRefs,
            coveredRawIds,
            parentBlockIds,
            childRefs,
            childBlockIds,
            lineage,
            parentUntouched: parent.state.blocks.length === parentBlocksBefore && JSON.stringify(parent.state.messageRefs.byRaw) === JSON.stringify(parentRefs),
            freshAboveParent: maxRefIndex(child.state.messageRefs.byRaw) > parentMaxRef && parentMaxRef > 1,
            parentMaxRef,
            childMaxRef: maxRefIndex(child.state.messageRefs.byRaw),
        };
    } finally {
        await close(proxy);
        await close(relay);
    }
}

test("identified resume inherits the parent's refs, blocks and lineage (#1486)", async () => {
    const r = await runResumeScenario({ forkAdoption: true, resumeInheritance: true });

    // Core regression: EVERY parent ref assignment survives into the resumed
    // session — stale citations resolve to their original messages.
    for (const [raw, ref] of Object.entries(r.parentRefs)) {
        assert.equal(r.childRefs[raw], ref, `ref ${ref} for a shared message must be preserved across the resume`);
    }
    // The sharp part: refs OUTSIDE the folded block are inherited too
    // (seedAllRefs — block-covered seeding alone would renumber these).
    const outside = Object.entries(r.parentRefs).filter(([raw, ref]) => !r.coveredRawIds.has(raw) && ref !== "BLOCKED");
    assert.ok(outside.length > 0, "scenario must produce numbered refs outside the folded block");
    for (const [raw, ref] of outside) {
        assert.equal(r.childRefs[raw], ref, `non-block-covered ref ${ref} must survive the resume (seedAllRefs)`);
    }
    assert.equal(r.lineage, r.parentId, "derivedFrom lineage must link to the parent");
    const adopted = r.parentBlockIds.filter((id) => r.childBlockIds.includes(id));
    assert.ok(adopted.length >= 1, `resumed session must adopt the parent's block(s) (parent=${JSON.stringify(r.parentBlockIds)} child=${JSON.stringify(r.childBlockIds)})`);
    assert.ok(r.parentUntouched, "parent session must stay untouched (copy-on-resume)");
    assert.ok(r.freshAboveParent, `fresh refs in the resumed session must number above the parent's ref space (parentMax=${r.parentMaxRef} childMax=${r.childMaxRef})`);
});

test("resumeInheritance disabled keeps the old behavior: no lineage, no adoption (#1486)", async () => {
    const r = await runResumeScenario({ forkAdoption: true, resumeInheritance: false });
    assert.equal(r.lineage, undefined, "no lineage when disabled");
    const adopted = r.parentBlockIds.filter((id) => r.childBlockIds.includes(id));
    assert.equal(adopted.length, 0, "disabled inheritance must not adopt blocks");
    const blockedRaws = Object.entries(r.parentRefs).filter(([, ref]) => ref === "BLOCKED").map(([raw]) => raw);
    if (blockedRaws.length > 0) {
        const fresh = blockedRaws.filter((raw) => /^m\d+$/.test(r.childRefs[raw] ?? ""));
        assert.ok(fresh.length > 0, "messages permanently BLOCKED in the parent get fresh numbers in the disabled child — the divergence this feature removes");
    }
});

test("unrelated history under a new id does not inherit anything (#1486)", async () => {
    const run = nextRunTag();
    const otherId = `${run}-C`;
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "resume-inh-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressed: true };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const opts = proxyOpts(`http://127.0.0.1:${relayPort}/v1/chat/completions`, { forkAdoption: true, resumeInheritance: true });
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;
    try {
        const filler = "an entirely different conversation about mountains and rivers. ";
        const history: ChatMsg[] = [];
        for (let i = 1; i <= 3; i++) {
            history.push({ role: "user", content: `other run ${run} turn ${i}: ${filler.repeat(12)}` });
            const reply = await chat(url, history, otherId);
            assert.ok(reply.length > 0);
            history.push({ role: "assistant", content: reply });
        }
        const sess = listSessions().find((s) => s.id === otherId);
        assert.ok(sess, "unrelated session must exist");
        assert.equal(sess.metadata.derivedFromSessionId, undefined, "no lineage for unrelated history");
        assert.ok(Object.keys(sess.state.messageRefs.byRaw).length >= 3, "unrelated session numbers its own messages");
    } finally {
        await close(proxy);
        await close(relay);
    }
});
