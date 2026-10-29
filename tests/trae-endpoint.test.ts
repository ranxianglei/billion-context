import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { _setStoreForTest, SessionStore } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #1295: a model endpoint on a non-standard path that speaks the Trae SOLO
// wire (openai-completions conversation inside a Trae envelope, answers in an
// SSE dialect with Trae's own frame names) must enter the compression pipeline
// once declared via modelEndpointPatterns, instead of being relayed
// byte-for-byte. Undeclared paths and unconvertible bodies must keep relaying.

const MODEL = "trae-dsv41";

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    forwards: Array<{ url: string; raw: string }>;
    proxy: http.Server;
    upstream: http.Server;
}

/** The dialect an upstream Trae backend answers with (WC-12c): frame names of
 *  its own, no space after the colon, no [DONE] sentinel. */
const TRAE_SSE = [
    'event:metadata\ndata:{"model":"' + MODEL + '","version":1}\n\n',
    'event:timing_cost\ndata:{"first_token_ms":120}\n\n',
    'event:output\ndata:{"response":"hi","reasoning_content":null,"tool_calls":null,"multimodal_contents":null,"phase":null}\n\n',
    'event:token_usage\ndata:{"prompt_tokens":11,"completion_tokens":4,"total_tokens":15,"cache_read_input_tokens":2,"cache_creation_input_tokens":0,"reasoning_tokens":0,"prompt_tokens_total":0}\n\n',
    'event:done\ndata:{"finish_reason":"stop"}\n\n',
].join("");

/** What a real Trae backend accepts: a streaming conversation whose message
 *  content is text parts only, mirroring the codec's convertibility rule so the
 *  fake backend answers SSE exactly when bili would have converted the body. */
function isTraeConversation(v: unknown): boolean {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const e = v as Record<string, unknown>;
    if (e.stream !== true || typeof e.model !== "string") return false;
    if (!Array.isArray(e.messages) || e.messages.length === 0) return false;
    return (e.messages as Array<Record<string, unknown>>).every((m) => {
        if (m === null || typeof m !== "object") return false;
        const c = m.content;
        if (c === null || c === undefined) return m.role === "assistant";
        if (typeof c === "string") return true;
        if (!Array.isArray(c)) return false;
        return c.every((p) => p !== null && typeof p === "object" && (p as Record<string, unknown>).type === "text");
    });
}

async function startRig(declared = true): Promise<Rig> {
    const forwards: Array<{ url: string; raw: string }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            forwards.push({ url: req.url ?? "", raw });
            let trae = false;
            try {
                trae = isTraeConversation(JSON.parse(raw));
            } catch { /* not json */ }
            if (trae) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(TRAE_SSE);
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(raw + "\n");
            }
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: {} },
        modelEndpoints: declared
            ? [{ match: `http://127.0.0.1:${upstreamPort}/api/agent/v3/llm_utils_chat`, wire: "trae" }]
            : [],
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: (proxy.address() as AddressInfo).port, upstreamPort, forwards, proxy, upstream };
}

/** A real Trae SOLO body (shape taken from the #1295 capture). */
const traeBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    stream: true,
    max_tokens: 64000,
    reasoning_effort: "extra_high",
    mode_type: 1,
    context_window_size: 1_000_000,
    prompt_max_tokens: 936_000,
    function: "solo_agent",
    config_name: MODEL,
    ...overrides,
});

const post = (rig: Rig, path: string, session: string, body: string) => fetch(
    `http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}${path}`,
    { method: "POST", headers: { "content-type": "application/json", "x-acp-session": session }, body },
);

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

test("#1295: declared trae endpoint — envelope unwrapped, Trae SSE back down", async () => {
    const rig = await startRig();
    try {
        const body = traeBody();
        const r = await post(rig, "/api/agent/v3/llm_utils_chat", "trae-sess", body);
        assert.equal(r.status, 200);
        const text = await r.text();
        assert.ok(text.includes("event:done"), `response must stay Trae SSE, got: ${text.slice(0, 300)}`);
        assert.ok(!text.includes("[DONE]"), "the Trae dialect has no [DONE] sentinel");
        assert.ok(!text.includes("data: "), "no space after the colon in Trae frames");
        const blocks = text.split("\n\n").filter((b) => b.trim().length > 0);
        assert.ok(blocks[blocks.length - 1].startsWith("event:done"), "the stream ends with a done frame");

        const fwd = rig.forwards.at(-1)!;
        assert.ok(fwd.url.startsWith("/api/agent/v3/llm_utils_chat"));
        assert.notEqual(fwd.raw, body, "a declared endpoint must be rebuilt by the pipeline, not relayed verbatim");
        const up = JSON.parse(fwd.raw) as Record<string, unknown>;
        // Envelope keys the flat body cannot carry ride along verbatim.
        assert.equal(up.function, "solo_agent");
        assert.equal(up.config_name, MODEL);
        assert.equal(up.mode_type, 1);
        assert.equal(up.context_window_size, 1_000_000);
        assert.equal(up.prompt_max_tokens, 936_000);
        assert.equal(up.stream, true);
        // ...and the rebuilt conversation is Trae-shaped again (text parts).
        const msgs = up.messages as Array<Record<string, unknown>>;
        assert.ok(Array.isArray(msgs) && msgs.length > 0);
        for (const m of msgs) {
            assert.ok(Array.isArray(m.content), `message content must be a parts array, got ${JSON.stringify(m.content)}`);
            for (const p of m.content as Array<Record<string, unknown>>) assert.equal(p.type, "text");
        }
        assert.ok(Array.isArray(up.tools) && up.tools.length > 0, "proxy tools ride inside the envelope");

        const s = listSessions().find((x) => x.id === "trae-sess");
        assert.equal(s?.stats.lastInputTokens, 11, "declared endpoint enters the pipeline (usage accounted)");
    } finally {
        await closeRig(rig);
    }
});

test("#1295: declared trae endpoint with a non-text part relays byte-for-byte", async () => {
    const rig = await startRig();
    try {
        const body = traeBody({
            messages: [{
                role: "user",
                content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }],
            }],
        });
        const r = await post(rig, "/api/agent/v3/llm_utils_chat", "trae-image", body);
        assert.equal(r.status, 200);
        const text = await r.text();
        const fwd = rig.forwards.at(-1)!;
        assert.equal(fwd.raw, body, "unconvertible bodies must reach upstream untouched");
        assert.ok(text.startsWith(body), "and the upstream reply passes through unmodified");
    } finally {
        await closeRig(rig);
    }
});

test("#1295: declared trae endpoint with a non-streaming body demotes to verbatim relay", async () => {
    const rig = await startRig();
    try {
        const body = traeBody({ stream: false });
        const r = await post(rig, "/api/agent/v3/llm_utils_chat", "trae-nostream", body);
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(rig.forwards.at(-1)!.raw, body, "non-streaming bodies are out of scope v1 — relayed verbatim");
    } finally {
        await closeRig(rig);
    }
});

test("#1295: an undeclared path with the same Trae body stays a verbatim relay", async () => {
    const rig = await startRig(false);
    try {
        const body = traeBody();
        const r = await post(rig, "/api/agent/v3/llm_utils_chat", "trae-undeclared", body);
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(rig.forwards.at(-1)!.raw, body, "without a declaration the body is relayed byte-for-byte");
        const s = listSessions().find((x) => x.id === "trae-undeclared");
        assert.ok(!s || s.stats.lastInputTokens === undefined, "undeclared path is never classified into the pipeline");
    } finally {
        await closeRig(rig);
    }
});
