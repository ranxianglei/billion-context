// #2626: decompress carries two modes — text block/range restore and image
// recovery (#1995) — and they were dispatched on whether imageRef was PRESENT
// rather than whether it carried a VALID value. Hosts and models emit "" /
// whitespace / null for optional fields, so `decompress({blockId:"b1",
// imageRef:""})` jumped into image mode and returned the "No restorable images"
// receipt instead of restoring b1 (the data never left the session, but the
// success-shaped receipt made callers believe the text restore completed).
//
// These tests pin the corrected validity-based dispatch: blank/null/undefined
// imageRef ⇒ unspecified → text path; a non-blank string ⇒ image path (the
// documented "list" / mNNNNN semantics are unchanged); a non-string non-null
// value ⇒ a loud param error rather than silently defaulting to the image list.
// They exercise resolveDecompress directly — the single shared resolver every
// wire/plugin lane funnels through (loop/core.ts executeProxyTool, stream.ts
// executeAnthropicProxyTool).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.BILI_PERSIST = "0";
// Isolate any incidental stateDir() writes under a throwaway dir (whole-block
// restore spills >10K bodies to tmpdir(), not stateDir, but keep it hermetic).
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "bili-imgref-dispatch-"));

import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { getSession } from "../src/session.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { resolveDecompress, type ProxyToolCtx } from "../src/decompress-shared.ts";

const pad = (n: number): string => String(n).padStart(5, "0");

function makeMsgs(): CoreMessage[] {
    const msgs: CoreMessage[] = [];
    for (let i = 0; i < 20; i++) {
        msgs.push({
            id: `h_${i}`,
            role: i % 2 === 0 ? "user" : "assistant",
            contentType: "text",
            text: `\x3cacp tokens="2K" type="text"\x3em${pad(i + 1)}\x3c/acp\x3e\nHistorical detail ${i}. ${"x".repeat(2000)}`,
        });
    }
    return msgs;
}

type FoldResult = {
    core: ReturnType<typeof createCore>;
    config: Config;
    session: ReturnType<typeof getSession>;
    msgs: CoreMessage[];
    blockId: string;
};

// Build a session holding one active compressed block whose content is fully
// recoverable via whole-block decompress (the text path under test).
function fold(): FoldResult {
    const core = createCore();
    const config = applyCompressSettings(
        defaultConfig(200_000),
        200_000,
        { ccr: { enabled: false, minToolTokens: 50 } },
    ) as Config;
    const session = getSession(`d2626-${Math.random().toString(36).slice(2)}`);
    const raw = makeMsgs();
    const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup.", topic: "Early history" }] }), ctx);
    const block = [...session.state.blocks].find((b) => b.active);
    assert.ok(block, "a block was created");
    return { core, config, session, msgs: turn.messages, blockId: block.blockId };
}

function ctxOf(f: FoldResult): ProxyToolCtx {
    return { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
}

// Minimal ctx for the IMAGE-mode assertions: those branches touch nothing but
// session.incomingImageIndex and log (mirrors tests/image-restore.test.ts).
function imgCtx(index: Map<string, unknown[]> | undefined): ProxyToolCtx {
    return { session: { incomingImageIndex: index }, log: () => undefined } as unknown as ProxyToolCtx;
}

test("#2626: valid blockId + EMPTY imageRef restores the text block, not the image receipt", () => {
    const f = fold();
    const r = resolveDecompress({ blockId: f.blockId, imageRef: "" }, ctxOf(f));
    assert.equal(r.outcome, "success", `expected success, got: ${r.text.slice(0, 120)}`);
    assert.match(r.text, new RegExp(`^\\[Block ${f.blockId} content \\u2014`));
    assert.doesNotMatch(r.text, /restorable images/i, "must not enter image mode");
});

test("#2626: whitespace-only imageRef counts as omitted too", () => {
    const f = fold();
    for (const ws of ["   ", "\t\n", "\u00a0"]) {
        const r = resolveDecompress({ blockId: f.blockId, imageRef: ws }, ctxOf(f));
        assert.equal(r.outcome, "success", `ws=${JSON.stringify(ws)}: ${r.text.slice(0, 120)}`);
        assert.match(r.text, new RegExp(`^\\[Block ${f.blockId} content \\u2014`));
    }
});

test("#2626: null imageRef counts as omitted (text restore)", () => {
    const f = fold();
    const r = resolveDecompress({ blockId: f.blockId, imageRef: null }, ctxOf(f));
    assert.equal(r.outcome, "success", r.text.slice(0, 120));
    assert.match(r.text, new RegExp(`^\\[Block ${f.blockId} content \\u2014`));
});

test("#2626: omitted imageRef still restores the text block (unchanged baseline)", () => {
    const f = fold();
    const r = resolveDecompress({ blockId: f.blockId }, ctxOf(f));
    assert.equal(r.outcome, "success", r.text.slice(0, 120));
    assert.match(r.text, new RegExp(`^\\[Block ${f.blockId} content \\u2014`));
});

test("#2626: empty imageRef with NO blockId fails loudly asking for one (not a silent list)", () => {
    for (const v of ["", "   ", null]) {
        const r = resolveDecompress({ imageRef: v }, imgCtx(undefined));
        assert.equal(r.outcome, "failure", `v=${JSON.stringify(v)}`);
        assert.match(r.text, /blockId is required/);
    }
});

test("#2626: non-string non-null imageRef is a loud param error, never a silent image-list default", () => {
    for (const v of [42, true, false, {}, ["m00042"]]) {
        const r = resolveDecompress({ blockId: "b1", imageRef: v }, imgCtx(undefined));
        assert.equal(r.outcome, "failure", `v=${JSON.stringify(v)}`);
        assert.match(r.text, /decompress FAILED: imageRef must be a string/);
    }
});

test("#2626: explicit \"list\" (any case, padded) still selects image mode", () => {
    // An index with one entry so the list branch renders the enumeration rather
    // than the absent-index notice; the point is that we REACHED image mode.
    const idx = new Map<string, unknown[]>([["m00042", [{ mediaType: "image/png", bytes: 88, width: 1, height: 1, path: "/nonexistent/x.png" }]]]);
    for (const v of ["list", "LIST", " List ", "\tlist\t"]) {
        const r = resolveDecompress({ imageRef: v }, imgCtx(idx));
        assert.equal(r.outcome, "success", `v=${JSON.stringify(v)}: ${r.text.slice(0, 120)}`);
        assert.match(r.text, /\[Restorable images \(1\):\]/, `v=${JSON.stringify(v)} must reach the image list`);
    }
});

test("#2626: a concrete mNNNNN imageRef still routes to image mode (no index → image failure, not text)", () => {
    // Proves a non-blank specific ref is NOT swallowed by the text path: with no
    // blockId and no index it must fail as an image restore, never as "blockId
    // is required".
    const r = resolveDecompress({ imageRef: "m00042" }, imgCtx(undefined));
    assert.equal(r.outcome, "failure");
    assert.match(r.text, /no image history is indexed/);
});
