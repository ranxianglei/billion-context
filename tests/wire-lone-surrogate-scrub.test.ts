// #816 family (wire layer): a lone surrogate anywhere in a request body —
// from pre-#816 persisted compression state, model-authored text, or replayed
// tails — serializes as an unpaired \uXXXX escape. Strict upstreams (Rust
// serde-style parsers) reject the ENTIRE body with a non-retryable 400, so a
// poisoned body is a deterministic dead conversation that never heals on
// retry. The scrub at the send chokepoints (loop fetchUpstream, relay forward
// #1884 seam, reasoning-guard round) must (a) replace the lone half with
// U+FFFD so the body parses and the request succeeds, and (b) leave clean
// bodies byte-identical — valid surrogate pairs and ordinary text untouched.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

const WINDOW = 32_000;

// Lone halves built via JSON.parse so the test source itself carries no
// unpaired code units (the file stays valid UTF-8 for every tool in the chain).
const LONE_LOW = JSON.parse('"\\udcca"');
const PAIR = JSON.parse('"\\ud83d\\udcca"');

/** The proxy renders model-visible text into content blocks and may prefix an
 *  <acp …> ref tag; this pulls the text back out for content assertions. */
function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : ""))
            .join("");
    }
    return "";
}

/** Recursively scan every string in a parsed JSON value. */
function findUnpaired(value: unknown, path = "$"): string | null {
    if (typeof value === "string") {
        for (let i = 0; i < value.length; i++) {
            const c = value.charCodeAt(i);
            if (c >= 0xd800 && c <= 0xdbff) {
                const n = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
                if (!(n >= 0xdc00 && n <= 0xdfff)) return `${path}: lone high at ${i}`;
                i++;
            } else if (c >= 0xdc00 && c <= 0xdfff) {
                const p = i > 0 ? value.charCodeAt(i - 1) : 0;
                if (!(p >= 0xd800 && p <= 0xdbff)) return `${path}: lone low at ${i}`;
            }
        }
        return null;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            const hit = findUnpaired(value[i], `${path}[${i}]`);
            if (hit) return hit;
        }
        return null;
    }
    if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const hit = findUnpaired(v, `${path}.${k}`);
            if (hit) return hit;
        }
    }
    return null;
}

function okSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 5000 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function makeRelay() {
    const received: Buffer[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            received.push(raw);
            let parsed: Record<string, unknown> = {};
            try {
                parsed = JSON.parse(raw.toString("utf8"));
            } catch {
                /* non-JSON — serve the SSE shape anyway */
            }
            if (parsed.stream !== true) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ id: "s", type: "message", role: "assistant", content: [{ type: "text", text: "sum" }], usage: { input_tokens: 10, output_tokens: 2 } }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(okSse());
        });
    });
    return { server, received };
}

async function startProxy(upstreamPort: number): Promise<{ proxy: http.Server; port: number }> {
    const store = new SessionStore({ enabled: false });
    _setStoreForTest(store);
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-relay": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        passthroughSource: null,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxy, port: (proxy.address() as { port: number }).port };
}

test("wire scrub: lone surrogate in the body is replaced, request still succeeds", async () => {
    const relay = makeRelay();
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = (relay.server.address() as { port: number }).port;
    const { proxy, port } = await startProxy(upstreamPort);
    const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

    try {
        const poisoned = `panel line one${LONE_LOW} ACP status ${PAIR} done`;
        const body = JSON.stringify({
            model: "claude-relay",
            max_tokens: 1024,
            stream: true,
            messages: [{ role: "user", content: poisoned }],
        });

        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "surrogate-sess" },
            body,
        });
        assert.equal(r.status, 200, "request with a poisoned body still succeeds");
        await r.text();

        const raw = relay.received[0];
        assert.ok(raw, "upstream received the request");
        const text = raw.toString("utf8");
        const parsed = JSON.parse(text);
        const hit = findUnpaired(parsed);
        assert.equal(hit, null, `upstream body carries no unpaired surrogate (${hit})`);

        const content = textOf((parsed.messages as { content: unknown }[])[0].content);
        assert.ok(content.includes(PAIR), "valid surrogate pair survives verbatim");
        assert.ok(content.includes("\ufffd"), "lone surrogate half was replaced with U+FFFD");
        assert.ok(!text.includes("udcca"), "no unpaired \\udcca escape remains on the wire");
    } finally {
        proxy.close();
        relay.server.close();
    }
});

test("wire scrub: clean bodies pass through untouched (no over-scrub)", async () => {
    const relay = makeRelay();
    relay.server.listen(0, "127.0.0.1");
    await once(relay.server, "listening");
    const upstreamPort = (relay.server.address() as { port: number }).port;
    const { proxy, port } = await startProxy(upstreamPort);
    const url = `http://127.0.0.1:${port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

    try {
        const clean = `emoji ${PAIR} plus text \\n \\t "quotes" — 中文 é ${"x".repeat(64)}`;
        const body = JSON.stringify({
            model: "claude-relay",
            max_tokens: 1024,
            stream: true,
            messages: [{ role: "user", content: clean }],
        });

        const r = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "clean-sess" },
            body,
        });
        assert.equal(r.status, 200, "clean request succeeds");
        await r.text();

        const parsed = JSON.parse(relay.received[0]!.toString("utf8"));
        const content = textOf((parsed.messages as { content: unknown }[])[0].content);
        assert.equal(findUnpaired(parsed), null, "clean body stays free of unpaired halves");
        assert.ok(content.includes(clean), "clean body content survives verbatim");
        assert.ok(!content.includes("\ufffd"), "the scrub introduced no U+FFFD into clean text");
    } finally {
        proxy.close();
        relay.server.close();
    }
});
