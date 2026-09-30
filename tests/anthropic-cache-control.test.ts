import assert from "node:assert";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";

// #1637: bili's Anthropic lane never emitted cache_control breakpoints, so
// Anthropic-style upstreams (explicit caching) never cached anything bili
// sent — relays that breakpoint only the system block left the whole history
// re-billing at full price every request (#1631). The fix stamps CUMULATIVE
// incremental breakpoints (the Anthropic-recommended cadence): the system
// block plus up to 3 message marks — a marked message STAYS marked (removing
// a mid-history marker mutates that element's bytes next turn and breaks the
// byte prefix exactly there, the fold-seam class the cache matrix pins).
// Marks die only by folding. Any client-set cache_control suppresses our
// stamps (client-managed wins).

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.close((error) => (error ? reject(error) : resolve()));
    return promise;
}

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function textScript(): string {
    return anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 42 } } }) +
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        anthropicSse("message_stop", { type: "message_stop" });
}

interface Rig {
    proxyPort: number;
    portHint(): number;
    upstreamBodies: string[];
    closeAll(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const upstreamBodies: string[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(textScript());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "l1637-model": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        log: false,
        sessionHeader: "x-acp-session",
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const server = await startServer(opts);
    await listen(server);
    const proxyPort = (server.address() as { port: number }).port;

    return {
        proxyPort,
        portHint: () => upstreamPort,
        upstreamBodies,
        closeAll: async () => {
            await close(server);
            await close(upstream);
        },
    };
}

interface Msg {
    role: "user" | "assistant";
    content: string | { type: "text"; text: string; cache_control?: unknown }[];
}

async function postModel(rig: Rig, sessionId: string, messages: Msg[], extraHeaders: Record<string, string> = {}, upstreamPortHint?: number, tools?: unknown[]): Promise<Response> {
    const port = upstreamPortHint ?? rig.portHint();
    return fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-affinity": sessionId, ...extraHeaders },
        body: JSON.stringify({ model: "l1637-model", max_tokens: 8192, stream: true, messages, ...(tools ? { tools } : {}) }),
    });
}

async function waitFor(pred: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(pred(), `timeout waiting for ${what}`);
}

interface AnthropicBody {
    system?: { type: string; text?: string; cache_control?: unknown }[];
    tools?: { name?: string; cache_control?: unknown }[];
    messages: { role: string; content: string | { type: string; text?: string; cache_control?: unknown }[] }[];
}

function parseBody(body: string): AnthropicBody {
    return JSON.parse(body) as AnthropicBody;
}

function markedCount(body: string): { system: number; messages: number[] } {
    const parsed = parseBody(body);
    const systemMarks = Array.isArray(parsed.system) ? parsed.system.filter((b) => b.cache_control).length : 0;
    const msgMarks: number[] = [];
    parsed.messages.forEach((m, i) => {
        const marked = Array.isArray(m.content) && m.content.some((b) => b.cache_control);
        if (marked) msgMarks.push(i);
    });
    return { system: systemMarks, messages: msgMarks };
}

test("#1637: armed anthropic request carries cache_control on the system block and the last stable message; ephemeral tails never carry it", async () => {
    const rig = await startRig();
    try {
        const history: Msg[] = [
            { role: "user", content: "hello one" },
            { role: "assistant", content: "ack one" },
            { role: "user", content: "hello two" },
        ];
        await postModel(rig, "sess-1637-a", history);
        await waitFor(() => rig.upstreamBodies.length >= 1, "first forward");

        const b1 = parseBody(rig.upstreamBodies[0]);
        assert.ok((b1.system ?? []).length > 0, "system injected as block array");
        const lastSys = b1.system![b1.system!.length - 1];
        assert.deepEqual(lastSys.cache_control, { type: "ephemeral" }, "system last block breakpointed");

        const marks1 = markedCount(rig.upstreamBodies[0]).messages;
        assert.equal(marks1.length, 1, "exactly one message breakpoint on turn 1");
        assert.equal(marks1[0], b1.messages.length - 1, "the LAST message carries the breakpoint (no tails this turn)");
    } finally {
        await rig.closeAll();
    }
});

test("#1637: incremental cadence — turn 2 keeps turn 1's marker for one extra turn and marks the new last message", async () => {
    const rig = await startRig();
    try {
        const h1: Msg[] = [{ role: "user", content: "u1" }, { role: "assistant", content: "a1" }];
        await postModel(rig, "sess-1637-b", h1);
        await waitFor(() => rig.upstreamBodies.length >= 1, "turn 1 forward");

        const h2: Msg[] = [...h1, { role: "user", content: "u2" }, { role: "assistant", content: "a2" }, { role: "user", content: "u3" }];
        await postModel(rig, "sess-1637-b", h2);
        await waitFor(() => rig.upstreamBodies.length >= 2, "turn 2 forward");

        const b1 = parseBody(rig.upstreamBodies[0]);
        const b2 = parseBody(rig.upstreamBodies[1]);
        const marks1 = markedCount(rig.upstreamBodies[0]).messages;
        const marks2 = markedCount(rig.upstreamBodies[1]).messages;
        assert.equal(marks1.length, 1, "turn 1: one marker");
        assert.ok(marks2.length >= 1 && marks2.length <= 2, "turn 2: previous marker kept + new last marked");
        // stability: every turn-1 message must serialize identically on turn 2
        // up to and including turn 1's marked message (prefix-cache contract).
        const n1 = b1.messages.length;
        for (let i = 0; i <= marks1[0]; i++) {
            assert.deepEqual(b2.messages[i], b1.messages[i], `message ${i} byte-stable across turns (prefix-cache contract)`);
        }
        assert.ok(n1 >= 1, "sanity");
        assert.equal(markedCount(rig.upstreamBodies[1]).system, 1, "system breakpoint persists");
    } finally {
        await rig.closeAll();
    }
});

test("#1637: client-managed cache_control wins — bili adds no breakpoints", async () => {
    const rig = await startRig();
    try {
        const history: Msg[] = [
            { role: "user", content: [{ type: "text", text: "client manages caching", cache_control: { type: "ephemeral" } }] },
            { role: "assistant", content: "ack" },
            { role: "user", content: "hello" },
        ];
        await postModel(rig, "sess-1637-c", history);
        await waitFor(() => rig.upstreamBodies.length >= 1, "forward");

        const b1 = parseBody(rig.upstreamBodies[0]);
        const marks = markedCount(rig.upstreamBodies[0]);
        // exactly the client's own one; bili contributed none
        assert.equal(marks.messages.length, 1, "only the client's own breakpoint present");
        const clientMsg = b1.messages.find((m) => Array.isArray(m.content) && m.content.some((c) => (c.text ?? "").includes("client manages caching")));
        assert.ok(clientMsg, "client's marked message forwarded");
        assert.equal(marks.system, 0, "bili did not breakpoint the system either");
    } finally {
        await rig.closeAll();
    }
});

test("#1637: BILI_NO_CACHE_CONTROL=1 disables all stamping", async () => {
    const prev = process.env.BILI_NO_CACHE_CONTROL;
    process.env.BILI_NO_CACHE_CONTROL = "1";
    const rig = await startRig();
    try {
        await postModel(rig, "sess-1637-d", [{ role: "user", content: "hello" }]);
        await waitFor(() => rig.upstreamBodies.length >= 1, "forward");
        const marks = markedCount(rig.upstreamBodies[0]);
        assert.equal(marks.system + marks.messages.length, 0, "no breakpoints anywhere");
    } finally {
        await rig.closeAll();
        if (prev === undefined) delete process.env.BILI_NO_CACHE_CONTROL;
        else process.env.BILI_NO_CACHE_CONTROL = prev;
    }
});

test("#1639: client cache_control on TOOLS only also suppresses bili's stamps (WC-010 combined budget)", async () => {
    const rig = await startRig();
    try {
        const history: Msg[] = [
            { role: "user", content: "hello one" },
            { role: "assistant", content: "ack one" },
            { role: "user", content: "hello two" },
        ];
        const tools = [{ name: "client_tool", description: "d", input_schema: { type: "object", properties: {} }, cache_control: { type: "ephemeral" } }];
        await postModel(rig, "sess-1639-e", history, {}, undefined, tools);
        await waitFor(() => rig.upstreamBodies.length >= 1, "forward");

        const b1 = parseBody(rig.upstreamBodies[0]);
        const marks = markedCount(rig.upstreamBodies[0]);
        assert.equal(marks.messages.length, 0, "bili added no message breakpoints");
        assert.equal(marks.system, 0, "bili did not breakpoint the system");
        const toolMarks = (b1.tools ?? []).filter((t) => t.cache_control).length;
        assert.equal(toolMarks, 1, "client's tools breakpoint preserved verbatim");
    } finally {
        await rig.closeAll();
    }
});

test("#1637: cap 3 — marks stop advancing once the budget is full and existing marks are never dropped or added", async () => {
    const rig = await startRig();
    const markedTexts = (body: string): string[] => {
        const out: string[] = [];
        for (const m of parseBody(body).messages) {
            if (Array.isArray(m.content) && m.content.some((b) => b.cache_control)) {
                // identify by trailing payload only: hydrated sessions prefix
                // kernel render tags (<acp ...>mNNNNN</acp>) and the
                // request-scoped chain checkpoint (#1395) rides the last block
                out.push(m.content.map((b) => b.text ?? "").join("")
                    .split("\x3c/acp\x3e").pop()!
                    .replace(/\x3cbili-chain v="1"[^]*\/\x3e/, "")
                    .trim());
            }
        }
        return out;
    };
    try {
        const sid = `sess-1639-f-${process.pid}`;
        let history: Msg[] = [];
        for (let turn = 1; turn <= 5; turn++) {
            history = turn === 1
                ? [{ role: "user", content: "u1" }]
                : [...history, { role: "assistant", content: `a${turn - 1}` }, { role: "user", content: `u${turn}` }];
            await postModel(rig, sid, history);
            await waitFor(() => rig.upstreamBodies.length >= turn, `turn ${turn} forward`);
            assert.ok(markedTexts(rig.upstreamBodies[turn - 1]).length <= 3, `turn ${turn}: never more than 3 message marks`);
        }
        assert.deepEqual(markedTexts(rig.upstreamBodies[2]), ["u1", "u2", "u3"], "turn 3 fills the budget");
        assert.deepEqual(markedTexts(rig.upstreamBodies[3]), ["u1", "u2", "u3"], "turn 4: frozen, no advance past cap");
        assert.deepEqual(markedTexts(rig.upstreamBodies[4]), ["u1", "u2", "u3"], "turn 5: still frozen — existing marks never dropped");
        assert.equal(markedCount(rig.upstreamBodies[4]).system, 1, "system breakpoint persists throughout");
    } finally {
        await rig.closeAll();
    }
});
