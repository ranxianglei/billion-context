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
import { executeProxyTool, type LoopCtx } from "../src/loop/core.ts";
import { handlePluginManifest } from "../src/plugin.ts";
import {
    effectiveRulesConfig,
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

test("rulesEnabled respects config", () => {
    assert.equal(rulesEnabled(defaultConfig(200000)), false);
    assert.equal(rulesEnabled({ ...defaultConfig(200000), rules: { enabled: false } }), false);
    assert.equal(rulesEnabled({ ...defaultConfig(200000), rules: { enabled: true } }), true);
});

test("isProxyToolFor: acp_rule only when effectively enabled", () => {
    const base = defaultConfig(200000);
    assert.equal(isProxyToolFor("compress", undefined, base), true);
    assert.equal(isProxyToolFor(RULE_TOOL_NAME, undefined, base), false);

    const on: Config = { ...base, rules: { enabled: true } };
    assert.equal(isProxyToolFor(RULE_TOOL_NAME, undefined, on), true);

    const session = makeSession();
    storeEffectiveRules(session, on);
    // Plugin tool API reads the per-session stored block even when the
    // fallback (base kernel config) has the feature off.
    assert.equal(isProxyToolFor(RULE_TOOL_NAME, session, base), true);
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

test("executeRule: add records with trim, omitting rule lists", () => {
    const { session, ctx } = makeRuleCtx();
    assert.equal(executeRule({ rule: "always run tests before committing" }, ctx), "Recorded rule-1: always run tests before committing");
    assert.equal(executeRule({ rule: "  trim input text  " }, ctx), "Recorded rule-2: trim input text");
    const listing = "Recorded rules (2):\n1. always run tests before committing\n2. trim input text";
    assert.equal(executeRule({}, ctx), listing);
    assert.equal(executeRule({ rule: "   " }, ctx), listing);
    assert.equal(executeRule({ rule: 42 }, ctx), listing);
    assert.equal(session.state.rules?.length, 2);
});

test("executeRule: validation failures return verbatim kernel errors, no state change", () => {
    const { session, ctx } = makeRuleCtx();
    assert.equal(executeRule({ rule: "dup rule" }, ctx), "Recorded rule-1: dup rule");
    assert.equal(executeRule({ rule: "dup rule" }, ctx), "identical rule already recorded (rule-1)");
    assert.match(executeRule({ rule: "x".repeat(301) }, ctx), /^rule too long \(301 chars, limit 300\)/);
    assert.equal((session.state.rules ?? []).length, 1);
});

test("executeRule: maxRules cap from config limits", () => {
    const { ctx } = makeRuleCtx({ rules: { enabled: true, maxRules: 2 } });
    assert.match(executeRule({ rule: "one" }, ctx), /^Recorded rule-1: one$/);
    assert.match(executeRule({ rule: "two" }, ctx), /^Recorded rule-2: two$/);
    assert.match(executeRule({ rule: "three" }, ctx), /^rule limit reached \(2\)/);
});

test("executeProxyTool: routes acp_rule through executeRule when enabled, unknown tool otherwise", () => {
    const { session, ctx } = makeRuleCtx();
    const loopCtx: LoopCtx = { core: createCore(), config: ctx.config, messages: [], session, log: () => {} };
    assert.equal(executeProxyTool(RULE_TOOL_NAME, { rule: "via loop" }, loopCtx), "Recorded rule-1: via loop");

    const offSession = makeSession();
    const offCtx: LoopCtx = { core: createCore(), config: defaultConfig(200000), messages: [], session: offSession, log: () => {} };
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

test("handlePluginManifest: advertises acp_rule alongside the ACP tools on all three wires", () => {
    let body = "";
    handlePluginManifest({ writeHead: () => {}, end: (b: string) => { body = b; } } as never);
    const data = JSON.parse(body) as {
        toolNames: string[];
        tools: { anthropic: { name: string; input_schema?: unknown }[]; openai: { name?: string; function?: { name: string } }[]; responses: { name?: string; type?: string }[] };
    };
    assert.ok(data.toolNames.includes(RULE_TOOL_NAME));
    assert.ok(data.tools.anthropic.some((t) => t.name === RULE_TOOL_NAME), "anthropic schema present");
    assert.ok(data.tools.openai.some((t) => t.function?.name === RULE_TOOL_NAME));
    assert.ok(data.tools.responses.some((t) => t.name === RULE_TOOL_NAME));
});

test("persist round-trip: recorded rules survive save/load", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-rules-"));
    const store = new SessionStore({ dir, debounceMs: 0 });
    const session = getSession(`t-rules-persist-${Math.random().toString(36).slice(2)}`, { protocol: "anthropic" });
    executeRule({ rule: "survive restarts" }, { config: { ...defaultConfig(200000), rules: { enabled: true } }, session, log: () => {} });
    assert.equal(store.flushSync(session), true);
    const loaded = store.loadSync(session.id, { protocol: "anthropic" });
    assert.ok(loaded, "session must reload");
    assert.deepEqual(loaded!.state.rules, [{ id: "rule-1", text: "survive restarts" }], "rules must survive restart");
});
