import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #4124: an upstream with a per-prompt IMAGE-COUNT hard wall (vLLM
// --limit-mm-per-prompt and gateway equivalents) answers 400 "Too many images in
// request: N > M". bili used to forward that rejection verbatim: no vocab match
// (isOverflow false), nothing armed, nothing shed — a permanent 400 loop every
// round, with a byte-wall 413 cascade behind it (field: 165 > 30 across three
// independent providers, same shared model service). The fix adds:
//   D1. inspectContextOverflow detects the count wall on its OWN channel
//       (imageCountCap/imageCountSeen); isOverflow stays token/context-only —
//       a cap of tens must never ride the token-window channel (toTokenNumber
//       rejects <1000; that channel drives token-space shrink).
//   D2. shedWireImagesToCount — count-space twin of shedWireImages (rung A only;
//       downscaling cannot reduce count; the protected tail yields to the HARD
//       cap, unlike the soft WS byte budget).
//   D3. relay integration — same-request rescue through the #1195 seam (learn
//       per-origin + converge to cap−1 + re-send once), proactive pre-send
//       convergence for later requests, learn-on-passthrough when the rescue
//       cannot run, and the pck A/B probe skipping content-wall 400s.

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { inspectContextOverflow } from "../src/util.ts";
import { shedWireImagesToCount } from "../src/egress-shed.ts";

// ── D1: detection ─────────────────────────────────────────────────────────────

const vllmBareBody = (seen: number, cap: number): string =>
    `{"error":{"message":"Upstream request failed: [invalid_request_error] Too many images in request: ${seen} > ${cap}","type":"invalid_request_error","param":"","code":null}}`;
// The field wire form: gateways re-serialize error bodies with HTML-style
// escapes, so ">" arrives as the six characters \u003e inside the raw JSON text.
const vllmEscapedBody = (seen: number, cap: number): string =>
    `{"error":{"message":"Upstream request failed: [invalid_request_error] Too many images in request: ${seen} \\u003e ${cap}","type":"invalid_request_error","param":"","code":null}}`;

test("#4124 D1: vLLM image-count rejection is detected on its own channel (bare >)", () => {
    const info = inspectContextOverflow(400, vllmBareBody(165, 30));
    assert.equal(info.isOverflow, false, "an image-count wall is NOT a token overflow");
    assert.equal(info.imageCountCap, 30);
    assert.equal(info.imageCountSeen, 165);
});

test("#4124 D1: the gateway-escaped \\u003e wire form matches too", () => {
    const info = inspectContextOverflow(400, vllmEscapedBody(165, 30));
    assert.equal(info.imageCountCap, 30);
    assert.equal(info.imageCountSeen, 165);
});

test("#4124 D1: generic 'At most N image(s) may be provided' form (cap only)", () => {
    const plural = inspectContextOverflow(400, '{"error":{"message":"At most 30 images may be provided"}}');
    assert.equal(plural.isOverflow, false);
    assert.equal(plural.imageCountCap, 30);
    assert.equal(plural.imageCountSeen, undefined);
    const singular = inspectContextOverflow(400, '{"error":{"message":"At most 1 image may be provided"}}');
    assert.equal(singular.imageCountCap, 1);
});

test("#4124 D1: status gate — plausible statuses only", () => {
    assert.equal(inspectContextOverflow(200, vllmBareBody(5, 2)).imageCountCap, undefined, "200 is dark");
    assert.equal(inspectContextOverflow(418, vllmBareBody(5, 2)).imageCountCap, undefined, "418 is dark");
    assert.equal(inspectContextOverflow(413, vllmBareBody(5, 2)).imageCountCap, 2, "413 is plausible");
    assert.equal(inspectContextOverflow(502, vllmBareBody(5, 2)).imageCountCap, 2, "5xx relays are plausible (#2484 parity)");
});

test("#4124 D1: token overflows stay token-only; non-overflow bodies stay dark", () => {
    const token = inspectContextOverflow(400, '{"error":{"message":"maximum context length is 131072 tokens"}}');
    assert.equal(token.isOverflow, true);
    assert.equal(token.imageCountCap, undefined);
    // Bedrock throttle phrase ("too many tokens") must not light up either channel.
    const throttle = inspectContextOverflow(429, '{"error":{"message":"Too many tokens, please wait before trying again."}}');
    assert.equal(throttle.isOverflow, false);
    assert.equal(throttle.imageCountCap, undefined);
    assert.equal(inspectContextOverflow(400, '{"error":{"message":"Invalid API key"}}').imageCountCap, undefined);
    assert.equal(inspectContextOverflow(400, "触发限流，请降低并发").imageCountCap, undefined);
    // A degenerate cap (zero) is not a wall — refuse rather than shed everything.
    assert.equal(inspectContextOverflow(400, vllmBareBody(5, 0)).imageCountCap, undefined);
});

// ── D2: count-space shedding ──────────────────────────────────────────────────

const b64 = (i: number): string => "AAAA" + i.toString().padStart(8, "0");

function openaiBodyWithImages(n: number): string {
    return JSON.stringify({
        model: "gpt-test",
        messages: Array.from({ length: n }, (_, i) => ({
            role: "user",
            content: [
                { type: "text", text: `turn ${i}` },
                { type: "image_url", image_url: { url: `data:image/png;base64,${b64(i)}` } },
            ],
        })),
    });
}

function countOpenaiImages(body: string): number {
    const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown[] }> };
    let n = 0;
    for (const m of parsed.messages ?? []) {
        if (!Array.isArray(m.content)) continue;
        for (const p of m.content) if (typeof p === "object" && p !== null && (p as { type?: unknown }).type === "image_url") n++;
    }
    return n;
}

test("#4124 D2: over-cap sheds oldest-first down to maxImages (openai)", async () => {
    const body = openaiBodyWithImages(10); // protectFrom = 10 − 8 = 2
    const r = await shedWireImagesToCount(body, "openai", 2);
    assert.equal(r.stats.changed, true);
    assert.equal(r.stats.archived, 8);
    assert.equal(countOpenaiImages(r.body), 2);
    const parsed = JSON.parse(r.body) as { messages: Array<{ content: Array<{ type?: string; text?: unknown }> }> };
    assert.ok(parsed.messages[8].content.some((p) => p.type === "image_url"), "newest survives");
    assert.ok(parsed.messages[9].content.some((p) => p.type === "image_url"), "newest survives");
    assert.ok(!parsed.messages[0].content.some((p) => p.type === "image_url"), "oldest archived");
    assert.ok(String(parsed.messages[0].content[1].text).includes("omitted for size limit"), "stable placeholder note");
});

test("#4124 D2: deterministic — two runs on identical input produce identical bytes", async () => {
    const body = openaiBodyWithImages(10);
    const a = await shedWireImagesToCount(body, "openai", 2);
    const b = await shedWireImagesToCount(body, "openai", 2);
    assert.equal(a.body, b.body);
});

test("#4124 D2: under-cap bodies pass through byte-identical (gate negative direction)", async () => {
    const body = openaiBodyWithImages(2);
    const atCap = await shedWireImagesToCount(body, "openai", 2);
    assert.equal(atCap.stats.changed, false);
    assert.equal(atCap.body, body);
    const under = await shedWireImagesToCount(openaiBodyWithImages(1), "openai", 2);
    assert.equal(under.stats.changed, false);
    assert.equal(under.body, openaiBodyWithImages(1));
});

test("#4124 D2: the protected tail YIELDS to the hard cap (all images in-tail)", async () => {
    const body = openaiBodyWithImages(4); // 4 entries are all inside the tail of 8
    const r = await shedWireImagesToCount(body, "openai", 1);
    assert.equal(r.stats.archived, 3);
    assert.equal(countOpenaiImages(r.body), 1);
    const parsed = JSON.parse(r.body) as { messages: Array<{ content: Array<{ type?: string }> }> };
    assert.ok(parsed.messages[3].content.some((p) => p.type === "image_url"), "the newest one survives");
});

test("#4124 D2: maxImages=0 archives every archivable image", async () => {
    const r = await shedWireImagesToCount(openaiBodyWithImages(3), "openai", 0);
    assert.equal(r.stats.archived, 3);
    assert.equal(countOpenaiImages(r.body), 0);
});

test("#4124 D2: anthropic protocol shape", async () => {
    const body = JSON.stringify({
        model: "claude-test",
        messages: Array.from({ length: 5 }, (_, i) => ({
            role: "user",
            content: [
                { type: "text", text: `t${i}` },
                { type: "image", source: { type: "base64", media_type: "image/png", data: b64(i) } },
            ],
        })),
    });
    const r = await shedWireImagesToCount(body, "anthropic", 2);
    assert.equal(r.stats.changed, true);
    assert.equal(r.stats.archived, 3);
    const parsed = JSON.parse(r.body) as { messages: Array<{ content: Array<{ type?: string }> }> };
    const remaining = parsed.messages.filter((m) => m.content.some((p) => p.type === "image")).length;
    assert.equal(remaining, 2);
});

test("#4124 D2: responses protocol shape", async () => {
    const body = JSON.stringify({
        model: "gpt-test",
        input: Array.from({ length: 5 }, (_, i) => ({
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: `t${i}` },
                { type: "input_image", image_url: `data:image/png;base64,${b64(i)}` },
            ],
        })),
    });
    const r = await shedWireImagesToCount(body, "responses", 2);
    assert.equal(r.stats.archived, 3);
    const parsed = JSON.parse(r.body) as { input: Array<{ content?: unknown[] }> };
    let remaining = 0;
    for (const item of parsed.input) {
        if (!Array.isArray(item.content)) continue;
        for (const p of item.content) if ((p as { type?: unknown }).type === "input_image") remaining++;
    }
    assert.equal(remaining, 2);
});

test("#4124 D2: google protocol shape", async () => {
    const body = JSON.stringify({
        contents: Array.from({ length: 5 }, (_, i) => ({
            parts: [
                { text: `t${i}` },
                { inlineData: { mimeType: "image/png", data: b64(i) } },
            ],
        })),
    });
    const r = await shedWireImagesToCount(body, "google", 2);
    assert.equal(r.stats.archived, 3);
    const parsed = JSON.parse(r.body) as { contents: Array<{ parts: Array<{ inlineData?: unknown }> }> };
    const remaining = parsed.contents.filter((c) => c.parts.some((p) => p.inlineData !== undefined)).length;
    assert.equal(remaining, 2);
});

test("#4124 D2: read_original_image outputs stay exempt (best-effort boundary)", async () => {
    const body = JSON.stringify({
        model: "gpt-test",
        input: [
            { type: "function_call", call_id: "c1", name: "acp_read_original_image", arguments: "{}" },
            { type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: `data:image/png;base64,${b64(99)}` }] },
            ...Array.from({ length: 3 }, (_, i) => ({
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: `t${i}` }, { type: "input_image", image_url: `data:image/png;base64,${b64(i)}` }],
            })),
        ],
    });
    const r = await shedWireImagesToCount(body, "responses", 1);
    assert.equal(r.stats.archived, 2, "only the two oldest ARCHIVABLE images go");
    const parsed = JSON.parse(r.body) as { input: Array<Record<string, unknown>> };
    const out = parsed.input.find((x) => x.type === "function_call_output")!;
    assert.ok(JSON.stringify(out.output).includes(b64(99)), "the exempt output rides untouched");
});

test("#4124 D2: unparseable bodies and no-image bodies pass through unchanged", async () => {
    const bad = await shedWireImagesToCount("not json at all", "openai", 0);
    assert.equal(bad.body, "not json at all");
    assert.equal(bad.stats.changed, false);
    const plain = openaiBodyWithImages(0);
    const r = await shedWireImagesToCount(plain, "openai", 0);
    assert.equal(r.body, plain);
});

test("#4124 D2: placeholders quote the resolved mNNNNN ref", async () => {
    const r = await shedWireImagesToCount(openaiBodyWithImages(3), "openai", 1, { resolveRef: async () => "m00012" });
    assert.ok(r.body.includes("m00012"));
    assert.ok(r.body.includes("omitted for size limit"));
});

// ── D3: relay integration (real startServer + scripted mock upstream) ─────────

const OK_BODY = JSON.stringify({
    id: "c1",
    object: "chat.completion",
    created: 1,
    model: "gpt-test",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
});

function imagesMsgs(n: number): Array<{ role: string; content: unknown[] }> {
    return Array.from({ length: n }, (_, i) => ({
        role: "user",
        content: [
            { type: "text", text: `turn ${i}` },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64(i)}` } },
        ],
    }));
}

interface Rig {
    post(messages: unknown[], extra?: Record<string, unknown>): Promise<Response>;
    upstreamBodies: string[];
    logs: string[];
    close(): Promise<void>;
}

async function startRig(script: Array<{ status: number; body: string }>): Promise<Rig> {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _resetSessionsForTest();
    const upstreamBodies: string[] = [];
    let call = 0;
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
            const step = script[Math.min(call, script.length - 1)];
            call++;
            res.writeHead(step.status, { "content-type": "application/json" });
            res.end(step.body);
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 100_000 } } } },
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const post = (messages: unknown[], extra: Record<string, unknown> = {}): Promise<Response> =>
        fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "sess-4124" },
            body: JSON.stringify({ model: "gpt-test", max_tokens: 1024, stream: false, messages, ...extra }),
        });
    const close = async (): Promise<void> => {
        setLogCapture(null);
        await new Promise<void>((r) => proxy.close(() => r()));
        await new Promise<void>((r) => upstream.close(() => r()));
    };
    return { post, upstreamBodies, logs, close };
}

test("#4124 D3a: image-count 400 → learn + same-request converge-to-cap−1 + re-send (client sees success)", async () => {
    const rig = await startRig([
        { status: 400, body: vllmEscapedBody(5, 2) },
        { status: 200, body: OK_BODY },
    ]);
    try {
        const r = await rig.post(imagesMsgs(5));
        assert.equal(r.status, 200, "the same-request rescue answers the client with success, not the 400");
        await r.text();
        assert.equal(rig.upstreamBodies.length, 2, "one rejected send + one converged re-send");
        assert.equal(countOpenaiImages(rig.upstreamBodies[0]), 5, "the first send carried all five");
        assert.equal(countOpenaiImages(rig.upstreamBodies[1]), 1, "the re-send carries cap−1 = 1 image");
        const s = listSessions().find((x) => x.stats.imageCountCaps && Object.keys(x.stats.imageCountCaps).length > 0);
        assert.ok(s, "a session exists with a learned per-origin cap");
        assert.deepEqual(Object.values(s!.stats.imageCountCaps!), [2]);
        assert.ok(
            rig.logs.some((l) => l.includes("image-count overflow (upstream cap 2") && l.includes("re-sent within the same request")),
            "structured info line names cap, archived count and outcome",
        );
        assert.ok(!rig.logs.some((l) => l.includes("[pck]")), "no pck activity without a key");
    } finally {
        await rig.close();
    }
});

test("#4124 D3b: the learned cap converges PRE-SEND on the next request (no rejected round-trip)", async () => {
    const rig = await startRig([
        { status: 400, body: vllmEscapedBody(5, 2) },
        { status: 200, body: OK_BODY },
        { status: 200, body: OK_BODY },
    ]);
    try {
        const first = await rig.post(imagesMsgs(5));
        assert.equal(first.status, 200);
        await first.text();
        assert.equal(rig.upstreamBodies.length, 2, "turn one needed the reactive rescue");
        const second = await rig.post(imagesMsgs(4));
        assert.equal(second.status, 200);
        await second.text();
        assert.equal(rig.upstreamBodies.length, 3, "turn two sent exactly ONE request — proactive convergence, no 400 round-trip");
        assert.equal(countOpenaiImages(rig.upstreamBodies[2]), 1, "the outbound copy was converged to cap−1 before send");
        assert.ok(rig.logs.some((l) => l.includes("[image-count-shed] pre-send")), "pre-send shed logged with archive count");
    } finally {
        await rig.close();
    }
});

test("#4124 D3c: the pck A/B probe skips content-wall 400s (key survives; the image rescue owns the retry)", async () => {
    const rig = await startRig([
        { status: 400, body: vllmBareBody(3, 2) },
        { status: 200, body: OK_BODY },
    ]);
    try {
        const r = await rig.post(imagesMsgs(3), { prompt_cache_key: "k1" });
        assert.equal(r.status, 200);
        await r.text();
        assert.equal(rig.upstreamBodies.length, 2, "exactly one retry — the image rescue's, not a probe's");
        const second = JSON.parse(rig.upstreamBodies[1]) as Record<string, unknown>;
        assert.equal(second.prompt_cache_key, "k1", "the key-less A/B probe did NOT consume the retry");
        assert.equal(countOpenaiImages(rig.upstreamBodies[1]), 1, "the retry is CONVERGED (cap−1), not the untouched key-less ablation (all 3)");
        assert.ok(rig.logs.some((l) => l.includes("[pck] 400 names a content wall")), "skip logged at debug");
        assert.ok(!rig.logs.some((l) => l.includes("egress carried prompt_cache_key")), "no false key-causation recorded");
    } finally {
        await rig.close();
    }
});
