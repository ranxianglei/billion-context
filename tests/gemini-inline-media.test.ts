import assert from "node:assert/strict";
import { test } from "node:test";
import { mediaBytesOfWireBody } from "../src/agent/media-bytes.ts";
import { _resetForTest, installNativeFetchIntercept } from "../src/agent/native-intercept.ts";

// Gemini's REST examples use inline_data / mime_type; SDKs also emit
// inlineData / mimeType. Both carry base64 media rather than core text.
const MEDIA = "A".repeat(4_200_000);
const ORIGIN = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash";

function body(part: unknown, text = "Describe the attachment."): string {
    return JSON.stringify({ contents: [{ role: "user", parts: [{ text }, part] }] });
}

async function throughUnavailableProxy(raw: string, suffix: string): Promise<{ status: number; gate: string | null; calls: { url: string; raw: string }[] }> {
    const saved = globalThis.fetch;
    const calls: { url: string; raw: string }[] = [];
    _resetForTest();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const req = new Request(input, init);
        calls.push({ url: req.url, raw: await req.text() });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
        assert.equal(installNativeFetchIntercept({
            origin: undefined,
            ready: Promise.resolve(undefined),
            respawn: async () => undefined,
        }), true);
        const response = await fetch(`${ORIGIN}:${suffix}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-bili-plugin-context-window": "1000000" },
            body: raw,
        });
        await response.text();
        return { status: response.status, gate: response.headers.get("x-bili-gate"), calls };
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}

test("Gemini REST inline_data receives the same media credit as inlineData", () => {
    const raw = JSON.stringify({ contents: [{ parts: [
        { inline_data: { mime_type: "image/png", data: "aGVsbG8=" } },
        { inlineData: { mimeType: "application/pdf", data: "d29ybGQ=" } },
        { text: "aGVsbG8=" },
    ] }] });
    assert.equal(mediaBytesOfWireBody(raw), 16, "count each media payload once and leave text billed");
});

test("malformed inline_data fields and textual lookalikes receive no media credit", () => {
    for (const part of [
        { inline_data: null },
        { inline_data: { data: 42 } },
        { inline_data: { data: ["aGVsbG8="] } },
        { inline_data: "aGVsbG8=" },
        { inline_data: [{ data: "aGVsbG8=" }] },
        { text: '{"inline_data":{"data":"aGVsbG8="}}' },
    ]) assert.equal(mediaBytesOfWireBody(body(part)), 0);
});

for (const suffix of ["generateContent", "streamGenerateContent?alt=sse"]) {
    for (const key of ["inline_data", "inlineData"]) {
        test(`${suffix}: ${key} media reaches direct fallback without a false text refusal`, async () => {
            const part = key === "inline_data"
                ? { inline_data: { mime_type: "image/png", data: MEDIA } }
                : { inlineData: { mimeType: "image/png", data: MEDIA } };
            const raw = body(part);
            const result = await throughUnavailableProxy(raw, suffix);
            assert.equal(result.status, 200);
            assert.equal(result.gate, null);
            assert.deepEqual(result.calls, [{ url: `${ORIGIN}:${suffix}`, raw }], "forward the original body exactly once");
        });
    }
}

test("base64 pasted as plain text still exceeds the direct-fallback window", async () => {
    const result = await throughUnavailableProxy(body({ text: MEDIA }), "generateContent");
    assert.equal(result.status, 422);
    assert.equal(result.gate, "oversize-refusal-fallback");
    assert.deepEqual(result.calls, [], "oversized core text never reaches the upstream");
});

test("valid snake-case media does not exempt an oversized accompanying prompt", async () => {
    const raw = body({ inline_data: { mime_type: "image/png", data: "aGVsbG8=" } }, MEDIA);
    const result = await throughUnavailableProxy(raw, "streamGenerateContent?alt=sse");
    assert.equal(result.status, 422);
    assert.equal(result.gate, "oversize-refusal-fallback");
    assert.deepEqual(result.calls, []);
});

test("an inline_data string is not credited as a valid media object", async () => {
    const result = await throughUnavailableProxy(body({ inline_data: MEDIA }), "generateContent");
    assert.equal(result.status, 422);
    assert.deepEqual(result.calls, []);
});
