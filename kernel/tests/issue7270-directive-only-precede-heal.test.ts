// #7270: a directive-only system (content:[] + output_config) in an illegal
// PRECEDE position (followed by a non-assistant) was skipped unconditionally
// by healIllegalSystemPositions on the assumption that Anthropic accepts it
// "at any position". A real upstream rejected `system(directive) → user`
// with the same 'must precede an assistant' 400 as content-bearing systems,
// permanently bricking the session after a degenerate fold. The fix moves an
// illegally-positioned directive-only system to the trailing run instead of
// skipping it, preserving the effort/tool-control semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coreToAnthropic } from "../src/wire/anthropic.js";
import type { AnthropicWireMessage } from "../src/wire/anthropic.js";
import type { BiliMessage } from "../src/wire/bili-message.js";

function dir(effort: string): BiliMessage {
  return {
    id: "d" + effort,
    role: "system",
    contentType: "text",
    text: "[effort:" + effort + "]",
    rawAnthropicMessage: {
      role: "system",
      content: [],
      output_config: { effort },
    },
  } as BiliMessage;
}

function u(id: string, text: string): BiliMessage {
  return { id, role: "user", contentType: "text", text };
}

function a(id: string, text: string): BiliMessage {
  return { id, role: "assistant", contentType: "text", text };
}

// --- the field regression shape (user, directive, user) --------------------

test("#7270: directive-only system followed by user is moved to the trailing run", () => {
  const out = coreToAnthropic([
    u("u1", "hello"),
    dir("medium"),
    u("u2", "world"),
  ] as never);
  // The directive-only system must NOT sit between two users.
  assert.equal(out.length, 3);
  assert.equal(out[0]!.role, "user");
  assert.equal(out[1]!.role, "user");
  assert.equal(out[2]!.role, "system");
  const d = out[2]! as { output_config?: { effort?: string } };
  assert.equal(d.output_config?.effort, "medium", "effort value preserved");
  assert.deepEqual(out[2]!.content, [], "content stays empty");
});

test("#7270: directive-only system followed by assistant stays in place (legal)", () => {
  const out = coreToAnthropic([
    u("u1", "hello"),
    dir("high"),
    a("a1", "ok"),
  ] as never);
  assert.equal(out.length, 3);
  assert.equal(out[0]!.role, "user");
  assert.equal(out[1]!.role, "system");
  assert.equal(out[2]!.role, "assistant");
  const d = out[1]! as { output_config?: { effort?: string } };
  assert.equal(d.output_config?.effort, "high");
});

// --- the real 6-message outbound shape from the issue -----------------------

test("#7270: real 6-message post-fold shape — no system→user adjacency", () => {
  // Mirrors the field shape: user, dir(medium), user, dir(high), user, system(text)
  // The last system has content (not directive-only) so it stays a system via rawAnthropicMessage.
  const tailSys: BiliMessage = {
    id: "s5",
    role: "system",
    contentType: "text",
    text: "tail system",
    rawAnthropicMessage: { role: "system", content: [{ type: "text", text: "tail system" }] },
  } as BiliMessage;
  const out = coreToAnthropic([
    u("u0", "q with images"),
    dir("medium"),
    u("u2", "followup"),
    dir("high"),
    u("u4", "another"),
    tailSys,
  ] as never);
  // All systems must be trailing (no non-system after any system).
  const sysIdx: number[] = [];
  for (let i = 0; i < out.length; i++) {
    if (out[i]!.role === "system") sysIdx.push(i);
  }
  assert.ok(sysIdx.length >= 2, "at least the two directive systems must survive");
  for (const i of sysIdx) {
    for (let j = i + 1; j < out.length; j++) {
      assert.equal(out[j]!.role, "system", `system at ${i} must be followed only by systems, found ${out[j]!.role} at ${j}`);
    }
  }
  // The two directive-only systems preserve their effort values.
  const dirs = out.filter((m) => m.role === "system" && Array.isArray(m.content) && m.content.length === 0) as Array<{ output_config?: { effort?: string } }>;
  assert.equal(dirs.length, 2);
  assert.equal(dirs[0]!.output_config?.effort, "medium");
  assert.equal(dirs[1]!.output_config?.effort, "high");
});

// --- negative guards: legal shapes stay byte-identical -----------------------

test("legal: directive-only system at array end stays verbatim", () => {
  const out = coreToAnthropic([
    u("u1", "hello"),
    a("a1", "ok"),
    dir("low"),
  ] as never);
  assert.equal(out.length, 3);
  assert.equal(out[2]!.role, "system");
  const d = out[2]! as { output_config?: { effort?: string } };
  assert.equal(d.output_config?.effort, "low");
  assert.deepEqual(out[2]!.content, []);
});

test("legal: directive-only system between user and assistant stays verbatim", () => {
  const out = coreToAnthropic([
    u("u1", "hello"),
    dir("medium"),
    a("a1", "ok"),
  ] as never);
  assert.equal(out[1]!.role, "system");
  const d = out[1]! as { output_config?: { effort?: string } };
  assert.equal(d.output_config?.effort, "medium");
});
