// #4313 toggle (PR #5236): message timestamps are OPT-IN, default OFF.
// Default-off bytes must stay identical to pre-feature master — wire tags
// carry no time= attr, compress receipts carry no [start – end] coverage
// span, and the prompt defaults are the exact pre-feature originals. This
// suite pins the HOST side of that contract (the kernel side lives in
// kernel/tests/issue4313-message-timestamps.test.ts):
//   - resolveMessageTimestamps env-over-file cascade (BILI_MESSAGE_TIMESTAMPS)
//   - messageTimestampSections variant selection at the prompt exits
//   - the compress-receipt fingerprint SPAN gate inside applyRanges
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, defaultConfig, assignRefs, emptyRefMap } from "acp-kernel";
import { FUNCTION_ACP_TAGS_TIMESTAMPED, LEAN_HOW_TO_COMPRESS, LEAN_HOW_TO_COMPRESS_TIMESTAMPED } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { resolveMessageTimestamps } from "../src/config.ts";
import { messageTimestampSections } from "../src/external-summary-surface.ts";

const SANDBOX = mkdtempSync(path.join(tmpdir(), "bili-4313-toggle-"));
const ABSENT_CONFIG = path.join(SANDBOX, "absent.json"); // deliberately never created
const LIVE_CONFIG = path.join(SANDBOX, "live.json");

const PREV_ENV = process.env.BILI_MESSAGE_TIMESTAMPS;
const PREV_CFG = process.env.BILI_CONFIG_FILE;

/** Point BOTH resolution layers where we want them: env value (or unset) and an
 *  optional config-file body (or none). Every assertion below runs under this. */
function setToggleLayers(envValue: string | undefined, configBody?: string): void {
    if (envValue === undefined) delete process.env.BILI_MESSAGE_TIMESTAMPS;
    else process.env.BILI_MESSAGE_TIMESTAMPS = envValue;
    if (configBody !== undefined) {
        writeFileSync(LIVE_CONFIG, configBody, "utf8");
        process.env.BILI_CONFIG_FILE = LIVE_CONFIG;
    } else {
        delete process.env.BILI_CONFIG_FILE;
        process.env.BILI_CONFIG_FILE = ABSENT_CONFIG;
    }
}

before(() => _setStoreForTest(new SessionStore({ enabled: false })));

after(() => {
    if (PREV_ENV === undefined) delete process.env.BILI_MESSAGE_TIMESTAMPS;
    else process.env.BILI_MESSAGE_TIMESTAMPS = PREV_ENV;
    if (PREV_CFG === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = PREV_CFG;
    rmSync(SANDBOX, { recursive: true, force: true });
});

test("resolveMessageTimestamps: env > file > default false", () => {
    assert.equal(resolveMessageTimestamps(undefined, {}), false);
    assert.equal(resolveMessageTimestamps({}, {}), false);
    assert.equal(resolveMessageTimestamps({ messageTimestamps: true }, {}), true);
    assert.equal(resolveMessageTimestamps({ messageTimestamps: false }, {}), false);
    assert.equal(resolveMessageTimestamps(undefined, { BILI_MESSAGE_TIMESTAMPS: "1" }), true);
    assert.equal(resolveMessageTimestamps({ messageTimestamps: true }, { BILI_MESSAGE_TIMESTAMPS: "0" }), false);
    assert.equal(resolveMessageTimestamps({ messageTimestamps: false }, { BILI_MESSAGE_TIMESTAMPS: "anything" }), true);
});

test("messageTimestampSections: OFF returns the input by reference (zero divergence)", () => {
    setToggleLayers(undefined);
    const sections = { howToCompress: LEAN_HOW_TO_COMPRESS };
    assert.equal(messageTimestampSections(sections), sections);
    assert.equal(messageTimestampSections(undefined), undefined);
});

test("messageTimestampSections: ON selects variants without stomping overrides", () => {
    setToggleLayers(undefined, JSON.stringify({ compress: { messageTimestamps: true } }));
    const swapped = messageTimestampSections({ howToCompress: LEAN_HOW_TO_COMPRESS });
    assert.equal(swapped?.acpTags, FUNCTION_ACP_TAGS_TIMESTAMPED);
    assert.equal(swapped?.howToCompress, LEAN_HOW_TO_COMPRESS_TIMESTAMPED);
    // pack/section overrides win even when the flag is on
    const customTags = "model-specific tag contract";
    const customHow = "model-specific compression rules";
    const preserved = messageTimestampSections({ acpTags: customTags, howToCompress: customHow });
    assert.equal(preserved?.acpTags, customTags);
    assert.equal(preserved?.howToCompress, customHow);
    // hybrid kind leaves acpTags alone (its TAGS section was never time-modified)
    assert.equal(messageTimestampSections({ howToCompress: LEAN_HOW_TO_COMPRESS }, "hybrid")?.acpTags, undefined);
});

// ── receipt fingerprint SPAN gate (applyRanges) ──────────────────────────────
const T0 = Date.UTC(2026, 8, 28, 7, 59, 9);

const MESSAGES = Array.from({ length: 80 }, (_, i) => ({
    id: `raw${i}`,
    role: (i % 2 ? "assistant" : "user") as "assistant" | "user",
    text: "lorem ipsum dolor sit amet conseq ".repeat(8) + i,
})) as unknown as CoreMessage[];

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void };

function makeCtx(): Ctx {
    return {
        core: createCore(),
        config: defaultConfig(200000, { preserveRecentMessages: 5, preserveRecentTokens: 0 }),
        messages: MESSAGES,
        session: {
            id: "toggle-span-gate",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
            pendingRetrievals: [],
        },
        log: () => {},
    };
}

/** Fold m00001–m00020 while EVERY covered id carries a persisted first-sight
 *  stamp, so the ONLY variable between cases is the toggle itself. */
function foldReceiptText(): string {
    const ctx = makeCtx();
    ctx.session.state.messageRefs = assignRefs(MESSAGES, { existing: emptyRefMap(), nextIndex: 0 }).map;
    ctx.session.state.tsStamps = Object.fromEntries(MESSAGES.map((m, i) => [m.id as string, T0 + i * 1000]));
    const parsed = parseCompressInput({ content: [{ startId: "m00001", endId: "m00020", summary: "y".repeat(100) }] });
    const text = applyRanges(parsed, ctx).text;
    assert.ok(text.includes("full summary"), `fold committed, got: ${text.slice(0, 160)}`);
    return text;
}

const SPAN_RE = /\[\d{4}-\d{2}-\d{2}[^\]]*–[^\]]*\]/;

test("receipt span GATE: default (flag off) omits the coverage span despite stamps", () => {
    setToggleLayers(undefined);
    const text = foldReceiptText();
    assert.match(text, /full summary \d+ch · head/);
    assert.doesNotMatch(text, SPAN_RE, `flag OFF must emit no local-time span:\n${text}`);
});

test("receipt span GATE: BILI_MESSAGE_TIMESTAMPS=1 turns the span on (env layer)", () => {
    setToggleLayers("1");
    assert.match(foldReceiptText(), SPAN_RE, "env-on must append the [start – end] span");
});

test("receipt span GATE: config file messageTimestamps=true turns it on (file layer)", () => {
    setToggleLayers(undefined, JSON.stringify({ compress: { messageTimestamps: true } }));
    assert.match(foldReceiptText(), SPAN_RE, "file-on must append the span");
});

test("receipt span GATE: env 0 beats a file true", () => {
    setToggleLayers("0", JSON.stringify({ compress: { messageTimestamps: true } }));
    assert.doesNotMatch(foldReceiptText(), SPAN_RE, "env 0 must force the pre-feature receipt bytes");
});
