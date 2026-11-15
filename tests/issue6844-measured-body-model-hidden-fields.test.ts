import assert from "node:assert/strict";
import test from "node:test";
import { defaultCountTokens } from "acp-kernel";
import { estimateRawBodyBreakdown, estimateRawBodyTokens } from "../src/preflight.ts";
import { measuredBreakdownClause } from "../src/server.ts";

// #6844: DSH attaches model-hidden provider metadata as top-level body fields
// (`dsh_session_log`, `dsh_plugin_packages`) — documented as staying outside
// model input — but the measured-body walks priced every top-level field into
// `other`, so an ordinary request 413'd at the egress fuse with `other` at
// 88% of the measured body while the model-visible buckets used 28% of budget.
const t = (s: string): number => defaultCountTokens(s);

function incidentBody(): { body: Record<string, unknown>; visible: number } {
    const messages = [{ role: "user", content: "hello message" }];
    const tools = [{ name: "search", description: "find things fast" }];
    const system = "system prompt text";
    const body = {
        model: "deepseek-flash",
        messages,
        tools,
        system,
        dsh_session_log: "L".repeat(100_000),
        dsh_plugin_packages: "P".repeat(10_000),
    };
    const visible = t("deepseek-flash") + t("user") + t("hello message") + t("search") + t("find things fast") + t("system prompt text");
    return { body, visible };
}

test("model-hidden DSH fields are excluded from the measured body", () => {
    const { body, visible } = incidentBody();
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.other, t("deepseek-flash"));
    assert.equal(bd.total, visible);
    assert.equal(estimateRawBodyTokens(body), visible);
});

test("a genuinely oversized other field is still counted", () => {
    const { body, visible } = incidentBody();
    const extra = "E".repeat(50_000);
    const withOther = { ...body, custom_extension: extra };
    const bd = estimateRawBodyBreakdown(withOther);
    assert.equal(bd.other, t("deepseek-flash") + t(extra));
    assert.equal(bd.total, visible + t(extra));
    assert.equal(estimateRawBodyTokens(withOther), visible + t(extra));
});

test("the same key nested inside messages[] still counts", () => {
    const nested = "N".repeat(1000);
    const body = {
        messages: [{ role: "user", content: [{ type: "text", text: "hi", dsh_session_log: nested }] }],
    };
    const bd = estimateRawBodyBreakdown(body);
    assert.equal(bd.messages, t("user") + t("text") + t("hi") + t(nested));
    assert.equal(bd.total, bd.messages);
    assert.equal(estimateRawBodyTokens(body), bd.messages);
});

test("total invariant holds with hidden and other fields mixed", () => {
    const { body, visible } = incidentBody();
    const mixed = { ...body, metadata: { note: "structural note" } };
    const bd = estimateRawBodyBreakdown(mixed);
    assert.equal(bd.other, t("deepseek-flash") + t("structural note"));
    assert.equal(bd.total, visible + t("structural note"));
    assert.equal(bd.total, estimateRawBodyTokens(mixed));
});

test("otherTop attributes the other bucket to its top-level fields, descending (#6844 item 3)", () => {
    const { body, visible } = incidentBody();
    const extra = "E".repeat(50_000);
    const withOther = { ...body, custom_extension: extra, metadata: { note: "note x" } };
    const bd = estimateRawBodyBreakdown(withOther);
    assert.deepEqual(bd.otherTop, [
        { field: "custom_extension", tokens: t(extra) },
        { field: "model", tokens: t("deepseek-flash") },
        { field: "metadata", tokens: t("note x") },
    ], "per-field attribution, largest first");
    assert.equal(bd.otherTop.reduce((sum, e) => sum + e.tokens, 0), bd.other, "otherTop sums to the other bucket");
    assert.equal(bd.total, visible + t(extra) + t("note x"));
});

test("hidden fields leave no otherTop attribution; empty other stays empty", () => {
    const { body } = incidentBody();
    const bd = estimateRawBodyBreakdown({ ...body, model: undefined });
    assert.equal(bd.other, 0, "only the two hidden fields were in other — both excluded");
    assert.deepEqual(bd.otherTop, []);
    assert.deepEqual(estimateRawBodyBreakdown({ messages: [{ role: "user", content: "hi" }] }).otherTop, []);
});

test("measuredBreakdownClause names the field dominating other (#6844 item 3)", () => {
    const { body } = incidentBody();
    const extra = "E".repeat(50_000);
    const bd = estimateRawBodyBreakdown({ ...body, custom_extension: extra });
    const clause = measuredBreakdownClause(bd);
    assert.match(clause, /other ~[\d,]+ \(top field: custom_extension ~[\d,]+\)/, `the 413 clause must name the dominating field, got: ${clause}`);
    assert.match(clause, /^messages ~[\d,]+ · tools\[\] ~[\d,]+ · system ~[\d,]+ · other /, "the four-bucket shape is unchanged");
});

test("measuredBreakdownClause stays bare when other is empty", () => {
    const bd = estimateRawBodyBreakdown({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(
        measuredBreakdownClause(bd),
        `messages ~${bd.messages.toLocaleString("en-US")} · tools[] ~0 · system ~0 · other ~0`,
        "no top-field suffix when other has nothing to attribute",
    );
});
