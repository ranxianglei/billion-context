import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { startChatRelay } from "./e2e/chat-relay.ts";

// Hermetic state dirs before any scenario boots a proxy (#2806 review): these
// anonymous-fork scenarios reattach through prefix-affinity.json, and without
// isolation every chain accumulated in the shared default state dir by sibling
// test files (and prior runs) hydrates into this process while those writers
// keep churning the same file underneath — cross-writer interference that
// flipped the fork/anchor assertions on CI once the suite grew heavier. Same
// idiom as tests/prefix-affinity-orphan.test.ts (#2719) and
// tests/abort-rewind-cache-seam.test.ts (#1613).
const hermeticRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bc-2806-forkwires-"));
for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = hermeticRoot;
test.after(() => fs.rmSync(hermeticRoot, { recursive: true, force: true }));

/**
 * #629 anonymous fork block-adoption, per wire. fork-adoption.test.ts proves
 * the whole lane (grow → proxy fold → mid-list edit → fork mint → seeded
 * refs + adopted blocks + untouched parent) on the openai chat wire only.
 * The mint itself is protocol-neutral (prefix-affinity on converted cores),
 * but identity extraction and the tool protocol are per-wire call sites
 * (src/server/handle.ts, src/loop/adapters) — correct-in-one-lane is not
 * correct-in-all (#377, the #2658 lesson). resume-adoption-wires.test.ts
 * covers the IDENTIFIED resume twin on responses/google; this file covers
 * the ANONYMOUS fork twin on anthropic/responses/google.
 *
 * responses rides the responses⇄chat bridge (startChatRelay, round-trips
 * the compress function-call, proven in e2e-grow-compress); anthropic and
 * google ride native mock upstreams that demand compress once (shape from
 * cache-friendly-proxy.test.ts / e2e-google-compress).
 */

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

const COMPRESS_SUMMARY = "session summary of folded early turns: numbered questions, filler answers; no decisions made.";

type RelayState = { upstreamReqs: string[]; compressed: boolean };

/** chat-wire mock upstream: one-shot compress tool_calls demand at >= 5 refs
 *  (shared by the chat proof and the responses bridge). */
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
                const args = JSON.stringify({ content: [{ startId: refIds[1]!, endId: refIds[refIds.length - 3]!, summary: COMPRESS_SUMMARY }] });
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_compress_1", type: "function", function: { name: "compress", arguments: args } }] } }] }));
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 500, completion_tokens: 50 } }));
            } else {
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

type AnthropicBlock = { type: "text"; text: string };
type AnthropicMsg = { role: "user" | "assistant"; content: AnthropicBlock[] };

/** anthropic native mock upstream: one-shot compress tool_use demand
 *  (SSE shape from cache-friendly-proxy.test.ts). */
function startMockAnthropic(state: RelayState): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            state.upstreamReqs.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const ev = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
            const idx = state.upstreamReqs.length;
            const refIds = parseRefIds(body);
            ev("message_start", { type: "message_start", message: { id: `msg_a_${idx}`, role: "assistant", usage: { input_tokens: 100 } } });
            if (!state.compressed && refIds.length >= 5) {
                state.compressed = true;
                const args = JSON.stringify({ content: [{ startId: refIds[1]!, endId: refIds[refIds.length - 3]!, summary: COMPRESS_SUMMARY }] });
                ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_cmp_1", name: "compress", input: {} } });
                ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(0, 20) } });
                ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(20) } });
                ev("content_block_stop", { type: "content_block_stop", index: 0 });
                ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } });
            } else {
                const text = `anthropic reply ${idx}: ${FILLER.repeat(10)}`;
                ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
                ev("content_block_stop", { type: "content_block_stop", index: 0 });
                ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
            }
            ev("message_stop", { type: "message_stop" });
            res.end();
        });
    });
    server.listen(0, "127.0.0.1");
    return server;
}

type GooglePart = { text?: string };
type GoogleContent = { role: "user" | "model"; parts: GooglePart[] };

/** Gemini native mock upstream (shape from resume-adoption-wires.test.ts). */
function startMockGemini(state: RelayState): http.Server {
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            state.upstreamReqs.push(body);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const refIds = parseRefIds(body);
            const frame = (parts: Array<Record<string, unknown>>, finishReason?: string): void => {
                const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
                if (finishReason) candidate.finishReason = finishReason;
                res.write(sseLine({ candidates: [candidate], modelVersion: "gemini-test" }));
            };
            if (!state.compressed && refIds.length >= 5) {
                state.compressed = true;
                frame([{ functionCall: { id: "fc_compress_1", name: "compress", args: { content: [{ startId: refIds[1]!, endId: refIds[refIds.length - 3]!, summary: COMPRESS_SUMMARY }] } } }]);
                frame([], "STOP");
            } else {
                frame([{ text: `gemini reply ${state.upstreamReqs.length}: ${FILLER.repeat(10)}` }]);
                frame([], "STOP");
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

async function anthropicTurn(url: string, messages: AnthropicMsg[]): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-test", stream: true, max_tokens: 1024, messages }),
    });
    if (!res.ok) assert.fail(`HTTP ${res.status}: ${await res.text()}`);
    let raw = "";
    for await (const chunk of res.body!) raw += Buffer.from(chunk).toString("utf8");
    let reply = "";
    let event = "";
    for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) {
            event = line.slice(6).trim();
            continue;
        }
        if (!line.startsWith("data:")) continue;
        let delta: string | undefined;
        try {
            delta = (JSON.parse(line.slice(5).trim()) as { delta?: { text?: string } }).delta?.text;
        } catch {
            delta = undefined;
        }
        if (event === "content_block_delta" && delta) reply += delta;
    }
    return reply;
}

async function responsesTurn(url: string, history: ResponsesItem[]): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", stream: true, instructions: "fork adoption wires", input: history }),
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

async function googleTurn(url: string, contents: GoogleContent[]): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
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

function proxyOpts(forkAdoption: boolean): ProxyOptions {
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
        forkAdoption,
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

type WireDriver<M> = {
    name: string;
    setup: () => Promise<{ url: string; cleanup: () => Promise<void> }>;
    send: (url: string, history: M[]) => Promise<string>;
    user: (text: string) => M;
    assistant: (text: string) => M;
    edited: (m: M) => M;
};

function anthropicDriver(): WireDriver<AnthropicMsg> {
    return {
        name: "anthropic",
        setup: async () => {
            const state: RelayState = { upstreamReqs: [], compressed: false };
            const upstream = startMockAnthropic(state);
            await listen(upstream);
            const port = (upstream.address() as { port: number }).port;
            const proxy = await startServer(proxyOpts(true));
            await listen(proxy);
            const proxyPort = (proxy.address() as { port: number }).port;
            return {
                url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${port}/v1/messages`,
                cleanup: async () => {
                    await close(proxy);
                    await close(upstream);
                },
            };
        },
        send: (url, history) => anthropicTurn(url, history),
        user: (text) => ({ role: "user", content: [{ type: "text", text }] }),
        assistant: (text) => ({ role: "assistant", content: [{ type: "text", text }] }),
        edited: (m) => ({ role: m.role, content: [{ type: "text", text: `${m.content[0]!.text} (edited branch)` }] }),
    };
}

function responsesDriver(): WireDriver<ResponsesItem> {
    return {
        name: "responses",
        setup: async () => {
            const state: RelayState = { upstreamReqs: [], compressed: false };
            const relay = startMockUpstream(state);
            await listen(relay);
            const relayPort = (relay.address() as { port: number }).port;
            const bridge = await startChatRelay({ upstream: `http://127.0.0.1:${relayPort}/v1/chat/completions` });
            const proxy = await startServer(proxyOpts(true));
            await listen(proxy);
            const proxyPort = (proxy.address() as { port: number }).port;
            return {
                url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${bridge.port}/v1/responses`,
                cleanup: async () => {
                    await close(proxy);
                    await bridge.close();
                    await close(relay);
                },
            };
        },
        send: (url, history) => responsesTurn(url, history),
        user: (text) => responsesItem("user", text),
        assistant: (text) => responsesItem("assistant", text),
        edited: (m) => responsesItem(m.role, `${m.content[0]!.text} (edited branch)`),
    };
}

function googleDriver(): WireDriver<GoogleContent> {
    return {
        name: "google",
        setup: async () => {
            const state: RelayState = { upstreamReqs: [], compressed: false };
            const upstream = startMockGemini(state);
            await listen(upstream);
            const port = (upstream.address() as { port: number }).port;
            const proxy = await startServer(proxyOpts(true));
            await listen(proxy);
            const proxyPort = (proxy.address() as { port: number }).port;
            return {
                url: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${port}/v1beta/models/gemini-test:streamGenerateContent?alt=sse`,
                cleanup: async () => {
                    await close(proxy);
                    await close(upstream);
                },
            };
        },
        send: (url, history) => googleTurn(url, history),
        user: (text) => ({ role: "user", parts: [{ text }] }),
        assistant: (text) => ({ role: "model", parts: [{ text }] }),
        edited: (m) => ({ role: m.role, parts: [{ text: `${m.parts[0]!.text} (edited branch)"` }] }),
    };
}

/** Same lane as fork-adoption.test.ts's runForkScenario, generic over the
 *  wire: 8 anonymous full-replay turns → one session + one folded block →
 *  mid-list edit AFTER the folded span → fork mint → adoption assertions →
 *  follow-up reconcile → parent untouched. */
async function runForkScenario<M>(driver: WireDriver<M>): Promise<{ parentBlockIds: string[]; childBlockIds: string[]; childBlocks: number; childContents: number; lineage: string | undefined }> {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const rig = await driver.setup();
    const preExisting = new Set(listSessions().map((s) => s.id));
    const newSessions = () => listSessions().filter((s) => !preExisting.has(s.id));
    try {
        const history: M[] = [];
        for (let i = 1; i <= 8; i++) {
            history.push(driver.user(userText(run, i)));
            const reply = await driver.send(rig.url, history);
            assert.ok(reply.length > 0, `${driver.name} turn ${i} must produce a reply`);
            history.push(driver.assistant(reply));
        }

        const sessionsBefore = newSessions();
        assert.equal(sessionsBefore.length, 1, `one anonymous ${driver.name} session so far`);
        const parent = sessionsBefore[0]!;
        const parentBlocks = parent.state.blocks.filter((b) => b.active).length;
        assert.ok(parentBlocks >= 1, `${driver.name} parent must have a folded block (got ${parentBlocks})`);
        const parentIdCount = parent.state.blocks.length;

        // The edit sits AFTER the compressed span (same EDIT_AT=8 as the chat
        // proof) so the block is fully present in the forked request.
        const EDIT_AT = 8;
        const forkHistory = history.map((m, i) => (i === EDIT_AT ? driver.edited(m) : m));
        const forkReply = await driver.send(rig.url, forkHistory);
        assert.ok(forkReply.length > 0, `${driver.name} fork turn must produce a reply`);

        const after = newSessions();
        assert.equal(after.length, 2, `${driver.name} fork must create a second session`);
        const child = after.find((s) => s.id !== parent.id)!;
        const snapshot = {
            parentBlockIds: parent.state.blocks.filter((b) => b.active).map((b) => b.blockId),
            childBlockIds: child.state.blocks.filter((b) => b.active).map((b) => b.blockId),
            childBlocks: child.state.blocks.filter((b) => b.active).length,
            childContents: child.state.blocks.filter((b) => child.blockContents.has(b.blockId)).length,
            lineage: (child.metadata.anonymousPrefixAffinity as { lineage?: { reason?: string } } | undefined)?.lineage?.reason,
        };
        assert.equal(snapshot.lineage, "forked", `${driver.name} child lineage must record the fork`);

        for (const b of child.state.blocks.filter((x) => x.active)) {
            for (const raw of b.effectiveMessageIds) {
                const parentRef = parent.state.messageRefs.byRaw[raw];
                assert.ok(parentRef, `${driver.name} parent must hold a ref for adopted id (${b.blockId})`);
                assert.equal(child.state.messageRefs.byRaw[raw], parentRef, `${driver.name} child ref for ${raw} must equal the parent's seeded ref`);
            }
        }
        assert.ok(child.state.nextBlockId >= parent.state.nextBlockId, `${driver.name} child block-id cursor must not fall behind the parent's`);
        assert.ok(child.state.nextRunId >= parent.state.nextRunId, `${driver.name} child run-id cursor must not fall behind the parent's`);

        forkHistory.push(driver.assistant(forkReply));
        forkHistory.push(driver.user(userText(run, 9)));
        const followUp = await driver.send(rig.url, forkHistory);
        assert.ok(followUp.length > 0, `${driver.name} fork follow-up must produce a reply`);

        assert.equal(parent.state.blocks.length, parentIdCount, `${driver.name} parent blocks must be untouched (copy-on-fork)`);
        return snapshot;
    } finally {
        await rig.cleanup();
    }
}

test("anonymous fork adopts the parent's compression blocks on the anthropic wire (#629)", { timeout: 120_000 }, async () => {
    const result = await runForkScenario(anthropicDriver());
    assert.ok(result.childBlocks >= 1, `anthropic fork must adopt the parent block (got ${result.childBlocks})`);
    assert.equal(result.childContents, result.childBlocks, "adopted blocks must carry their summaries");
    const adopted = result.parentBlockIds.filter((id) => result.childBlockIds.includes(id));
    assert.ok(adopted.length >= 1, `anthropic child must carry the parent's block id (parent=${JSON.stringify(result.parentBlockIds)} child=${JSON.stringify(result.childBlockIds)})`);
});

test("anonymous fork adopts the parent's compression blocks on the responses wire (#629)", { timeout: 120_000 }, async () => {
    const result = await runForkScenario(responsesDriver());
    assert.ok(result.childBlocks >= 1, `responses fork must adopt the parent block (got ${result.childBlocks})`);
    assert.equal(result.childContents, result.childBlocks, "adopted blocks must carry their summaries");
    const adopted = result.parentBlockIds.filter((id) => result.childBlockIds.includes(id));
    assert.ok(adopted.length >= 1, `responses child must carry the parent's block id (parent=${JSON.stringify(result.parentBlockIds)} child=${JSON.stringify(result.childBlockIds)})`);
});

test("anonymous fork adopts the parent's compression blocks on the google wire (#629)", { timeout: 120_000 }, async () => {
    const result = await runForkScenario(googleDriver());
    assert.ok(result.childBlocks >= 1, `google fork must adopt the parent block (got ${result.childBlocks})`);
    assert.equal(result.childContents, result.childBlocks, "adopted blocks must carry their summaries");
    const adopted = result.parentBlockIds.filter((id) => result.childBlockIds.includes(id));
    assert.ok(adopted.length >= 1, `google child must carry the parent's block id (parent=${JSON.stringify(result.parentBlockIds)} child=${JSON.stringify(result.childBlockIds)})`);
});

/** The flag gates per wire too — one control (responses, cheapest bridge)
 *  mirrors fork-adoption.test.ts's off test. */
test("forkAdoption disabled leaves the responses fork at zero compression state", { timeout: 120_000 }, async () => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    // Sibling scenarios above leave adopted forked children in the process-wide
    // session table (#2806 review): the assertion below scans EVERY forked
    // session, so reset the table to this scenario's scope — same idiom as
    // fork-side-request-lane.test.ts / issue2407-google-khat-lane.test.ts.
    _resetSessionsForTest();
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await listen(relay);
    const relayPort = (relay.address() as { port: number }).port;
    const bridge = await startChatRelay({ upstream: `http://127.0.0.1:${relayPort}/v1/chat/completions` });
    const opts = { ...proxyOpts(false) };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${bridge.port}/v1/responses`;
    try {
        const history: ResponsesItem[] = [];
        for (let i = 1; i <= 8; i++) {
            history.push(responsesItem("user", userText(run, i)));
            const reply = await responsesTurn(url, history);
            assert.ok(reply.length > 0, `turn ${i} must produce a reply`);
            history.push(responsesItem("assistant", reply));
        }
        const EDIT_AT = 8;
        const forkHistory = history.map((m, i) => (i === EDIT_AT ? responsesItem(m.role, `${m.content[0]!.text} (edited branch)`) : m));
        const forkReply = await responsesTurn(url, forkHistory);
        assert.ok(forkReply.length > 0, "fork turn must produce a reply");
        const parentSessions = listSessions().filter((s) => s.state.blocks.some((b) => b.active));
        assert.ok(parentSessions.length >= 1, "parent session folded");
        const forkSessions = listSessions().filter((s) => (s.metadata.anonymousPrefixAffinity as { lineage?: { reason?: string } } | undefined)?.lineage?.reason === "forked");
        assert.ok(forkSessions.length >= 1, "fork lineage recorded");
        for (const child of forkSessions) {
            assert.equal(child.state.blocks.length, 0, "disabled adoption must not seed blocks on the responses fork");
            assert.equal(child.state.blocks.filter((b) => child.blockContents.has(b.blockId)).length, 0, "disabled adoption must not seed summaries");
        }
    } finally {
        await close(proxy);
        await bridge.close();
        await close(relay);
    }
});
