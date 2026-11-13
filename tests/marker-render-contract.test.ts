// Render-contract for the acp_status body consumer (#2815 review, point 2).
//
// src/marker/status-body.ts anchors on the `<icon> [ACP] … acp_status …` head
// and eats the contiguous report body line-by-line. Its SECTION_HEADS
// whitelist is a hand-maintained mirror of the REAL renderers — kernel
// report (kernel/src/report.ts) and host extras (src/acp-status.ts). This
// test drives the real emitters over every report variant and asserts the
// consumer eats each rendered report whole, so a renderer that adds/renames
// a section fails here the moment the two sides drift (instead of silently
// re-leaking bodies on the wire, #2789).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig, type CoreMessage } from "acp-kernel";
import { handleAcpStatus } from "../src/acp-status.ts";
import { applyRanges } from "../src/stream.ts";
import { parseCompressInput } from "../src/compress-tool.ts";
import { consumeAcpStatusBody } from "../src/marker/status-body.ts";
import { buildVisibilityMarker } from "../src/loop/core.ts";
import type { Session } from "../src/session.ts";

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeCtx(): { ctx: Parameters<typeof handleAcpStatus>[1]; } {
    const msgs: CoreMessage[] = [];
    for (let i = 1; i <= 12; i++) {
        msgs.push(textMsg(`raw_${i}`, i % 2 === 1 ? "user" : "assistant", "x".repeat(5000)));
    }
    const session = {
        id: "marker-render-contract",
        meta: {},
        stats: { requests: 3, tokensSaved: 0, inputTokens: 4242, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 15000, compressCreditTokens: 0, contextTokens: 0, retrieveCalls: 0, retrieveHits: 0, retrieveMisses: 0, storedBytes: 0, storeBytesSaved: 0, rangeRestores: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
        pendingRetrievals: [],
    } as unknown as Session;
    const res = assignRefs(msgs, { existing: emptyRefMap(), nextIndex: 0 });
    session.state.messageRefs = res.map;
    const ctx = { core: createCore(), config: defaultConfig(200000), messages: msgs, session, log: () => {} };
    const fold = applyRanges(parseCompressInput(JSON.parse(JSON.stringify({ content: [{ startId: "m00001", endId: "m00006", summary: "RENDER-CONTRACT-SUMMARY-PAYLOAD-LONG-ENOUGH-FOR-THE-KERNEL-MIN-LENGTH-CHECK" }] }))), ctx as never);
    assert.ok(!fold.text.startsWith("[Compression FAILED"), `fixture fold succeeded (got: ${fold.text.slice(0, 80)})`);
    return { ctx: ctx as never };
}

// Legacy wire echo shape, before buildVisibilityMarker added wrapper pairs:
// `\n${icon} [ACP] acp_status result:\n${result.trim()}\n`.
const ICON = "\u{1F4CA}";
function echo(result: string): string {
    return `${ICON} [ACP] acp_status result:\n${result.trim()}\n`;
}

const VARIANTS: { name: string; args: Record<string, unknown> }[] = [
    { name: "default (overview + ranges + nudge)", args: {} },
    { name: "scope uncompressed, sorted by size", args: { scope: "uncompressed" } },
    { name: "scope uncompressed, sorted by time", args: { scope: "uncompressed", sort: "time" } },
    { name: "scope uncompressed, view messages", args: { scope: "uncompressed", view: "messages" } },
    { name: "scope compressed", args: { scope: "compressed" } },
    { name: "scope compressed, view messages", args: { scope: "compressed", view: "messages" } },
];

test("render contract: every report variant is consumed whole (SECTION_HEADS cannot drift)", () => {
    const { ctx } = makeCtx();
    for (const v of VARIANTS) {
        const report = handleAcpStatus(v.args, ctx).text;
        assert.ok(report.length > 50, `${v.name}: fixture produced a real report`);
        const standalone = consumeAcpStatusBody(echo(report));
        assert.equal(standalone.bodies, 1, `${v.name}: head + body recognized`);
        assert.equal(standalone.text.trim(), "", `${v.name}: whole report consumed (residual: ${JSON.stringify(standalone.text.slice(0, 160))})`);
        assert.ok(standalone.lines > 0, `${v.name}: body lines were removed`);
        // embedded between user prose: the report is eaten, the prose stays
        const embedded = consumeAcpStatusBody(`before prose\n${echo(report)}after prose`);
        assert.equal(embedded.bodies, 1, `${v.name}: embedded head + body recognized`);
        assert.equal(embedded.text.trim(), "before prose\nafter prose", `${v.name}: surrounding prose survives (got: ${JSON.stringify(embedded.text)})`);
    }
});

test("render contract: pre-compaction archive sections are consumed whole (#3105)", () => {
    const { ctx } = makeCtx();
    const archive: Record<string, { at: number; reason: string }> = {};
    for (let i = 1; i <= 60; i++) archive[`b${i}`] = { at: i, reason: "covered substrate destroyed by unannounced client history rewrite (#2695)" };
    ctx.session.metadata.preCompactionArchive = archive;
    for (const args of [{}, { archiveDetail: true }] as Record<string, unknown>[]) {
        const report = handleAcpStatus(args, ctx).text;
        assert.match(report, /PRE-COMPACTION ARCHIVE/);
        const standalone = consumeAcpStatusBody(echo(report));
        assert.equal(standalone.bodies, 1, `${JSON.stringify(args)}: head + body recognized`);
        assert.equal(standalone.text.trim(), "", `${JSON.stringify(args)}: whole report consumed (residual: ${JSON.stringify(standalone.text.slice(0, 160))})`);
    }
});

test("render contract: consumer leaves non-report marker lines alone", () => {
    // A bare head with no report grammar behind it (plain marker line) is
    // owned by MARKER_LINE, not this consumer.
    const lone = `${ICON} [ACP] acp_status result: something short`;
    const out = consumeAcpStatusBody(lone);
    assert.equal(out.bodies, 0);
    assert.equal(out.text, lone);
});

test("render contract: real visibility markers and already-orphaned wrappers are consumed", () => {
    const { ctx } = makeCtx();
    for (const v of VARIANTS) {
        const marker = buildVisibilityMarker("acp_status", handleAcpStatus(v.args, ctx).text).trim();
        for (const report of [marker, marker.slice(marker.indexOf("[acp-status]"))]) {
            const out = consumeAcpStatusBody(`before prose\n${report}\nafter prose`);
            assert.equal(out.bodies, 1, v.name);
            assert.ok(out.lines > 0, v.name);
            assert.equal(out.text, "before prose\nafter prose", v.name);
            assert.deepEqual(consumeAcpStatusBody(out.text), { text: out.text, bodies: 0, lines: 0 });
        }
    }
});

test("render contract: wrapped reports do not depend on the legacy section whitelist", () => {
    const marker = buildVisibilityMarker("acp_status", "A future report section\n  synthetic row").trim();
    const out = consumeAcpStatusBody(`${marker}\nkept prose\n${marker}`);
    assert.equal(out.bodies, 2);
    assert.equal(out.text, "kept prose");
    const incomplete = "[acp-status]\nnot a complete report\nuser prose";
    assert.equal(consumeAcpStatusBody(incomplete).text, incomplete);
    const literal = "Mention [acp-status] and [/acp-status] in prose.";
    assert.equal(consumeAcpStatusBody(literal).text, literal);
});
