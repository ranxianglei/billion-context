import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { listSessions } from "../src/session.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { setLogCapture } from "../src/logger.ts";

process.env.NODE_ENV = "test";

/**
 * #2265 proxy-level e2e: a Trae-style anonymous client switches models
 * mid-conversation, and the switch rewrites the replayed history on the wire —
 * EVERY assistant message gets re-stamped with the new model tag (a pervasive
 * decorative rewrite; the exact bytes change, the content stays the same), and
 * a couple of user messages grow <system-reminder> wrappers around words that
 * are themselves untouched. Byte-exact prefix matching dies at the first
 * re-stamped position; without recovery the proxy mints a fresh session and
 * the whole 900k-token re-fold loop from the issue begins.
 *
 * The simhash chain-alignment rung must: re-attach the existing session
 * (compression state preserved, no second session), log the adoption, and —
 * because the rewritten bytes become the client's new canon — self-heal back
 * to the exact-prefix fast path on the NEXT request (no second adoption).
 */

const FILLER = "filler prose that pads the reply so the item has enough tokens for a stable simhash signature even after a small decorative rewrite ";

function userText(run: string, i: number): string {
    return `question ${i} of ${run}: tell me about topic ${i % 6} in detail please with a numbered list — ${FILLER.repeat(12)}`;
}

function relayReply(n: number, lastUser: string): string {
    return `answer ${n} to <${lastUser.slice(0, 40)}>: ${FILLER.repeat(4)}`;
}

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

function sseLine(obj: unknown): string {
    return `data: ${JSON.stringify(obj)}\n\n`;
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
                res.write(
                    sseLine({
                        id: "c1",
                        object: "chat.completion.chunk",
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    role: "assistant",
                                    content: null,
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "call_compress_1",
                                            type: "function",
                                            function: {
                                                name: "compress",
                                                arguments: JSON.stringify({
                                                    content: [
                                                        {
                                                            startId: from,
                                                            endId: to,
                                                            topic: "model restamp fixture",
                                                            summary: `folded early turns of the model-restamp e2e fixture: the user asked numbered questions about several topics, the assistant answered with padded prose, and several exchanges accumulated before folding. No decisions were made. Range ${from}..${to}.`,
                                                        },
                                                    ],
                                                }),
                                            },
                                        },
                                    ],
                                },
                            },
                        ],
                    }),
                );
                res.write(sseLine({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 500, completion_tokens: 2 } }));
            } else {
                const msgs = JSON.parse(body).messages as Array<{ role: string; content: string }>;
                const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
                const text = relayReply(state.upstreamReqs.length, lastUser);
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

async function chat(url: string, messages: ChatMsg[]): Promise<string> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
}

test("proxy e2e: model-switch history re-stamp re-attaches the anonymous session and self-heals (#2265)", async () => {
    const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const state: RelayState = { upstreamReqs: [], compressed: false };
    const relay = startMockUpstream(state);
    await once(relay, "listening");
    const relayPort = (relay.address() as { port: number }).port;
    const proxy = await startServer(proxyOpts(`http://127.0.0.1:${relayPort}/v1/chat/completions`));
    if (!proxy.listening) await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`;

    const logs: string[] = [];
    setLogCapture((level, msg) => logs.push(`${level} ${msg}`));

    const preExisting = new Set(listSessions().map((s) => s.id));
    const newSessions = () => listSessions().filter((s) => !preExisting.has(s.id));

    try {
        // Phase 1 — grow the conversation on model A. The client replays the
        // full history every turn; the relay folds once it sees enough refs.
        const history: ChatMsg[] = [];
        for (let i = 1; i <= 8; i++) {
            history.push({ role: "user", content: userText(run, i) });
            const reply = await chat(url, history);
            assert.ok(reply.length > 0, `turn ${i} must produce a reply`);
            history.push({ role: "assistant", content: reply });
        }
        assert.equal(state.compressed, true, "relay must have folded the grown history once");
        assert.equal(newSessions().length, 1, "one anonymous session before the switch");
        const session = newSessions()[0]!;
        const blocksBefore = session.state.blocks.filter((b) => b.active).length;
        assert.ok(blocksBefore >= 1, `session must hold a folded block (got ${blocksBefore})`);
        const sessionIdBefore = session.id;

        // Phase 2 — model switch. Trae re-stamps EVERY stored assistant
        // message with the new model tag (decorative, pervasive) and wraps a
        // couple of user messages in <system-reminder> (words untouched).
        const restamped = history.map((m, i) => {
            if (m.role === "assistant") return { role: m.role, content: `[via model:glm-5.3] ${m.content}` };
            if (i === 2 || i === 6) return { role: m.role, content: `<system-reminder>attachment refreshed</system-reminder>${m.content}` };
            return m;
        });
        restamped.push({ role: "user", content: userText(run, 9) });
        const reply9 = await chat(url, restamped);
        assert.ok(reply9.length > 0, "post-switch turn must produce a reply");

        assert.equal(newSessions().length, 1, "the re-stamped request must NOT mint a second session");
        assert.equal(newSessions()[0]!.id, sessionIdBefore, "the existing anonymous session must be re-attached");
        const blocksAfter = newSessions()[0]!.state.blocks.filter((b) => b.active).length;
        assert.equal(blocksAfter, blocksBefore, "compression state must be preserved across the re-stamp");
        const adoptions = logs.filter((l) => l.includes("re-attached via simhash alignment"));
        assert.equal(adoptions.length, 1, `exactly one simhash adoption must be logged (got ${adoptions.length}: ${logs.filter((l) => l.includes("prefix-affinity")).join(" | ")})`);

        // Phase 3 — self-heal. The re-stamped bytes are the client's canon
        // now; the next full replay must resolve through the exact-prefix
        // fast path again (same session, NO second adoption log).
        restamped.push({ role: "assistant", content: reply9 });
        restamped.push({ role: "user", content: userText(run, 10) });
        const reply10 = await chat(url, restamped);
        assert.ok(reply10.length > 0, "post-heal turn must produce a reply");
        assert.equal(newSessions().length, 1, "still exactly one session after self-heal");
        assert.equal(newSessions()[0]!.id, sessionIdBefore, "still the same session after self-heal");
        assert.equal(logs.filter((l) => l.includes("re-attached via simhash alignment")).length, 1, "the healed request must ride the exact-prefix fast path, not a second adoption");
    } finally {
        setLogCapture(null);
        proxy.close();
        proxy.closeIdleConnections?.();
        relay.close();
        relay.closeIdleConnections?.();
        await Promise.allSettled([once(proxy, "close"), once(relay, "close")]);
    }
});
