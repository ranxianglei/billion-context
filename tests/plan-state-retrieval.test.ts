import test from "node:test";
import assert from "node:assert/strict";
import { createCore, createInitialState, type CompressionBlock, type CoreMessage } from "acp-kernel";
import { anthropicToCore, openaiToCore, responsesToCore } from "acp-kernel/wire";
import { executeSearchContext, extractPlanState } from "../src/decompress-shared.ts";
import { getSession } from "../src/session.ts";
import { PLAN_QUERY_REGRESSION_CASES } from "./fixtures/plan-state-retrieval-query-regressions.ts";

process.env.BILI_PERSIST = "0";

function call(input: unknown, toolName = "TodoWrite", id = "plan"): CoreMessage {
    return { id, role: "assistant", contentType: "tool-call", toolName, text: JSON.stringify(input) };
}

function user(text: string): CoreMessage {
    return { id: "user", role: "user", contentType: "text", text };
}

function todo(content: string, status: string) {
    return { content, status };
}

function block(id: string, summary: string, topic = id): CompressionBlock {
    return {
        blockId: id, runId: "plan-state", tier: 1, topic, summary,
        directMessageIds: [], effectiveMessageIds: [], directBlockIds: [],
        compressedTokens: 0, createdAt: 0, survivedCount: 0, generation: "young", active: true,
    };
}

function search(query: string, blocks: CompressionBlock[], messages: CoreMessage[], log: (message: string) => void = () => {}) {
    const core = createCore();
    const state = createInitialState();
    state.blocks = blocks;
    const session = getSession(`plan-state-${Math.random().toString(36).slice(2)}`);
    const before = structuredClone({ state, messages, metadata: session.metadata });
    const text = executeSearchContext({ query, limit: 1 }, core, state, undefined, { messages, session, log }).text;
    assert.deepEqual({ state, messages, metadata: session.metadata }, before, "retrieval must be read-only");
    return { text, core, state, session };
}

test("TodoWrite uses in-progress content without completed, pending, or display metadata", () => {
    const state = extractPlanState([call({
        todos: [
            { ...todo("ratelimit middleware", "in_progress"), activeForm: "duplicate_display", id: "metadata_identifier" },
            todo("authentication migration", "completed"),
            todo("billing dashboard", "pending"),
        ],
        metadata: "unrelated_metadata",
    })]);
    assert.ok(state);
    assert.equal(state.statusAware, true);
    assert.ok(state.terms.has("ratelimit"));
    for (const term of ["authentication", "billing", "duplicate", "display", "identifier", "metadata", "content"]) {
        assert.ok(!state.terms.has(term), `non-active content must not contribute: ${term}`);
    }
});

test("pending tasks contribute only when no in-progress task exists; OpenCode cancellation is terminal", () => {
    for (const toolName of ["TodoWrite", "todowrite"]) {
        const tasks = [todo("ratelimit middleware", "pending"), todo("billing dashboard", "pending"), todo("authentication migration", "completed")];
        if (toolName === "todowrite") tasks.push(todo("retired webhook", "cancelled"));
        const state = extractPlanState([call({ todos: tasks }, toolName)]);
        assert.ok(state);
        assert.equal(state.statusAware, true);
        assert.ok(state.terms.has("ratelimit"));
        assert.ok(state.terms.has("billing"));
        assert.ok(!state.terms.has("authentication"));
        assert.ok(!state.terms.has("webhook"));
    }
});

test("all in-progress tasks contribute and activeForm is not required", () => {
    const state = extractPlanState([call({ todos: [todo("ratelimit middleware", "in_progress"), todo("billing dashboard", "in_progress")] }, "todowrite")]);
    assert.ok(state?.terms.has("ratelimit"));
    assert.ok(state?.terms.has("billing"));
});

test("latest cleared or terminal snapshot replaces earlier state while independent sources remain", () => {
    const earlier = call({ todos: [todo("obsolete authentication", "in_progress")] }, "TodoWrite", "earlier");
    for (const todos of [[], [todo("obsolete authentication", "completed")]]) {
        const latest = call({ todos }, "TodoWrite", "latest");
        assert.equal(extractPlanState([earlier, latest]), null);
        const state = extractPlanState([earlier, latest, call({ task: "deployment readiness" }, "CustomPlan"), user("revisit billing")], ["CustomPlan"]);
        assert.ok(state);
        assert.equal(state.statusAware, true);
        assert.ok(!state.terms.has("obsolete"));
        assert.ok(!state.terms.has("authentication"));
        assert.ok(state.terms.has("billing"));
        assert.ok(state.terms.has("deployment"));
    }
});

test("invalid snapshots retain the exact legacy terms and never revive an older snapshot", () => {
    const invalid: unknown[] = [
        null, [], { todos: null }, { todos: "ratelimit" },
        { todos: [todo("ratelimit", "in_progress"), todo("authentication", "unknown")] },
        { todos: [todo("ratelimit", "in_progress"), { content: "authentication" }] },
        { todos: [todo("ratelimit", "in_progress"), { content: 7, status: "completed" }] },
        { todos: [todo("ratelimit", "in_progress"), todo("   ", "completed")] },
        { todos: [todo("retired authentication", "cancelled")] },
    ];
    const texts = [...invalid.map((input) => JSON.stringify(input)), '{"todos":[{"content":"ratelimit","status":"in_progress"}'];
    for (const text of texts) {
        const latest = { ...call({}, "TodoWrite", "latest"), text };
        const actual = extractPlanState([call({ todos: [todo("ancient zebra", "in_progress")] }, "TodoWrite", "old"), latest]);
        const expected = extractPlanState([{ ...latest, toolName: "CustomPlan" }], ["CustomPlan"]);
        assert.deepEqual(actual?.terms, expected?.terms, text);
        assert.ok(!actual?.statusAware, text);
        assert.ok(!actual?.terms.has("zebra"), text);
    }
});

test("custom, incremental, and differently named tools keep legacy extraction", () => {
    const input = { todos: [todo("authentication", "completed"), todo("ratelimit", "in_progress")] };
    for (const toolName of ["CustomPlan", "TaskCreate", "TaskUpdate", "update_plan", "todo_list", "mcp__tasks__TodoWrite"]) {
        const state = extractPlanState([call(input, toolName)], [toolName]);
        assert.ok(state?.terms.has("authentication"), toolName);
        assert.ok(state?.terms.has("ratelimit"), toolName);
        assert.ok(!state?.statusAware, toolName);
    }
});

test("only a leading ACP ref tag can be removed before parsing a snapshot", () => {
    const snapshot = call({ todos: [todo("ratelimit", "in_progress"), todo("authentication", "completed")] });
    const tag = '\x3cacp tokens="120" type="TodoWrite"\x3em00003\x3c/acp\x3e\n';
    const tagged = extractPlanState([{ ...snapshot, text: tag + snapshot.text }]);
    assert.deepEqual(tagged, extractPlanState([snapshot]));
    for (const prefix of ["tool arguments: ", '\x3cacp\x3enot-a-ref\x3c/acp\x3e\n']) {
        const malformed = extractPlanState([{ ...snapshot, text: prefix + snapshot.text }]);
        assert.ok(!malformed?.statusAware, prefix);
        assert.ok(malformed?.terms.has("authentication"), prefix);
    }
});

test("JSON at the 4000-character cap is parsed; longer snapshots use bounded legacy fallback", () => {
    const input = { todos: [todo("authentication", "completed"), todo("ratelimit", "in_progress")], padding: "" };
    const base = JSON.stringify(input);
    input.padding = "x".repeat(4000 - base.length);
    const capped = call(input);
    assert.equal(capped.text?.length, 4000);
    const exact = extractPlanState([capped]);
    assert.equal(exact?.statusAware, true);
    assert.ok(!exact?.terms.has("authentication"));
    const tag = '\x3cacp tokens="1K" type="TodoWrite"\x3em00003\x3c/acp\x3e\n';
    assert.deepEqual(extractPlanState([{ ...capped, text: tag + capped.text }]), exact, "ACP metadata does not consume the JSON cap");
    input.padding += "x";
    const oversized = call(input);
    assert.equal(oversized.text?.length, 4001);
    const actual = extractPlanState([oversized]);
    const legacy = extractPlanState([{ ...oversized, toolName: "CustomPlan" }], ["CustomPlan"]);
    assert.deepEqual(actual?.terms, legacy?.terms);
    assert.ok(!actual?.statusAware);
    assert.ok(actual?.terms.has("authentication"));
    const lateActive = extractPlanState([call({ todos: [todo("authcache ".repeat(500), "completed"), todo("redis", "in_progress")] })]);
    assert.ok(!lateActive?.statusAware);
    assert.ok(lateActive?.terms.has("authcache"));
    assert.ok(!lateActive?.terms.has("redis"), "oversized input retains bounded legacy extraction, not partial structured parsing");
});

test("all protocol adapters expose the same snapshot and extraction preserves their messages", () => {
    const input = { todos: [{ ...todo("authentication", "completed"), activeForm: "Authenticating" }, { ...todo("ratelimit", "in_progress"), activeForm: "Rate limiting" }] };
    const json = JSON.stringify(input);
    const projected = [
        anthropicToCore({ messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call-plan", name: "TodoWrite", input }] }] }).msgs,
        openaiToCore({ messages: [{ role: "assistant", content: null, tool_calls: [{ id: "call-plan", type: "function", function: { name: "TodoWrite", arguments: json } }] }] }).msgs,
        responsesToCore({ input: [{ type: "function_call", call_id: "call-plan", name: "TodoWrite", arguments: json }] }).msgs,
    ];
    for (const messages of projected) {
        const before = structuredClone(messages);
        assert.equal(messages[0]?.text, json);
        const state = extractPlanState(messages);
        assert.equal(state?.statusAware, true);
        assert.ok(state?.terms.has("ratelimit"));
        assert.ok(!state?.terms.has("authentication"));
        assert.deepEqual(messages, before);
    }
});

test("changing only task status changes the retrieved block without mutating inputs or session state", () => {
    const blocks = [block("b1", "token authentication history"), block("b2", "token ratelimit history")];
    for (const active of ["authentication", "ratelimit"]) {
        const messages = [user("continue"), call({ todos: [todo("authentication", active === "authentication" ? "in_progress" : "completed"), todo("ratelimit", active === "ratelimit" ? "in_progress" : "completed")] })];
        const before = structuredClone({ blocks, messages });
        const result = search("token", blocks, messages);
        assert.match(result.text, new RegExp(`\\n\\n${active === "authentication" ? "b1" : "b2"} \\(T1\\)`));
        const stateBefore = structuredClone(result.state);
        const metadataBefore = structuredClone(result.session.metadata);
        const again = executeSearchContext({ query: "token", limit: 1 }, result.core, result.state, undefined, { messages, session: result.session, log: () => {} });
        assert.equal(again.text, result.text);
        assert.deepEqual({ blocks, messages }, before);
        assert.deepEqual(result.state, stateBefore);
        assert.deepEqual(result.session.metadata, metadataBefore);
    }
});

test("explicit query coverage outranks an active task when revisiting completed work", () => {
    const messages = [call({ todos: [todo("authentication", "completed"), todo("ratelimit", "in_progress")] })];
    const blocks = [block("b1", "token authentication decisions"), block("b2", "token ratelimit ratelimit middleware")];
    assert.match(search("AUTHENTICATION\t token", blocks, messages).text, /\n\nb1 \(T1\)/);
    assert.match(search("token", blocks, messages).text, /\n\nb2 \(T1\)/, "plan still decides when both blocks cover the query");
    assert.match(search("token unresolved", blocks, messages).text, /\n\nb2 \(T1\)/, "plan still decides when neither block fully covers the query");
    const legacy = [call({ todos: [todo("ratelimit", "unknown")] })];
    assert.match(search("authentication token", blocks, legacy).text, /\n\nb2 \(T1\)/, "unrecognized schemas keep legacy ranking");
});

test("query guard preserves contiguous CJK phrases and punctuation-bearing identifiers", () => {
    const cases = [
        { query: "密码管理 token", full: "密码管理 token archive", partial: "密 钥 码 管 理 token ratelimit ratelimit" },
        { query: "user_id token", full: "user_id token archive", partial: "user id token ratelimit ratelimit" },
        { query: "v2.3 token", full: "v2.3 token archive", partial: "v2 and 3 token ratelimit ratelimit" },
    ];
    for (const row of cases) {
        const messages = [call({ todos: [todo("ratelimit", "in_progress")] })];
        const blocks = [block("b1", row.full), block("b2", row.partial)];
        assert.match(search(row.query, blocks, messages).text, /\n\nb1 \(T1\)/, row.query);
        assert.match(search("token", blocks, messages).text, /\n\nb2 \(T1\)/, `${row.query}: no false guard without the specific query term`);
    }
});

test("equal coverage and equal plan scores preserve the kernel order", () => {
    const blocks = [block("b1", "token ratelimit history"), block("b2", "token ratelimit history")];
    const messages = [call({ todos: [todo("ratelimit", "in_progress")] })];
    const result = search("token", blocks, messages);
    assert.equal(result.core.search("token", result.state)[0]?.blockId, "b1");
    assert.match(result.text, /\n\nb1 \(T1\)/);
});

test("ranking diagnostics explain query protection and stable ties without changing tool output", () => {
    const messages = [call({ todos: [todo("authentication", "completed"), todo("ratelimit", "in_progress")] })];
    const cases = [
        { query: "token token authentication", blocks: [block("b1", "token authentication decisions"), block("b2", "token ratelimit ratelimit middleware")], breakdown: "query=2/2,plan=0" },
        { query: "token", blocks: [block("b1", "token ratelimit history"), block("b2", "token ratelimit history")], breakdown: "query=1/1,plan=2" },
    ];
    for (const row of cases) {
        const logs: string[] = [];
        const result = search(row.query, row.blocks, messages, (message) => logs.push(message));
        assert.equal(result.text, search(row.query, row.blocks, messages).text);
        assert.match(result.text, /\n\nb1 \(T1\)/);
        const originalRank = result.core.search(row.query, result.state).findIndex((entry) => entry.blockId === "b1") + 1;
        assert.equal(logs.length, 1);
        assert.ok(logs[0].endsWith(`b1(${row.breakdown},original=${originalRank})`), logs[0]);
    }
    const legacyLogs: string[] = [];
    search("token authentication", cases[0].blocks, [call({ todos: [todo("ratelimit", "unknown")] })], (message) => legacyLogs.push(message));
    assert.equal(legacyLogs.length, 1);
    assert.ok(legacyLogs[0].endsWith("b2:4"), "unsupported schemas retain the original log format");
});

for (const row of PLAN_QUERY_REGRESSION_CASES) {
    test(`partial explicit query retains historical evidence: ${row.id}`, () => {
        const blocks = row.blocks.map((entry) => block(entry.blockId, entry.summary, entry.topic));
        const messages: CoreMessage[] = row.planningMessages.map((entry, i) => ({
            id: `plan-${i}`, role: "assistant", contentType: "tool-call", toolName: entry.toolName, text: entry.text,
        }));
        const result = search(row.query, blocks, messages);
        const firstBlock = result.text.match(/\n\n(b\d+) \(T1\)/)?.[1];
        assert.ok(firstBlock && row.relevantBlockIds.includes(firstBlock), `${row.id}: ${row.query} returned ${firstBlock}`);
    });
}

test("repeated query words and summary occurrences cannot outweigh distinct query evidence", () => {
    const blocks = [block("b1", "JWT issuer archive"), block("b2", `${"token ".repeat(20)}ratelimit middleware`)];
    const messages = [call({ todos: [todo("JWT issuer", "completed"), todo("ratelimit", "in_progress")] })];
    for (const query of ["token JWT issuer", "token token token token JWT issuer"]) {
        assert.match(search(query, blocks, messages).text, /\n\nb1 \(T1\)/, query);
    }
    assert.match(search("token", blocks, messages).text, /\n\nb2 \(T1\)/, "the common word alone still retrieves its matching block");
});
