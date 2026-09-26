import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";

import { REMOTE_IMAGE_TOKENS, imageTokensInParsedBody, imageTokensInRawBody } from "../src/image-tokens.ts";
import { droppedOpenaiParts } from "../src/wire-drop-warn.ts";
import { _resetWireDropWarningsForTest, warnDroppedOpenaiParts } from "../src/server/prepare-openai.ts";
import { openaiToCore, coreToOpenai } from "acp-kernel/wire";

// Issue #1205: the openai wire codec silently dropped every user content part
// whose type was neither text nor image_url — DeepSeek Files API attachments
// ({type:"file","file_id":"file-api-…"}) vanished before any compression. This
// pins (1) token estimation charging file parts like remote references so they
// stop being invisible to fit decisions, (2) the proxy logging a one-time warn
// for the surviving drop class (non-user roles), and (3) the acp-kernel 0.0.85
// activation: user-message parts now survive the codec round trip verbatim.

const deepseekFilePart = { type: "file", file_id: "file-api-abc123" };
const openaiInlineDataFilePart = { type: "file", file: { file_data: `data:image/png;base64,${"A".repeat(800)}`, filename: "shot.png" } };
const openaiUrlFilePart = { type: "file", file: { url: "https://files.example.com/x.png" } };
const imagePart = { type: "image_url", image_url: { url: "https://img.example.com/a.png" } };

function openaiBody(messages: unknown[]): Record<string, unknown> {
    return { model: "deepseek-chat", messages };
}

test("openai file part (DeepSeek Files API ref) costs the flat remote price", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "what is in this image?" }, deepseekFilePart] }]);
    assert.equal(imageTokensInParsedBody("openai", body), REMOTE_IMAGE_TOKENS);
});

test("openai file part with inline file_data is sized from its base64 payload", () => {
    const body = openaiBody([{ role: "user", content: [openaiInlineDataFilePart] }]);
    assert.equal(imageTokensInParsedBody("openai", body), Math.ceil(800 / 4));
});

test("openai file part with a url ref costs the flat remote price", () => {
    const body = openaiBody([{ role: "user", content: [openaiUrlFilePart] }]);
    assert.equal(imageTokensInParsedBody("openai", body), REMOTE_IMAGE_TOKENS);
});

test("mixed text + file + image_url sums all three", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "hi" }, deepseekFilePart, imagePart] }]);
    assert.equal(imageTokensInParsedBody("openai", body), REMOTE_IMAGE_TOKENS * 2);
});

test("file parts outside user role are charged the same way (parity with image_url)", () => {
    const body = openaiBody([{ role: "assistant", content: [deepseekFilePart] }]);
    assert.equal(imageTokensInParsedBody("openai", body), REMOTE_IMAGE_TOKENS);
});

test("plain-text bodies stay free (no regression)", () => {
    assert.equal(imageTokensInParsedBody("openai", openaiBody([{ role: "user", content: "hello" }])), 0);
    assert.equal(imageTokensInParsedBody("openai", openaiBody([{ role: "user", content: [{ type: "text", text: "hello" }] }])), 0);
});

test("raw-body probe fires on file parts even without any image_url marker", () => {
    const compact = JSON.stringify(openaiBody([{ role: "user", content: [{ type: "text", text: "hi" }, deepseekFilePart] }]));
    assert.ok(!compact.includes("image_url"));
    assert.equal(imageTokensInRawBody("openai", compact), REMOTE_IMAGE_TOKENS);
    const spaced = compact.replace('"type":"file"', '"type": "file"');
    assert.equal(imageTokensInRawBody("openai", spaced), REMOTE_IMAGE_TOKENS);
});

// Kernel 0.0.85 (PR #365) carries ALL user-message non-text parts through
// the rawOpenaiContentParts sidecar, so the drop detector no longer flags
// user messages — only non-user roles (text-only reduction) still drop.

test("droppedOpenaiParts stays silent for DeepSeek-style file refs on user messages (kernel 0.0.85+ preserves them)", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "what is in this image?" }, deepseekFilePart] }]);
    assert.equal(droppedOpenaiParts(body), null);
});

test("droppedOpenaiParts ignores preserved user parts (text + image_url)", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "hi" }, imagePart] }]);
    assert.equal(droppedOpenaiParts(body), null);
});

test("droppedOpenaiParts stays silent for mixed file + image on user messages (both ride the sidecar)", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "hi" }, deepseekFilePart, imagePart] }]);
    assert.equal(droppedOpenaiParts(body), null);
});

test("droppedOpenaiParts applies the text-only preserved set to non-user roles", () => {
    const body = openaiBody([
        { role: "user", content: "hi" },
        { role: "assistant", content: [imagePart] },
    ]);
    assert.deepEqual(droppedOpenaiParts(body), { count: 1, types: ["image_url"], firstIndex: 1 });
});

test("droppedOpenaiParts unions types across non-user messages and keeps the earliest index", () => {
    const body = openaiBody([
        { role: "user", content: [{ type: "input_audio", input_audio: {} }, { type: "text", text: "ok" }] },
        { role: "assistant", content: [{ type: "custom_thing", x: 1 }] },
        { role: "tool", content: [{ type: "file", file_id: "f" }] },
    ]);
    assert.deepEqual(droppedOpenaiParts(body), { count: 2, types: ["custom_thing", "file"], firstIndex: 1 });
});

test("droppedOpenaiParts counts typeless non-user parts and tolerates degenerate shapes", () => {
    assert.deepEqual(droppedOpenaiParts(openaiBody([{ role: "assistant", content: [{ foo: 1 }] }])), { count: 1, types: ["<no-type>"], firstIndex: 0 });
    assert.equal(droppedOpenaiParts(openaiBody([{ role: "user", content: [{ foo: 1 }] }])), null);
    assert.equal(droppedOpenaiParts(openaiBody([{ role: "user", content: "plain string" }])), null);
    assert.equal(droppedOpenaiParts({}), null);
    assert.equal(droppedOpenaiParts(null), null);
    assert.equal(droppedOpenaiParts("not an object"), null);
});

test("warnDroppedOpenaiParts logs once per session per distinct type-set", () => {
    _resetWireDropWarningsForTest();
    const lines: string[] = [];
    const log = (level: string, msg: string) => lines.push(`${level}: ${msg}`);
    const body = openaiBody([
        { role: "user", content: [{ type: "text", text: "hi" }, deepseekFilePart] },
        { role: "assistant", content: [{ type: "file", file_id: "file-api-xyz" }] },
    ]);

    warnDroppedOpenaiParts(body, "ses_a", log);
    warnDroppedOpenaiParts(body, "ses_a", log); // same session, same types → deduped
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^warn: \[ses_a\] wire codec will drop 1 non-user content part\(s\) with unrecognized type\(s\) \[file\]/);
    assert.match(lines[0], /#1205/);

    const secondType = openaiBody([{ role: "assistant", content: [{ type: "input_audio", input_audio: {} }] }]);
    warnDroppedOpenaiParts(secondType, "ses_a", log); // new type-set → warns again
    assert.equal(lines.length, 2);

    warnDroppedOpenaiParts(body, "ses_b", log); // new session → warns again
    assert.equal(lines.length, 3);

    warnDroppedOpenaiParts(openaiBody([{ role: "user", content: "clean" }]), "ses_a", log); // nothing dropped → silent
    assert.equal(lines.length, 3);

    warnDroppedOpenaiParts(openaiBody([{ role: "user", content: [{ type: "text", text: "ok" }, deepseekFilePart] }]), "ses_b", log); // user-only drop candidates are preserved → silent
    assert.equal(lines.length, 3);

    _resetWireDropWarningsForTest();
    warnDroppedOpenaiParts(body, "ses_a", log); // after reset → warns again
    assert.equal(lines.length, 4);
});

// --- acp-kernel 0.0.85 activation (#1205 root fix): user-message parts survive the codec ---

test("kernel 0.0.85 round trip preserves a DeepSeek Files API file ref on user messages verbatim", () => {
    const body = openaiBody([
        { role: "user", content: [{ type: "text", text: "what is in this image?" }, deepseekFilePart] },
    ]);
    const { msgs } = openaiToCore(body as never);
    const rebuilt = coreToOpenai(msgs) as Array<{ role: string; content: unknown }>;
    const userMsg = rebuilt.find((m) => m.role === "user");
    assert.ok(Array.isArray(userMsg?.content), "user content should stay an array");
    const parts = userMsg!.content as Array<{ type: string; file_id?: string }>;
    const filePart = parts.find((p) => p.type === "file");
    assert.ok(filePart, "file part must survive the round trip");
    assert.equal(filePart!.file_id, "file-api-abc123");
    assert.deepEqual(parts.map((p) => p.type), ["text", "file"], "wire order preserved");
});

test("kernel 0.0.85 round trip preserves mixed file + image parts with order and bytes", () => {
    const body = openaiBody([
        { role: "user", content: [{ type: "text", text: "hi" }, deepseekFilePart, imagePart] },
    ]);
    const { msgs } = openaiToCore(body as never);
    const rebuilt = coreToOpenai(msgs) as Array<{ role: string; content: unknown }>;
    const parts = (rebuilt.find((m) => m.role === "user")!.content) as Array<Record<string, unknown>>;
    assert.deepEqual(parts.map((p) => p.type), ["text", "file", "image_url"]);
    assert.equal((parts[1] as { file_id: string }).file_id, "file-api-abc123");
    assert.deepEqual(parts[2].image_url, imagePart.image_url);
});

test("kernel 0.0.85 round trip preserves an inline data-URL file part byte-exact", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "see" }, openaiInlineDataFilePart] }]);
    const { msgs } = openaiToCore(body as never);
    const rebuilt = coreToOpenai(msgs) as Array<{ role: string; content: unknown }>;
    const parts = (rebuilt.find((m) => m.role === "user")!.content) as Array<Record<string, unknown>>;
    const filePart = parts.find((p) => p.type === "file") as { file: Record<string, unknown> };
    assert.ok(filePart, "inline file part must survive");
    assert.deepEqual(filePart.file, openaiInlineDataFilePart.file, "inline file payload byte-exact");
});

test("kernel 0.0.85 lone string-URL image keeps the legacy singular sidecar shape (byte stability)", () => {
    const body = openaiBody([{ role: "user", content: [{ type: "text", text: "look" }, imagePart] }]);
    const { msgs } = openaiToCore(body as never);
    const rebuilt = coreToOpenai(msgs) as Array<{ role: string; content: unknown }>;
    const parts = (rebuilt.find((m) => m.role === "user")!.content) as Array<Record<string, unknown>>;
    assert.deepEqual(parts.map((p) => p.type), ["text", "image_url"]);
    assert.deepEqual(parts[1].image_url, imagePart.image_url);
});
