import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anthropicToCore, googleToCore, openaiToCore, responsesToCore } from "acp-kernel/wire";
import { createInitialState } from "acp-kernel";
import {
    buildIncomingImageIndex,
    describeRestorable,
    messageImageBytes,
    writeRestoredImage,
    type IndexedImage,
    type RestorableImage,
} from "../src/image-restore.ts";
import { resolveDecompress, type ProxyToolCtx } from "../src/decompress-shared.ts";
import type { WireProtocol } from "../src/util.js";

// Isolate stateDir() (hence restoreExportDir()) under a throwaway dir before any
// write. node --test gives each file its own process, so the env mutation is safe.
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bili-img-restore-"));

// A valid 1x1 PNG so decodeImageDims() resolves real dimensions.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const pngImg: RestorableImage = { mediaType: "image/png", b64: PNG, bytes: Buffer.byteLength(PNG, "base64") };
const dataUrl = `data:image/png;base64,${PNG}`;

// Each wire converter has a distinct concrete signature; the test drives them
// uniformly on already-shaped bodies, so they are widened at the single call
// site below rather than forced into one callable type here.
const TO_CORE = {
    anthropic: anthropicToCore,
    openai: openaiToCore,
    responses: responsesToCore,
    google: googleToCore,
};
function coreMsgs(r: unknown): Array<{ id?: string }> {
    const m = Array.isArray(r) ? r : (r as { msgs?: unknown }).msgs;
    return (Array.isArray(m) ? m : []) as Array<{ id?: string }>;
}
// Run the protocol parser, assign each produced core message a deterministic ref
// (m00001..), then build the index. excludeImaged leaves imaged messages unref'd to
// exercise the "unref'd tail messages are skipped" path.
function buildIndex(proto: WireProtocol, body: unknown, excludeImaged = false, sessionId = "s1") {
    const conv = TO_CORE[proto] as unknown as (b: unknown) => unknown;
    const msgs = coreMsgs(conv(body));
    const state = createInitialState();
    msgs.forEach((m, i) => {
        if (!m.id) return;
        if (excludeImaged && messageImageBytes(m as never).length > 0) return;
        state.messageRefs.byRaw[m.id] = `m${String(i + 1).padStart(5, "0")}`;
    });
    return buildIncomingImageIndex(body, proto, state, sessionId);
}
function ctxWith(index: Map<string, IndexedImage[]> | undefined): ProxyToolCtx {
    // Only the imageRef branch of resolveDecompress is exercised here; it touches
    // nothing but session.incomingImageIndex and log, so a minimal ctx suffices.
    return { session: { incomingImageIndex: index }, log: () => undefined } as unknown as ProxyToolCtx;
}

test("messageImageBytes: extracts base64 across all four wire sidecars", () => {
    const anthro = messageImageBytes({ rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } } } as never);
    assert.equal(anthro.length, 1);
    assert.equal(anthro[0].b64, PNG);
    assert.equal(anthro[0].mediaType, "image/png");

    const anthroUrl = messageImageBytes({ rawAnthropicBlock: { type: "image", source: { type: "url", url: dataUrl } } } as never);
    assert.equal(anthroUrl.length, 1);
    assert.equal(anthroUrl[0].b64, PNG);

    // A tool_result block shares the sidecar field but is not an image.
    assert.deepEqual(messageImageBytes({ rawAnthropicBlock: { type: "tool_result", content: [] } } as never), []);

    const oaMulti = messageImageBytes({ rawOpenaiContentParts: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: dataUrl } }] } as never);
    assert.equal(oaMulti.length, 1);
    assert.equal(oaMulti[0].b64, PNG);

    const resp = messageImageBytes({ rawResponsesItem: { type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: dataUrl }] } } as never);
    assert.equal(resp.length, 1);
    assert.equal(resp[0].b64, PNG);

    const g = messageImageBytes({ rawGoogleParts: [{ text: "see" }, { inlineData: { mimeType: "image/png", data: PNG } }] } as never);
    assert.equal(g.length, 1);
    assert.equal(g[0].b64, PNG);

    // Singular fallback: the shared imageBase64 sidecar.
    const single = messageImageBytes({ imageBase64: PNG, imageMediaType: "image/jpeg" } as never);
    assert.equal(single.length, 1);
    assert.equal(single[0].mediaType, "image/jpeg");

    // Plain text carries nothing.
    assert.deepEqual(messageImageBytes({ role: "user", text: "hello" } as never), []);
});

test("messageImageBytes: multi-image yields every part, not just the first", () => {
    const two = messageImageBytes({ rawGoogleParts: [{ inlineData: { mimeType: "image/png", data: PNG } }, { inlineData: { mimeType: "image/gif", data: PNG } }] } as never);
    assert.equal(two.length, 2);
    assert.equal(two[0].mediaType, "image/png");
    assert.equal(two[1].mediaType, "image/gif");
});

test("buildIncomingImageIndex: indexes carried images by mNNNNN ref (all protocols)", () => {
    const openai = buildIndex("openai", { model: "gpt", messages: [
        { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: dataUrl } }] },
        { role: "assistant", content: "ok" },
    ] });
    assert.equal(openai.size, 1, "exactly one imaged message indexed");
    const [ref, imgs] = [...openai.entries()][0];
    assert.match(ref, /^m\d+$/);
    assert.ok(existsSync(imgs[0].path), "image spilled to disk at index time");
    assert.deepEqual(readFileSync(imgs[0].path), Buffer.from(PNG, "base64"), "spilled bytes round-trip");
    assert.ok(!("b64" in imgs[0]), "index retains metadata + path only, never base64 (#1995 memory bound)");

    // Anthropic splits a multi-block message into one core msg per block; only the
    // image block is indexed.
    const anthro = buildIndex("anthropic", { model: "claude", messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ] });
    assert.equal(anthro.size, 1);
    assert.deepEqual(readFileSync([...anthro.values()][0][0].path), Buffer.from(PNG, "base64"));

    const responses = buildIndex("responses", { model: "gpt", input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "see" }, { type: "input_image", image_url: dataUrl }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ] });
    assert.equal(responses.size, 1);
    assert.deepEqual(readFileSync([...responses.values()][0][0].path), Buffer.from(PNG, "base64"));

    const google = buildIndex("google", { contents: [{ role: "user", parts: [{ text: "see" }, { inlineData: { mimeType: "image/png", data: PNG } }] }] });
    assert.equal(google.size, 1);
    assert.deepEqual(readFileSync([...google.values()][0][0].path), Buffer.from(PNG, "base64"));
});

test("buildIncomingImageIndex: skips unref'd tail messages and image-free bodies", () => {
    const body = { model: "gpt", messages: [
        { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] },
        { role: "assistant", content: "ok" },
    ] };
    // Leave the imaged message unref'd -> nothing recoverable even though an image is present.
    assert.equal(buildIndex("openai", body, true).size, 0);
    // No images at all -> empty.
    assert.equal(buildIndex("openai", { model: "gpt", messages: [{ role: "user", content: "plain" }] }).size, 0);
});

test("describeRestorable: one line per image, sorted, capped", () => {
    const meta = (mediaType: string): IndexedImage => ({ mediaType, bytes: Buffer.byteLength(PNG, "base64"), width: 1, height: 1, path: "/nonexistent/x.png" });
    const idx = new Map<string, IndexedImage[]>([
        ["m00005", [meta("image/png"), meta("image/gif")]],
        ["m00002", [meta("image/png")]],
    ]);
    const lines = describeRestorable(idx);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^m00002 \[png 1x1 · \d+KB\]$/);
    assert.match(lines[1], /^m00005 \[png 1x1 · \d+KB\]$/);
    assert.match(lines[2], /^m00005\[-1\] \[gif 1x1 · \d+KB\]$/);
    assert.equal(describeRestorable(idx, 1).length, 1, "cap honored");
});

test("writeRestoredImage: writes decoded bytes 0600 under retrieve/img, idempotent", () => {
    const p = writeRestoredImage("m00042", 0, pngImg, "sess-A");
    assert.ok(p && /m00042-[0-9a-f]{8}\.png$/.test(p.replace(/\\/g, "/")), `path ${p}`);
    assert.ok(existsSync(p!));
    assert.deepEqual(readFileSync(p!), Buffer.from(PNG, "base64"), "decoded bytes round-trip");
    if (process.platform !== "win32") assert.equal(statSync(p!).mode & 0o777, 0o600, "not world-readable");
    // Multi-image suffix + extension mapping.
    const p2 = writeRestoredImage("m00042", 1, pngImg, "sess-A");
    assert.ok(/m00042-1-[0-9a-f]{8}\.png$/.test(p2!.replace(/\\/g, "/")));
    const jpg = writeRestoredImage("m00042", 0, { ...pngImg, mediaType: "image/jpeg" }, "sess-B");
    assert.ok(/m00042-[0-9a-f]{8}\.jpg$/.test(jpg!.replace(/\\/g, "/")));
    // Idempotent rewrite of identical bytes.
    assert.equal(writeRestoredImage("m00042", 0, pngImg, "sess-A"), p);
});

test("writeRestoredImage: a rebase that restarts refs never restores the previous generation's pixels (#1995)", () => {
    // resetSessionCompression clears the in-memory index/caches when refs are
    // renumbered from m00001, but old spill files survive on disk — a ref-only
    // filename plus skip-if-exists would hand the NEW image's ref back the OLD
    // generation's file. The content salt must discriminate the two generations
    // (same session id, same ref, same media type, different bytes).
    const PNG2 = PNG.slice(0, -8) + "YPhfDw" + PNG.slice(-2); // distinct bytes, same 1x1 PNG shape
    const png2: RestorableImage = { mediaType: "image/png", b64: PNG2, bytes: Buffer.byteLength(PNG2, "base64") };
    const gen1 = writeRestoredImage("m00001", 0, pngImg, "sess-rebase")!;
    const gen2 = writeRestoredImage("m00001", 0, png2, "sess-rebase")!;
    assert.notEqual(gen1, gen2, "different bytes must land in different files");
    assert.deepEqual(readFileSync(gen1), Buffer.from(PNG, "base64"), "old generation keeps its own bytes");
    assert.deepEqual(readFileSync(gen2), Buffer.from(PNG2, "base64"), "new generation is not served stale pixels");
    // Idempotency is preserved per content: re-spilling the SAME image returns
    // the same file, whichever generation it belongs to.
    assert.equal(writeRestoredImage("m00001", 0, png2, "sess-rebase"), gen2);
    assert.equal(writeRestoredImage("m00001", 0, pngImg, "sess-rebase"), gen1);
});

test("resolveDecompress({ imageRef }): lists, restores to file, and reports misses", () => {
    const p = writeRestoredImage("m00042", 0, pngImg, "sess-A")!;
    const idx = new Map<string, IndexedImage[]>([["m00042", [{ mediaType: "image/png", bytes: Buffer.byteLength(PNG, "base64"), width: 1, height: 1, path: p }]]]);
    const list = resolveDecompress({ imageRef: "list" }, ctxWith(idx)).text;
    assert.match(list, /\[Restorable images \(1\):\]/);
    assert.match(list, /m00042/);

    const restored = resolveDecompress({ imageRef: "m00042" }, ctxWith(idx)).text;
    assert.match(restored, /Restored 1 image\(s\) for m00042/);
    assert.ok(existsSync(p), "restored file exists");
    assert.deepEqual(readFileSync(p), Buffer.from(PNG, "base64"));

    assert.match(resolveDecompress({ imageRef: "m99999" }, ctxWith(idx)).text, /no restorable image for ref "m99999"/);
    assert.equal(resolveDecompress({ imageRef: "m99999" }, ctxWith(idx)).outcome, "failure");
    // #2626: an empty/blank imageRef is NO LONGER treated as "list" — presence-
    // based dispatch hijacked the text path. With no blockId it now fails loudly
    // asking for one; only a non-blank string selects image mode.
    assert.match(resolveDecompress({ imageRef: "" }, ctxWith(idx)).text, /blockId is required/, "empty imageRef no longer means list");
    assert.equal(resolveDecompress({ imageRef: "" }, ctxWith(idx)).outcome, "failure");
    assert.match(resolveDecompress({ imageRef: "   " }, ctxWith(idx)).text, /blockId is required/, "whitespace imageRef no longer means list");
    assert.match(resolveDecompress({ imageRef: "list" }, ctxWith(undefined)).text, /No restorable images right now/, "absent index degrades gracefully");
});

test("cross-session isolation: same ref number in two sessions never collides", () => {
    // Regression for the review blocker: refs are per-session sequence numbers,
    // so a flat retrieve/img/ let session B's m00001 hit session A's file via
    // skip-if-exists — B's restore would return A's pixels. The session id is
    // now part of the directory, so each session spills under its own tree.
    const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const gifImg: RestorableImage = { mediaType: "image/gif", b64: GIF, bytes: Buffer.byteLength(GIF, "base64") };
    const pa = writeRestoredImage("m00001", 0, pngImg, "conv-alpha")!;
    const pb = writeRestoredImage("m00001", 0, gifImg, "conv-beta")!;
    assert.notEqual(pa, pb, "two sessions' m00001 must be distinct files");
    assert.ok(pa.includes(join("retrieve", "img", "conv-alpha")));
    assert.ok(pb.includes(join("retrieve", "img", "conv-beta")));
    assert.deepEqual(readFileSync(pa), Buffer.from(PNG, "base64"), "alpha's file holds alpha's pixels");
    assert.deepEqual(readFileSync(pb), Buffer.from(GIF, "base64"), "beta's file holds beta's pixels — not skipped as a duplicate");

    // End-to-end through the index builder: identical ref numbering, different
    // sessions -> each index's path resolves to that session's own bytes.
    const body = { model: "gpt", messages: [
        { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: dataUrl } }] },
        { role: "assistant", content: "ok" },
    ] };
    const bodyGif = { model: "gpt", messages: [
        { role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: `data:image/gif;base64,${GIF}` } }] },
        { role: "assistant", content: "ok" },
    ] };
    const idxA = buildIndex("openai", body, false, "conv-alpha");
    const idxB = buildIndex("openai", bodyGif, false, "conv-beta");
    const a = [...idxA.entries()][0];
    const b = [...idxB.entries()][0];
    assert.equal(a[0], b[0], "both sessions legitimately number the image m00001-style");
    assert.notEqual(a[1][0].path, b[1][0].path, "but the spilled paths differ by session");
    assert.deepEqual(readFileSync(a[1][0].path), Buffer.from(PNG, "base64"));
    assert.deepEqual(readFileSync(b[1][0].path), Buffer.from(GIF, "base64"), "beta restores its own pixels, not alpha's");
});

test("messageImageBytes: tool-result-nested images are indexed on every wire that strips them", () => {
    // anthropic tool_result.content — strip side removes these (stripNestedImages),
    // so the index must see them or they are unrecoverable.
    const tr = messageImageBytes({ rawAnthropicBlock: { type: "tool_result", tool_use_id: "t1", content: [
        { type: "text", text: "screenshot attached" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        { type: "image", source: { type: "url", url: dataUrl } },
    ] } } as never);
    assert.equal(tr.length, 2, "both nested images extracted, text part ignored");
    assert.equal(tr[0].b64, PNG);
    assert.equal(tr[1].mediaType, "image/png");

    // responses function_call_output keeps parts in `.output`, not `.content`.
    const fco = messageImageBytes({ rawResponsesItem: { type: "function_call_output", call_id: "c1", output: [
        { type: "output_text", text: "see" },
        { type: "input_image", image_url: dataUrl },
    ] } } as never);
    assert.equal(fco.length, 1, "image found in .output array");
    assert.equal(fco[0].b64, PNG);

    // google functionResponse.parts nested inlineData (image mime only).
    const fr = messageImageBytes({ rawGoogleParts: [{ functionResponse: { name: "shot", parts: [
        { inlineData: { mimeType: "image/png", data: PNG } },
        { inlineData: { mimeType: "application/pdf", data: "AAAA" } }, // document: stripped? no — not an image mime, strip keeps it
    ] } } ] } as never);
    assert.equal(fr.length, 1, "nested image-mime inlineData indexed, pdf part left alone");

    // google nested fileData is a remote reference with no bytes -> nothing indexable.
    const fd = messageImageBytes({ rawGoogleParts: [{ functionResponse: { name: "shot", parts: [
        { fileData: { mimeType: "image/png", fileUri: "https://files.example/x.png" } },
    ] } } ] } as never);
    assert.equal(fd.length, 0, "remote fileData carries no bytes to recover");
});

test("buildIncomingImageIndex: end-to-end nested tool_result recovery (anthropic)", () => {
    // A user turn with a tool_use, then a tool_result carrying a screenshot.
    // The strip side drops the nested image on the next turn; the index must
    // have spilled it under the tool message's ref before that happens.
    const idx = buildIndex("anthropic", { model: "claude", messages: [
        { role: "user", content: [{ type: "text", text: "run it" }, { type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
        { role: "assistant", content: [{ type: "text", text: "running" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
        ] }] },
    ] });
    assert.equal(idx.size, 1, "the tool_result message is indexed");
    const [ref, imgs] = [...idx.entries()][0];
    assert.match(ref, /^m\d+$/);
    assert.ok(existsSync(imgs[0].path), "nested image spilled at index time");
    assert.deepEqual(readFileSync(imgs[0].path), Buffer.from(PNG, "base64"), "nested pixels round-trip");
});
