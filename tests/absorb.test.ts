import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    createCore,
    createInitialState,
    defaultConfig,
    DEFAULT_ABSORB_CONFIG,
    type AbsorbConfig,
    type AbsorbRecord,
    type Config,
    type CoreMessage,
} from "acp-kernel";
import {
    applyAbsorbView,
    absorbEnabled,
    absorbToolName,
    effectiveAbsorbConfig,
    executeAbsorb,
    isProxyToolFor,
    storeEffectiveAbsorb,
} from "../src/absorb.ts";
import { mergeCompress, applyCompressSettings } from "../src/compress-settings.ts";
import { parseCompressSettings } from "../src/config.ts";
import { handlePluginManifest } from "../src/plugin.ts";
import { getSession, type Session } from "../src/session.ts";
import { SessionStore } from "../src/persist.ts";

const BIG_TEXT = "line of build output ".repeat(700); // ~3.7K tokens

function freshMsgs(): CoreMessage[] {
    return [
        { id: "u1", role: "user", contentType: "text", text: "run a big build" },
        { id: "a-tc", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call_1", text: JSON.stringify({ command: "npm test" }) },
        { id: "t-res", role: "tool", contentType: "tool-result", toolCallId: "call_1", text: BIG_TEXT },
    ];
}

function makeTurn() {
    const core = createCore();
    const msgs = freshMsgs();
    // mediaOnly off: these host-plumbing tests exercise the credit/view
    // mechanism over a TEXT result; the #3402 media-scope gate is covered separately.
    const config: Config = { ...defaultConfig(200000), absorb: { ...DEFAULT_ABSORB_CONFIG, enabled: true, minToolTokens: 100, mediaOnly: false } };
    const turn = core.processTurn({ messages: msgs, state: createInitialState(), config, tokenCount: 0, renderTags: "text-only" });
    const byRef = Object.entries(turn.state.messageRefs.byRef ?? {});
    const refFor = (rawId: string): string => byRef.find(([, raw]) => raw === rawId)?.[0] ?? "";
    return { core, turn, config, refFor };
}

function makeSession(): Session {
    const session = getSession(`t-absorb-${Math.random().toString(36).slice(2)}`);
    session.stats.lastInputTokens = 100_000;
    return session;
}

test("absorbEnabled / absorbToolName respect config", () => {
    assert.equal(absorbEnabled(defaultConfig(200000)), false);
    assert.equal(absorbEnabled({ ...defaultConfig(200000), absorb: { ...DEFAULT_ABSORB_CONFIG, enabled: true } }), true);
    assert.equal(absorbToolName({ ...defaultConfig(200000), absorb: { ...DEFAULT_ABSORB_CONFIG, enabled: true, toolName: "acp_absorb" } }), "acp_absorb");
    assert.equal(absorbToolName(defaultConfig(200000)), "absorb");
});

test("isProxyToolFor: static ACP names always proxy; absorb only when effectively enabled", () => {
    const base = defaultConfig(200000);
    assert.equal(isProxyToolFor("compress", undefined, base), true);
    assert.equal(isProxyToolFor("absorb", undefined, base), false);
    assert.equal(isProxyToolFor("bash", undefined, base), false);

    const on: Config = { ...base, absorb: { ...DEFAULT_ABSORB_CONFIG, enabled: true } };
    assert.equal(isProxyToolFor("absorb", undefined, on), true);

    const session = getSession(`t-absorb-adjudicate-${Math.random().toString(36).slice(2)}`);
    storeEffectiveAbsorb(session, on);
    // Plugin tool API reads the per-session stored block even when the fallback
    // (base kernel config) has the feature off.
    assert.equal(isProxyToolFor("absorb", session, base), true);
    assert.equal(isProxyToolFor("compress", session, base), true);

    storeEffectiveAbsorb(session, base);
    assert.equal(isProxyToolFor("absorb", session, on), false);

    const renamed: Config = { ...base, absorb: { ...DEFAULT_ABSORB_CONFIG, enabled: true, toolName: "acp_absorb" } };
    assert.equal(isProxyToolFor("acp_absorb", undefined, renamed), true);
    assert.equal(isProxyToolFor("absorb", undefined, renamed), false);
});

test("effectiveAbsorbConfig: session metadata wins over fallback", () => {
    const on: AbsorbConfig = { ...DEFAULT_ABSORB_CONFIG, enabled: true, minToolTokens: 555 };
    const session = getSession(`t-absorb-meta-${Math.random().toString(36).slice(2)}`);
    storeEffectiveAbsorb(session, { ...defaultConfig(200000), absorb: on });
    assert.deepEqual(effectiveAbsorbConfig(session, defaultConfig(200000)), on);
    // defaultConfig() ships the kernel-default (disabled) block, so storing a
    // plain base config records "absorb off" for this session and shadows a
    // more permissive fallback.
    storeEffectiveAbsorb(session, defaultConfig(200000));
    const eff = effectiveAbsorbConfig(session, { ...defaultConfig(200000), absorb: on });
    assert.equal(eff?.enabled, false);
});

test("executeAbsorb: success records absorption, credits net exactly once", () => {
    const { turn, config, refFor } = makeTurn();
    const ref = refFor("t-res");
    assert.ok(ref, "tool result must have a ref");
    const session = makeSession();
    session.state = turn.state;
    const before = session.stats.compressCreditTokens ?? 0;
    const result = executeAbsorb({ ref, summary: "Build passed; 42 tests ok." }, "call_x", config.absorb!, {
        config,
        messages: turn.messages,
        session,
    }).text;
    assert.ok(!result.includes("FAILED"), result);
    assert.match(result, /^absorbed m\d+/);
    assert.equal(session.state.absorbed?.length, 1);
    const record = session.state.absorbed![0];
    assert.ok(record.tokensReclaimed > 0);
    assert.equal(session.state.stats.absorbedTokens, record.tokensReclaimed);
    assert.equal(session.stats.compressCreditTokens, before + record.tokensReclaimed);
    assert.equal(session.stats.lastInputTokens, 100_000 - record.tokensReclaimed);

    // Re-absorbing the same ref is an ok=true no-op and must NOT credit again.
    const again = executeAbsorb({ ref, summary: "retry" }, "call_y", config.absorb!, { config, messages: turn.messages, session }).text;
    assert.ok(!again.includes("FAILED"), again);
    assert.match(again, /already absorbed/);
    assert.equal(session.state.absorbed?.length, 1);
    assert.equal(session.stats.compressCreditTokens, before + record.tokensReclaimed);
});

test("executeAbsorb: bad ref and invalid input fail with FAILED marker", () => {
    const { turn, config } = makeTurn();
    const session = makeSession();
    session.state = turn.state;
    const badRef = executeAbsorb({ ref: "m99999", summary: "x" }, undefined, config.absorb!, { config, messages: turn.messages, session }).text;
    assert.match(badRef, /\[absorb FAILED: absorb failed: ref m99999/);
    const badInput = executeAbsorb({ summary: "no ref" }, undefined, config.absorb!, { config, messages: turn.messages, session }).text;
    assert.match(badInput, /\[absorb FAILED: invalid input/);
    assert.equal((session.state.absorbed ?? []).length, 0);
});

test("kernel gating: prompts honor minToolTokens/contextThresholdPct at processTurn time", () => {
    // Gates are evaluated when processTurn renders the turn, so each scenario
    // needs its own turn computed under that config (reusing one rendered view
    // across configs would see markers already baked in).
    const run = (absorb: AbsorbConfig, tokenCount = 100_000): boolean => {
        const core = createCore();
        const cfg: Config = { ...defaultConfig(200000), absorb };
        const turn = core.processTurn({ messages: freshMsgs(), state: createInitialState(), config: cfg, tokenCount, renderTags: "text-only" });
        return turn.messages.some((m) => (m.text ?? "").includes("[ACP absorb]"));
    };
    // mediaOnly pinned off: these scenarios isolate the token/context gates;
    // the #3402 media-scope gate is covered separately in the kernel suite.
    const A = { ...DEFAULT_ABSORB_CONFIG, mediaOnly: false };
    assert.equal(run({ ...A, enabled: true, minToolTokens: 100 }), true, "large eligible result is prompted");
    assert.equal(run({ ...A, enabled: true, minToolTokens: 100_000 }), false, "minToolTokens gate");
    assert.equal(run({ ...A, enabled: true, minToolTokens: 100, contextThresholdPct: 0.8 }), false, "below context threshold (50% usage)");
    assert.equal(run({ ...A, enabled: true, minToolTokens: 100, contextThresholdPct: 0.8 }, 180_000), true, "above context threshold (90% usage)");
    // excludeTools is a known no-op on tool RESULTS: the wire projections build
    // result CoreMessages without toolName, so isAbsorbCandidate's name guard
    // never fires (ranxianglei/acp-kernel#213). Asserting current behavior so a
    // kernel fix flips this line red instead of silently changing semantics.
    assert.equal(run({ ...A, enabled: true, minToolTokens: 100, excludeTools: ["bash"] }), true, "excluded tool name (kernel limitation)");
    assert.equal(run({ ...A, enabled: false, minToolTokens: 100 }), false, "feature disabled");
});

test("applyAbsorbView: hides recorded pairs even after the feature is disabled", () => {
    const { turn, config, refFor } = makeTurn();
    const session = makeSession();
    session.state = turn.state;
    const ref = refFor("t-res");
    const result = executeAbsorb({ ref, summary: "short" }, undefined, config.absorb!, { config, messages: turn.messages, session }).text;
    assert.ok(!result.includes("FAILED"), result);
    const hidden = applyAbsorbView(turn.messages, session.state, defaultConfig(200000), 100_000);
    assert.deepEqual(hidden.map((m) => m.id), ["u1"], "both halves of the absorbed pair are hidden");
    assert.ok(!hidden.some((m) => (m.text ?? "").includes("[ACP absorb]")));
});

test("mergeCompress: absorb sub-fields merge deepest-wins like other nested fields", () => {
    const merged = mergeCompress(
        { absorb: { enabled: true, minToolTokens: 500 } },
        { absorb: { contextThresholdPct: "75%" } },
        { absorb: { excludeTools: ["bash"] } },
    );
    assert.deepEqual(merged.absorb, { enabled: true, minToolTokens: 500, contextThresholdPct: "75%", excludeTools: ["bash"] });
    const partial = mergeCompress({ absorb: { enabled: true } }, undefined, { absorb: { toolName: "x" } });
    assert.deepEqual(partial.absorb, { enabled: true, toolName: "x" });
    assert.equal(mergeCompress(undefined, undefined, undefined).absorb, undefined);
});

test("applyCompressSettings: maps settings absorb onto kernel AbsorbConfig with defaults + percent parse", () => {
    const base = defaultConfig(200000);
    const out = applyCompressSettings(base, 200_000, { absorb: { enabled: true, contextThresholdPct: "80%" } });
    assert.deepEqual(out.absorb, {
        enabled: true,
        toolName: "absorb",
        minToolTokens: 4000,
        contextThresholdPct: 0.8,
        excludeTools: [],
        mediaOnly: true,
    });
    const numeric = applyCompressSettings(base, 200_000, { absorb: { enabled: false, minToolTokens: 250, contextThresholdPct: 0.5 } });
    assert.equal(numeric.absorb?.enabled, false);
    assert.equal(numeric.absorb?.minToolTokens, 250);
    assert.equal(numeric.absorb?.contextThresholdPct, 0.5);
    const absent = applyCompressSettings(base, 200_000, {});
    assert.deepEqual(absent.absorb, base.absorb, "absent settings leave the base absorb block untouched");
});

test("parseCompressSettings: validates absorb sub-object field-by-field, rejects whole block on any bad field", () => {
    const good = parseCompressSettings({ absorb: { enabled: true, minToolTokens: 100, contextThresholdPct: "75%", excludeTools: ["bash"], toolName: "abs" } });
    assert.deepEqual(good?.absorb, { enabled: true, minToolTokens: 100, contextThresholdPct: "75%", excludeTools: ["bash"], toolName: "abs" });
    assert.equal(parseCompressSettings({ absorb: { enabled: "yes" } }), undefined);
    assert.equal(parseCompressSettings({ absorb: { minToolTokens: "big" } }), undefined);
    assert.equal(parseCompressSettings({ absorb: { contextThresholdPct: "abc" } }), undefined);
    assert.equal(parseCompressSettings({ absorb: { excludeTools: "bash" } }), undefined);
    assert.equal(parseCompressSettings({ absorb: { toolName: "" } }), undefined);
    assert.equal(parseCompressSettings({ absorb: { mediaOnly: false } })?.absorb?.mediaOnly, false);
    assert.equal(parseCompressSettings({ absorb: { mediaOnly: "yes" } }), undefined);
    assert.equal(parseCompressSettings({ absorb: [] }), undefined);
    // A bad absorb field rejects sibling fields too (whole-block convention).
    assert.equal(parseCompressSettings({ tiers: false, absorb: { enabled: 1 } }), undefined);
});

// #1192: hosts register manifest tools verbatim, so a disabled absorb must not
// be advertised at all — only an absorb-enabled config may list it.
test("handlePluginManifest: absorb advertised on all three wires only when enabled", () => {
    let body = "";
    const res = { writeHead: () => {}, end: (b: string) => { body = b; } } as unknown as Parameters<typeof handlePluginManifest>[0];
    const data = (): {
        toolNames: string[];
        tools: { anthropic: { name: string; input_schema?: unknown }[]; openai: { name?: string; function?: { name: string } }[]; responses: { name?: string; type?: string }[] };
    } => JSON.parse(body);

    handlePluginManifest(res, defaultConfig(200_000));
    let d = data();
    assert.ok(!d.toolNames.includes("absorb"), "disabled by default → not advertised");
    assert.ok(!d.tools.anthropic.some((t) => t.name === "absorb"));
    assert.ok(!d.tools.openai.some((t) => t.function?.name === "absorb"));
    assert.ok(!d.tools.responses.some((t) => t.name === "absorb"));

    handlePluginManifest(res, { ...defaultConfig(200_000), absorb: { ...DEFAULT_ABSORB_CONFIG, enabled: true } });
    d = data();
    assert.ok(d.toolNames.includes("absorb"));
    const anthro = d.tools.anthropic.find((t) => t.name === "absorb");
    assert.ok(anthro, "anthropic schema present");
    const schema = anthro!.input_schema as { required?: string[] };
    assert.deepEqual(schema.required, ["ref", "summary"]);
    assert.ok(d.tools.openai.some((t) => t.function?.name === "absorb"));
    assert.ok(d.tools.responses.some((t) => t.name === "absorb"));
});

test("persist round-trip: absorbed records and absorbedTokens survive save/load", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-absorb-"));
    const store = new SessionStore({ dir, debounceMs: 0 });
    const session = getSession(`t-absorb-persist-${Math.random().toString(36).slice(2)}`, { protocol: "anthropic" });
    const record: AbsorbRecord = {
        toolCallId: "call_1",
        callMessageId: "a-tc",
        resultMessageId: "t-res",
        summary: "Build passed.",
        tokensReclaimed: 4321,
        createdAt: Date.now(),
    };
    session.state.absorbed = [record];
    session.state.stats.absorbedTokens = 4321;
    assert.equal(store.flushSync(session), true);
    const loaded = store.loadSync(session.id, { protocol: "anthropic" });
    assert.ok(loaded, "session must reload");
    assert.deepEqual(loaded!.state.absorbed, [record], "absorbed records must survive restart");
    assert.equal(loaded!.state.stats.absorbedTokens, 4321);
});
