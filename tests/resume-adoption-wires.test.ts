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
import { startChatRelay } from "./e2e/chat-relay.ts";

/**
 * #1853 resume-fork inheritance on the OTHER two wires. The #1486 harness
 * (resume-ref-inheritance.test.ts) proves identified resume-forks inherit
 * refs/blocks/lineage on the openai-chat wire; #1850 made block adoption
 * the default. But fork-adoption's id pass used to skip responses and
 * google entirely (SUPPORTED={openai,anthropic}), so codex-over-responses
 * and gemini clients resuming under a fresh id inherited NOTHING but
 * lineage — every folded original came back on the wire and had to fold
 * again. These scenarios grow a parent to a proxy-mode fold on each wire,
 * then resume under a fresh session id replaying the full transcript, and
 * assert the same inheritance contract as the openai wire: every parent
 * ref survives (stale citations resolve), fully-present blocks are
 * adopted, lineage is recorded, the parent is untouched and fresh refs
 * number above the parent's space. With resumeInheritance disabled the
 * responses resume keeps the old behavior (no lineage, no adoption).
 */

let scenarioSeq = 0;
function nextRunTag(): string {
    scenarioSeq += 1;
    return `rwire${scenarioSeq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function userText(run: string, i: number): string {
    return `run ${run} user turn ${i}: ${FILLER.repeat(12)}`;
}

type RelayState = { upstreamReqs: string[]; compressed: boolean };

/** One-shot compress demand at >= 5 refs (same trigger as the #1486 harness):
 *  fold refIds[1] .. refIds[len-3], once per relay. */
function compressRange(refIds: string[]): { startId: string; endId: string; topic: string; summary: string } {
    const from = refIds[1]!;
    const to = refIds[refIds.length - 3]!;
    return { startId: from, endId: to, topic: "folded", summary: `summary covering ${from}..${to} of the conversation history` };
}

/** Openai-chat SSE upstream: used BEHIND the responses⇄chat bridge for the
 *  responses wire (the bridge translates both directions, including the
 *  compress function-call round-trip — proven by e2e-grow-compress). */
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
                                function: { name: "compress", arguments: JSON.stringify({ content: [compressRange(refIds)] }) },
                            }],
                        },
                    }],
                }));
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }));
            } else {
                let lastUser = "";
                try {
                    const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: unknown }> };
                    for (let i = (parsed.messages ?? []).length - 1; i >= 0; i--) {
                        const msg = parsed.messages![i]!;
                        if (msg.role === "user") {
                            lastUser = typeof msg.content === "string" ? msg.content : "";
                            break;
                        }
                    }
                } catch {
                    /* fall through with empty echo */
                }
                const text = `run reply ${state.upstreamReqs.length} to <${lastUser.slice(0, 48)}>: ${FILLER.repeat(10)}`;
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

type GooglePart = { text?: string; functionCall?: { id?: string; name: string; args?: unknown } };
type GoogleContent = { role: "user" | "model"; parts: GooglePart[] };

/** Gemini native upstream: SSE frames in the real shape, one-shot compress
 *  demand at >= 5 refs (same trigger; shape from e2e-google-compress). */
function startMockGemini(state: RelayState): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            state.upstreamReqs.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const refIds = parseRefIds(body);
            const frame = (parts: GooglePart[], finishReason?: string): string => {
                const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
                if (finishReason) candidate.finishReason = finishReason;
                return sseLine({ candidates: [candidate], modelVersion: "gemini-test" });
            };
            if (!state.compressed && refIds.length >= 5) {
                state.compressed = true;
                res.write(frame([{ functionCall: { id: "fc_compress_1", name: "compress", args: { content: [compressRange(refIds)] } } }]));
                res.write(frame([], "STOP"));
            } else {
                res.write(frame([{ text: `gemini reply ${state.upstreamReqs.length}: ${FILLER.repeat(10)}` }]));
                res.write(frame([], "STOP"));
            }
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

type ResponsesItem = { type: "message"; role: "user" | "assistant"; content: Array<{ type: "input_text" | "output_text"; text: string }> };

function responsesItem(role: "user" | "assistant", text: string): ResponsesItem {
    return { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] };
}

/** Responses-wire client turn (URL points at the proxy; upstream behind the
 *  bridge). Reply text accumulates from response.output_text.delta. */
async function responsesTurn(url: string, history: ResponsesItem[], sessionId?: string): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(sessionId ? { "x-acp-session": sessionId } : {}) },
        body: JSON.stringify({ model: "gpt-test", stream: true, instructions: "resume adoption", input: history }),
    });
    if (!res.ok) assert.fail(`HTTP ${res.status}: ${await res.text()}`);
    let raw = "";
    for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
    let reply = "";
    for (const block of raw.split("\n\n")) {
        let event = "";
        let delta: string | undefined;
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) {
                try {
                    delta = (JSON.parse(line.slice(5).trim()) as { delta?: string }).delta;
                } catch {
                    delta = undefined;
                }
            }
        }
        if (event === "response.output_text.delta" && delta) reply += delta;
    }
    return reply;
}

/** Gemini-wire client turn (URL points at the proxy). Reply accumulates text
 *  parts of the client-visible stream. */
async function googleTurn(url: string, contents: GoogleContent[], sessionId?: string): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(sessionId ? { "x-acp-session": sessionId } : {}) },
        body: JSON.stringify({ contents }),
    });
    if (!res.ok) assert.fail(`HTTP ${res.status}: ${await res.text()}`);
    let raw = "";
    for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
    let reply = "";
    for (const block of raw.split("\n\n")) {
        const line = block.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
            const ev = JSON.parse(line.slice(5).trim()) as { candidates?: Array<{ content?: { parts?: GooglePart[] } }> };
            for (const cand of ev.candidates ?? []) {
                for (const part of cand.content?.parts ?? []) reply += part.text ?? "";
            }
        } catch {
            /* ignore keepalives */
        }
    }
    return reply;
}

function proxyOpts(resumeInheritance: boolean): ProxyOptions {
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
        forkAdoption: false,
        resumeInheritance,
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
};

test("responses wire: identified resume inherits refs, blocks and lineage (#1853)", async () => {
    const run = nextRunTag();
    const parentId = `${run}-A`;
    const childId = `${run}-B`;
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rwire-resp-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const bridge = await startChatRelay({ upstream: `http://127.0.0.1:${relayPort}/v1/chat/completions` });
    const proxy = await startServer(proxyOpts(true));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${bridge.port}/v1/responses`;
    try {
        const history: ResponsesItem[] = [];
        for (let i = 1; i <= 8; i++) {
            history.push(responsesItem("user", userText(run, i)));
            const reply = await responsesTurn(url, history, parentId);
            assert.ok(reply.length > 0, `parent turn ${i} must produce a reply`);
            history.push(responsesItem("assistant", reply));
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

        const resumeHistory: ResponsesItem[] = [...history, responsesItem("user", userText(`${run}-r`, 1))];
        const reply1 = await responsesTurn(url, resumeHistory, childId);
        assert.ok(reply1.length > 0, "resumed first turn must produce a reply");

        const child = listSessions().find((s) => s.id === childId);
        assert.ok(child, "resumed session must exist");
        const childRefs = { ...child.state.messageRefs.byRaw };
        const childBlockIds = child.state.blocks.map((b) => b.blockId);
        const lineage = child.metadata.derivedFromSessionId as string | undefined;

        resumeHistory.push(responsesItem("assistant", reply1));
        resumeHistory.push(responsesItem("user", userText(`${run}-r`, 2)));
        const reply2 = await responsesTurn(url, resumeHistory, childId);
        assert.ok(reply2.length > 0, "resume follow-up must produce a reply");
        resumeHistory.push(responsesItem("assistant", reply2));
        resumeHistory.push(responsesItem("user", userText(`${run}-r`, 3)));
        const reply3 = await responsesTurn(url, resumeHistory, childId);
        assert.ok(reply3.length > 0, "resume third turn must produce a reply");

        for (const [raw, ref] of Object.entries(parentRefs)) {
            assert.equal(childRefs[raw], ref, `ref ${ref} for a shared message must be preserved across the responses resume`);
        }
        const outside = Object.entries(parentRefs).filter(([raw, ref]) => !coveredRawIds.has(raw) && ref !== "BLOCKED");
        assert.ok(outside.length >= 1, "scenario must cover refs outside the folded block");
        for (const parentBlockId of parentBlockIds) {
            assert.ok(childBlockIds.includes(parentBlockId), `block ${parentBlockId} must be adopted into the resumed session`);
        }
        assert.equal(lineage, parentId, "resume must record derivedFromSessionId lineage");
        const parentAfter = listSessions().find((s) => s.id === parentId)!;
        assert.equal(parentAfter.state.blocks.length, parentBlocksBefore, "parent block list must be untouched");
        assert.equal(JSON.stringify(parentAfter.state.messageRefs.byRaw), JSON.stringify(parentRefs), "parent refs must be untouched");
        assert.ok(maxRefIndex(child.state.messageRefs.byRaw) > parentMaxRef && parentMaxRef > 1, "fresh resumed messages must number above the parent's ref space");
    } finally {
        await close(proxy);
        await bridge.close();
        await close(relay);
    }
});

test("responses wire: resumeInheritance disabled keeps the old behavior", async () => {
    const run = nextRunTag();
    const parentId = `${run}-A`;
    const childId = `${run}-B`;
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rwire-resp-off-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const bridge = await startChatRelay({ upstream: `http://127.0.0.1:${relayPort}/v1/chat/completions` });
    const proxy = await startServer(proxyOpts(false));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${bridge.port}/v1/responses`;
    try {
        const history: ResponsesItem[] = [];
        for (let i = 1; i <= 8; i++) {
            history.push(responsesItem("user", userText(run, i)));
            const reply = await responsesTurn(url, history, parentId);
            assert.ok(reply.length > 0, `parent turn ${i} must produce a reply`);
            history.push(responsesItem("assistant", reply));
        }
        const parent = listSessions().find((s) => s.id === parentId)!;
        assert.ok(parent.state.blocks.some((b) => b.active), "parent must have folded a block");

        const resumeHistory: ResponsesItem[] = [...history, responsesItem("user", userText(`${run}-r`, 1))];
        const reply1 = await responsesTurn(url, resumeHistory, childId);
        assert.ok(reply1.length > 0, "resumed first turn must produce a reply");

        const child = listSessions().find((s) => s.id === childId)!;
        assert.equal(child.metadata.derivedFromSessionId, undefined, "no lineage when resumeInheritance is disabled");
        assert.equal(child.state.blocks.length, 0, "no block adoption when resumeInheritance is disabled (relay demand is one-shot, a fresh session cannot fold)");
    } finally {
        await close(proxy);
        await bridge.close();
        await close(relay);
    }
});

test("google wire: identified resume inherits refs, blocks and lineage (#1853)", async () => {
    const run = nextRunTag();
    const parentId = `${run}-A`;
    const childId = `${run}-B`;
    process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rwire-goog-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const upstream = startMockGemini(state);
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(true));
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`;
    try {
        const contents: GoogleContent[] = [];
        for (let i = 1; i <= 8; i++) {
            contents.push({ role: "user", parts: [{ text: userText(run, i) }] });
            const reply = await googleTurn(url, contents, parentId);
            assert.ok(reply.length > 0, `parent turn ${i} must produce a reply`);
            contents.push({ role: "model", parts: [{ text: reply }] });
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

        const resumeContents: GoogleContent[] = [...contents, { role: "user", parts: [{ text: userText(`${run}-r`, 1) }] }];
        const reply1 = await googleTurn(url, resumeContents, childId);
        assert.ok(reply1.length > 0, "resumed first turn must produce a reply");

        const child = listSessions().find((s) => s.id === childId);
        assert.ok(child, "resumed session must exist");
        const childRefs = { ...child.state.messageRefs.byRaw };
        const childBlockIds = child.state.blocks.map((b) => b.blockId);
        const lineage = child.metadata.derivedFromSessionId as string | undefined;

        resumeContents.push({ role: "model", parts: [{ text: reply1 }] });
        resumeContents.push({ role: "user", parts: [{ text: userText(`${run}-r`, 2) }] });
        const reply2 = await googleTurn(url, resumeContents, childId);
        assert.ok(reply2.length > 0, "resume follow-up must produce a reply");
        resumeContents.push({ role: "model", parts: [{ text: reply2 }] });
        resumeContents.push({ role: "user", parts: [{ text: userText(`${run}-r`, 3) }] });
        const reply3 = await googleTurn(url, resumeContents, childId);
        assert.ok(reply3.length > 0, "resume third turn must produce a reply");

        for (const [raw, ref] of Object.entries(parentRefs)) {
            assert.equal(childRefs[raw], ref, `ref ${ref} for a shared message must be preserved across the google resume`);
        }
        const outside = Object.entries(parentRefs).filter(([raw, ref]) => !coveredRawIds.has(raw) && ref !== "BLOCKED");
        assert.ok(outside.length >= 1, "scenario must cover refs outside the folded block");
        for (const parentBlockId of parentBlockIds) {
            assert.ok(childBlockIds.includes(parentBlockId), `block ${parentBlockId} must be adopted into the resumed session`);
        }
        assert.equal(lineage, parentId, "resume must record derivedFromSessionId lineage");
        const parentAfter = listSessions().find((s) => s.id === parentId)!;
        assert.equal(parentAfter.state.blocks.length, parentBlocksBefore, "parent block list must be untouched");
        assert.equal(JSON.stringify(parentAfter.state.messageRefs.byRaw), JSON.stringify(parentRefs), "parent refs must be untouched");
        assert.ok(maxRefIndex(child.state.messageRefs.byRaw) > parentMaxRef && parentMaxRef > 1, "fresh resumed messages must number above the parent's ref space");
    } finally {
        await close(proxy);
        await close(upstream);
    }
});
