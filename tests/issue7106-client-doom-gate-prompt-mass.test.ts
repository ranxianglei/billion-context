// #7106: the client-local doom gate must price the PROMPT mass, not the whole
// wire body. DSH stamps transport-only top-level fields (dsh_session_log up to
// 8 MiB, dsh_plugin_packages) that never reach the model; pricing them as text
// made a 736K-token prompt on a 1,048,576 window look like a 2.4M-token body,
// so the gate refused it locally before the provider saw it.
//
// The fixtures below mirror the production shape captured in #7106:
//   wireChars=9947234  messages:2561750  system:92785  dsh_session_log:7275441
// with the prompt mass at ~736K tokens (CJK-aware count).

import assert from "node:assert/strict";
import test from "node:test";

import { bodyOverWindowDetail } from "../src/agent/native-intercept.js";

const WINDOW = 1_048_576;
const TRANSPORT_BLOB = "L".repeat(7 * 1024 * 1024);

function wire(body: Record<string, unknown>): string {
    return JSON.stringify(body);
}

test("#7106: a 7 MiB transport field does not doom an in-window anthropic prompt", () => {
    // Prompt: messages ~2.5M chars + system ~92K chars => ~648K tokens,
    // times the calibrated 1.14 bias => ~739K, comfortably under the window.
    const raw = wire({
        model: "deepseek-flash",
        stream: true,
        max_tokens: 256000,
        messages: [{ role: "user", content: "x".repeat(2_500_000) }],
        system: "s".repeat(92_000),
        tools: [{ name: "t", description: "d" }],
        dsh_session_log: TRANSPORT_BLOB,
        dsh_plugin_packages: "p".repeat(14_000),
    });
    assert.ok(raw.length > 9_000_000, "fixture is the production body size");
    assert.equal(bodyOverWindowDetail(Buffer.byteLength(raw, "utf8"), raw, WINDOW), undefined, "prompt fits the window, transport mass must not doom it");
});

test("#7106: a prompt that really is over the window still dooms, priced by prompt mass", () => {
    const raw = wire({
        model: "deepseek-flash",
        messages: [{ role: "user", content: "x".repeat(4_500_000) }],
        system: "s".repeat(92_000),
        dsh_session_log: TRANSPORT_BLOB,
    });
    const doom = bodyOverWindowDetail(Buffer.byteLength(raw, "utf8"), raw, WINDOW);
    assert.ok(doom, "an over-window prompt is still refused");
    assert.equal(doom.protocol, "anthropic");
    assert.ok(doom.promptTokens !== undefined, "the verdict names the prompt mass");
    assert.equal(doom.floorTokens, doom.promptTokens, "no images: floor is the prompt mass");
    assert.ok(doom.provablyOver, "1.125M > 1,048,576 on the floor alone");
});

test("#7106: the prompt/named-bucket comparison uses CJK-aware text counting", () => {
    // 1.1M CJK chars count ~1 token each, so they are over the window on their
    // own even though they are only ~3.3 MB of bytes (a byte/4 estimate would
    // have measured ~0.8M and let this through).
    const cjk = "\u61C9".repeat(1_100_000);
    const raw = wire({ messages: [{ role: "user", content: cjk }] });
    const doom = bodyOverWindowDetail(Buffer.byteLength(raw, "utf8"), raw, WINDOW);
    assert.ok(doom);
    assert.equal(doom.protocol, "openai");
    assert.ok(doom.promptTokens !== undefined && doom.promptTokens > WINDOW);
});

test("#7106: google and openai lanes are recognized by body shape", () => {
    const google = wire({
        contents: [{ role: "user", parts: [{ text: "x".repeat(200_000) }] }],
        systemInstruction: "s".repeat(92_000),
        tools: [{ name: "t" }],
        dsh_session_log: TRANSPORT_BLOB,
    });
    assert.equal(bodyOverWindowDetail(Buffer.byteLength(google, "utf8"), google, WINDOW), undefined, "google prompt fits; transport mass excluded");

    const openai = wire({ messages: [{ role: "user", content: "x".repeat(5_000_000) }], dsh_session_log: TRANSPORT_BLOB });
    const doom = bodyOverWindowDetail(Buffer.byteLength(openai, "utf8"), openai, WINDOW);
    assert.ok(doom);
    assert.equal(doom.protocol, "openai");
});

test("#7106: bodies we cannot price by shape keep the byte estimate", () => {
    const doom = bodyOverWindowDetail(9_000_000, "not-json-at-all", WINDOW);
    assert.ok(doom, "a 9 MB non-JSON body is still refused");
    assert.equal(doom.promptTokens, undefined, "no prompt pricing without a parsed body");
    assert.equal(doom.floorTokens, Math.ceil(9_000_000 / 4));
});

test("#7106: image bytes are excluded from the prompt mass (media uncounted, #4111)", () => {
    const raw = wire({
        messages: [{
            role: "user",
            content: [
                { type: "text", text: "x".repeat(1_000) },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(2_000_000) } },
            ],
        }],
        dsh_session_log: TRANSPORT_BLOB,
    });
    const doom = bodyOverWindowDetail(Buffer.byteLength(raw, "utf8"), raw, WINDOW);
    assert.equal(doom, undefined, "base64 image bytes are not text prompt mass");
});

test("#7106 review: a shape-priced prompt below the window is NOT doomed (no double calibration)", () => {
    // 1.0M CJK chars price at ~1.0M tokens already (direct CJK-aware count).
    // The old code multiplied that by 1.14 and refused at ~0.877 x window,
    // which is the false-refusal this issue is about.
    const raw = wire({
        model: "deepseek-flash",
        messages: [{ role: "user", content: "\u61C9".repeat(1_000_000) }],
        system: "s".repeat(50_000),
    });
    const bytes = Buffer.byteLength(raw, "utf8");
    assert.ok(Math.ceil((bytes / 3) * 1.14) > WINDOW, "fixture must pass the cheap early-out bound");
    assert.equal(bodyOverWindowDetail(bytes, raw, WINDOW), undefined, "prompt mass ~1.01M sits under the 1,048,576 window");
});

test("#7106 review: a shape-priced prompt just over the window dooms, and carries no 1.14 slack", () => {
    const raw = wire({ messages: [{ role: "user", content: "\u61C9".repeat(1_060_000) }] });
    const doom = bodyOverWindowDetail(Buffer.byteLength(raw, "utf8"), raw, WINDOW);
    assert.ok(doom, "1.06M prompt tokens exceed the window");
    assert.equal(doom.promptTokens, doom.floorTokens);
    assert.equal(doom.estTokens, doom.floorTokens, "shape-priced mass is not re-calibrated by 1.14");
    assert.equal(doom.provablyOver, true);
});
