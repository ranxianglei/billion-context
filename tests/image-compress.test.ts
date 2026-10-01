import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST = "0";

import sharp from "sharp";
import {
    DEFAULT_IMAGE_COMPRESSION_CONFIG,
    IMAGE_FULL_FAILURE_MARKER,
    defaultConfig,
    imageShrinksForRef,
    isImageFullRestored,
    type Config,
} from "acp-kernel";
import type { BiliMessage } from "acp-kernel/wire";
import { parseCompressSettings } from "../src/config.ts";
import { applyCompressSettings, mergeCompress } from "../src/compress-settings.ts";
import { isProxyToolFor } from "../src/absorb.ts";
import {
    IMAGE_FULL_TOOL_NAME,
    applyImageCompressionPass,
    executeImageFull,
    imageFullTrailingNote,
    imageUsageSuffix,
    storeEffectiveImageCompression,
} from "../src/image-compress.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import {
    _resetSessionsForTest,
    getSession,
    markDirty,
    resetSessionCompression,
    type Session,
} from "../src/session.ts";

interface Fixture { b64: string; mediaType: string; width: number; height: number; bytes: number }

async function makeFixture(width: number, height: number, patterned: boolean): Promise<Fixture> {
    const raw = Buffer.alloc(width * height * 3);
    if (patterned) {
        for (let i = 0; i < raw.length; i += 3) {
            raw[i] = i & 0xff;
            raw[i + 1] = (i * 7) & 0xff;
            raw[i + 2] = (i * 13) & 0xff;
        }
    } else {
        raw.fill(0x88);
    }
    const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
    return { b64: buf.toString("base64"), mediaType: "image/png", width, height, bytes: buf.length };
}

// 2048×2944: aspect 1.4375 ∈ [1.4, 2.6] and short side ≥ 720 ⇒ the kernel's
// heuristic classifier routes it downsample; the repeating pattern keeps the
// PNG large so the shrunken webp is guaranteed smaller (no keep-smaller flake).
// The size also sits at the kernel pixel-tile estimate cap (2125 tok), while
// the 1280-maxDimension recipe lands at ~1105 — so token savings are real,
// not just byte savings (the estimate is coarse and capped).
let shotCache: Fixture | undefined;
async function shot(): Promise<Fixture> {
    return (shotCache ??= await makeFixture(2048, 2944, true));
}
// 800×600 landscape ⇒ not screenshot-like ⇒ decision pass (byte-identical).
let flatCache: Fixture | undefined;
async function flat(): Promise<Fixture> {
    return (flatCache ??= await makeFixture(800, 600, false));
}

function armedSession(byRaw: Record<string, string>): Session {
    const s = getSession(`img-${Math.random().toString(36).slice(2)}`);
    storeEffectiveImageCompression(s, { enabled: true });
    // Seed BOTH ref maps: the kernel's image_full validation requires the ref
    // to exist in byRef (in production processTurn/assignRefsNode fills both).
    for (const [raw, ref] of Object.entries(byRaw)) {
        s.state.messageRefs.byRaw[raw] = ref;
        s.state.messageRefs.byRef[ref] = raw;
    }
    return s;
}

function enabledCfg(extra: Record<string, unknown> = {}): Config {
    return applyCompressSettings(defaultConfig(200_000), 200_000, { imageCompression: { enabled: true, ...extra } });
}

interface AnthropicImgSource { type: string; media_type: string; data: string }
interface AnthropicImgBlock { type: string; source: AnthropicImgSource }

function anthropicMsg(id: string, fx: Fixture): BiliMessage {
    return {
        id,
        role: "user",
        contentType: "text",
        text: "",
        rawAnthropicBlock: { type: "image", source: { type: "base64", media_type: fx.mediaType, data: fx.b64 } },
    };
}

function antSrc(m: BiliMessage): AnthropicImgSource {
    return (m.rawAnthropicBlock as AnthropicImgBlock).source;
}

const logsOf = (): { logs: string[]; log: (level: "info" | "warn" | "error", msg: string) => void } => {
    const logs: string[] = [];
    return { logs, log: (level, msg) => logs.push(`${level}|${msg}`) };
};

test("parseCompressSettings validates imageCompression", () => {
    const ok = parseCompressSettings({
        imageCompression: { enabled: true, minTokens: 512, maxDimension: 1280, quality: 80, format: "webp" },
    });
    assert.ok(ok);
    assert.deepEqual(ok.imageCompression, { enabled: true, minTokens: 512, maxDimension: 1280, quality: 80, format: "webp" });
    assert.equal(parseCompressSettings({ imageCompression: { enabled: "yes" } }), undefined);
    assert.equal(parseCompressSettings({ imageCompression: { minTokens: "500" } }), undefined);
    assert.equal(parseCompressSettings({ imageCompression: { maxDimension: Number.NaN } }), undefined);
    assert.equal(parseCompressSettings({ imageCompression: { quality: Number.NaN } }), undefined);
    assert.equal(parseCompressSettings({ imageCompression: { format: "gif" } }), undefined);
    assert.equal(parseCompressSettings({ imageCompression: [] }), undefined);
});

test("mergeCompress merges imageCompression sub-field-wise across levels", () => {
    const out = mergeCompress(
        { imageCompression: { enabled: true, minTokens: 100 } },
        undefined,
        { imageCompression: { maxDimension: 900 } },
    );
    assert.deepEqual(out.imageCompression, { enabled: true, minTokens: 100, maxDimension: 900 });
});

test("applyCompressSettings maps imageCompression onto the kernel config with defaults", () => {
    const mapped = applyCompressSettings(defaultConfig(200_000), 200_000, { imageCompression: { enabled: true, minTokens: 200 } });
    assert.deepEqual(mapped.imageCompression, { ...DEFAULT_IMAGE_COMPRESSION_CONFIG, enabled: true, minTokens: 200 });
    // No level configures the feature ⇒ the kernel base default is inherited
    // (enabled:false — the feature stays OFF unless explicitly enabled).
    const absent = applyCompressSettings(defaultConfig(200_000), 200_000, {});
    assert.deepEqual(absent.imageCompression, DEFAULT_IMAGE_COMPRESSION_CONFIG);
});

test("unarmed session leaves traffic byte-identical", async () => {
    const fx = await shot();
    const s = getSession(`img-off-${Math.random().toString(36).slice(2)}`);
    s.state.messageRefs.byRaw.r1 = "m00001";
    const m = anthropicMsg("r1", fx);
    const { logs, log } = logsOf();
    await applyImageCompressionPass(s, [m], { config: enabledCfg(), billing: "pixels", log });
    assert.equal(antSrc(m).data, fx.b64);
    assert.equal(antSrc(m).media_type, "image/png");
    assert.equal(imageShrinksForRef(s.state, "m00001").length, 0);
    assert.equal(logs.length, 0);
});

test("decision pass-through: non-screenshot and below-min-tokens images untouched", async () => {
    const f = await flat();
    const s = armedSession({ r1: "m00001", r2: "m00002" });
    const notScreenshot = anthropicMsg("r1", f);
    // 720×1008 ≈ 936 pixel-tiles < minTokens 2000 ⇒ below-min-tokens pass.
    const smallShot = await makeFixture(720, 1008, true);
    const belowMin = anthropicMsg("r2", smallShot);
    const { logs, log } = logsOf();
    await applyImageCompressionPass(s, [notScreenshot, belowMin], { config: enabledCfg({ minTokens: 2000 }), billing: "pixels", log });
    assert.equal(antSrc(notScreenshot).data, f.b64);
    assert.equal(antSrc(belowMin).data, smallShot.b64);
    assert.equal(imageShrinksForRef(s.state, "m00001").length, 0);
    assert.equal(imageShrinksForRef(s.state, "m00002").length, 0);
    assert.equal(logs.length, 0);
});

test("anthropic screenshot shrunk once, deterministically, with record and stats", async () => {
    const fx = await shot();
    const s = armedSession({ r1: "m00001" });
    const m = anthropicMsg("r1", fx);
    const { logs, log } = logsOf();
    await applyImageCompressionPass(s, [m], { config: enabledCfg(), billing: "pixels", log });
    const src = antSrc(m);
    assert.notEqual(src.data, fx.b64);
    assert.equal(src.media_type, "image/webp");
    const meta = await sharp(Buffer.from(src.data, "base64")).metadata();
    assert.ok((meta.width ?? 0) > 0 && (meta.height ?? 0) > 0);
    assert.ok(Math.max(meta.width ?? 0, meta.height ?? 0) <= 1280);

    const recs = imageShrinksForRef(s.state, "m00001");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].ref, "m00001");
    assert.equal(recs[0].format, "webp");
    assert.ok(recs[0].shrunkBytes < recs[0].originalBytes);
    assert.ok(recs[0].tokensAfter < recs[0].tokensBefore);
    assert.equal(s.stats.imageShrunkCount, 1);
    assert.ok((s.stats.imageBytesSaved ?? 0) > 0);
    assert.ok((s.stats.imageTokensSaved ?? 0) > 0);
    assert.ok(logs.some((l) => l.includes("[acp-image]") && l.includes("m00001")));

    // Second request carries the ORIGINAL bytes again (client never saw the
    // shrunk form): fingerprint cache must emit byte-identical output without
    // duplicating records or inflating stats.
    const m2 = anthropicMsg("r1", fx);
    await applyImageCompressionPass(s, [m2], { config: enabledCfg(), billing: "pixels" });
    assert.equal(antSrc(m2).data, src.data);
    assert.equal(imageShrinksForRef(s.state, "m00001").length, 1);
    assert.equal(s.stats.imageShrunkCount, 1);

    // A message already carrying our emitted bytes must never be re-encoded
    // (double-shrink would break the standing-wire-bytes invariant).
    const before = antSrc(m).data;
    await applyImageCompressionPass(s, [m], { config: enabledCfg(), billing: "pixels" });
    assert.equal(antSrc(m).data, before);
});

test("openai carriers: multi-part mixed routing, single data URL, mirror sync, remote URL untouched", async () => {
    const sx = await shot();
    const fl = await flat();
    const s = armedSession({ r1: "m00001", r2: "m00002" });
    const dataUrl = (f: Fixture) => `data:${f.mediaType};base64,${f.b64}`;

    const multi: BiliMessage = {
        id: "r1",
        role: "user",
        contentType: "text",
        text: "",
        rawOpenaiContentParts: [
            { type: "text", text: "see both" },
            { type: "image_url", image_url: { url: dataUrl(sx) } },
            { type: "image_url", image_url: { url: dataUrl(fl) } },
            { type: "image_url", image_url: { url: "https://example.com/remote.png" } },
        ],
    };
    const single: BiliMessage = {
        id: "r2",
        role: "user",
        contentType: "text",
        text: "",
        rawOpenaiContent: dataUrl(sx),
        imageMediaType: sx.mediaType,
        imageBase64: sx.b64,
    };
    await applyImageCompressionPass(s, [multi, single], { config: enabledCfg(), billing: "pixels" });

    const parts = multi.rawOpenaiContentParts as Array<Record<string, unknown>>;
    const urlA = (parts[1].image_url as { url: string }).url;
    const urlB = (parts[2].image_url as { url: string }).url;
    const urlC = (parts[3].image_url as { url: string }).url;
    assert.ok(urlA.startsWith("data:image/webp;base64,"));
    assert.notEqual(urlA, dataUrl(sx));
    assert.equal(urlB, dataUrl(fl));
    assert.equal(urlC, "https://example.com/remote.png");

    assert.equal(typeof single.rawOpenaiContent, "string");
    assert.ok((single.rawOpenaiContent as string).startsWith("data:image/webp;base64,"));
    assert.equal(single.imageBase64, (single.rawOpenaiContent as string).split(",")[1]);
    assert.equal(single.imageMediaType, "image/webp");
    assert.equal(imageShrinksForRef(s.state, "m00001").length, 1);
    assert.equal(imageShrinksForRef(s.state, "m00002").length, 1);
});

test("responses carrier: input_image parts rewritten, mirror synced", async () => {
    const fx = await shot();
    const s = armedSession({ r1: "m00001" });
    const item = {
        type: "message",
        role: "user",
        content: [
            { type: "input_text", text: "look" },
            { type: "input_image", image_url: `data:${fx.mediaType};base64,${fx.b64}` },
        ],
    };
    const m: BiliMessage = {
        id: "r1",
        role: "user",
        contentType: "text",
        text: "",
        rawResponsesItem: item,
        imageMediaType: fx.mediaType,
        imageBase64: fx.b64,
    };
    await applyImageCompressionPass(s, [m], { config: enabledCfg(), billing: "pixels" });
    const content = (item.content as Array<Record<string, unknown>>);
    const img = content[1];
    assert.ok(String(img.image_url).startsWith("data:image/webp;base64,"));
    assert.equal(m.imageBase64, String(img.image_url).split(",")[1]);
    assert.equal(m.imageMediaType, "image/webp");
    assert.equal(imageShrinksForRef(s.state, "m00001").length, 1);
});

test("google carrier: inlineData parts rewritten", async () => {
    const fx = await shot();
    const s = armedSession({ r1: "m00001" });
    const parts: Array<Record<string, unknown>> = [
        { text: "hi" },
        { inlineData: { mimeType: fx.mediaType, data: fx.b64 } },
    ];
    const m: BiliMessage = { id: "r1", role: "user", contentType: "text", text: "", rawGoogleParts: parts };
    await applyImageCompressionPass(s, [m], { config: enabledCfg(), billing: "pixels" });
    const inline = parts[1].inlineData as { mimeType: string; data: string };
    assert.equal(inline.mimeType, "image/webp");
    assert.notEqual(inline.data, fx.b64);
    assert.equal(imageShrinksForRef(s.state, "m00001").length, 1);
});

test("image_full restores original resolution for the rest of the session", async () => {
    const fx = await shot();
    const s = armedSession({ r1: "m00001", r2: "m00002" });
    const cfg = enabledCfg();
    await applyImageCompressionPass(s, [anthropicMsg("r1", fx)], { config: cfg, billing: "pixels" });

    const note = imageFullTrailingNote(s);
    assert.ok(note !== undefined);
    assert.ok(note.includes("Downscaled screenshots"));
    assert.ok(note.includes("image_full"));

    const bad = executeImageFull({}, s, cfg);
    assert.ok(bad.startsWith(IMAGE_FULL_FAILURE_MARKER));

    const ghost = executeImageFull({ ref: "m99999" }, s, cfg);
    assert.ok(ghost.startsWith(IMAGE_FULL_FAILURE_MARKER));

    const ok = executeImageFull({ ref: "m00001" }, s, cfg);
    assert.ok(!ok.startsWith(IMAGE_FULL_FAILURE_MARKER));
    assert.equal(isImageFullRestored(s.state, "m00001"), true);
    assert.equal(imageFullTrailingNote(s), undefined);
    assert.equal(s.stats.imageFullCalls, 3);
    assert.equal(s.stats.imageFullRestores, 1);

    // Restored ref: the next forward emits the ORIGINAL bytes untouched.
    const fresh = anthropicMsg("r1", fx);
    await applyImageCompressionPass(s, [fresh], { config: cfg, billing: "pixels" });
    assert.equal(antSrc(fresh).data, fx.b64);
    assert.equal(antSrc(fresh).media_type, "image/png");

    // Idempotent: a second restore of the same ref is a no-op success.
    const again = executeImageFull({ ref: "m00001" }, s, cfg);
    assert.ok(!again.startsWith(IMAGE_FULL_FAILURE_MARKER));
    assert.equal(s.stats.imageFullRestores, 1);
});

test("isProxyToolFor gates image_full on arming", () => {
    const cfg = enabledCfg();
    const armed = getSession(`img-gate-${Math.random().toString(36).slice(2)}`);
    storeEffectiveImageCompression(armed, { enabled: true });
    assert.equal(isProxyToolFor(IMAGE_FULL_TOOL_NAME, armed, cfg), true);
    const unarmed = getSession(`img-gate2-${Math.random().toString(36).slice(2)}`);
    assert.equal(isProxyToolFor(IMAGE_FULL_TOOL_NAME, unarmed, cfg), false);
    assert.equal(isProxyToolFor("acp_status", unarmed, cfg), true);
});

test("resetSessionCompression clears image state and caches", async () => {
    const fx = await shot();
    const s = armedSession({ r1: "m00001" });
    const cfg = enabledCfg();
    await applyImageCompressionPass(s, [anthropicMsg("r1", fx)], { config: cfg, billing: "pixels" });
    assert.ok((s.imageFingerprintsByRef?.get("m00001")?.length ?? 0) > 0);
    // Restore invalidates the fingerprint entry by design (the shrunk bytes
    // must be re-encodable from a fresh original if the session re-shrinks).
    executeImageFull({ ref: "m00001" }, s, cfg);
    assert.equal(s.imageFingerprintsByRef?.get("m00001"), undefined);
    resetSessionCompression(s);
    assert.equal(s.state.imageShrinks?.length ?? 0, 0);
    assert.equal(s.state.imageFullRestored?.length ?? 0, 0);
    assert.equal(s.imageEncodeCache?.size ?? 0, 0);
    assert.equal(s.imageFingerprintsByRef?.size ?? 0, 0);
});

test("image state survives persist/reload round-trip", async () => {
    const P = mkdtempSync(path.join(tmpdir(), "bili-img-persist-"));
    try {
        const store = new SessionStore({ dir: P, debounceMs: 0 });
        _setStoreForTest(store);
        const fx = await shot();
        const s = armedSession({ r1: "m00001" });
        await applyImageCompressionPass(s, [anthropicMsg("r1", fx)], { config: enabledCfg(), billing: "pixels" });
        executeImageFull({ ref: "m00001" }, s, enabledCfg());
        markDirty(s);
        store.flushSync(s);
        _resetSessionsForTest();
        const reloaded = getSession(s.id);
        assert.equal(imageShrinksForRef(reloaded.state, "m00001").length, 1);
        assert.equal(isImageFullRestored(reloaded.state, "m00001"), true);
        assert.equal(reloaded.stats.imageShrunkCount, 1);
        assert.equal(reloaded.stats.imageFullCalls, 1);
        assert.equal(reloaded.stats.imageFullRestores, 1);
        assert.ok((reloaded.stats.imageBytesSaved ?? 0) > 0);
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
        rmrf(P);
    }
});

test("imageUsageSuffix reports lifetime savings alongside usage stats", async () => {
    assert.equal(imageUsageSuffix(undefined), "");
    const fx = await shot();
    const s = armedSession({ r1: "m00001" });
    assert.equal(imageUsageSuffix(s), "");
    await applyImageCompressionPass(s, [anthropicMsg("r1", fx)], { config: enabledCfg(), billing: "pixels" });
    assert.match(imageUsageSuffix(s), /img-saved=\d+tok/);
});
