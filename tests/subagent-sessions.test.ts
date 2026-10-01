import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { createCore, createInitialState, assignRefs, emptyRefMap, defaultConfig, summaryMessageId } from "acp-kernel";
import { parseCompressInput } from "../src/compress-tool.ts";
import { applyRanges, type RewriteCtx } from "../src/stream.ts";
import { attachSubagentSessions, captureSubagentSessionIds, subagentSessionNote, subagentSessionsOf, syncSubagentSessions } from "../src/subagent-sessions.ts";

// #1702 (redesign of #1704 per review): the sub-agent session id is captured
// from the dispatch pair's STRUCTURED field into a metadata sidecar at fold
// commit, surfaced on the compress receipt and the rendered carrier — the
// stored block summary stays byte-clean and prose is never regex-scanned.

const SES = "ses_9f2b7c41d8e04a5f";

type Ctx = Omit<RewriteCtx, "log"> & { log: (m: string) => void; logs: string[] };

function makeCtx(messages: CoreMessage[], overrides?: Record<string, unknown>): Ctx {
    const logs: string[] = [];
    return {
        core: createCore(),
        config: defaultConfig(200000, overrides as never),
        messages,
        session: {
            id: "subagent-sessions-test",
            meta: {},
            stats: { requests: 0, tokensSaved: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheSamples: 0, lastInputTokens: 0, compressCreditTokens: 0, contextTokens: 0 },
            metadata: {},
            state: createInitialState(),
            createdAt: Date.now(),
            lastSeen: Date.now(),
            blockContents: new Map(),
            inFlight: 0,
            persisted: false,
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

function seedDispatch(idCall: string, idResult: string, sessionId: string): CoreMessage[] {
    // real opencode wire shape (sst/opencode tool/task.ts renderOutput): the
    // call args never carry the id; the result text opens with the machine
    // envelope `<task id="ses_..." state="completed">`.
    return [
        { id: idCall, role: "assistant", contentType: "tool-call", toolName: "task", text: JSON.stringify({ description: "research", prompt: "go look" }) },
        { id: idResult, role: "tool", contentType: "tool-result", toolName: "task", text: `<task id="${sessionId}" state="completed">\n<summary>research done</summary>\n<task_result>\nThe sub-agent finished its research and reported findings.\n</task_result>\n</task>` },
    ];
}

function runApply(ctx: Ctx, args: unknown): string {
    return applyRanges(parseCompressInput(args), ctx);
}

function opencode(ctx: Ctx): Ctx {
    ctx.session.metadata.pluginAgent = "opencode";
    return ctx;
}

test("capture reads the structured id fields of task dispatch payloads", () => {
    const mk = (id: string, payload: string): CoreMessage =>
        ({ id, role: "assistant", contentType: "tool-call", toolName: "task", text: payload });
    const msgs = [
        mk("a", JSON.stringify({ sessionId: "ses_abc123" })),
        mk("b", JSON.stringify({ sessionID: "ses_def456" })),
        mk("c", JSON.stringify({ session_id: "ses_ghi789" })),
    ];
    const covered = new Set(["a", "b", "c"]);
    assert.deepEqual(captureSubagentSessionIds(msgs, covered), ["ses_abc123", "ses_def456", "ses_ghi789"]);
});

test("capture reads the tool-result envelope header — the real opencode carrier", () => {
    const mk = (id: string, text: string, contentType: "tool-result" | "tool-call" = "tool-result", toolName = "task"): CoreMessage =>
        ({ id, role: "tool", contentType, toolName, text });
    const msgs = [
        mk("a", '<task id="ses_env001" state="completed">\n<task_result>\nok\n</task_result>\n</task>'),
        mk("b", '<task id="ses_env002" state="running">\n<summary>thinking</summary>\n</task>'),
        mk("c", '<task id="ses_env003" state="error">\n<task_error>\nboom\n</task_error>\n</task>'),
        mk("d", 'leading prose then <task id="ses_notfirst" state="completed">'),
        mk("e", '<task id="malformed-id" state="completed">'),
        mk("f", '<task state="completed">\nno id attribute at all\n</task>'),
        { id: "g", role: "tool", contentType: "tool-result", toolName: "bash", text: '<task id="ses_wrongtool" state="completed">' },
        // opencode 2.x: tool renamed subagent, envelope attribute renamed sessionID
        mk("h", '<subagent sessionID="ses_env004" state="completed">\nfinal output\n</subagent>', "tool-result", "subagent"),
        // the gate is "subagent-dispatch tool + head-anchored machine envelope";
        // either envelope shape on either dispatch tool name is fine (never
        // occurs crossed in practice, but both are machine-written headers)
        { id: "i", role: "tool", contentType: "tool-result", toolName: "task", text: '<subagent sessionID="ses_env005" state="completed">' },
    ];
    const covered = new Set(msgs.map((m) => m.id));
    // only the head-anchored envelope of subagent-dispatch tools yields ids:
    // completed, running and error states all count; buried/malformed/
    // foreign-tool never do.
    assert.deepEqual(
        captureSubagentSessionIds(msgs, covered),
        ["ses_env001", "ses_env002", "ses_env003", "ses_env004", "ses_env005"],
    );
});

test("capture dedupes, caps shape strictly, and ignores everything but task tool JSON", () => {
    const msgs: CoreMessage[] = [
        { id: "a", role: "assistant", contentType: "tool-call", toolName: "task", text: JSON.stringify({ sessionId: "ses_dup", note: JSON.stringify({ sessionId: "ses_inner" }) }) },
        { id: "b", role: "assistant", contentType: "tool-call", toolName: "task", text: JSON.stringify({ sessionId: "ses_dup" }) },
        { id: "c", role: "assistant", contentType: "tool-call", toolName: "task", text: JSON.stringify({ sessionId: "not-a-ses-id" }) },
        { id: "d", role: "assistant", contentType: "tool-call", toolName: "task", text: "not json at all" },
        { id: "e", role: "assistant", contentType: "tool-call", toolName: "bash", text: JSON.stringify({ sessionId: "ses_other" }) },
        { id: "f", role: "assistant", contentType: "text", text: "prose mentioning ses_notextracted inline" },
        { id: "g", role: "assistant", contentType: "tool-call", toolName: "task", text: JSON.stringify({ sessionID: 42 }) },
    ];
    const covered = new Set(msgs.map((m) => m.id));
    // no-regex proof: the prose mention (f) and the nested-JSON echo (a.note)
    // never yield ids; only the top-level structured field of task payloads does.
    assert.deepEqual(captureSubagentSessionIds(msgs, covered), ["ses_dup"]);
    assert.deepEqual(captureSubagentSessionIds(msgs, new Set(["a"])), ["ses_dup"]);
});

test("sync is gated on opencode and prunes dead blocks; empty re-capture keeps the old entry; children inherit", () => {
    const gate: { metadata?: Record<string, unknown>; state: { blocks: { blockId: string; active?: boolean }[] } } = {
        metadata: { pluginAgent: "pi" },
        state: { blocks: [{ blockId: "b1", active: true }] },
    };
    syncSubagentSessions(gate, [{ blockId: "b1", effectiveMessageIds: [], directBlockIds: [] }], []);
    assert.equal((gate.metadata.subagentSessions as unknown), undefined);

    const session = {
        metadata: { pluginAgent: "opencode", subagentSessions: { b1: ["ses_old"], bDead: ["ses_dead"] } },
        state: { blocks: [{ blockId: "b1", active: true }, { blockId: "b2", active: true }] },
    };
    // refold of b1 with an empty view: keeps the prior entry; bDead is pruned.
    syncSubagentSessions(session, [{ blockId: "b1", effectiveMessageIds: [], directBlockIds: [] }], []);
    assert.deepEqual(subagentSessionsOf(session), { b1: ["ses_old"] });

    // new T2 block b2 over b1: inherits the child entry even with no raw originals.
    syncSubagentSessions(session, [{ blockId: "b2", effectiveMessageIds: [], directBlockIds: ["b1"] }], []);
    assert.deepEqual(subagentSessionsOf(session), { b1: ["ses_old"], b2: ["ses_old"] });
    assert.equal(subagentSessionNote("b2", ["ses_old"]), "[acp-subagent-sessions b2: ses_old]");
});

test("attach appends the id line to the active carrier only, without mutating inputs", () => {
    const carrier = { id: summaryMessageId("b1"), role: "system", contentType: "text" as const, text: "SUMMARY-BODY" };
    const other = { id: "raw_1", role: "user", contentType: "text" as const, text: "hello" };
    const inactive = { id: summaryMessageId("b9"), role: "system", contentType: "text" as const, text: "OLD" };
    const messages = [other, carrier, inactive];
    const session = {
        metadata: { pluginAgent: "opencode", subagentSessions: { b1: ["ses_x1", "ses_x2"], b9: ["ses_y"] } },
        state: { blocks: [{ blockId: "b1", active: true }, { blockId: "b9", active: false }] },
    };
    const out = attachSubagentSessions(messages, session);
    assert.equal(out[0], other);
    assert.equal(out[2], inactive);
    assert.equal(out[1].text, "SUMMARY-BODY\n\n[acp-subagent-sessions: ses_x1, ses_x2]");
    assert.equal(carrier.text, "SUMMARY-BODY", "input message object must not be mutated");

    // non-opencode sessions and empty maps return the original array reference
    const plain = { metadata: { pluginAgent: "pi" }, state: session.state };
    assert.equal(attachSubagentSessions(messages, plain), messages);
    const emptyMap = { metadata: { pluginAgent: "opencode" }, state: session.state };
    assert.equal(attachSubagentSessions(messages, emptyMap), messages);
});

test("#1702 integration: fold records the sidecar entry, keeps the summary byte-clean, and the receipt names the id", () => {
    const dispatch = seedDispatch("raw_2", "raw_3", SES);
    const msgs = [
        textMsg("raw_1", "user", "x".repeat(3000)),
        ...dispatch,
        textMsg("raw_4", "assistant", "y".repeat(3000)),
        textMsg("raw_5", "user", "recent"),
        textMsg("raw_6", "assistant", "recent"),
        textMsg("raw_7", "user", "recent"),
        textMsg("raw_8", "assistant", "recent"),
        textMsg("raw_9", "user", "recent"),
    ];
    const ctx = opencode(withRefs(makeCtx(msgs, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 0, minSummaryLength: 0 } })));
    ctx.session.stats.lastInputTokens = 60000;
    const MODEL_SUMMARY = "The user asked for research; a task sub-agent was dispatched and returned findings.";
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: MODEL_SUMMARY }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    const block = ctx.session.state.blocks.find((b) => b.active);
    assert.ok(block, "expected an active block");
    assert.equal(block.summary, MODEL_SUMMARY, "stored summary must be byte-identical to the model payload");
    assert.deepEqual(subagentSessionsOf(ctx.session)[block.blockId], [SES]);
    assert.ok(out.includes(`[acp-subagent-sessions ${block.blockId}: ${SES}]`), `receipt must name the id:\n${out}`);

    // render-time attach on the proxy-mode carrier
    const carrier = { id: summaryMessageId(block.blockId), role: "system", contentType: "text" as const, text: block.summary };
    const attached = attachSubagentSessions([carrier], ctx.session as never);
    assert.ok(attached[0].text!.includes(`[acp-subagent-sessions: ${SES}]`));
});

test("#1702 integration: non-opencode sessions get no sidecar and no receipt note", () => {
    const msgs = [
        textMsg("raw_1", "user", "x".repeat(3000)),
        ...seedDispatch("raw_2", "raw_3", SES),
        textMsg("raw_4", "assistant", "y".repeat(3000)),
        textMsg("raw_5", "user", "recent"),
        textMsg("raw_6", "assistant", "recent"),
        textMsg("raw_7", "user", "recent"),
        textMsg("raw_8", "assistant", "recent"),
    ];
    const ctx = withRefs(makeCtx(msgs, { preserveRecentMessages: 0, preserveRecentTokens: 0, compress: { minCompressRange: 0, minSummaryLength: 0 } }));
    ctx.session.stats.lastInputTokens = 60000;
    const out = runApply(ctx, { content: [{ startId: "m00001", endId: "m00004", summary: "plain summary with no ids" }] });
    assert.ok(out.startsWith("[Compressed"), `expected success, got: ${out.slice(0, 120)}`);
    assert.deepEqual(subagentSessionsOf(ctx.session), {});
    assert.ok(!out.includes("acp-subagent-sessions"), `note must not appear for non-opencode sessions:\n${out}`);
    assert.equal(attachSubagentSessions([{ id: "raw_9", role: "user", contentType: "text", text: "z" }], ctx.session as never).length, 1);
});
