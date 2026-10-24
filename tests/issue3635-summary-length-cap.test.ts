import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { ExternalSummaryExecutor, describeExternalSummaryFailure, summaryLengthBudgetClause } from "../src/external-summary.ts";
import { applyConfiguredCompression } from "../src/external-summary-compress.ts";
import { SummaryCredentialStore } from "../src/external-summary-credentials.ts";
import { parseCompressSettings } from "../src/config.ts";
import { mergeCompress, applyCompressSettings } from "../src/compress-settings.ts";
import { createSession } from "../src/session.ts";
import type { RewriteCtx } from "../src/stream.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.NODE_ENV = "test";

const BUDGET = { totalTimeoutMs: 2000, targetTimeoutMs: 1000, maxSummaryBytes: 10_000 };
const CLAUSE = "\n\nLENGTH BUDGET: Your ENTIRE response must be AT MOST 20000 characters total — longer output is rejected by the pipeline. Be dense: compact bullets, no filler or repetition.";

function candidate(reply: string) {
    return { summarize: async () => reply };
}

test("invalid_summary attempts name the exact rejection reason (#3635)", async () => {
    const executor = new ExternalSummaryExecutor(1);
    const overCap = await executor.execute(
        { content: "x".repeat(100), instructions: "summarize", maxSummaryChars: 10 },
        [candidate("y".repeat(15))], BUDGET);
    assert.deepEqual(overCap, { status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "invalid_summary", detail: "summary 15 chars exceeds cap 10" }] });

    const tooShort = await executor.execute(
        { content: "x".repeat(100), instructions: "summarize", minSummaryChars: 100, maxSummaryChars: 1000 },
        [candidate("short")], BUDGET);
    assert.deepEqual(tooShort, { status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "invalid_summary", detail: "summary 5 chars below floor 100" }] });

    // The byte cap fires before the char checks (validator order).
    const overBytes = await executor.execute(
        { content: "x".repeat(100), instructions: "summarize" },
        [candidate("\u4e2d".repeat(10))], { ...BUDGET, maxSummaryBytes: 20 });
    assert.deepEqual(overBytes, { status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "invalid_summary", detail: "response 30 bytes exceeds byte cap 20" }] });

    const empty = await executor.execute(
        { content: "x".repeat(100), instructions: "summarize" },
        [candidate(" \n")], BUDGET);
    assert.deepEqual(empty, { status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "invalid_summary", detail: "empty or non-string response" }] });
});

test("describeExternalSummaryFailure renders the detail and keeps its legacy form without one (#3635/#2484)", () => {
    assert.equal(
        describeExternalSummaryFailure({ status: "finished", results: [{ status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "invalid_summary", detail: "summary 20059 chars exceeds cap 20000" }] }] }),
        "batch=finished result=failed reason=exhausted attempts=[t0:invalid_summary (summary 20059 chars exceeds cap 20000)]");
    // No detail → byte-identical to the pre-#3635 rendering (pinned by tests/issue2484-overflow-and-summary.test.ts).
    assert.equal(
        describeExternalSummaryFailure({ status: "finished", results: [{ status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "timeout" }] }] }),
        "batch=finished result=failed reason=exhausted attempts=[t0:timeout]");
});

test("summaryLengthBudgetClause gates on a finite budget at or above the floor (#3635)", () => {
    assert.equal(summaryLengthBudgetClause(20000, 50), CLAUSE);
    assert.ok(summaryLengthBudgetClause(50, 50).includes("AT MOST 50 characters"));
    assert.equal(summaryLengthBudgetClause(undefined, 50), "");
    assert.equal(summaryLengthBudgetClause(Number.POSITIVE_INFINITY, 50), "");
    assert.equal(summaryLengthBudgetClause(0, 50), "");
    assert.equal(summaryLengthBudgetClause(49, 50), "");
    // 0 = unbounded cap must stay omitted even with the floor disabled — never "AT MOST 0".
    assert.equal(summaryLengthBudgetClause(0, 0), "");
});

test("parseCompressSettings accepts the summary-length caps; 0 stays meaningful (#3635)", () => {
    assert.equal(parseCompressSettings({ maxSummaryLength: 32000, minSummaryLength: 80 })?.maxSummaryLength, 32000);
    assert.equal(parseCompressSettings({ maxSummaryLength: 32000, minSummaryLength: 80 })?.minSummaryLength, 80);
    assert.equal(parseCompressSettings({ maxSummaryLength: 0 })?.maxSummaryLength, 0);
    assert.equal(parseCompressSettings({ minSummaryLength: 0 })?.minSummaryLength, 0);
    assert.equal(parseCompressSettings({ maxSummaryLength: -1 }), undefined);
    assert.equal(parseCompressSettings({ minSummaryLength: -1 }), undefined);
    assert.equal(parseCompressSettings({ maxSummaryLength: "x" }), undefined);
    assert.equal(parseCompressSettings({ maxSummaryLength: Number.NaN }), undefined);
});

test("mergeCompress carries the summary-length caps across levels (#3635)", () => {
    const merged = mergeCompress({ maxSummaryLength: 100 }, { minSummaryLength: 20 }, { maxSummaryLength: 300 });
    assert.equal(merged.maxSummaryLength, 300);
    assert.equal(merged.minSummaryLength, 20);
});

test("applyCompressSettings maps the caps onto the resolved kernel config (#3635)", () => {
    const base = defaultConfig(100_000);
    assert.equal(base.compress.maxSummaryLength, 20000);
    assert.equal(base.compress.minSummaryLength, 50);
    const applied = applyCompressSettings(base, 100_000, { maxSummaryLength: 32000, minSummaryLength: 80 });
    assert.equal(applied.compress.maxSummaryLength, 32000);
    assert.equal(applied.compress.minSummaryLength, 80);
    const untouched = applyCompressSettings(base, 100_000, {});
    assert.equal(untouched.compress.maxSummaryLength, 20000);
    assert.equal(untouched.compress.minSummaryLength, 50);
});

const WIRE_SUMMARY = "Historical build completed. Preserve src/example.ts:27, error E_TEST, the no-deploy constraint, and the unfinished testing task.";
const WIRE_RAW = "Historical source src/example.ts:27 E_TEST; do not deploy; still add tests. ".repeat(90);

function wireContext(settings: unknown, cap?: number): RewriteCtx {
    const core = createCore();
    const config = defaultConfig(400_000) as Config & { externalSummary?: unknown };
    config.externalSummary = settings;
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    if (cap !== undefined) config.compress.maxSummaryLength = cap;
    const session = createSession(`issue3635-${Math.random()}`);
    const messages: CoreMessage[] = [
        { id: "history", role: "assistant", contentType: "text", text: WIRE_RAW },
        { id: "current-task", role: "user", contentType: "text", text: "Current task: finish tests without deployment." },
    ];
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 10000, renderTags: "text-only" }).state;
    return { core, config, session, messages, log: () => {} };
}
function wireArgs(ctx: RewriteCtx): Record<string, unknown> {
    return { content: [{ startId: ctx.session.state.messageRefs.byRaw.history, endId: ctx.session.state.messageRefs.byRaw.history }] };
}

// #3635 root cause on the wire: the model-tool compress path now states the
// EXACT cap its validator enforces to the external summarizer (the preflight
// path has done this since #1775), and a configured cap flows through to it.
test("the compress path tells external summarizers the exact enforced cap on the wire (#3635)", async () => {
    for (const [cap, expected] of [[undefined, "AT MOST 20000 characters"], [32000, "AT MOST 32000 characters"]] as const) {
        const bodies: string[] = [];
        const root = mkdtempSync(join(tmpdir(), "bili-3635-wire-"));
        const previous = process.env.BILI_CONFIG_FILE;
        process.env.BILI_CONFIG_FILE = join(root, "config.json");
        const server = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                bodies.push(Buffer.concat(chunks).toString("utf8"));
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ status: "completed", output_text: WIRE_SUMMARY }));
            });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
        const store = new SummaryCredentialStore();
        store.set("primary", "test-primary-key");
        const settings = { enabled: true, targets: [{ name: "primary", protocol: "responses", url: `${base}/primary`, model: "summary-primary", credentialRef: "secret:primary" }] };
        try {
            const ctx = wireContext(settings, cap);
            const result = await applyConfiguredCompression(wireArgs(ctx), ctx);
            assert.equal(result.outcome, "applied", result.text);
            assert.equal(bodies.length, 1);
            assert.ok(bodies[0].includes(expected), `cap ${String(cap)}: clause missing from the wire body`);
            assert.ok(bodies[0].includes("rejected by the pipeline"));
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
            else process.env.BILI_CONFIG_FILE = previous;
            rmrf(root);
        }
    }
});
