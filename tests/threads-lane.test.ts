// [#2926] anthropic Threads lane — mirror capture, budget reforge, fail-open.
//
// Threads state lives server-side; a `continue` wire body is delta-only no
// matter how big the thread grew. The lane mirrors every turn into the
// unified store (session_ext threads:mirror:*) and, when the mirror crosses
// the window on a continue (rollout anthropicThreadsReforge on), swaps that
// continue for a fresh `create` carrying [summary, tail ring, delta] — the
// only channel that can deliver a fold to a server-side thread.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { startServer, type ProxyOptions } from "../src/server.js";
import { defaultConfig } from "acp-kernel";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _resetSessionsForTest } from "../src/session.js";
import { _resetPluginStateForTest } from "../src/plugin.js";
import { resetToolRingForTest } from "../src/tool-ring.js";
import { __resetThreadsLaneForTests, type ThreadsMirrorMeta } from "../src/server/threads-lane.js";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "bili-threads-lane-"));

const ev = (type: string, data: unknown): string => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const messageStart = (id: string) => ev("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900, output_tokens: 1 } } });
const blockStart = (index: number) => ev("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
const blockDelta = (index: number, text: string) => ev("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } });
const blockStop = (index: number) => ev("content_block_stop", { type: "content_block_stop", index });
const messageDelta = () => ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 900, output_tokens: 3 } });
const messageStop = ev("message_stop", { type: "message_stop" });

const sseReply = (res: http.ServerResponse, id: string, text: string): void => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([messageStart(id), blockStart(0), blockDelta(0, text), blockStop(0), messageDelta(), messageStop].join(""));
};

interface HarnessOpts {
    window?: number;
    /** First non-stream (summary side-call) request fails. */
    failFirstSideCall?: boolean;
    /** Status the failed first side-call answers with (default 500). */
    sideCallFailStatus?: number;
}

interface Harness {
    proxyUrl: string;
    post: (body: Record<string, unknown>, sid?: string) => Promise<{ status: number; body: unknown }>;
    forwarded: Record<string, unknown>[];
    forwardedPaths: string[];
    readMirror: (sid: string) => { meta?: ThreadsMirrorMeta; error?: string };
    close: () => Promise<void>;
}

async function harness(storageMode: "full" | "legacy", opts: HarnessOpts = {}): Promise<Harness> {
    const dir = mkdtempSync(join(testRoot, "run-"));
    for (const key of ["XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = dir;
    process.env.BILI_STORAGE_UNIFIED = storageMode === "full" ? "full" : "legacy";
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    __resetThreadsLaneForTests();
    const store = new SessionStore({ debounceMs: 60000, enabled: true });
    _setStoreForTest(store);
    const forwarded: Record<string, unknown>[] = [];
    const forwardedPaths: string[] = [];
    let sideCalls = 0;
    const upstream = http.createServer((req, res) => {
        const urlPath = (req.url ?? "/").split("?")[0];
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwardedPaths.push(urlPath);
            // Strict mode (#3617-B): production anthropic 404s unknown paths.
            // This fake used to answer 200 for ANY url — that is exactly what
            // let #3569 (side-call on the bare origin) ship green. A wrong
            // path now lands as a real 404 and fails the dependent asserts.
            if (urlPath !== "/v1/messages") {
                res.writeHead(404, { "content-type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `no such route ${urlPath}` } }));
                return;
            }
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            forwarded.push(body);
            const stream = body.stream === true;
            const isSideCall = !stream && body.thread === undefined;
            if (isSideCall) sideCalls++;
            if (isSideCall && opts.failFirstSideCall && sideCalls === 1) {
                const status = opts.sideCallFailStatus ?? 500;
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: status === 404 ? "not_found_error" : "api_error", message: "boom" } }));
                return;
            }
            if (stream) {
                sseReply(res, `msg_${forwarded.length}`, "answer " + forwarded.length);
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: `msg_${forwarded.length}`, role: "assistant", content: [{ type: "text", text: "SUMMARY-" + sideCalls }], usage: { input_tokens: 100, output_tokens: 10 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const window = opts.window ?? 400000;
    const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "claude-test": { context: window } } } }, modelContextLimit: window, kernelConfig: defaultConfig(window), compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
    if (!(proxy as unknown as { listening?: boolean }).listening) await once(proxy, "listening");
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const post = async (body: Record<string, unknown>, sid = "threads-1") => {
        const response = await fetch(`${proxyUrl}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01", "x-acp-session": sid }, body: JSON.stringify(body) });
        const text = await response.text();
        let parsed: unknown = text;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = text;
        }
        return { status: response.status, body: parsed };
    };
    const readMirror = (sid: string): { meta?: ThreadsMirrorMeta; error?: string } => {
        try {
            const meta = store.getSessionExt(sid, "threads:mirror:meta");
            return { meta: meta as ThreadsMirrorMeta | undefined };
        } catch (err) {
            return { error: String(err) };
        }
    };
    return {
        proxyUrl,
        post,
        forwarded,
        forwardedPaths,
        readMirror,
        close: async () => {
            await new Promise<void>((resolve) => proxy.close(() => resolve()));
            store.closeQuietly();
            __resetThreadsLaneForTests();
            await new Promise<void>((resolve) => upstream.close(() => resolve()));
        },
    };
}

function join(...parts: string[]): string {
    return path.join(...parts);
}

const CLIENT_SYSTEM = [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }];
const CLIENT_TOOLS = [{ name: "Bash", description: "Executes a given bash command.", input_schema: { type: "object", properties: {}, required: [] } }];

const createBody = (messages: { role: string; content: string }[]): Record<string, unknown> => ({
    model: "claude-test",
    stream: true,
    max_tokens: 1024,
    system: CLIENT_SYSTEM,
    tools: CLIENT_TOOLS,
    thread: { type: "create" },
    messages,
});

const continueBody = (messages: { role: string; content: string }[], prev: string): Record<string, unknown> => ({
    model: "claude-test",
    stream: true,
    max_tokens: 1024,
    system: CLIENT_SYSTEM,
    tools: CLIENT_TOOLS,
    thread: { type: "continue", previous_message_id: prev },
    messages,
});

const turnText = (n: number, reps = 213): string => `turn payload ${n} `.repeat(reps); // reps 213 ≈ 800 tok, reps 400 ≈ 1500 tok

test("threads lane: create and continue pass through byte-faithfully while the mirror accumulates", async () => {
    const h = await harness("full");
    try {
        const create = createBody([{ role: "user", content: turnText(1) }, { role: "assistant", content: "answer 1" }]);
        const r1 = await h.post(create);
        assert.equal(r1.status, 200);
        assert.equal((h.forwarded[0] as { thread?: { type?: string } }).thread?.type, "create");
        assert.deepEqual((h.forwarded[0] as { system?: unknown }).system, CLIENT_SYSTEM, "create system forwarded verbatim");
        assert.equal((h.forwarded[0] as { messages?: unknown[] }).messages?.length, 2, "no history rewrite on the threads wire");
        const r2 = await h.post(continueBody([{ role: "user", content: turnText(2) }], "msg_1"));
        assert.equal(r2.status, 200);
        assert.equal((h.forwarded[1] as { thread?: { type?: string } }).thread?.type, "continue");
        assert.equal((h.forwarded[1] as { messages?: unknown[] }).messages?.length, 1, "continue delta forwarded as-is");
        const mirror = h.readMirror("threads-1");
        assert.ok(mirror.meta, "mirror meta persisted");
        assert.equal(mirror.meta?.count, 3, "create(2) + continue delta(1)");
        assert.deepEqual(mirror.meta?.shape?.system, CLIENT_SYSTEM, "create shape captured");
        assert.deepEqual(mirror.meta?.shape?.tools, CLIENT_TOOLS);
    } finally {
        await h.close();
    }
});

test("threads lane claims the turn before the #2648 global-scope stand-down (#2884)", async () => {
    const h = await harness("full");
    try {
        const globalSystem = [...CLIENT_SYSTEM, { type: "text", text: "global posture", cache_control: { scope: "global" } }];
        const create = { ...createBody([{ role: "user", content: turnText(1) }]), system: globalSystem };
        const r = await h.post(create);
        assert.equal(r.status, 200);
        const mirror = h.readMirror("threads-1");
        assert.ok(mirror.meta, "threads lane captured the turn even with a global-scope system");
        assert.deepEqual(mirror.meta?.shape?.system, globalSystem);
    } finally {
        await h.close();
    }
});

test("threads lane: over-window continue is reforged into a fresh create (summary + tail ring + delta)", async () => {
    process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE = "1";
    const h = await harness("full", { window: 5000 });
    try {
        // Seed a thread past the tiny window: 3 user turns ≈ 1500 tok each.
        await h.post(createBody([
            { role: "user", content: turnText(1, 400) },
            { role: "assistant", content: "answer 1" },
            { role: "user", content: turnText(2, 400) },
            { role: "assistant", content: "answer 2" },
            { role: "user", content: turnText(3, 400) },
            { role: "assistant", content: "answer 3" },
        ]));
        // Next continue crosses the window → side-call + reforged create.
        const r = await h.post(continueBody([{ role: "user", content: turnText(4, 400) }], "msg_1"));
        assert.equal(r.status, 200);
        const sideCall = h.forwarded[1] as { stream?: boolean; thread?: unknown; messages?: { role: string; content: unknown }[]; system?: { type: string; text: string }[] };
        assert.equal(sideCall.stream, false, "summary side-call is non-stream");
        assert.equal(sideCall.thread, undefined, "side-call is a plain message request, no thread field");
        assert.equal(h.forwardedPaths[1], "/v1/messages", "#3569: the side-call must land on the chat endpoint, not the bare origin");
        const reforged = h.forwarded[2] as { thread?: { type?: string }; system?: unknown; tools?: unknown; messages?: { role: string; content: unknown }[] };
        assert.equal(reforged.thread?.type, "create", "continue was swapped for a fresh create");
        assert.deepEqual(reforged.system, CLIENT_SYSTEM, "client system copied byte-faithfully");
        assert.deepEqual(reforged.tools, CLIENT_TOOLS, "client tools copied byte-faithfully");
        const msgs = reforged.messages ?? [];
        assert.ok(msgs.length >= 2, "summary head + at least the delta");
        const head = msgs[0] as { role: string; content: { type: string; text: string }[] };
        assert.equal(head.role, "user");
        assert.match(head.content[0].text, /SUMMARY-1/, "side-call answer text rides the summary head");
        assert.match(head.content[0].text, /folded into this summary/);
        const last = msgs[msgs.length - 1] as { role: string; content: string };
        assert.equal(last.role, "user");
        assert.equal(last.content, turnText(4, 400), "client delta rides verbatim at the tail");
        const mirror = h.readMirror("threads-1");
        assert.ok((mirror.meta?.foldedBefore ?? 0) > 0, "fold point recorded in the mirror");
        assert.match(String(mirror.meta?.foldedSummary ?? ""), /SUMMARY-1/);
    } finally {
        delete process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE;
        await h.close();
    }
});

test("threads lane: post-reforge continue passes through (budget below the window again)", async () => {
    process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE = "1";
    const h = await harness("full", { window: 5000 });
    try {
        await h.post(createBody([
            { role: "user", content: turnText(1) }, { role: "assistant", content: "a1" },
            { role: "user", content: turnText(2) }, { role: "assistant", content: "a2" },
            { role: "user", content: turnText(3) }, { role: "assistant", content: "a3" },
            { role: "user", content: turnText(4) }, { role: "assistant", content: "a4" },
            { role: "user", content: turnText(5) }, { role: "assistant", content: "a5" },
            { role: "user", content: turnText(6) }, { role: "assistant", content: "a6" },
        ]));
        await h.post(continueBody([{ role: "user", content: turnText(7) }], "msg_1"));
        const before = h.forwarded.length;
        const r = await h.post(continueBody([{ role: "user", content: "small follow-up" }], "msg_3"));
        assert.equal(r.status, 200);
        assert.equal(h.forwarded.length, before + 1, "no extra side-call — budget is below the window");
        const next = h.forwarded.at(-1) as { thread?: { type?: string }; messages?: unknown[] };
        assert.equal(next.thread?.type, "continue", "plain continue, no re-reforge");
        assert.equal(next.messages?.length, 1);
    } finally {
        delete process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE;
        await h.close();
    }
});

test("threads lane: rollout off keeps over-window continues untouched (no side-call)", async () => {
    const h = await harness("full", { window: 5000 });
    try {
        await h.post(createBody([
            { role: "user", content: turnText(1) }, { role: "assistant", content: "a1" },
            { role: "user", content: turnText(2) }, { role: "assistant", content: "a2" },
            { role: "user", content: turnText(3) }, { role: "assistant", content: "a3" },
            { role: "user", content: turnText(4) }, { role: "assistant", content: "a4" },
            { role: "user", content: turnText(5) }, { role: "assistant", content: "a5" },
            { role: "user", content: turnText(6) }, { role: "assistant", content: "a6" },
        ]));
        const before = h.forwarded.length;
        const r = await h.post(continueBody([{ role: "user", content: turnText(7) }], "msg_1"));
        assert.equal(r.status, 200);
        assert.equal(h.forwarded.length, before + 1, "no summary side-call when the rollout flag is off");
        const next = h.forwarded.at(-1) as { thread?: { type?: string } };
        assert.equal(next.thread?.type, "continue", "continue forwarded unchanged");
    } finally {
        await h.close();
    }
});

test("threads lane: legacy-only storage degrades to pure passthrough (no mirror, no reforge)", async () => {
    process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE = "1";
    const h = await harness("legacy", { window: 5000 });
    try {
        await h.post(createBody([
            { role: "user", content: turnText(1) }, { role: "assistant", content: "a1" },
            { role: "user", content: turnText(2) }, { role: "assistant", content: "a2" },
            { role: "user", content: turnText(3) }, { role: "assistant", content: "a3" },
            { role: "user", content: turnText(4) }, { role: "assistant", content: "a4" },
            { role: "user", content: turnText(5) }, { role: "assistant", content: "a5" },
            { role: "user", content: turnText(6) }, { role: "assistant", content: "a6" },
        ]));
        await h.post(continueBody([{ role: "user", content: turnText(7) }], "msg_1"));
        const mirror = h.readMirror("threads-1");
        assert.equal(mirror.meta, undefined, "no mirror on legacy-only storage");
        const next = h.forwarded.at(-1) as { thread?: { type?: string } };
        assert.equal(next.thread?.type, "continue", "continue forwarded as-is even over budget");
    } finally {
        delete process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE;
        await h.close();
    }
});

test("threads lane: summary side-call failure fails open (continue forwarded unchanged)", async () => {
    process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE = "1";
    const h = await harness("full", { window: 5000, failFirstSideCall: true });
    try {
        await h.post(createBody([
            { role: "user", content: turnText(1, 400) }, { role: "assistant", content: "a1" },
            { role: "user", content: turnText(2, 400) }, { role: "assistant", content: "a2" },
            { role: "user", content: turnText(3, 400) }, { role: "assistant", content: "a3" },
        ]));
        const before = h.forwarded.length;
        const r = await h.post(continueBody([{ role: "user", content: turnText(4, 400) }], "msg_1"));
        assert.equal(r.status, 200);
        assert.equal(h.forwarded.length, before + 2, "side-call attempted, then the original continue forwarded");
        const next = h.forwarded.at(-1) as { thread?: { type?: string }; messages?: unknown[] };
        assert.equal(next.thread?.type, "continue", "fail-open: the client's continue reached the upstream untouched");
        assert.equal(next.messages?.length, 1);
    } finally {
        delete process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE;
        await h.close();
    }
});

test("threads lane: repeated side-call failures cool down instead of re-uploading every continue (#3569)", async () => {
    process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE = "1";
    const h = await harness("full", { window: 5000, failFirstSideCall: true });
    try {
        await h.post(createBody([
            { role: "user", content: turnText(1, 400) }, { role: "assistant", content: "a1" },
            { role: "user", content: turnText(2, 400) }, { role: "assistant", content: "a2" },
            { role: "user", content: turnText(3, 400) }, { role: "assistant", content: "a3" },
        ]));
        // First over-window continue: side-call fails (500), continue forwards.
        const before = h.forwarded.length;
        const r1 = await h.post(continueBody([{ role: "user", content: turnText(4, 400) }], "msg_1"));
        assert.equal(r1.status, 200);
        assert.equal(h.forwarded.length, before + 2, "side-call attempted, then the original continue forwarded");
        // The mirror is still over the window (no fold landed), so this
        // continue would arm the reforge again — the per-session cooldown
        // must suppress the doomed retry instead of re-uploading everything.
        const before2 = h.forwarded.length;
        const r2 = await h.post(continueBody([{ role: "user", content: turnText(5, 400) }], "msg_3"));
        assert.equal(r2.status, 200);
        assert.equal(h.forwarded.length, before2 + 1, "cooldown active: no second side-call within the window");
        const next = h.forwarded.at(-1) as { thread?: { type?: string }; messages?: unknown[] };
        assert.equal(next.thread?.type, "continue", "fail-open still holds while cooling down");
        assert.equal(next.messages?.length, 1);
    } finally {
        delete process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE;
        await h.close();
    }
});

test("threads lane: a 404 from the summary side-call fails open and cools down (#3617-B)", async () => {
    process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE = "1";
    const h = await harness("full", { window: 5000, failFirstSideCall: true, sideCallFailStatus: 404 });
    try {
        await h.post(createBody([
            { role: "user", content: turnText(1, 400) }, { role: "assistant", content: "a1" },
            { role: "user", content: turnText(2, 400) }, { role: "assistant", content: "a2" },
            { role: "user", content: turnText(3, 400) }, { role: "assistant", content: "a3" },
        ]));
        // The production signature of #3569: the side-call hit a path the
        // upstream does not know → not_found_error (404), never a summary.
        const before = h.forwarded.length;
        const r1 = await h.post(continueBody([{ role: "user", content: turnText(4, 400) }], "msg_1"));
        assert.equal(r1.status, 200);
        assert.equal(h.forwarded.length, before + 2, "side-call attempted (and 404'd), then the original continue forwarded");
        const next = h.forwarded.at(-1) as { thread?: { type?: string }; messages?: unknown[] };
        assert.equal(next.thread?.type, "continue", "fail-open: a 404 must not break the client's continue");
        assert.equal(next.messages?.length, 1);
        const before2 = h.forwarded.length;
        const r2 = await h.post(continueBody([{ role: "user", content: turnText(5, 400) }], "msg_3"));
        assert.equal(r2.status, 200);
        assert.equal(h.forwarded.length, before2 + 1, "cooldown holds after a 404 too: no doomed retry re-uploading the transcript");
    } finally {
        delete process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE;
        await h.close();
    }
});

test("threads lane: a re-create under the same session id resets bili's own fold tracking", async () => {
    process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE = "1";
    const h = await harness("full", { window: 5000 });
    try {
        await h.post(createBody([
            { role: "user", content: turnText(1, 400) }, { role: "assistant", content: "a1" },
            { role: "user", content: turnText(2, 400) }, { role: "assistant", content: "a2" },
            { role: "user", content: turnText(3, 400) }, { role: "assistant", content: "a3" },
        ]));
        await h.post(continueBody([{ role: "user", content: turnText(4, 400) }], "msg_1"));
        const afterReforge = h.readMirror("threads-1");
        assert.ok((afterReforge.meta?.foldedBefore ?? 0) > 0, "the over-window continue was reforged (fold point recorded)");
        await h.post(createBody([
            { role: "user", content: turnText(1) }, { role: "assistant", content: "b1" },
            { role: "user", content: turnText(2) }, { role: "assistant", content: "b2" },
        ]));
        const afterRecreate = h.readMirror("threads-1");
        assert.equal(afterRecreate.meta?.foldedBefore, 0, "re-create resets the fold point to zero");
        assert.equal(afterRecreate.meta?.foldedSummary, undefined, "re-create drops the stale summary");
        assert.equal(afterRecreate.meta?.count, 4, "mirror holds only the fresh snapshot");
    } finally {
        delete process.env.BILI_ROLLOUT_ANTHROPIC_THREADS_REFORGE;
        await h.close();
    }
});

test.after(() => {
    rmSync(testRoot, { recursive: true, force: true });
});
