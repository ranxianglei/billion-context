import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    createCore,
    defaultConfig,
    RULE_TOOL_NAME,
    type Config,
} from "acp-kernel";
import { isProxyToolFor } from "../src/absorb.ts";
import { mergeCompress, applyCompressSettings } from "../src/compress-settings.ts";
import { parseCompressSettings } from "../src/config.ts";
import { RULE_TOOL, RULE_TOOL_GOOGLE, RULE_TOOL_OPENAI, RULE_TOOL_RESPONSES } from "../src/compress-tool.ts";
import { executeProxyTool, type LoopCtx } from "../src/loop/core.ts";
import { handlePluginManifest } from "../src/plugin.ts";
import {
    effectiveRulesConfig,
    effectiveRulesEnabled,
    executeRule,
    rulesEnabled,
    storeEffectiveRules,
    type RuleExecCtx,
} from "../src/rules-feature.ts";
import { getSession, type Session } from "../src/session.ts";
import { SessionStore } from "../src/persist.ts";

function makeSession(): Session {
    return getSession(`t-rules-${Math.random().toString(36).slice(2)}`);
}

function makeRuleCtx(config?: Partial<Config>): { session: Session; ctx: RuleExecCtx } {
    const session = makeSession();
    const cfg: Config = { ...defaultConfig(200000), rules: { enabled: true }, ...config };
    return { session, ctx: { config: cfg, session, log: () => {} } };
}

test("rulesEnabled is opt-in; explicit true enables, explicit false is a loud off", () => {
    assert.equal(rulesEnabled(defaultConfig(200000)), false);
    assert.equal(rulesEnabled({ ...defaultConfig(200000), rules: { enabled: false } }), false);
    assert.equal(rulesEnabled({ ...defaultConfig(200000), rules: { enabled: true } }), true);
});

test("isProxyToolFor: acp_rule opt-in — on only when enabled (#1399)", () => {
    const base = defaultConfig(200000);
    assert.equal(isProxyToolFor("compress", undefined, base), true);
    assert.equal(isProxyToolFor(RULE_TOOL_NAME, undefined, base), false, "unset → not a proxy tool");

    const off: Config = { ...base, rules: { enabled: false } };
    assert.equal(isProxyToolFor(RULE_TOOL_NAME, undefined, off), false);

    const session = makeSession();
    storeEffectiveRules(session, off);
    // Plugin tool API reads the per-session stored block even when the
    // fallback (base kernel config) has the feature enabled.
    assert.equal(isProxyToolFor(RULE_TOOL_NAME, session, { ...base, rules: { enabled: true } }), false);
    storeEffectiveRules(session, { ...base, rules: { enabled: true } });
    assert.equal(isProxyToolFor(RULE_TOOL_NAME, session, off), true);
});

test("effectiveRulesConfig: session metadata wins over fallback; absent stored block falls through", () => {
    const on: NonNullable<Config["rules"]> = { enabled: true };
    const session = makeSession();
    storeEffectiveRules(session, { ...defaultConfig(200000), rules: on });
    assert.deepEqual(effectiveRulesConfig(session, defaultConfig(200000)), on);
    // Unlike absorb, defaultConfig() ships NO rules block, so storing a config
    // without one records null and falls through to the fallback's block.
    storeEffectiveRules(session, defaultConfig(200000));
    assert.deepEqual(effectiveRulesConfig(session, { ...defaultConfig(200000), rules: on }), on);
    assert.equal(effectiveRulesConfig(undefined, defaultConfig(200000)), undefined);
});

test("effectiveRulesEnabled: opt-in — unset → off; explicit true enables from either layer", () => {
    const base = defaultConfig(200000);
    assert.equal(effectiveRulesEnabled(undefined, base), false, "unset → off (opt-in)");
    assert.equal(effectiveRulesEnabled(undefined, { ...base, rules: { enabled: true } }), true);
    assert.equal(effectiveRulesEnabled(undefined, { ...base, rules: { enabled: false } }), false);
    const session = makeSession();
    storeEffectiveRules(session, base);
    assert.equal(effectiveRulesEnabled(session, { ...base, rules: { enabled: true } }), true, "stored-unset block falls through to the enabled fallback");
    storeEffectiveRules(session, { ...base, rules: { enabled: false } });
    assert.equal(effectiveRulesEnabled(session, { ...base, rules: { enabled: true } }), false, "stored false beats fallback true");
    storeEffectiveRules(session, { ...base, rules: { enabled: true } });
    assert.equal(effectiveRulesEnabled(session, base), true, "stored true beats absent fallback");
});

test("executeRule: add records with trim, omitting rule lists", () => {
    const { session, ctx } = makeRuleCtx();
    assert.equal(executeRule({ rule: "always run tests before committing" }, ctx), "Recorded rule1: always run tests before committing");
    assert.equal(executeRule({ rule: "  trim input text  " }, ctx), "Recorded rule2: trim input text");
    const listing = "1. [rule1] always run tests before committing\n2. [rule2] trim input text";
    assert.equal(executeRule({}, ctx), listing);
    assert.equal(executeRule({ rule: "   " }, ctx), listing);
    assert.equal(executeRule({ rule: 42 }, ctx), listing);
    assert.equal(session.state.rules?.length, 2);
});

test("executeRule: validation failures return verbatim kernel errors, no state change", () => {
    const { session, ctx } = makeRuleCtx();
    assert.equal(executeRule({ rule: "dup rule" }, ctx), "Recorded rule1: dup rule");
    assert.equal(executeRule({ rule: "dup rule" }, ctx), "identical rule already exists (rule1) \u2014 no change.");
    assert.match(executeRule({ rule: "x".repeat(301) }, ctx), /^301 chars exceeds the 300-char limit/);
    assert.equal((session.state.rules ?? []).length, 1);
});

test("executeRule: maxRules cap from config limits", () => {
    const { ctx } = makeRuleCtx({ rules: { enabled: true, maxRules: 2 } });
    assert.match(executeRule({ rule: "one" }, ctx), /^Recorded rule1: one$/);
    assert.match(executeRule({ rule: "two" }, ctx), /^Recorded rule2: two$/);
    assert.match(executeRule({ rule: "three" }, ctx), /^rule limit reached \(2\)/);
});

test("executeRule: delete removes one rule by id and returns Removed with its text", () => {
    const { session, ctx } = makeRuleCtx();
    assert.equal(executeRule({ rule: "keep me" }, ctx), "Recorded rule1: keep me");
    assert.equal(executeRule({ rule: "drop me" }, ctx), "Recorded rule2: drop me");
    assert.equal(executeRule({ delete: "rule2" }, ctx), "Removed rule2: drop me");
    assert.deepEqual(session.state.rules, [{ id: "rule1", text: "keep me" }]);
    assert.equal(executeRule({}, ctx), "1. [rule1] keep me");
});

test("executeRule: delete trims the id and passes unknown ids through verbatim", () => {
    const { session, ctx } = makeRuleCtx();
    assert.equal(executeRule({ rule: "target" }, ctx), "Recorded rule1: target");
    assert.equal(executeRule({ delete: "  rule9  " }, ctx), 'no rule with id "rule9" \u2014 list current rules first (omit the text argument).');
    assert.deepEqual(session.state.rules, [{ id: "rule1", text: "target" }], "failed delete must not mutate state");
    assert.equal(executeRule({ delete: "  rule1 " }, ctx), "Removed rule1: target");
    assert.equal(session.state.rules?.length, 0);
});

test("executeRule: clear removes all rules and reports the count; empty clear is honest", () => {
    const { session, ctx } = makeRuleCtx();
    executeRule({ rule: "one" }, ctx);
    executeRule({ rule: "two" }, ctx);
    assert.equal(executeRule({ clear: true }, ctx), "Cleared 2 rule(s).");
    assert.deepEqual(session.state.rules, []);
    assert.equal(executeRule({}, ctx), "No rules recorded.");
    assert.equal(executeRule({ clear: true }, ctx), "No rules to clear.");
});

test("executeRule: delete/clear are mutually exclusive with each other and with rule", () => {
    const { session, ctx } = makeRuleCtx();
    executeRule({ rule: "survivor" }, ctx);
    const conflict = "Use one operation per call: record (rule), remove one (delete), remove all (clear: true), or list (no arguments).";
    assert.equal(executeRule({ delete: "rule1", clear: true }, ctx), conflict);
    assert.equal(executeRule({ delete: "rule1", rule: "new" }, ctx), conflict);
    assert.equal(executeRule({ clear: true, rule: "new" }, ctx), conflict);
    assert.deepEqual(session.state.rules, [{ id: "rule1", text: "survivor" }], "conflicting calls must not mutate state");
    // Non-string delete / non-true clear are ignored, same convention as non-string rule.
    assert.equal(executeRule({ delete: true }, ctx), "1. [rule1] survivor");
    assert.equal(executeRule({ clear: false }, ctx), "1. [rule1] survivor");
});

test("acp_rule schemas document rule/delete/clear on every wire shape", () => {
    type ToolShape = { input_schema?: { properties?: Record<string, { description?: string }> }; parameters?: { properties?: Record<string, { description?: string }> }; function?: { parameters?: { properties?: Record<string, { description?: string }> } } };
    for (const tool of [RULE_TOOL, RULE_TOOL_OPENAI, RULE_TOOL_RESPONSES, RULE_TOOL_GOOGLE] as ToolShape[]) {
        const props = tool.input_schema?.properties ?? tool.parameters?.properties ?? tool.function?.parameters?.properties;
        assert.ok(props, "acp_rule carries a parameter schema");
        for (const key of ["rule", "delete", "clear"]) {
            assert.ok(typeof props[key]?.description === "string" && props[key].description.length > 0, `param ${key} documented`);
        }
    }
});

test("executeProxyTool: routes acp_rule through executeRule when enabled, unknown tool otherwise", () => {
    const { session, ctx } = makeRuleCtx();
    const loopCtx: LoopCtx = { core: createCore(), config: ctx.config, messages: [], session, log: () => {} };
    assert.equal(executeProxyTool(RULE_TOOL_NAME, { rule: "via loop" }, loopCtx), "Recorded rule1: via loop");
    assert.equal(executeProxyTool(RULE_TOOL_NAME, { delete: "rule1" }, loopCtx), "Removed rule1: via loop");

    const offSession = makeSession();
    const offCtx: LoopCtx = { core: createCore(), config: { ...defaultConfig(200000), rules: { enabled: false } }, messages: [], session: offSession, log: () => {} };
    assert.equal(executeProxyTool(RULE_TOOL_NAME, {}, offCtx), `[Unknown proxy tool: ${RULE_TOOL_NAME}]`);
});

test("parseCompressSettings: validates rules boolean, rejects whole block on bad field", () => {
    assert.equal(parseCompressSettings({ rules: true })?.rules, true);
    assert.equal(parseCompressSettings({ rules: false })?.rules, false);
    assert.equal(parseCompressSettings({ rules: "yes" }), undefined);
    assert.equal(parseCompressSettings({ tiers: false, rules: 1 }), undefined);
});

test("mergeCompress: rules merges deepest-wins like other scalar fields", () => {
    assert.equal(mergeCompress({ rules: true }, { rules: false }, undefined).rules, false);
    assert.equal(mergeCompress({ rules: true }, undefined, undefined).rules, true);
    assert.equal(mergeCompress(undefined, undefined, { rules: true }).rules, true);
    assert.equal(mergeCompress(undefined, undefined, undefined).rules, undefined);
});

test("applyCompressSettings: maps settings rules onto kernel RuleFeatureConfig", () => {
    const base = defaultConfig(200000);
    assert.deepEqual(applyCompressSettings(base, 200_000, { rules: true }).rules, { enabled: true });
    assert.deepEqual(applyCompressSettings(base, 200_000, { rules: false }).rules, { enabled: false });
    const absent = applyCompressSettings(base, 200_000, {});
    assert.equal(absent.rules, undefined, "absent settings leave the base rules block untouched");
});

// #1192: hosts register manifest tools verbatim, so acp_rule must never be
// advertised while not enabled — including the unset (default-off) config.
test("handlePluginManifest: acp_rule advertised only when enabled", () => {
    let body = "";
    const res = { writeHead: () => {}, end: (b: string) => { body = b; } } as unknown as Parameters<typeof handlePluginManifest>[0];
    const data = (): {
        toolNames: string[];
        tools: { anthropic: { name: string; input_schema?: unknown }[]; openai: { name?: string; function?: { name: string } }[]; responses: { name?: string; type?: string }[] };
    } => JSON.parse(body);

    handlePluginManifest(res, defaultConfig(200_000));
    let d = data();
    assert.ok(!d.toolNames.includes(RULE_TOOL_NAME), "unset (default-off) → not advertised");
    assert.ok(!d.tools.anthropic.some((t) => t.name === RULE_TOOL_NAME));

    handlePluginManifest(res, { ...defaultConfig(200_000), rules: { enabled: true } });
    d = data();
    assert.ok(d.toolNames.includes(RULE_TOOL_NAME), "enabled → advertised");
    assert.ok(d.tools.anthropic.some((t) => t.name === RULE_TOOL_NAME), "anthropic schema present");
    assert.ok(d.tools.openai.some((t) => t.function?.name === RULE_TOOL_NAME));
    assert.ok(d.tools.responses.some((t) => t.name === RULE_TOOL_NAME));

    handlePluginManifest(res, { ...defaultConfig(200_000), rules: { enabled: false } });
    d = data();
    assert.ok(!d.toolNames.includes(RULE_TOOL_NAME), "explicitly disabled → not advertised");
    assert.ok(!d.tools.anthropic.some((t) => t.name === RULE_TOOL_NAME));
    assert.ok(!d.tools.openai.some((t) => t.function?.name === RULE_TOOL_NAME));
    assert.ok(!d.tools.responses.some((t) => t.name === RULE_TOOL_NAME));
});

test("persist round-trip: recorded rules survive save/load", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-rules-"));
    const store = new SessionStore({ dir, debounceMs: 0 });
    const session = getSession(`t-rules-persist-${Math.random().toString(36).slice(2)}`, { protocol: "anthropic" });
    executeRule({ rule: "survive restarts" }, { config: { ...defaultConfig(200000), rules: { enabled: true } }, session, log: () => {} });
    assert.equal(store.flushSync(session), true);
    const loaded = store.loadSync(session.id, { protocol: "anthropic" });
    assert.ok(loaded, "session must reload");
    assert.deepEqual(loaded!.state.rules, [{ id: "rule1", text: "survive restarts" }], "rules must survive restart");
});
