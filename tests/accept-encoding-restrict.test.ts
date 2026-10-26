// #2993 gates: bili parses every upstream body it fetches (SSE frames, JSON,
// summaries), so it must never ADVERTISE a content-coding its own fetch cannot
// decode. Node's fetch (undici) transparently decodes gzip/deflate/br but
// passes anything else through UNDECODED with a 200 status — deepseek began
// honoring `Accept-Encoding: zstd`, so a verbatim-forwarded client
// accept-encoding made healthy generations arrive as binary: zero SSE events,
// clean EOF, a phantom upstream_stream_truncated. These pin the restriction at
// the single upstream chokepoint (fetchWithTimeout): unit-level rewrite
// semantics, a live-undici repro against a coding-honoring mock upstream, and
// a deterministic negative control showing the pre-fix failure mode.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { gzipSync } from "node:zlib";
import { withFetchTransport } from "../src/fetch-transport.js";
import { _liveUpstreamTimersForTest, fetchWithTimeout, restrictAcceptEncoding, type FetchOptions } from "../src/fetch-util.js";

process.env.NODE_ENV = "test";

const SSE_PLAIN = 'data: {"id":"chatcmpl_z","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
// Static zstd frame of SSE_PLAIN (magic 28 b5 2f fd). Embedded rather than
// generated because zlib.zstdCompressSync needs Node >= 22.15.
const ZSTD_FRAME = Buffer.from("KLUv/SCS3QMAEggbHmBF2wbAgIqNYbL/j8khXc3+w52ECTCEV1mgAlW6AgghhIJhcCD0IM8b7vb7clOpSFjTVcTTc4U3exnv3FUvuZ4Ed4Bcq3eOe0tUZvh0ZRcMjWXtXBqG0WjMxIGfHpAsDYOtGP6+9E7gVKsVAwA42LwkQoDIbD4B", "base64");

afterEach(() => assert.equal(_liveUpstreamTimersForTest(), 0));

test("#2993: mixed accept-encoding keeps only the decodable subset, in order, with q-values", () => {
    const out = restrictAcceptEncoding({ "accept-encoding": "gzip, br;q=0.8, zstd;q=0.5" }) as Record<string, string>;
    assert.equal(out["accept-encoding"], "gzip, br;q=0.8");
});

test("#2993: an all-undecodable accept-encoding drops the header entirely (identity)", () => {
    const out = restrictAcceptEncoding({ "accept-encoding": "zstd" }) as Record<string, string>;
    assert.equal(out["accept-encoding"], undefined);
});

test("#2993: identity-only accept-encoding drops the header", () => {
    const out = restrictAcceptEncoding({ "accept-encoding": "identity" }) as Record<string, string>;
    assert.equal(out["accept-encoding"], undefined);
});

test("#2993: wildcard is dropped, explicit decodable codings survive", () => {
    const out = restrictAcceptEncoding({ "accept-encoding": "*;q=0.5, gzip" }) as Record<string, string>;
    assert.equal(out["accept-encoding"], "gzip");
});

test("#2993: coding match is case-insensitive, surviving tokens keep their case", () => {
    const out = restrictAcceptEncoding({ "accept-encoding": "GZIP, ZSTD" }) as Record<string, string>;
    assert.equal(out["accept-encoding"], "GZIP");
});

test("#2993: x-gzip and deflate are decodable by undici and stay", () => {
    const out = restrictAcceptEncoding({ "accept-encoding": "x-gzip, deflate" }) as Record<string, string>;
    assert.equal(out["accept-encoding"], "x-gzip, deflate");
});

test("#2993: malformed parts (stray commas/whitespace) are dropped, valid ones kept", () => {
    const out = restrictAcceptEncoding({ "accept-encoding": " , gzip , ,zstd," }) as Record<string, string>;
    assert.equal(out["accept-encoding"], "gzip");
});

test("#2993: every non-accept-encoding header passes through byte-for-byte", () => {
    const out = restrictAcceptEncoding({ authorization: "Bearer k", "accept-encoding": "gzip, zstd", "x-session-id": "s1" }) as Record<string, string>;
    assert.deepEqual(out, { authorization: "Bearer k", "accept-encoding": "gzip", "x-session-id": "s1" });
});

test("#2993: undefined headers pass through untouched", () => {
    assert.equal(restrictAcceptEncoding(undefined), undefined);
});

test("#2993: Headers-instance input is rewritten too", () => {
    const h = new Headers();
    h.set("accept-encoding", "br, zstd");
    h.set("authorization", "Bearer k");
    const out = restrictAcceptEncoding(h) as Record<string, string>;
    assert.equal(out["accept-encoding"], "br");
    assert.equal(out["authorization"], "Bearer k");
});

test("#2993: pair-array input is rewritten too", () => {
    const out = restrictAcceptEncoding([["accept-encoding", "gzip, zstd"], ["x-a", "b"]]) as Record<string, string>;
    assert.equal(out["accept-encoding"], "gzip");
    assert.equal(out["x-a"], "b");
});

/** A mock upstream that HONORS accept-encoding exactly like deepseek now does:
 *  zstd advertised → zstd-compressed SSE with Content-Encoding: zstd; else gzip
 *  advertised → gzip; else identity. Records what it saw on the wire. */
async function startCodingUpstream(capture: { ae?: string }): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer((req, res) => {
        capture.ae = req.headers["accept-encoding"];
        const ae = (capture.ae ?? "").toLowerCase();
        if (ae.includes("zstd")) {
            res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "zstd" });
            res.end(ZSTD_FRAME);
        } else if (ae.includes("gzip")) {
            res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
            res.end(gzipSync(Buffer.from(SSE_PLAIN, "utf8")));
        } else {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(SSE_PLAIN);
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/v1/chat/completions`, close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())) };
}

test("#2993: a zstd-advertising client reaches a coding-honoring upstream intact (repro)", async () => {
    const capture: { ae?: string } = {};
    const up = await startCodingUpstream(capture);
    try {
        const { response, clearTimer } = await fetchWithTimeout(up.url, {
            method: "POST",
            headers: { "content-type": "application/json", "accept-encoding": "gzip, br, zstd", authorization: "Bearer k" },
            body: "{}",
        });
        try {
            // The fix: zstd never leaves bili, so the upstream answers gzip and
            // undici decodes it — the healthy generation arrives as SSE, not binary.
            assert.equal(capture.ae, "gzip, br", "outbound accept-encoding keeps only the decodable subset");
            assert.equal(response.status, 200);
            assert.equal(await response.text(), SSE_PLAIN, "body is the decoded SSE stream, not a compressed frame");
        } finally {
            clearTimer();
        }
    } finally {
        await up.close();
    }
});

test("#2993 negative control: an upstream honoring zstd delivers undecodable bytes (the pre-fix failure)", async () => {
    const fake = async (_url: string, _opts: FetchOptions) =>
        new Response(ZSTD_FRAME, { status: 200, headers: { "content-type": "text/event-stream", "content-encoding": "zstd" } });
    const { response, clearTimer } = await withFetchTransport(fake, () =>
        fetchWithTimeout("http://fake.invalid/v1/chat/completions", { method: "POST", headers: { "accept-encoding": "gzip, br, zstd" }, body: "{}" }));
    try {
        const text = await response.text();
        assert.notEqual(text, SSE_PLAIN, "the zstd frame is NOT auto-decoded...");
        assert.ok(!text.includes("[DONE]"), "...so the SSE parser sees zero events — the phantom truncation");
    } finally {
        clearTimer();
    }
});
