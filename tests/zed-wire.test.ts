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
import { rewrapZedEnvelope, unwrapZedEnvelope } from "../src/zed-wire.ts";
import { preferZedThreadIdIdentity, type ConversationIdentity } from "../src/session-id.ts";

// zed cloud wire: cloud.zed.dev POSTs the provider request nested in a
// `{thread_id, prompt_id, provider, model, provider_request}` envelope to
// /completions. bili unwraps it into the standard provider wire (session keyed
// by the envelope thread_id), runs the pipeline, rewraps at egress, and passes
// the NDJSON response through byte-for-byte.

const MODEL = "claude-sonnet-4-5";

const anthropicInner = (overrides: Record<string, unknown> = {}) => ({
    model: MODEL,
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "hello zed" }] }],
    ...overrides,
});

const zedEnvelope = (inner: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
    thread_id: "zed-thread-001",
    prompt_id: "zed-prompt-001",
    provider: "anthropic",
    model: inner.model,
    provider_request: inner,
    ...overrides,
});

// ---- codec unit tests ------------------------------------------------------

test("zed codec: anthropic envelope round-trips verbatim", () => {
    const inner = anthropicInner();
    const envelope = zedEnvelope(inner, { priority: "interactive" });
    const unwrapped = unwrapZedEnvelope(envelope as Record<string, unknown>);
    assert.ok(unwrapped, "valid envelope must unwrap");
    assert.equal(unwrapped!.provider, "anthropic");
    assert.equal(unwrapped!.threadId, "zed-thread-001");
    assert.equal(unwrapped!.promptId, "zed-prompt-001");
    assert.equal(unwrapped!.meta.model, MODEL);
    assert.equal(unwrapped!.meta.rest.priority, "interactive");
    assert.deepEqual(rewrapZedEnvelope(inner, unwrapped!.meta), envelope);
});

test("zed codec: rewrap tracks a pipeline-rewritten inner model", () => {
    const envelope = zedEnvelope(anthropicInner());
    const unwrapped = unwrapZedEnvelope(envelope as Record<string, unknown>);
    const inner2 = { ...anthropicInner(), model: "claude-sonnet-4-6" };
    const out = rewrapZedEnvelope(inner2, unwrapped!.meta) as Record<string, unknown>;
    assert.equal(out.model, "claude-sonnet-4-6");
    assert.equal((out.provider_request as Record<string, unknown>).model, "claude-sonnet-4-6");
    assert.equal(out.thread_id, "zed-thread-001");
});

test("zed codec: garbage envelope fields pass through verbatim", () => {
    const envelope = zedEnvelope(anthropicInner(), { thread_id: 42 as unknown });
    const unwrapped = unwrapZedEnvelope(envelope as Record<string, unknown>);
    assert.ok(unwrapped, "non-string thread_id is tolerated at unwrap (no identity claim)");
    assert.equal(unwrapped!.threadId, undefined);
    assert.deepEqual(rewrapZedEnvelope(anthropicInner(), unwrapped!.meta), envelope);
});

test("zed codec: rejects every unconvertible shape (strict fidelity)", () => {
    const base = zedEnvelope(anthropicInner());
    assert.equal(unwrapZedEnvelope({ ...base, provider: "azure" } as Record<string, unknown>), undefined);
    assert.equal(unwrapZedEnvelope({ ...base, provider: 7 } as Record<string, unknown>), undefined);
    assert.equal(unwrapZedEnvelope({ ...base, provider_request: "nope" } as Record<string, unknown>), undefined);
    assert.equal(unwrapZedEnvelope({ ...base, provider_request: [1] } as Record<string, unknown>), undefined);
    assert.equal(unwrapZedEnvelope({ ...base, provider_request: undefined } as Record<string, unknown>), undefined);
    // arm-shape gates
    const noMsgs = zedEnvelope({ model: MODEL, stream: true }, {});
    assert.equal(unwrapZedEnvelope(noMsgs as Record<string, unknown>), undefined);
    assert.equal(unwrapZedEnvelope(zedEnvelope({ model: MODEL, messages: [] }) as Record<string, unknown>), undefined);
    const xai = zedEnvelope({ model: "grok-4", messages: [{ role: "user", content: "hi" }] }, { provider: "x_ai" });
    assert.equal(unwrapZedEnvelope(xai as Record<string, unknown>)?.provider, "x_ai");
    const oai = zedEnvelope({ model: "gpt-5", input: [{ role: "user", content: "hi" }] }, { provider: "open_ai" });
    assert.equal(unwrapZedEnvelope(oai as Record<string, unknown>)?.provider, "open_ai");
    const oaiNoInput = zedEnvelope({ model: "gpt-5" }, { provider: "open_ai" });
    assert.equal(unwrapZedEnvelope(oaiNoInput as Record<string, unknown>), undefined);
    const goog = zedEnvelope({ systemInstruction: "be nice", contents: [{ role: "user", parts: [{ text: "hi" }] }] }, { provider: "google" });
    assert.equal(unwrapZedEnvelope(goog as Record<string, unknown>)?.provider, "google");
    const googNoContents = zedEnvelope({ systemInstruction: "be nice" }, { provider: "google" });
    assert.equal(unwrapZedEnvelope(googNoContents as Record<string, unknown>), undefined);
});

// ---- identity unit tests ---------------------------------------------------

const fingerprint = (value: string): ConversationIdentity => ({ value, source: "content-fingerprint", clientProvided: false });
const headerId = (value: string): ConversationIdentity => ({ value, source: "header", clientProvided: true });

test("zed identity: thread_id promotes over the content fingerprint only", () => {
    const promoted = preferZedThreadIdIdentity(fingerprint("fp-abc"), "zed-thread-001");
    assert.deepEqual(promoted, { value: "zed-thread-001", source: "zed-thread-id", clientProvided: true });
    // a roster header stays stronger — the promotion guard (preferPromptCacheKeyIdentity pattern)
    assert.deepEqual(preferZedThreadIdIdentity(headerId("hdr-1"), "zed-thread-001"), headerId("hdr-1"));
    const bodySession: ConversationIdentity = { value: "bs-1", source: "body-session", clientProvided: true };
    assert.deepEqual(preferZedThreadIdIdentity(bodySession, "zed-thread-001"), bodySession);
    const pck: ConversationIdentity = { value: "pck-1", source: "prompt-cache-key", clientProvided: true };
    assert.deepEqual(preferZedThreadIdIdentity(pck, "zed-thread-001"), pck);
    // no usable thread_id -> the fingerprint (or 400-anonymous policy) stands
    assert.deepEqual(preferZedThreadIdIdentity(fingerprint("fp-abc"), null), fingerprint("fp-abc"));
    assert.deepEqual(preferZedThreadIdIdentity(fingerprint("fp-abc"), "   "), fingerprint("fp-abc"));
    assert.deepEqual(preferZedThreadIdIdentity(fingerprint("fp-abc"), 42), fingerprint("fp-abc"));
    assert.equal(preferZedThreadIdIdentity(undefined, "zed-thread-001"), undefined);
});

// ---- handle() lane tests ---------------------------------------------------

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    forwards: Array<{ url: string; raw: string }>;
    proxy: http.Server;
    upstream: http.Server;
}

const NDJSON_RESPONSE = [
    '{"status":"queued","position":0}',
    '{"status":"started"}',
    '{"event":{"type":"message_start"}}',
    '{"status":"stream_ended"}',
].join("\n") + "\n";

async function startRig(): Promise<Rig> {
    const forwards: Array<{ url: string; raw: string }> = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            forwards.push({ url: req.url ?? "", raw });
            let zedInner = false;
            try {
                const e = JSON.parse(raw) as any;
                zedInner = typeof e?.provider === "string" && typeof e?.provider_request === "object"
                    && Array.isArray(e?.provider_request?.messages);
            } catch { /* not json */ }
            if (zedInner) {
                res.writeHead(200, { "content-type": "application/x-ndjson" });
                res.end(NDJSON_RESPONSE);
            } else {
                // echo non-conversation bytes so verbatim-relay assertions compare exactly
                res.writeHead(200, { "content-type": "application/json" });
                res.end(raw);
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

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    await once(rig.proxy, "close");
    rig.upstream.close();
    await once(rig.upstream, "close");
}

async function postZed(rig: Rig, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
    const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
}

test("zed lane: envelope unwrapped upstream, passthrough back down, session keyed by thread_id", async () => {
    const rig = await startRig();
    try {
        const out = await postZed(rig, zedEnvelope(anthropicInner()));
        assert.equal(out.status, 200);

        const fwd = rig.forwards.at(-1)!;
        assert.ok(fwd.url.startsWith("/completions"));
        const up = JSON.parse(fwd.raw);
        // the egress rewraps: the real upstream IS zed's cloud endpoint, so it
        // must see the ENVELOPE again — with the ACP-tagged inner inside
        assert.equal(up.thread_id, "zed-thread-001");
        assert.equal(up.prompt_id, "zed-prompt-001");
        assert.equal(up.provider, "anthropic");
        assert.equal(up.model, MODEL);
        const inner = up.provider_request;
        assert.ok(inner && typeof inner === "object", "rewrapped envelope must carry the provider wire in provider_request");
        assert.ok(Array.isArray(inner.messages) && inner.messages.length === 1);
        assert.ok(fwd.raw.includes("<acp tokens="), "request-side ACP processing must run inside the envelope (proxy mode)");
        // response: NDJSON bytes must pass through untouched
        assert.equal(out.text, NDJSON_RESPONSE, "NDJSON response must be byte-for-byte passthrough");
        assert.equal(fwd.raw.includes("x-bili-zed-lane"), false, "the zed marker header must not leak upstream");

        const sess = listSessions().find((s) => s.id === "zed-thread-001");
        assert.ok(sess, `session must be keyed by the envelope thread_id; sessions: ${listSessions().map((s) => s.id).join(",")}`);
    } finally {
        await closeRig(rig);
    }
});

test("zed lane: distinct thread_ids are distinct sessions (subagent isolation)", async () => {
    const rig = await startRig();
    try {
        const inner = anthropicInner();
        const a = await postZed(rig, zedEnvelope(inner, { thread_id: "zed-thread-A" }));
        assert.equal(a.status, 200);
        const b = await postZed(rig, zedEnvelope(anthropicInner({ messages: [{ role: "user", content: [{ type: "text", text: "different subagent work" }] }] }), { thread_id: "zed-thread-B" }));
        assert.equal(b.status, 200);
        const ids = listSessions().map((s) => s.id).sort();
        assert.ok(ids.includes("zed-thread-A"), `sessions: ${ids.join(",")}`);
        assert.ok(ids.includes("zed-thread-B"), `sessions: ${ids.join(",")}`);
        assert.equal(listSessions().find((s) => s.id === "zed-thread-A")?.stats.requests, 1, "thread A must have exactly its own single turn");
        assert.equal(listSessions().find((s) => s.id === "zed-thread-B")?.stats.requests, 1, "thread B must have exactly its own single turn");
    } finally {
        await closeRig(rig);
    }
});

test("zed lane: a roster conversation header beats the envelope thread_id", async () => {
    const rig = await startRig();
    try {
        const out = await postZed(rig, zedEnvelope(anthropicInner(), { thread_id: "zed-thread-HDR" }), { "x-session-id": "hdr-wins" });
        assert.equal(out.status, 200);
        const ids = listSessions().map((s) => s.id);
        assert.ok(ids.includes("hdr-wins"), `header identity must win: ${ids.join(",")}`);
        assert.ok(!ids.includes("zed-thread-HDR"), `thread_id must NOT claim a session when a header stated one: ${ids.join(",")}`);
    } finally {
        await closeRig(rig);
    }
});

test("zed lane: ambiguous envelope body relays verbatim (never a partial conversion)", async () => {
    const rig = await startRig();
    try {
        const bad = zedEnvelope({ model: MODEL }, { thread_id: "zed-thread-AMBIG" }); // no messages -> codec rejects
        const original = JSON.stringify(bad);
        const out = await postZed(rig, bad);
        assert.equal(out.status, 200);
        assert.equal(out.text, original, "rejected envelope must round-trip byte-for-byte");
        const fwd = rig.forwards.at(-1)!;
        assert.equal(fwd.raw, original);
        assert.equal(listSessions().find((s) => s.id === "zed-thread-AMBIG"), undefined, "no session may be created for an unconvertible body");
    } finally {
        await closeRig(rig);
    }
});

test("zed lane: envelope-shaped body on /chat/completions is NOT the zed wire", async () => {
    const rig = await startRig();
    try {
        // same envelope fields, but a standard openai chat body — the path must
        // not be misclassified as zed (/chat/completions endsWith /completions)
        const body = zedEnvelope({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true }, { thread_id: "zed-thread-CC" });
        const original = JSON.stringify(body);
        const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-session-id": "not-zed" },
            body: original,
        });
        assert.equal(r.status, 200);
        const fwd = rig.forwards.at(-1)!;
        // no messages at the TOP level of this body -> the openai arm relays it
        // verbatim (#1284); the crucial negative: NO zed unwrap/rewrap happened
        assert.equal(fwd.raw, original, "/chat/completions must not treat the envelope as a zed wire");
        assert.equal(listSessions().find((s) => s.id === "zed-thread-CC"), undefined, "no zed-thread session may exist for a /chat/completions request");
    } finally {
        await closeRig(rig);
    }
});
