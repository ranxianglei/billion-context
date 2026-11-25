import test from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import * as http from "node:http";
import { createOmpDirectSendGuard, stampPromptCacheKey } from "../src/agent/pi.ts";
import { withRestoredBody } from "../src/agent/native-intercept.ts";

// The omp plugin stamps the session id as a top-level prompt_cache_key while a
// proxy is claimed (BILLION_CONTEXT_PROXY). The proxy strips it before it
// forwards. When one request then degrades to a direct send (proxy not ready,
// or its respawn failed) the claim is still set, so the body was stamped, but
// no proxy strips it: a strict upstream (Anthropic Messages) answers 400
// "prompt_cache_key: Extra inputs are not permitted". The omp direct-send
// guard must drop the stamp it added — and only that.

const INTERCEPT_FLAG = Symbol.for("billion-context.native-fetch-intercept");
const PROXY_ORIGIN = "http://127.0.0.1:36011";
const URL_MESSAGES = "http://127.0.0.1:8199/v1/messages";

function withNativeClaim<T>(fn: () => T): T {
    const g = globalThis as Record<PropertyKey, unknown>;
    const prevFlag = g[INTERCEPT_FLAG];
    const prevProxy = process.env.BILLION_CONTEXT_PROXY;
    g[INTERCEPT_FLAG] = true;
    process.env.BILLION_CONTEXT_PROXY = PROXY_ORIGIN;
    try {
        return fn();
    } finally {
        if (prevFlag === undefined) delete g[INTERCEPT_FLAG];
        else g[INTERCEPT_FLAG] = prevFlag;
        if (prevProxy === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prevProxy;
    }
}

function stampedBody(sessionId: string): Record<string, unknown> {
    const ctx = { model: { baseUrl: "http://127.0.0.1:8199/v1" }, sessionManager: { getSessionId: () => sessionId } };
    const event = { type: "before_provider_request", payload: { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] } };
    const out = withNativeClaim(() => stampPromptCacheKey(event, ctx, "omp"));
    assert.equal(out?.prompt_cache_key, sessionId, "fixture: the plugin stamps the session id");
    return out!;
}

test("direct send drops the prompt_cache_key the plugin stamped", async () => {
    const body = stampedBody("sess-direct-1");
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, { method: "POST", body: JSON.stringify(body) });
    assert.equal(prep.outcome, "restored");
    const sent = JSON.parse((prep as { body: string }).body) as Record<string, unknown>;
    assert.equal("prompt_cache_key" in sent, false);
    assert.deepEqual(sent, { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
});

test("direct send keeps a prompt_cache_key the plugin did not stamp", async () => {
    stampedBody("sess-direct-2");
    const own = { model: "m", messages: [{ role: "user", content: "hi" }], prompt_cache_key: "host-own-key" };
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, { method: "POST", body: JSON.stringify(own) });
    assert.equal(prep.outcome, "as-is");
});

test("direct send leaves a body without prompt_cache_key untouched", async () => {
    const plain = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, { method: "POST", body: plain });
    assert.equal(prep.outcome, "as-is");
});

test("a non-JSON body stays as-is", async () => {
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, { method: "POST", body: "not json" });
    assert.equal(prep.outcome, "as-is");
});

// #7698: omp's Anthropic client sends the model body as a gzip-encoded
// Uint8Array with content-encoding: gzip. The guard must DECODE the body before
// stripping the stamped prompt_cache_key (a TextDecoder over the compressed
// bytes is garbage, so JSON.parse failed and the key survived into a strict
// upstream — 400 "prompt_cache_key: Extra inputs are not permitted"), then
// re-encode the stripped body to the SAME coding so the content-encoding header
// stays valid.

function encodedBodyInit(body: Record<string, unknown>, encode: (b: Buffer) => Buffer, encoding: string): RequestInit {
    const json = Buffer.from(JSON.stringify(body), "utf8");
    return { method: "POST", headers: { "content-encoding": encoding, "content-type": "application/json" }, body: new Uint8Array(encode(json)) };
}

test("gzip body: the stamped prompt_cache_key is stripped and the body re-encoded to gzip", async () => {
    const body = stampedBody("sess-gzip-1");
    const init = encodedBodyInit(body, (b) => zlib.gzipSync(b), "gzip");
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, init);
    assert.equal(prep.outcome, "restored");
    assert.ok(prep.body instanceof Uint8Array, "re-encoded body is a Uint8Array (gzip)");
    const decoded = JSON.parse(zlib.gunzipSync(Buffer.from(prep.body)).toString("utf8")) as Record<string, unknown>;
    assert.equal("prompt_cache_key" in decoded, false);
    assert.deepEqual(decoded, { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
});

test("gzip body: a prompt_cache_key the plugin did not stamp is left as-is", async () => {
    stampedBody("sess-gzip-2");
    const own = { model: "m", messages: [{ role: "user", content: "hi" }], prompt_cache_key: "host-own-key" };
    const init = encodedBodyInit(own, (b) => zlib.gzipSync(b), "gzip");
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, init);
    assert.equal(prep.outcome, "as-is");
});

test("deflate body: the stamped prompt_cache_key is stripped and the body re-encoded to deflate", async () => {
    const body = stampedBody("sess-deflate-1");
    const init = encodedBodyInit(body, (b) => zlib.deflateSync(b), "deflate");
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, init);
    assert.equal(prep.outcome, "restored");
    assert.ok(prep.body instanceof Uint8Array, "re-encoded body is a Uint8Array (deflate)");
    const decoded = JSON.parse(zlib.inflateSync(Buffer.from(prep.body)).toString("utf8")) as Record<string, unknown>;
    assert.equal("prompt_cache_key" in decoded, false);
    assert.deepEqual(decoded, { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
});

test("br body: the stamped prompt_cache_key is stripped and the body re-encoded to br", async () => {
    const body = stampedBody("sess-br-1");
    const init = encodedBodyInit(body, (b) => zlib.brotliCompressSync(b), "br");
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, init);
    assert.equal(prep.outcome, "restored");
    assert.ok(prep.body instanceof Uint8Array, "re-encoded body is a Uint8Array (br)");
    const decoded = JSON.parse(zlib.brotliDecompressSync(Buffer.from(prep.body)).toString("utf8")) as Record<string, unknown>;
    assert.equal("prompt_cache_key" in decoded, false);
    assert.deepEqual(decoded, { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
});

test("corrupt gzip body: the guard fails open (as-is, the key survives)", async () => {
    const body = stampedBody("sess-gzip-corrupt");
    const json = Buffer.from(JSON.stringify(body), "utf8");
    // A valid gzip header followed by garbage — gunzipSync throws.
    const corrupt = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from("garbage-not-gzip")]);
    void json;
    const init: RequestInit = { method: "POST", headers: { "content-encoding": "gzip", "content-type": "application/json" }, body: new Uint8Array(corrupt) };
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, URL_MESSAGES, init);
    assert.equal(prep.outcome, "as-is", "undecodable body → fail open, the shared guard's verdict stands");
});

test("gzip body via a Request object: the stamped key is stripped", async () => {
    const body = stampedBody("sess-gzip-req");
    const json = Buffer.from(JSON.stringify(body), "utf8");
    const gz = zlib.gzipSync(json);
    const req = new Request(URL_MESSAGES, { method: "POST", headers: { "content-encoding": "gzip", "content-type": "application/json" }, body: gz });
    const prep = await createOmpDirectSendGuard()(URL_MESSAGES, req, undefined);
    assert.equal(prep.outcome, "restored");
    assert.ok(prep.body instanceof Uint8Array, "re-encoded body is a Uint8Array (gzip)");
    const decoded = JSON.parse(zlib.gunzipSync(Buffer.from(prep.body)).toString("utf8")) as Record<string, unknown>;
    assert.equal("prompt_cache_key" in decoded, false);
    assert.deepEqual(decoded, { model: "m", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
});

// #7698 review: the re-encoded body is a different size than the original, so a
// content-length the CLIENT set is stale — undici throws
// UND_ERR_REQ_CONTENT_LENGTH_MISMATCH on an explicit stale value and the
// degraded send dies locally. withRestoredBody must drop it so fetch measures
// the new body. Regression: the wire content-length must equal the re-encoded
// size, and the key must be stripped.
test("re-encoded body: a client-set content-length is dropped so the wire length matches", async () => {
    const server = http.createServer((r, s) => {
        const chunks: Buffer[] = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
            const actual = Buffer.concat(chunks).length;
            const decoded = JSON.parse(zlib.gunzipSync(Buffer.concat(chunks)).toString("utf8")) as Record<string, unknown>;
            s.end(JSON.stringify({ declared: r.headers["content-length"], actual, hasKey: "prompt_cache_key" in decoded }));
            server.close();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/v1/messages`;
    try {
        const body = stampedBody("sess-gzip-cl");
        const json = Buffer.from(JSON.stringify(body), "utf8");
        const gz = zlib.gzipSync(json);
        const req = new Request(url, { method: "POST", headers: { "content-encoding": "gzip", "content-type": "application/json", "content-length": String(gz.length) }, body: gz });
        const prep = await createOmpDirectSendGuard()(url, req, undefined);
        assert.equal(prep.outcome, "restored");
        assert.ok(prep.body instanceof Uint8Array);
        const reencoded = prep.body;
        assert.notEqual(reencoded.length, gz.length, "fixture: stripping the key changes the compressed size");
        const dispatch = withRestoredBody(req, undefined, reencoded);
        const resp = await fetch(dispatch.input, dispatch.init);
        assert.equal(resp.status, 200);
        const seen = JSON.parse(await resp.text()) as { declared?: string; actual: number; hasKey: boolean };
        assert.equal(seen.hasKey, false, "the stamped key is stripped");
        assert.equal(seen.actual, reencoded.length, "the wire body is the re-encoded body");
        assert.equal(seen.declared, String(reencoded.length), "the wire content-length matches the re-encoded size (stale client value dropped)");
    } finally {
        server.close();
    }
});
