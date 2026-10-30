import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { assignRefs, COMPRESS_PARAMETERS, createCore, createInitialState, defaultConfig, emptyRefMap } from "acp-kernel";
import { parseCompressInput, withFirstSightDrain, withSummaryBudgetNote } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { EXTERNAL_SUMMARY_NOTE } from "../src/external-summary-surface.ts";

// #5080: after the #4252 narrowing (advertised form = ONE plain string), every
// model-facing compress text on the proxy lane must teach ONLY that form. The
// parser still salvages legacy object/array shapes — but re-teaching them in
// failure receipts or nudge notes steered models back into schema-rejected
// hybrids (#5080 report: receipts lectured "EITHER an object … OR one
// line-form string" while the schema declares content type:string). These pins
// cover the negative direction per the gate discipline (#3617): the positive
// direction (the string form parses and folds) is covered by the existing
// line-form suites.

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[]): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000),
        messages,
        session: {
            id: "issue-5080-form-test",
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
        log: (m: string) => { logs.push(m); },
        logs,
    };
}

function withRefs(ctx: Ctx): Ctx {
    const res = assignRefs(ctx.messages, { existing: emptyRefMap(), nextIndex: 0 });
    ctx.session.state.messageRefs = res.map;
    return ctx;
}

function textMsg(id: string, role: "user" | "assistant", text: string): CoreMessage {
    return { id, role, contentType: "text", text };
}

function makeCompressibleCtx(): Ctx {
    return withRefs(makeCtx([
        textMsg("raw_1", "user", "x".repeat(20000)),
        textMsg("raw_2", "assistant", "x".repeat(20000)),
        textMsg("raw_3", "user", "x".repeat(5000)),
        textMsg("raw_4", "assistant", "x".repeat(5000)),
        textMsg("raw_5", "user", "x".repeat(5000)),
        textMsg("raw_6", "assistant", "x".repeat(5000)),
        textMsg("raw_7", "user", "x".repeat(5000)),
    ]));
}

function runApply(ctx: Ctx, args: unknown): string {
    return applyRanges(parseCompressInput(args), ctx).text;
}

const OBJECT_FORM_TEACHING = /EITHER an object|object-form content|\{startId,\s*endId,\s*summary\}|'content' array|content array whose elements/i;

test("#5080: the advertised schema stays the single-string form", () => {
    const props = COMPRESS_PARAMETERS.properties as Record<string, { type?: string }>;
    assert.equal(props.content?.type, "string", "content must stay type:string");
    assert.equal((COMPRESS_PARAMETERS as { required?: unknown }).required, undefined, "open object shell: no top-level required");
});

test("#5080: no-valid-ranges receipt teaches only the single-string form", () => {
    const ctx = makeCompressibleCtx();
    const out = runApply(ctx, { content: JSON.stringify(["## Block one\nsummary text", "## Block two\nmore text", "## Block three\nyet more"]) });
    assert.ok(out.startsWith("[Compression FAILED"), out);
    assert.ok(out.includes("no valid ranges parsed"), out);
    assert.ok(out.includes("ONE argument shape"), out);
    assert.ok(out.includes("single non-empty string holding ALL ranges"), out);
    assert.ok(out.includes("mNNNNN–mNNNNN optional topic"), out);
    assert.doesNotMatch(out, OBJECT_FORM_TEACHING);
});

test("#5080: empty-call receipt teaches only the single-string form", () => {
    const ctx = makeCompressibleCtx();
    const out = runApply(ctx, {});
    assert.ok(out.includes("carried no content at all"), out);
    assert.ok(out.includes("ONE non-empty 'content' string"), out);
    assert.doesNotMatch(out, OBJECT_FORM_TEACHING);
});

test("#5080: corrupt-args receipt teaches only the single-string form", () => {
    const ctx = makeCompressibleCtx();
    const out = runApply(ctx, "{{{not-json");
    assert.ok(out.includes("not parseable JSON"), out);
    assert.ok(out.includes("ONE non-empty string holding every range"), out);
    assert.doesNotMatch(out, OBJECT_FORM_TEACHING);
});

test("#5080: armed-breaker refusal teaches only the single-string form", () => {
    const ctx = makeCompressibleCtx();
    let out = "";
    for (let i = 0; i < 4; i++) {
        out = runApply(ctx, { content: JSON.stringify([`headerless block ${i}`]) });
    }
    assert.ok(out.includes("circuit breaker is still armed"), out);
    assert.ok(out.includes("ONE plain string holding every range"), out);
    assert.doesNotMatch(out, OBJECT_FORM_TEACHING);
});

test("#5080: standing notes and external-summary note teach only the single-string form", () => {
    const budget = withSummaryBudgetNote("", false);
    assert.ok(budget.includes("mNNNNN–mNNNNN topic"), budget);
    assert.doesNotMatch(budget, OBJECT_FORM_TEACHING);

    const drain = withFirstSightDrain("", "backlog [first-sight mass]", false);
    assert.ok(drain.includes("mNNNNN–mNNNNN topic"), drain);
    assert.doesNotMatch(drain, OBJECT_FORM_TEACHING);

    const drainExternal = withFirstSightDrain("", "backlog [first-sight mass]", true);
    assert.ok(drainExternal.includes("mNNNNN–mNNNNN topic"), drainExternal);
    assert.doesNotMatch(drainExternal, OBJECT_FORM_TEACHING);

    assert.ok(EXTERNAL_SUMMARY_NOTE.includes("single-string content form"), EXTERNAL_SUMMARY_NOTE);
    assert.doesNotMatch(EXTERNAL_SUMMARY_NOTE, OBJECT_FORM_TEACHING);
});
