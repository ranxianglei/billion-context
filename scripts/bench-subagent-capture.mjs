import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { captureSubagentSessionIds, subagentSessionsOf, syncSubagentSessions } from "../src/subagent-sessions.ts";

const count = Number(process.argv[2] ?? 20_000);
if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) throw new Error("Expected 1..100000 unique subagent sessions");
const expected = Array.from({ length: count }, (_, i) => `ses_${String(i).padStart(8, "0")}`);
const messages = expected.flatMap((id, i) => [
    { id: `call-${i}`, contentType: "tool-call", toolName: "task", text: JSON.stringify({ sessionId: id }) },
    { id: `result-${i}`, contentType: "tool-result", toolName: "task", text: `<task id="${id}" state="completed">\nresult` },
]);
const changed = [{ blockId: "b1", effectiveMessageIds: messages.map(m => m.id), directBlockIds: [] }];
const elapsedMs = [];
for (let run = 0; run < 3; run++) {
    const session = { metadata: { pluginAgent: "opencode" }, state: { blocks: [{ blockId: "b1", active: true }] } };
    const started = performance.now();
    syncSubagentSessions(session, changed, messages);
    elapsedMs.push(performance.now() - started);
    assert.deepEqual(subagentSessionsOf(session).b1, expected.slice(0, 100));
}
assert.deepEqual(captureSubagentSessionIds(messages, new Set(changed[0].effectiveMessageIds)), expected);
console.log(JSON.stringify({ node: process.version, uniqueSessions: count, messages: messages.length, retainedIds: Math.min(count, 100), elapsedMs }, null, 2));
