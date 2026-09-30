import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { ACP_READONLY_TOOLS_RESPONSES, ACP_TOOLS_ANTHROPIC, ACP_TOOLS_OPENAI, ACP_TOOLS_RESPONSES, DECOMPRESS_TOOL_NAME, SEARCH_CONTEXT_TOOL_NAME, createCore, createInitialState, defaultConfig } from "acp-kernel";
import { anthropicToCore, type AnthropicRequestBody } from "acp-kernel/wire";
import { BILI_ACP_READONLY_TOOLS_RESPONSES, BILI_ACP_TOOLS_ANTHROPIC, BILI_ACP_TOOLS_OPENAI, BILI_ACP_TOOLS_RESPONSES } from "../src/compress-tool.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetSessionsForTest, getSession, type Session } from "../src/session.ts";
import { executeSearchContext, executeSearchContextTarget } from "../src/decompress-shared.ts";
import { rmrf } from "./tmp-rm.ts";

function makeSession(id: string): Session {
    return {
        id,
        meta: {},
        stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, contextTokens: 0 },
        metadata: {},
        state: createInitialState(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
        blockContents: new Map(),
        inFlight: 0,
        persisted: false,
    };
}

function compressInto(session: Session) {
    const core = createCore();
    const config = defaultConfig(200000);
    const body: AnthropicRequestBody = { model: "claude-test", messages: [] };
    for (let i = 0; i < 40; i++) {
        body.messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `auth token flow message ${i} ${"y".repeat(2000)}` });
    }
    const { msgs } = anthropicToCore(body);
    const turn = core.processTurn({ messages: msgs, state: session.state, config, tokenCount: 9999, renderTags: "text-only" });
    const res = core.applyCompression({
        ranges: [{ startRef: "m00001", endRef: "m00015", summary: "auth token exchange and refresh design decisions".repeat(3) }],
        state: turn.state,
        config,
        messages: turn.messages,
    });
    assert.equal(res.result.blocksCreated, 1, "compression block should be created");
    session.state = res.state;
    return core;
}

type FlatTool = { name?: string; description?: string; input_schema?: Record<string, unknown>; parameters?: Record<string, unknown>; function?: { name?: string; parameters?: Record<string, unknown> } };

function searchEntry(arr: unknown[], shape: "flat" | "openai"): FlatTool | undefined {
    return arr.find((t) => {
        const e = t as FlatTool;
        return shape === "openai" ? e.function?.name === SEARCH_CONTEXT_TOOL_NAME : e.name === SEARCH_CONTEXT_TOOL_NAME;
    }) as FlatTool | undefined;
}

function paramsOf(entry: FlatTool): Record<string, unknown> {
    return entry.parameters ?? entry.input_schema ?? entry.function?.parameters ?? {};
}

test("#841 schema: BILI arrays no longer add conversation_id to search_context (#1685); #1179 range args stay on decompress", () => {
    const cases: [unknown[], unknown[], "flat" | "openai"][] = [
        [BILI_ACP_TOOLS_ANTHROPIC, ACP_TOOLS_ANTHROPIC, "flat"],
        [BILI_ACP_TOOLS_OPENAI, ACP_TOOLS_OPENAI, "openai"],
        [BILI_ACP_TOOLS_RESPONSES, ACP_TOOLS_RESPONSES, "flat"],
    ];
    for (const [bili, kernel, shape] of cases) {
        const entry = searchEntry(bili, shape);
        assert.ok(entry, `search_context missing in ${shape} array`);
        const props = paramsOf(entry).properties as Record<string, Record<string, unknown>>;
        assert.equal(props.conversation_id, undefined, "#1685: conversation_id NOT advertised (zero-injection)");
        const required = paramsOf(entry).required as string[];
        assert.ok(!required.includes("conversation_id"), "conversation_id must stay out of required");

        const kernelEntry = searchEntry(kernel, shape);
        const kernelProps = paramsOf(kernelEntry!).properties as Record<string, unknown>;
        assert.equal(kernelProps.conversation_id, undefined, "kernel constant must not be mutated");

        const nameOf = (t: unknown): string | undefined => {
            const e = t as FlatTool;
            return shape === "openai" ? e.function?.name : e.name;
        };
        // #1179: decompress gains exactly two optional range params; everything else stays identical
        const stripRange = (e: FlatTool): FlatTool => {
            const params = paramsOf(e) as Record<string, unknown>;
            const props = { ...(params.properties as Record<string, unknown>) };
            delete props.startId;
            delete props.endId;
            const p = { ...params, properties: props };
            if (e.function) return { ...e, function: { ...e.function, parameters: p } };
            if (e.input_schema) return { ...e, input_schema: p };
            return { ...e, parameters: p };
        };
        const biliDec = bili.find((t) => nameOf(t) === DECOMPRESS_TOOL_NAME) as FlatTool | undefined;
        const kernelDec = kernel.find((t) => nameOf(t) === DECOMPRESS_TOOL_NAME) as FlatTool | undefined;
        assert.ok(biliDec && kernelDec, `decompress missing in ${shape} array`);
        assert.deepEqual(stripRange(biliDec), stripRange(kernelDec), "decompress differs only by the added range params");
        const biliProps = paramsOf(biliDec).properties as Record<string, Record<string, unknown>>;
        assert.equal(biliProps.startId?.type, "string");
        assert.equal(biliProps.endId?.type, "string");
        const decRequired = paramsOf(biliDec).required as string[] | undefined;
        assert.ok(!decRequired?.includes("startId") && !decRequired?.includes("endId"), "range args must stay optional");

        const biliRest = bili.filter((t) => t !== entry && nameOf(t) !== DECOMPRESS_TOOL_NAME);
        const kernelRest = kernel.filter((t) => t !== kernelEntry && nameOf(t) !== DECOMPRESS_TOOL_NAME);
        assert.deepEqual(biliRest, kernelRest, "no other tool may change");
    }
    const ro = searchEntry(BILI_ACP_READONLY_TOOLS_RESPONSES, "flat")!;
    assert.equal((paramsOf(ro).properties as Record<string, unknown>).conversation_id, undefined, "#1685: readonly array clean too");
    assert.equal((paramsOf(searchEntry(ACP_READONLY_TOOLS_RESPONSES, "flat")!).properties as Record<string, unknown>).conversation_id, undefined, "kernel readonly constant must not be mutated");
});

test("#841 omitted or own conversation_id → current-session behavior unchanged", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    const session = makeSession("pfa-current");
    const core = compressInto(session);
    const direct = executeSearchContext({ query: "auth token" }, core, session.state);
    const outOmitted = executeSearchContextTarget({ query: "auth token" }, core, "pfa-current", session.state);
    const outOwn = executeSearchContextTarget({ query: "auth token", conversation_id: "pfa-current" }, core, "pfa-current", session.state);
    assert.equal(outOmitted, direct);
    assert.equal(outOwn, direct);
    assert.ok(!outOmitted.includes("in session"), "no foreign scope on current-session search");
});

test("#1125 literal \"current\" (any case) resolves to the current session", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    const session = makeSession("pfa-real-id");
    const core = compressInto(session);
    const direct = executeSearchContext({ query: "auth token" }, core, session.state);
    const outLower = executeSearchContextTarget({ query: "auth token", conversation_id: "current" }, core, "pfa-real-id", session.state);
    const outUpper = executeSearchContextTarget({ query: "auth token", conversation_id: "Current" }, core, "pfa-real-id", session.state);
    const outMixed = executeSearchContextTarget({ query: "auth token", conversation_id: "cUrReNt" }, core, "pfa-real-id", session.state);
    assert.equal(outLower, direct, "'current' must equal direct current-session execution");
    assert.equal(outUpper, direct, "'Current' must equal direct current-session execution");
    assert.equal(outMixed, direct, "'cUrReNt' must equal direct current-session execution");
    assert.ok(!outLower.includes("in session"), "no foreign scope on the 'current' alias");
    assert.ok(!outLower.includes("FAILED"), "'current' must not fail as an unknown session");
});

test("#841 self-reference via canonical alias keeps current-session semantics", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    const session = getSession("client-conv-1");
    const core = compressInto(session);
    const canonical = `pfa-${createHash("sha256").update(`legacy:${session.id}`).digest("hex").slice(0, 16)}`;
    const direct = executeSearchContext({ query: "auth token" }, core, session.state);
    const outAlias = executeSearchContextTarget({ query: "auth token", conversation_id: canonical }, core, session.id, session.state);
    assert.equal(outAlias, direct, "canonical alias of the current session must behave exactly like omitting conversation_id");
    assert.ok(!outAlias.includes("historical"), "self-search must not carry the historical-session note");
});

test("#841 unknown conversation_id → FAILED with id echoed", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    const out = executeSearchContextTarget({ query: "auth", conversation_id: "pfa-nope" }, createCore(), "pfa-current", createInitialState());
    assert.equal(out, '[search_context FAILED: unknown session "pfa-nope"]');
});

test("#841 foreign no-match and empty-state strings carry session scope", () => {
    const s1 = makeSession("s1");
    const core = compressInto(s1);
    assert.match(executeSearchContext({ query: "zzz-no-such-topic" }, core, s1.state, "pfa-old"), /^\[No blocks matched "zzz-no-such-topic" in session pfa-old\]$/);
    assert.equal(executeSearchContext({ query: "anything" }, createCore(), createInitialState(), "pfa-old"), "[No compressed blocks exist yet in session pfa-old — nothing to search.]");
});

test("#841 resident historical session served from memory without disk", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    _resetSessionsForTest();
    const old = getSession("pfa-resident");
    const core = compressInto(old);
    const out = executeSearchContextTarget({ query: "auth token", conversation_id: "pfa-resident" }, core, "pfa-other", makeSession("pfa-other").state);
    assert.match(out, /^Found \d+ block\(s\) for "auth token" in session pfa-resident:/);
    assert.ok(out.includes("Read-only search of historical session pfa-resident"));
    assert.ok(out.includes("bili export pfa-resident [--full]"));
});

test("#841 cold-loaded historical session: read-only, file untouched, no save scheduled", async () => {
    _resetSessionsForTest();
    const dir = mkdtempSync(path.join(tmpdir(), "bili-xsearch-"));
    try {
        const writer = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        const old = makeSession("pfa-old");
        compressInto(old);
        await writer.writeNow(old);

        const reader = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        await reader.boot();
        _setStoreForTest(reader);

        const allFiles: string[] = [];
        for (const d of readdirSync(dir)) {
            if (!d.startsWith(".")) for (const f of readdirSync(path.join(dir, d))) allFiles.push(path.join(dir, d, f));
        }
        assert.ok(allFiles.length > 0, "session file must exist");
        const before = allFiles.map((f) => readFileSync(f, "utf8"));

        const cur = makeSession("pfa-new");
        const out = executeSearchContextTarget({ query: "auth token", conversation_id: "pfa-old" }, createCore(), "pfa-new", cur.state);
        assert.match(out, /^Found \d+ block\(s\) for "auth token" in session pfa-old:/);
        assert.ok(out.includes("(T"), "tier present");
        assert.ok(out.includes("auth token exchange"), "summary preview present");
        assert.ok(out.includes("Read-only search of historical session pfa-old"));
        assert.ok(out.includes("decompress acts on the current session only"));

        assert.deepEqual(allFiles.map((f) => readFileSync(f, "utf8")), before, "target session file must be byte-identical after search");
        assert.equal(reader.hasPending("pfa-old"), false, "read-only search must not schedule a save");
    } finally {
        _setStoreForTest(new SessionStore({ enabled: false }));
        _resetSessionsForTest();
        rmrf(dir);
    }
});
