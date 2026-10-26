// #4460: in external-summary mode the conversation model only selects ranges;
// the independent service writes the committed summary and receives the
// summary-writing rules in its own request. The conversation-side prompt must
// therefore drop HOW TO COMPRESS (KEEP VERBATIM / DROP / PRIORITY …) and the
// per-summary length budget — and must stay byte-identical when the chain is
// off (classic mode, where the model writes the summary itself).
import test from "node:test";
import assert from "node:assert/strict";
import { buildCompressHybridSystemPrompt, buildCompressSystemPrompt, defaultConfig, defaultPrompts, type Config } from "acp-kernel";
import type { ProxyOptions } from "../src/config.ts";
import { withSummaryBudgetNote } from "../src/compress-tool.ts";
import { resolveCompressSurface } from "../src/compress-settings.ts";
import { conversationPromptSections, EXTERNAL_SUMMARY_NOTE } from "../src/external-summary-surface.ts";
import { injectSystem } from "../src/server/inject.ts";

const RULES_MARKERS = ["HOW TO COMPRESS", "KEEP VERBATIM", "DROP — extract the signal", "PRIORITY — when the summary must be compact"];
const BUDGET_MARKER = "[Per-summary length budget";
const KEPT_MARKERS = ["Compression Philosophy:", "ACP TAGS", "TOOLS", "COMPRESSION SUMMARIES IN CONTEXT"];

function proxyOptions(): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        mitm: { enabled: false, domains: [] },
    };
}

function configWithChain(enabled: boolean): Config {
    return { ...defaultConfig(400_000), externalSummary: { enabled, targets: [], budget: { totalTimeoutMs: 50_000, targetTimeoutMs: 25_000, maxSummaryBytes: 65_536 } } } as unknown as Config;
}

test("#4460: conversationPromptSections drops howToCompress only in external mode", () => {
    assert.deepEqual(conversationPromptSections(undefined, true), { howToCompress: null });
    assert.deepEqual(conversationPromptSections({ acpTags: "custom tags" }, true), { acpTags: "custom tags", howToCompress: null });
    const sections = { acpTags: "custom tags" };
    assert.equal(conversationPromptSections(sections, false), sections, "classic mode passes the caller's sections through untouched");
    assert.equal(conversationPromptSections(undefined, false), undefined);
});

test("#4460: external mode — the function-tool prompt keeps the selection surface, drops the writing rules", () => {
    const text = buildCompressSystemPrompt(defaultPrompts, conversationPromptSections(undefined, true));
    for (const marker of RULES_MARKERS) assert.ok(!text.includes(marker), `external prompt must not carry "${marker}"`);
    for (const marker of KEPT_MARKERS) assert.ok(text.includes(marker), `external prompt must keep "${marker}"`);
    assert.ok(text.length < buildCompressSystemPrompt(defaultPrompts).length - 5_000, "drops the ~5.8K-char rules block");
});

test("#4460: classic mode — prompts are byte-identical to the unmodified builders", () => {
    assert.equal(buildCompressSystemPrompt(defaultPrompts, conversationPromptSections(undefined, false)), buildCompressSystemPrompt(defaultPrompts));
    assert.equal(buildCompressHybridSystemPrompt(defaultPrompts, conversationPromptSections(undefined, false)), buildCompressHybridSystemPrompt(defaultPrompts));
    for (const marker of RULES_MARKERS) assert.ok(buildCompressSystemPrompt(defaultPrompts).includes(marker), `classic prompt still carries "${marker}"`);
});

test("#4460: the hybrid (text-protocol) builder honors the same drop", () => {
    const text = buildCompressHybridSystemPrompt(defaultPrompts, conversationPromptSections(undefined, true));
    for (const marker of RULES_MARKERS) assert.ok(!text.includes(marker), `hybrid external prompt must not carry "${marker}"`);
    assert.ok(text.includes("Compression Philosophy:"));
});

test("#4460: a pack's replacement rules are dropped in external mode and kept in classic mode", () => {
    const sections = resolveCompressSurface({ promptPack: "lean" }).promptSections;
    assert.equal(typeof sections?.howToCompress, "string", "lean ships its own howToCompress text");
    const lean = sections?.howToCompress as string;
    assert.ok(!buildCompressSystemPrompt(defaultPrompts, conversationPromptSections(sections, true)).includes(lean));
    assert.ok(buildCompressSystemPrompt(defaultPrompts, conversationPromptSections(sections, false)).includes(lean));
});

test("#4460: withSummaryBudgetNote — external gets the disclosure instead of the budget rule", () => {
    const external = withSummaryBudgetNote("BASE", true);
    assert.equal(external, "BASE" + EXTERNAL_SUMMARY_NOTE);
    assert.ok(!external.includes(BUDGET_MARKER));
    const classic = withSummaryBudgetNote("BASE", false);
    assert.ok(classic.includes(BUDGET_MARKER));
    assert.ok(!classic.includes("External summary mode"));
});

test("#4460: injectSystem (anthropic lane) — external drops rules + budget, classic keeps both", () => {
    const external = injectSystem({ system: "client", messages: [] }, proxyOptions(), undefined, configWithChain(true)) as string;
    for (const marker of [...RULES_MARKERS, BUDGET_MARKER]) assert.ok(!external.includes(marker), `external wire must not carry "${marker}"`);
    assert.ok(external.includes("External summary mode"));
    assert.ok(external.startsWith("client"), "client system block stays byte-exact");

    const classic = injectSystem({ system: "client", messages: [] }, proxyOptions(), undefined, configWithChain(false)) as string;
    for (const marker of [...RULES_MARKERS, BUDGET_MARKER]) assert.ok(classic.includes(marker), `classic wire keeps "${marker}"`);
    assert.ok(!classic.includes("External summary mode"));
});
