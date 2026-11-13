// #3701: Jimp rescale is per-image, so accumulated images still push the FINAL Responses
// WebSocket frame past the upstream gateway's byte limit — close 1009 with zero events,
// at 30–40% token usage where no token-space gate fires, and every retry resends the same
// bytes. This suite pins the byte-space backstop: pre-send shedding against
// network.wsOutboundBytes on the WS lane only, typed 1009 errors that preserve
// close_code/received_events, and a single strictly-smaller shrunken resend.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { ResponsesWsUpstream, ResponsesWsUpstreamError } from "../src/responses-ws.ts";
import { shedWireImages, shedEgressIfOverBudget, extractWsOversizeError } from "../src/egress-shed.ts";
import { markWsLaneTransport, withFetchTransport } from "../src/fetch-transport.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { createSession, peekSession } from "../src/session.ts";
import { BILI_ACP_TOOLS_RESPONSES, READ_ORIGINAL_IMAGE_TOOL_NAME } from "../src/compress-tool.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import type { ProxyOptions } from "../src/config.ts";

type Item = Record<string, unknown>;

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ws-shed-home-"));
process.env.XDG_STATE_HOME = testHome;
process.env.XDG_DATA_HOME = testHome;
process.env.XDG_CACHE_HOME = testHome;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function pngCrc(buf: Buffer): number {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(pngCrc(body));
    return Buffer.concat([len, body, crc]);
}

/** Incompressible-noise RGB PNG: jimp can decode AND downscale it, and its size tracks
 *  pixel count, so shedding math is predictable. */
function noisePng(w: number, h: number, seed: number): Buffer {
    let s = seed || 1;
    const rnd = (): number => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) % 256; };
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const raw = Buffer.alloc(h * (1 + w * 3));
    let p = 0;
    for (let y = 0; y < h; y++) {
        raw[p++] = 0;
        for (let x = 0; x < w; x++) {
            raw[p++] = rnd();
            raw[p++] = rnd();
            raw[p++] = rnd();
        }
    }
    return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw, { level: 6 })), pngChunk("IEND", Buffer.alloc(0))]);
}

/** Not an image at all: jimp cannot decode it, so rung B must yield null (graceful). */
function fakeB64(seed: number, rawBytes = 150_000): string {
    const buf = Buffer.alloc(rawBytes);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + seed * 7) % 256;
    return buf.toString("base64");
}

const userImage = (text: string, b64: string): Item => ({
    type: "message",
    role: "user",
    content: [
        { type: "input_text", text },
        { type: "input_image", image_url: `data:image/png;base64,${b64}` },
    ],
});


test("#3701 shedWireImages: archives oldest non-protected images until under target", async () => {
    const input: Item[] = [];
    for (let i = 0; i < 16; i++) input.push(userImage(`image ${i}`, fakeB64(i + 1)));
    const body = JSON.stringify({ model: "m", input });
    // 16 x ~200 KiB of base64: archiving the oldest 4 lands the estimate just under target.
    const targetBytes = 2_500_000;
    const before = body;
    const { body: next, stats } = await shedWireImages(body, "responses", targetBytes);
    assert.equal(before, body, "input string untouched");
    assert.ok(stats.changed);
    assert.equal(stats.archived, 4, "oldest-first across the 8 archivable entries stops as soon as the estimate fits");
    assert.ok(stats.finalBytes <= targetBytes, `${stats.finalBytes} <= ${targetBytes}`);
    const parsed = JSON.parse(next) as { input: Item[] };
    for (let i = 0; i < stats.archived; i++) {
        const content = parsed.input[i].content as Item[];
        assert.equal(content[1].type, "input_text", `entry ${i} image part replaced by a note`);
        assert.match(String(content[1].text), /omitted for size limit/);
    }
    for (let i = stats.archived; i < 16; i++) {
        const content = parsed.input[i].content as Item[];
        assert.equal(content[1].type, "input_image", `entry ${i} keeps its image`);
    }
});

test("#3701 shedWireImages: under-target and unparseable bodies pass through unchanged", async () => {
    const small = JSON.stringify({ model: "m", input: [userImage("a", fakeB64(1, 1024))] });
    const under = await shedWireImages(small, "responses", 1_000_000);
    assert.equal(under.body, small);
    assert.equal(under.stats.changed, false);
    const junk = "not-json {";
    const bad = await shedWireImages(junk, "responses", 10);
    assert.equal(bad.body, junk);
    assert.equal(bad.stats.changed, false);
});

test("#3701 shedWireImages: openai and anthropic shapes shed too", async () => {
    // >8 messages so the two image-bearing entries sit OUTSIDE the protected tail of 8.
    const openai = JSON.stringify({
        model: "m",
        messages: [
            { role: "user", content: [{ type: "text", text: "a" }, { type: "image_url", image_url: `data:image/png;base64,${fakeB64(1)}` }] },
            { role: "user", content: [{ type: "text", text: "b" }, { type: "image_url", image_url: { url: `data:image/jpeg;base64,${fakeB64(2)}` } }] },
            ...Array.from({ length: 8 }, (_, i) => ({ role: "user", content: [{ type: "text", text: `pad ${i}` }] })),
        ],
    });
    const openaiOut = await shedWireImages(openai, "openai", 100_000);
    assert.ok(openaiOut.stats.changed);
    assert.equal(openaiOut.stats.archived, 2, "both string-form and object-form image_url shed");
    assert.ok(openaiOut.stats.finalBytes <= 100_000);
    const openaiParsed = JSON.parse(openaiOut.body) as { messages: Item[] };
    for (const i of [0, 1]) {
        const content = openaiParsed.messages[i].content as Item[];
        assert.equal(content[1].type, "text");
        assert.match(String(content[1].text), /omitted for size limit/);
    }
    const anthropic = JSON.stringify({
        model: "m",
        messages: Array.from({ length: 12 }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: [{ type: "text", text: `t${i}` }, { type: "image", source: { type: "base64", media_type: "image/png", data: fakeB64(i + 1) } }],
        })),
    });
    // 12 x ~200 KiB: archiving the first two images lands the estimate just under target.
    const anthropicOut = await shedWireImages(anthropic, "anthropic", 2_100_000);
    assert.ok(anthropicOut.stats.changed);
    assert.equal(anthropicOut.stats.archived, 2);
    assert.ok(anthropicOut.stats.finalBytes <= 2_100_000);
    const anthropicParsed = JSON.parse(anthropicOut.body) as { messages: Item[] };
    assert.equal((anthropicParsed.messages[0].content as Item[])[1].type, "text");
    assert.equal((anthropicParsed.messages[11].content as Item[])[1].type, "image", "protected tail keeps its image");
});

test("#3701 shedWireImages: read_original_image outputs stay exempt", async () => {
    // Both image-bearing entries sit OUTSIDE the protected tail of 8, so only the
    // read_original_image exemption can keep the tool output's image alive.
    const input: Item[] = [
        { type: "message", role: "user", content: [{ type: "input_text", text: "read it" }] },
        { type: "function_call", id: "fc_1", call_id: "call_1", name: READ_ORIGINAL_IMAGE_TOOL_NAME, arguments: "{}" },
        {
            type: "function_call_output",
            call_id: "call_1",
            output: [
                { type: "input_text", text: "original" },
                { type: "input_image", image_url: `data:image/png;base64,${fakeB64(9)}` },
            ],
        },
        userImage("another", fakeB64(10)),
        ...Array.from({ length: 9 }, (_, i) => ({ type: "message", role: "user", content: [{ type: "input_text", text: `pad ${i}` }] })),
    ];
    const body = JSON.stringify({ model: "m", input });
    const { body: next, stats } = await shedWireImages(body, "responses", 50_000);
    assert.equal(stats.archived, 1, "only the non-exempt image is archived");
    const parsed = JSON.parse(next) as { input: Item[] };
    const exempt = parsed.input[2] as Item;
    assert.ok((exempt.output as Item[]).some(p => p.type === "input_image"), "read_original_image output image intact");
    assert.equal((parsed.input[3].content as Item[])[1].type, "input_text");
});


test("#3701 shedEgressIfOverBudget: WS-lane only, records metadata, honors disable", async () => {
    const session = createSession(`ws-shed-${randomUUID()}`);
    const input: Item[] = [];
    for (let i = 0; i < 12; i++) input.push(userImage(`image ${i}`, fakeB64(i + 1)));
    const big = JSON.stringify({ model: "m", input });
    process.env.BILI_WS_OUTBOUND_BYTES = String(1_000_000);
    try {
        const logs: string[] = [];
        // markWsLaneTransport: only a WS-tagged transport triggers the shed (#3701
        // Finding 1 — the gate used to fire for ANY managed transport, shedding
        // dsh-inline's large-but-deliverable HTTP requests).
        const out = await withFetchTransport(markWsLaneTransport(async () => new Response("unused")), () =>
            shedEgressIfOverBudget(big, "responses", { sessionId: session.id, session, log: (level, msg) => logs.push(`${level}:${msg}`), phase: "unit" }));
        assert.ok(out.stats.changed);
        assert.equal(out.stats.archived, 4, "entries 0..3 are the only archivable ones (tail of 8 protected)");
        assert.ok(out.body.length < big.length);
        const meta = session.metadata.wsByteShed as Record<string, unknown> | undefined;
        assert.ok(meta, "wsByteShed recorded on the session");
        assert.equal(meta?.phase, "unit");
        assert.ok((meta?.fromBytes as number) > (meta?.toBytes as number));
        assert.ok(logs.some(l => l.includes("[ws-byte-shed]") && l.includes("still over budget")), "protected tail overage is warned, not silent");

        const httpOut = await shedEgressIfOverBudget(big, "responses", { sessionId: session.id, session });
        assert.equal(httpOut.body, big, "plain relay but body ~2.4 MiB < default 10 MiB http budget (#3909) → still passthrough");
        assert.equal(httpOut.stats.changed, false);

        // #3701 Finding 1 regression pin: a MANAGED-but-HTTP transport (the dsh-inline
        // shape, inline-engine.ts) must also pass through untouched — the shed keys on
        // the WS tag, not on "any managed transport".
        const managedHttp = await withFetchTransport(async () => new Response("unused"), () =>
            shedEgressIfOverBudget(big, "responses", { sessionId: session.id, session }));
        assert.equal(managedHttp.body, big, "managed HTTP transport (dsh-inline shape) passes through untouched");
        assert.equal(managedHttp.stats.changed, false);
        assert.equal(managedHttp.stats.archived, 0);

        process.env.BILI_WS_OUTBOUND_BYTES = "0";
        const off = await withFetchTransport(markWsLaneTransport(async () => new Response("unused")), () => shedEgressIfOverBudget(big, "responses", {}));
        assert.equal(off.body, big, "budget 0 disables shedding");
    } finally {
        delete process.env.BILI_WS_OUTBOUND_BYTES;
    }
});


test("#3701 extractWsOversizeError: only close-1009 zero-event matches", () => {
    const hit = new ResponsesWsUpstreamError("m", 1009, "await-first-event", 0);
    assert.equal(extractWsOversizeError(hit), hit);
    assert.equal(extractWsOversizeError(new Error("wrap", { cause: new Error("wrap2", { cause: hit }) })), hit);
    assert.equal(extractWsOversizeError(new ResponsesWsUpstreamError("m", 1011, "stream", 3)), undefined, "other close codes keep their existing treatment");
    assert.equal(extractWsOversizeError(new ResponsesWsUpstreamError("m", 1009, "stream", 3)), undefined, "events already received = stream drop, not a size verdict");
    assert.equal(extractWsOversizeError(new ResponsesWsUpstreamError("m", "none", "await-first-event", 0)), undefined, "close_code none must never be misclassified");
    assert.equal(extractWsOversizeError(new Error("plain")), undefined);
});


async function withLocalUpstream(scenario: "close1009" | "eventThenClose" | "complete", fn: (port: number) => Promise<void>): Promise<void> {
    const upstream = http.createServer((_req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", peer => peer.on("message", () => {
        if (scenario === "close1009") {
            peer.close(1009, "message too big");
            return;
        }
        if (scenario === "eventThenClose") {
            peer.send(JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress", output: [] } }));
            peer.close(1009, "message too big");
            return;
        }
        const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
        peer.send(JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress", output: [] } }));
        peer.send(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }));
        peer.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
        peer.send(JSON.stringify({ type: "response.completed", response: { id: "r1", object: "response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }));
    }));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    try {
        await fn((upstream.address() as { port: number }).port);
    } finally {
        for (const client of wss.clients) client.terminate();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
        wss.close();
    }
}

const wsRequestBody = (): string => JSON.stringify({
    model: "gpt-5.2",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
});

test("#3701 transport: close 1009 before any event yields a typed oversize error", async () => {
    await withLocalUpstream("close1009", async port => {
        const transport = new ResponsesWsUpstream();
        try {
            await assert.rejects(
                transport.fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: wsRequestBody() }),
                (err: unknown) => err instanceof ResponsesWsUpstreamError
                    && err.closeCode === 1009
                    && err.phase === "await-first-event"
                    && err.receivedEvents === 0
                    && /close_code=1009/.test(err.message),
            );
        } finally {
            transport.close("test-end");
        }
    });
});

test("#3701 transport: 1009 after events is a stream drop, not a size verdict", async () => {
    await withLocalUpstream("eventThenClose", async port => {
        const transport = new ResponsesWsUpstream();
        try {
            await assert.rejects(
                transport.fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: wsRequestBody() }),
                (err: unknown) => err instanceof ResponsesWsUpstreamError
                    && err.closeCode === 1009
                    && err.phase === "stream"
                    && err.receivedEvents >= 1,
            );
        } finally {
            transport.close("test-end");
        }
    });
});

test("#3701 transport regression: normal completion still resolves through sendCreate", async () => {
    await withLocalUpstream("complete", async port => {
        const log: string[] = [];
        const transport = new ResponsesWsUpstream((_level, message) => log.push(message));
        try {
            const res = await transport.fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: wsRequestBody() });
            assert.equal(res.status, 200);
            const json = (await res.json()) as Item;
            assert.equal(json.status, "completed");
            assert.ok(log.some(l => /^upstream send mode=full bytes=\d+$/.test(l)), "outbound frame bytes are logged");
        } finally {
            transport.close("test-end");
        }
    });
});

// The logger flushes asynchronously (createWriteStream in src/logger.ts), so a
// single readFileSync right after the turn can miss the final line on slow CI disks.
async function waitForLogLine(logPath: string, needle: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const text = fs.readFileSync(logPath, "utf8");
        if (text.includes(needle)) return text;
        if (Date.now() >= deadline) throw new Error(`timed out waiting for log line ${JSON.stringify(needle)} in ${logPath}`);
        await new Promise(r => setTimeout(r, 25));
    }
}

interface ShedFixture {
    frames: string[];
    turn: (input: Item[]) => Promise<Item[]>;
    logPath: string;
    sid: string;
    close: () => Promise<void>;
}

async function shedProxyFixture(): Promise<ShedFixture> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ws-shed-"));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const frames: string[] = [];
    let firstFrameSeen = false;
    const upstream = http.createServer((_req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ server: upstream });
    wss.on("connection", peer => peer.on("message", raw => {
        const text = String(raw);
        frames.push(text);
        if (!firstFrameSeen) {
            // The gateway verdict this issue reproduces: size rejection, zero events.
            firstFrameSeen = true;
            peer.close(1009, "message too big");
            return;
        }
        const item = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
        peer.send(JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress", output: [] } }));
        peer.send(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }));
        peer.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
        peer.send(JSON.stringify({ type: "response.completed", response: { id: "r1", object: "response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }));
    }));
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const config = defaultConfig(200000);
    config.preserveRecentTokens = 0;
    const opts: ProxyOptions = {
        host: "127.0.0.1", port: 0, upstream: "http://127.0.0.1", routes: {}, proxy: "", proxyMode: "direct", proxySource: "direct",
        proxyFallback: { explicitDirect: true, globalSource: "direct" }, auxProxyFallback: { explicitDirect: true, globalSource: "direct" },
        modelContextLimit: 200000, kernelConfig: config, compress: { injectTool: true, injectNudge: false }, promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session", log: true, logFile: path.join(tmp, "bili.log"), debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const sid = `ses_shed_${randomUUID()}`;
    const client = new WebSocket(`${proxyOrigin.replace(/^http/, "ws")}/bili/responses/${upstreamOrigin}/v1/responses`, {
        headers: { authorization: "Bearer fake-credential", "x-bili-plugin": "opencode", "x-bili-plugin-conversation": sid, "x-bili-plugin-model": "gpt-5.2", "x-bili-plugin-context-window": "200000" },
    });
    await once(client, "open");
    const turn = (input: Item[]): Promise<Item[]> => new Promise((resolve, reject) => {
        const events: Item[] = [];
        const timer = setTimeout(() => { cleanup(); reject(new Error("WS turn timed out")); }, 60_000);
        const cleanup = (): void => { clearTimeout(timer); client.off("message", onMessage); client.off("close", onClose); };
        const onClose = (): void => { cleanup(); reject(new Error("WS client closed")); };
        const onMessage = (raw: WebSocket.RawData): void => {
            const event = JSON.parse(String(raw)) as Item;
            events.push(event);
            if (["response.completed", "response.failed", "response.incomplete", "error"].includes(String(event.type))) {
                cleanup();
                resolve(events);
            }
        };
        client.on("message", onMessage);
        client.once("close", onClose);
        client.send(JSON.stringify({ type: "response.create", model: "gpt-5.2", store: false, input, tools: BILI_ACP_TOOLS_RESPONSES }));
    });
    return {
        frames, turn, sid, logPath: path.join(tmp, "bili.log"),
        close: async () => {
            client.terminate();
            for (const conn of wss.clients) conn.terminate();
            await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
            wss.close();
        },
    };
}

test("#3701 e2e: oversized WS frame is shed pre-send, and a 1009 triggers one strictly smaller resend", { timeout: 180_000 }, async t => {
    const f = await shedProxyFixture();
    const budget = 10 * 1024 * 1024;
    process.env.BILI_WS_OUTBOUND_BYTES = String(budget);
    try {
        const input: Item[] = [];
        for (let i = 0; i < 16; i++) input.push(userImage(`screenshot ${i}`, noisePng(900, 700, i + 1).toString("base64")));
        const events = await f.turn(input);
        const completedEvent = events.find(e => e.type === "response.completed");
        assert.ok(completedEvent, `expected recovery to complete, got ${JSON.stringify(events.map(e => e.type))}`);
        assert.equal(f.frames.length, 2, "exactly one shrunken resend — no same-size retry loop");
        const firstBytes = Buffer.byteLength(f.frames[0]);
        const secondBytes = Buffer.byteLength(f.frames[1]);
        assert.ok(firstBytes <= budget + 64 * 1024, `pre-send shed kept frame 1 within budget (${firstBytes} vs ${budget})`);
        assert.ok(secondBytes < firstBytes, `resend strictly smaller (${secondBytes} < ${firstBytes})`);
        const logText = await waitForLogLine(f.logPath, "1009 recovered");
        assert.ok(logText.includes("[ws-byte-shed]"), "shed activity logged");
        const meta = peekSession(f.sid)?.metadata.wsByteShed as Record<string, unknown> | undefined;
        assert.equal(meta?.phase, "post-1009");
        assert.ok((meta?.fromBytes as number) > (meta?.toBytes as number));
    } finally {
        delete process.env.BILI_WS_OUTBOUND_BYTES;
        await f.close();
    }
});

test("#3701 e2e: unsheddable oversize surfaces an actionable error instead of infinite resends", { timeout: 120_000 }, async t => {
    const f = await shedProxyFixture();
    process.env.BILI_WS_OUTBOUND_BYTES = String(64 * 1024);
    try {
        const input: Item[] = [];
        for (let i = 0; i < 4; i++) input.push(userImage(`shot ${i}`, fakeB64(i + 1)));
        let terminal: Item[] | undefined;
        let rejected: Error | undefined;
        try {
            terminal = await f.turn(input);
        } catch (error) {
            rejected = error as Error;
        }
        assert.ok(rejected !== undefined || !terminal?.some(e => e.type === "response.completed"), "no successful completion without a smaller payload");
        assert.equal(f.frames.length, 1, "nothing was shrunken, so nothing was resent");
        const logText = await waitForLogLine(f.logPath, "cannot be reduced further");
        assert.ok(logText.includes("sending as-is"), "pre-send warn explains why the frame went out full-size");
    } finally {
        delete process.env.BILI_WS_OUTBOUND_BYTES;
        await f.close();
    }
});
