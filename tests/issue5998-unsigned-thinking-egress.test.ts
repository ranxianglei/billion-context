// #5998: hosts whose transcripts store reasoning without signatures (DSH:
// {type,text} only) rebuild every turn with signature-less thinking blocks;
// signature-verifying upstreams (Anthropic proper) reject those with "thinking.
// signature: Field required" (#2501) — while never-signing relays (DeepSeek's
// /anthropic endpoint, #5495) require the unsigned thinking back VERBATIM
// ("must be passed back"). The two inbound histories are byte-identical, so no
// static rule can discriminate: the fix learns the upstream's personality at
// the relay egress seam (src/server/thinking-posture.ts), mirroring the #2645
// pck probe-and-remember discipline — first "Field required" 400 ⇒ one
// strip-and-resend probe; accepted ⇒ session remembers strict posture and later
// sends drop proactively; still failing ⇒ original 400 stands, nothing learned.
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
import { _resetSessionsForTest } from "../src/session.ts";
import type { Session } from "../src/session.js";
import { detectThinkingSignatureRejection, rememberStrictThinkingPosture, stripUnsignedThinkingFromWire, thinkingPostureIsStrict } from "../src/server/thinking-posture.js";

// ---------------------------------------------------------------------------
// detectThinkingSignatureRejection — the 400-wording gate
// ---------------------------------------------------------------------------

const FIELD_REQUIRED = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "messages.1.content.0.thinking.signature: Field required" },
});

test("#5998 detector: the pinned Anthropic 'Field required' wording matches", () => {
    assert.equal(detectThinkingSignatureRejection(400, FIELD_REQUIRED), true);
});

test("#5998 detector: 'missing' variants match too", () => {
    assert.equal(detectThinkingSignatureRejection(400, '{"error":{"message":"thinking signature is missing"}}'), true);
});

test("#5998 detector: #5495 mandatory-thinking wording NEVER matches (verbatim replay required there)", () => {
    assert.equal(detectThinkingSignatureRejection(400, '{"error":{"message":"The `content[].thinking` in the thinking mode must be passed back to the API."}}'), false);
});

test("#5998 detector: #1960 tamper wording NEVER matches (signed channel, KDD#10)", () => {
    assert.equal(detectThinkingSignatureRejection(400, '{"error":{"message":"Invalid signature: thinking blocks cannot be modified"}}'), false);
});

test("#5998 detector: unrelated 400s and non-400 statuses never match", () => {
    assert.equal(detectThinkingSignatureRejection(400, '{"error":{"message":"model not found"}}'), false);
    assert.equal(detectThinkingSignatureRejection(400, '{"error":{"message":"signature format invalid"}}'), false);
    assert.equal(detectThinkingSignatureRejection(500, FIELD_REQUIRED), false);
});

// ---------------------------------------------------------------------------
// stripUnsignedThinkingFromWire — the wire-level drop
// ---------------------------------------------------------------------------

function wire(messages: unknown[]): string {
    return JSON.stringify({ model: "claude-test", max_tokens: 1024, messages });
}

test("#5998 strip: unsigned thinking drops, signed sibling and text survive byte-exact", () => {
    const body = wire([
        { role: "user", content: "seed" },
        { role: "assistant", content: [
            { type: "thinking", thinking: "unsigned CoT" },
            { type: "thinking", thinking: "signed CoT", signature: "sig_A" },
            { type: "text", text: "hello" },
        ] },
        { role: "user", content: "continue" },
    ]);
    const out = stripUnsignedThinkingFromWire(body);
    assert.equal(out.removed, 1);
    const msgs = (JSON.parse(out.body) as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.deepEqual(msgs[1]?.content, [
        { type: "thinking", thinking: "signed CoT", signature: "sig_A" },
        { type: "text", text: "hello" },
    ]);
    assert.deepEqual(msgs[0], { role: "user", content: "seed" });
});

test("#5998 strip: redacted_thinking passes untouched (its data IS the payload)", () => {
    const body = wire([
        { role: "assistant", content: [
            { type: "redacted_thinking", data: "ZGF0YQ==" },
            { type: "thinking", thinking: "x" },
        ] },
    ]);
    const out = stripUnsignedThinkingFromWire(body);
    assert.equal(out.removed, 1);
    const msgs = (JSON.parse(out.body) as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.deepEqual(msgs[0]?.content, [{ type: "redacted_thinking", data: "ZGF0YQ==" }]);
});

test("#5998 strip: a pure-unsigned-thinking turn drops the whole message and repairs role alternation", () => {
    const body = wire([
        { role: "user", content: "a" },
        { role: "assistant", content: [{ type: "thinking", thinking: "only CoT" }] },
        { role: "user", content: "b" },
    ]);
    const out = stripUnsignedThinkingFromWire(body);
    assert.equal(out.removed, 1);
    const msgs = (JSON.parse(out.body) as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    // The drop leaves two adjacent user turns — they merge into ONE legal
    // message (string content becomes a text block), so alternation holds.
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
});

test("#5998 strip: clean body is a no-op returning the input string itself", () => {
    const body = wire([
        { role: "assistant", content: [{ type: "thinking", thinking: "ok", signature: "s" }, { type: "text", text: "t" }] },
    ]);
    const out = stripUnsignedThinkingFromWire(body);
    assert.equal(out.removed, 0);
    assert.equal(out.body, body);
});

test("#5998 strip: non-JSON and message-less bodies are no-ops (never guess)", () => {
    assert.deepEqual(stripUnsignedThinkingFromWire("not json"), { body: "not json", removed: 0 });
    assert.deepEqual(stripUnsignedThinkingFromWire("{}"), { body: "{}", removed: 0 });
    assert.deepEqual(stripUnsignedThinkingFromWire('{"tools":[]}'), { body: '{"tools":[]}', removed: 0 });
});

// ---------------------------------------------------------------------------
// posture get/set — session-scoped, no config surface
// ---------------------------------------------------------------------------

test("#5998 posture: absent by default, sticky once remembered, other keys untouched", () => {
    const s = { metadata: { otherKey: 1 } } as Pick<Session, "metadata">;
    assert.equal(thinkingPostureIsStrict(s), false);
    rememberStrictThinkingPosture(s);
    assert.equal(thinkingPostureIsStrict(s), true);
    assert.deepEqual(s.metadata.otherKey, 1);
});

// ---------------------------------------------------------------------------
// Full-proxy e2e: the relay egress seam against scripted upstream personalities
// ---------------------------------------------------------------------------

function anthropicSse(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicStream(): string {
    return (
        anthropicSse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 42 } } }) +
        anthropicSse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        anthropicSse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
        anthropicSse("content_block_stop", { type: "content_block_stop", index: 0 }) +
        anthropicSse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }) +
        anthropicSse("message_stop", { type: "message_stop" })
    );
}

type Personality = "lenient" | "strict" | "poisoned-signature" | "mandatory-thinking" | "tamper";

const WORDINGS: Record<Exclude<Personality, "lenient" | "strict">, string> = {
    "poisoned-signature": "messages.1.content.0.thinking.signature: Field required",
    "mandatory-thinking": "The `content[].thinking` in the thinking mode must be passed back to the API.",
    tamper: "Invalid signature: thinking blocks cannot be modified",
};

function bodyHasUnsignedThinking(raw: string): boolean {
    try {
        const p = JSON.parse(raw) as Record<string, unknown>;
        const msgs = p.messages;
        if (!Array.isArray(msgs)) return false;
        return msgs.some((m) => {
            if (typeof m !== "object" || m === null) return false;
            const msg = m as Record<string, unknown>;
            if (msg.role !== "assistant" || !Array.isArray(msg.content)) return false;
            return (msg.content as unknown[]).some((b) => {
                if (typeof b !== "object" || b === null) return false;
                const blk = b as Record<string, unknown>;
                return blk.type === "thinking" && !(typeof blk.signature === "string" && blk.signature.length > 0);
            });
        });
    } catch {
        return false;
    }
}

interface Rig {
    messagesUrl: () => string;
    upstreamBodies: string[];
    setPersonality(mode: Personality): void;
    closeAll(): Promise<void>;
}

async function startRig(): Promise<Rig> {
    const upstreamBodies: string[] = [];
    let personality: Personality = "lenient";
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            upstreamBodies.push(raw);
            const rejectWith = (message: string): void => {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
            };
            switch (personality) {
                case "strict":
                    if (bodyHasUnsignedThinking(raw)) rejectWith(WORDINGS["poisoned-signature"]);
                    break;
                case "poisoned-signature":
                    rejectWith(WORDINGS["poisoned-signature"]);
                    break;
                case "mandatory-thinking":
                    rejectWith(WORDINGS["mandatory-thinking"]);
                    break;
                case "tamper":
                    rejectWith(WORDINGS.tamper);
                    break;
                default:
                    break;
            }
            if (res.writableEnded) return;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(anthropicStream());
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    _resetSessionsForTest();
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: 100_000 } } } },
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
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const closeOne = (s: http.Server): Promise<void> =>
        new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
    return {
        messagesUrl: () => `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`,
        upstreamBodies,
        setPersonality: (mode) => { personality = mode; },
        closeAll: async () => {
            await closeOne(proxy);
            await closeOne(upstream);
        },
    };
}

// The DSH shape: reasoning stored without signatures, rebuilt into history.
function dshBody(sid: string): string {
    return JSON.stringify({
        model: "claude-test",
        max_tokens: 1024,
        prompt_cache_key: sid,
        messages: [
            { role: "user", content: "seed" },
            { role: "assistant", content: [
                { type: "thinking", thinking: "unsigned CoT" },
                { type: "text", text: "hello" },
            ] },
            { role: "user", content: "continue" },
        ],
    });
}

async function post(rig: Rig, sid: string): Promise<Response> {
    return fetch(rig.messagesUrl(), {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test" },
        body: dshBody(sid),
    });
}

test("#5998 e2e: strict upstream self-heals in one turn; later turns drop proactively", async () => {
    const rig = await startRig();
    try {
        rig.setPersonality("strict");
        // Turn 1: the send 400s, the probe strips the unsigned block and the
        // retry is accepted — the client never sees the 400.
        const r1 = await post(rig, "ts-strict-1");
        assert.equal(r1.status, 200);
        await r1.text();
        assert.equal(rig.upstreamBodies.length, 2);
        assert.equal(bodyHasUnsignedThinking(rig.upstreamBodies[0]!), true, "original attempt carried the unsigned block");
        assert.equal(bodyHasUnsignedThinking(rig.upstreamBodies[1]!), false, "probe dropped it");
        const retried = JSON.parse(rig.upstreamBodies[1]!) as Record<string, unknown>;
        const retriedContent = (retried.messages as Array<Record<string, unknown>>)[1]?.content as Array<Record<string, unknown>>;
        assert.equal(retriedContent.length, 1, "only the text sibling survives the drop");
        assert.equal(retriedContent[0].type, "text");
        // The egress text carries bili's ACP tag prefix (KDD#2) — check the tail.
        assert.ok(String(retriedContent[0].text).endsWith("hello"), "text sibling survived the drop");
        // Turn 2: posture learned — the drop happens BEFORE egress, so exactly
        // ONE upstream hit, already clean.
        const r2 = await post(rig, "ts-strict-1");
        assert.equal(r2.status, 200);
        await r2.text();
        assert.equal(rig.upstreamBodies.length, 3);
        assert.equal(bodyHasUnsignedThinking(rig.upstreamBodies[2]!), false, "proactive drop — no second 400 round trip");
    } finally {
        await rig.closeAll();
    }
});

test("#5998 e2e: lenient upstream keeps receiving unsigned thinking verbatim, nothing learned", async () => {
    const rig = await startRig();
    try {
        rig.setPersonality("lenient");
        for (let i = 0; i < 2; i++) {
            const r = await post(rig, "ts-lenient-1");
            assert.equal(r.status, 200);
            await r.text();
        }
        assert.equal(rig.upstreamBodies.length, 2, "no probe ever fired");
        for (const raw of rig.upstreamBodies) {
            assert.equal(bodyHasUnsignedThinking(raw), true, "unsigned thinking rides verbatim (never-signing relays need it, #5495)");
        }
    } finally {
        await rig.closeAll();
    }
});

test("#5998 e2e: persistent signature-wording 400 — probe inconclusive, original 400 forwarded, nothing learned", async () => {
    const rig = await startRig();
    try {
        rig.setPersonality("poisoned-signature");
        const r1 = await post(rig, "ts-poison-1");
        assert.equal(r1.status, 400);
        const t1 = await r1.text();
        assert.ok(t1.includes("Field required"), "original 400 stands verbatim");
        assert.equal(rig.upstreamBodies.length, 2, "original + one inconclusive probe");
        // The NEXT turn re-runs the experiment from scratch (still no posture).
        const r2 = await post(rig, "ts-poison-1");
        assert.equal(r2.status, 400);
        await r2.text();
        assert.equal(rig.upstreamBodies.length, 4);
        assert.equal(bodyHasUnsignedThinking(rig.upstreamBodies[2]!), true, "nothing was learned — turn 2 still sent the block first");
    } finally {
        await rig.closeAll();
    }
});

test("#5998 e2e: #5495 mandatory-thinking 400 never triggers the probe — verbatim replay preserved", async () => {
    const rig = await startRig();
    try {
        rig.setPersonality("mandatory-thinking");
        const r1 = await post(rig, "ts-mandatory-1");
        assert.equal(r1.status, 400);
        const t1 = await r1.text();
        assert.ok(t1.includes("must be passed back"), "DeepSeek's 400 reaches the client untouched");
        assert.equal(rig.upstreamBodies.length, 1, "NO probe — stripping here would manufacture the failure");
        assert.equal(bodyHasUnsignedThinking(rig.upstreamBodies[0]!), true, "unsigned thinking still rides verbatim");
    } finally {
        await rig.closeAll();
    }
});

test("#5998 e2e: #1960 tamper 400 never triggers the probe (signed channel, KDD#10)", async () => {
    const rig = await startRig();
    try {
        rig.setPersonality("tamper");
        const r1 = await post(rig, "ts-tamper-1");
        assert.equal(r1.status, 400);
        const t1 = await r1.text();
        assert.ok(t1.includes("cannot be modified"));
        assert.equal(rig.upstreamBodies.length, 1, "NO probe");
    } finally {
        await rig.closeAll();
    }
});
