// #1712: blank optional decompress range fields (startId/endId = "" or
// whitespace) must mean "unspecified" → whole-block restore, not a
// "given together" failure. One-sided non-blank still fails, now steering to
// omitting both. And the advertised decompress schema must not offer range
// args where execution refuses them: plugin manifest advertises them only on
// the wires whose CCR can arm (anthropic/openai, base-config enabled per
// #1345/#1271), proxy wire injection only while the session is CCR-armed.
import test from "node:test";
import assert from "node:assert/strict";

process.env.BILI_PERSIST = "0";

import { createCore, defaultConfig, DECOMPRESS_TOOL_NAME, SEARCH_CONTEXT_TOOL_NAME, type Config, type CoreMessage } from "acp-kernel";
import { applyCompressSettings } from "../src/compress-settings.ts";
import { storeEffectiveCcr } from "../src/store.ts";
import { getSession } from "../src/session.ts";
import { parseCompressInput, BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_OPENAI_NO_RANGE, BILI_ACP_TOOLS_RESPONSES, BILI_ACP_TOOLS_RESPONSES_NO_RANGE, BILI_ACP_TOOLS_GOOGLE, BILI_ACP_TOOLS_GOOGLE_NO_RANGE, BILI_ACP_READONLY_TOOLS_RESPONSES, BILI_ACP_READONLY_TOOLS_RESPONSES_NO_RANGE } from "../src/compress-tool.ts";
import { applyRanges } from "../src/stream.ts";
import { resolveDecompress } from "../src/decompress-shared.ts";
import { handlePluginManifest } from "../src/plugin.ts";

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

function fold(opts: { ccr: boolean; plugin?: string }): FoldResult {
    const core = createCore();
    const config = applyCompressSettings(
        defaultConfig(200_000),
        200_000,
        { ccr: opts.ccr ? { enabled: true, minToolTokens: 50 } : { enabled: false, minToolTokens: 50 } },
    ) as Config;
    const session = getSession(`d1712-${Math.random().toString(36).slice(2)}`);
    if (opts.ccr) storeEffectiveCcr(session, { enabled: true, minToolTokens: 50 });
    if (opts.plugin) session.metadata.pluginAgent = opts.plugin;
    const raw = makeMsgs();
    const turn = core.processTurn({ messages: raw, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    session.state = turn.state;
    const ctx = { core, config, messages: turn.messages, session, log: () => {} };
    applyRanges(parseCompressInput({ content: [{ startId: "m00001", endId: "m00007", summary: "Early history: messages 1-7 covered initial setup.", topic: "Early history" }] }), ctx);
    const block = [...session.state.blocks].find((b) => b.active);
    assert.ok(block, "a block was created");
    return { core, config, session, msgs: turn.messages, blockId: block.blockId };
}

function ctxOf(f: FoldResult) {
    return { core: f.core, config: f.config, messages: f.msgs, session: f.session, log: () => {} };
}

test("#1712: both range fields blank → whole-block restore, no failure", () => {
    const f = fold({ ccr: true });
    const out = resolveDecompress({ blockId: f.blockId, startId: "", endId: "" }, ctxOf(f));
    assert.doesNotMatch(out, /FAILED/, `blank range fields must not fail: ${out.slice(0, 120)}`);
    assert.match(out, new RegExp(`^\\[Block ${f.blockId} content \\u2014`));
});

test("#1712: whitespace-only range fields count as omitted too", () => {
    const f = fold({ ccr: true });
    const out = resolveDecompress({ blockId: f.blockId, startId: "   ", endId: "\t" }, ctxOf(f));
    assert.doesNotMatch(out, /FAILED/);
    assert.match(out, new RegExp(`^\\[Block ${f.blockId} content \\u2014`));
});

test("#1712: one field missing + other blank → whole-block restore", () => {
    const f = fold({ ccr: true });
    const out = resolveDecompress({ blockId: f.blockId, startId: "" }, ctxOf(f));
    assert.doesNotMatch(out, /FAILED/);
    assert.match(out, new RegExp(`^\\[Block ${f.blockId} content \\u2014`));
});

test("#1712: one-sided non-blank still requires both, and steers to omitting them", () => {
    const f = fold({ ccr: true });
    const outStart = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "" }, ctxOf(f));
    assert.match(outStart, /startId and endId must be given together/);
    assert.match(outStart, /omit both to restore the whole block/);
    const outEnd = resolveDecompress({ blockId: f.blockId, endId: "m00004" }, ctxOf(f));
    assert.match(outEnd, /startId and endId must be given together/);
});

test("#1712: plugin mode without CCR points at the working call shape instead of dead-end param filling", () => {
    const f = fold({ ccr: false, plugin: "omp" });
    const out = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, ctxOf(f));
    assert.match(out, /plugin-mode session does not have/);
    assert.ok(out.includes(`{"blockId":"${f.blockId}"}`), `copy-pasteable guidance: ${out}`);
    assert.doesNotMatch(out, /is proxy-mode only/);
});

test("#1712: proxy mode without CCR keeps the enable-CCR error", () => {
    const f = fold({ ccr: false });
    const out = resolveDecompress({ blockId: f.blockId, startId: "m00002", endId: "m00004" }, ctxOf(f));
    assert.match(out, /requires CCR \u2014 enable compress\.ccr\.enabled/);
});

type FlatTool = { name?: string; description?: string; input_schema?: Record<string, unknown>; parameters?: Record<string, unknown>; function?: { name?: string; parameters?: Record<string, unknown> } };

function propsOf(arr: unknown[], name: string): Record<string, unknown> | undefined {
    const e = arr.find((t) => {
        const o = t as FlatTool;
        return o.name === name || o.function?.name === name;
    }) as FlatTool | undefined;
    if (!e) return undefined;
    const schema = (e.input_schema ?? e.parameters ?? e.function?.parameters) as { properties?: Record<string, unknown> } | undefined;
    return schema?.properties;
}

function namesOf(arr: unknown[]): string[] {
    return arr.map((t) => {
        const o = t as FlatTool;
        return o.name ?? o.function?.name ?? "";
    }).sort();
}

const RANGE_PAIRS: [unknown[], unknown[]][] = [
    [BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_ANTHROPIC_NO_RANGE],
    [BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_OPENAI_NO_RANGE],
    [BILI_ACP_TOOLS_RESPONSES, BILI_ACP_TOOLS_RESPONSES_NO_RANGE],
    [BILI_ACP_TOOLS_GOOGLE, BILI_ACP_TOOLS_GOOGLE_NO_RANGE],
    [BILI_ACP_READONLY_TOOLS_RESPONSES, BILI_ACP_READONLY_TOOLS_RESPONSES_NO_RANGE],
];

test("#1712: with-range arrays expose optional startId/endId; NO_RANGE variants drop exactly those", () => {
    for (const [withRange, noRange] of RANGE_PAIRS) {
        const wr = propsOf(withRange, DECOMPRESS_TOOL_NAME);
        assert.ok(wr, "decompress present in with-range array");
        assert.equal(wr.startId?.type, "string");
        assert.equal(wr.endId?.type, "string");
        const nr = propsOf(noRange, DECOMPRESS_TOOL_NAME);
        assert.ok(nr, "decompress present in NO_RANGE array");
        assert.equal(nr.startId, undefined, "NO_RANGE drops startId");
        assert.equal(nr.endId, undefined, "NO_RANGE drops endId");
        assert.deepEqual(namesOf(noRange as unknown[]), namesOf(withRange as unknown[]), "tool set otherwise identical");
        const sc = propsOf(noRange as unknown[], SEARCH_CONTEXT_TOOL_NAME);
        assert.equal(sc?.conversation_id, undefined, "#1685 zero-injection: search_context carries no conversation_id");
    }
});

type ManifestBody = { toolNames: string[]; tools: Record<string, unknown[]> };

function readManifest(config: Config): ManifestBody {
    let body = "";
    const res = { writeHead: () => {}, end: (b: string) => { body = b; } } as never;
    handlePluginManifest(res, config);
    return JSON.parse(body) as ManifestBody;
}

test("#1712: manifest (CCR off by default) never advertises decompress range args on any wire", () => {
    const m = readManifest(defaultConfig(200_000));
    for (const wire of ["anthropic", "openai", "responses"]) {
        const props = propsOf(m.tools[wire] ?? [], DECOMPRESS_TOOL_NAME);
        assert.ok(props, `${wire}: decompress present`);
        assert.equal(props.startId, undefined, `${wire}: no startId when CCR off`);
        assert.equal(props.endId, undefined, `${wire}: no endId when CCR off`);
        assert.equal(props.blockId?.type, "string", `${wire}: blockId untouched`);
    }
});

test("#1712: manifest with base CCR on advertises range args on anthropic/openai only — responses never arms CCR in plugin mode (#1271)", () => {
    const m = readManifest({ ...defaultConfig(200_000), ccr: { enabled: true } });
    for (const wire of ["anthropic", "openai"]) {
        const props = propsOf(m.tools[wire] ?? [], DECOMPRESS_TOOL_NAME);
        assert.equal(props?.startId?.type, "string", `${wire}: startId advertised with base CCR on`);
        assert.equal(props?.endId?.type, "string", `${wire}: endId advertised with base CCR on`);
    }
    const respProps = propsOf(m.tools.responses ?? [], DECOMPRESS_TOOL_NAME);
    assert.equal(respProps?.startId, undefined, "responses wire must NOT advertise range args");
    assert.equal(respProps?.endId, undefined, "responses wire must NOT advertise range args");
});
