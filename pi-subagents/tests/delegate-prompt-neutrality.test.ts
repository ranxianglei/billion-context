import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool } from "../src/delegate-tool.js";
import { ACP_DELEGATE_PROMPT } from "../src/system-prompt.js";

// #5237: the model-visible text injected by the acp_delegate tool family must stay
// capability/contract-only — what the tools DO, their parameters, lifecycle, failure
// and resume semantics. Delegation STRATEGY (when to delegate, prefer async, how many
// runs, which role for which task kind) belongs to the user / their AGENTS.md, not to
// a default-injected preference. Both directions are asserted: removed preference
// phrases must be gone AND retained contract terms must still be present.

const PREFERENCE_PHRASES = [
  "Use to get focused review/investigation/implementation",
  "or to run several tasks concurrently",
  "Prefer async=true and launch several",
  "parallelize independent work",
  "Route by task kind",
  "never use worker to review",
  "sole writer",
];

const CONTRACT_TERMS = [
  "reviewer",
  "researcher",
  "worker",
  "planner",
  "oracle",
  "async=true",
  "acp_delegate_wait",
  "acp_delegate_cancel",
  "resumeFrom",
  "timeoutMinutes",
];

const ROLES = ["reviewer", "researcher", "worker", "planner", "oracle"];

test("acp_delegate tool surface is preference-free but contract-complete (#5237)", () => {
  const pi = {} as unknown as Parameters<typeof makeDelegateTool>[0];
  const tool = makeDelegateTool(pi);
  const injected = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");

  for (const phrase of PREFERENCE_PHRASES) {
    assert.ok(!injected.includes(phrase), `preference phrase must be gone: ${phrase}`);
  }
  for (const term of CONTRACT_TERMS) {
    assert.ok(injected.includes(term), `contract term must remain: ${term}`);
  }

  for (const role of ROLES) {
    assert.ok(tool.promptSnippet.includes(role), `snippet lists every role without priming one: ${role}`);
  }
  assert.ok(!tool.promptSnippet.includes('agent: "reviewer"'), "snippet must not prime the reviewer role");

  assert.equal(tool.promptGuidelines.length, 1, "guidelines collapse to the single load-bearing task-construction contract");
  assert.match(tool.promptGuidelines[0], /NO access to this conversation/);
});

test("ACP_DELEGATE system-prompt appendix stays mechanics-only (#5237)", () => {
  assert.ok(ACP_DELEGATE_PROMPT.includes("ACP_DELEGATE NOTIFICATIONS"));
  for (const phrase of PREFERENCE_PHRASES) {
    assert.ok(!ACP_DELEGATE_PROMPT.includes(phrase), `appendix must not carry a preference: ${phrase}`);
  }
});

test("wait/cancel tool guidance stays mechanics-only and unchanged (#5237)", () => {
  const pi = {} as unknown as Parameters<typeof makeDelegateTool>[0];
  const wait = makeDelegateWaitTool(pi);
  const cancel = makeDelegateCancelTool(pi);
  assert.ok(wait.promptGuidelines.length >= 1, "wait keeps its mechanics guidance");
  assert.deepEqual(cancel.promptGuidelines, []);
});
