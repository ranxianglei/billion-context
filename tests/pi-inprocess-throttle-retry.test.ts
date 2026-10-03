import { test } from "node:test";
import assert from "node:assert/strict";
import {
  THROTTLE_RETRY_ERROR_MESSAGE,
  THROTTLE_KICK_TEXT,
  THROTTLE_KICK_SENTINEL,
  INITIAL_THROTTLE_STATE,
  ThrottleEpisode,
  isThrottleError,
  isKickMessage,
  resolveThrottleRetry,
  throttleDelayMs,
  abortableSleep,
  type ThrottleErrorProbe,
} from "../src/agent/pi-inprocess/throttle-retry.js";

const RELAY_ERROR = "Provider finish_reason: error_finish";
const BEDROCK_JSON = '{"message":"Too many tokens, please wait before trying again."}';

function assistant(errorMessage: string | undefined, content: unknown, stopReason = "error"): ThrottleErrorProbe {
  return { role: "assistant", stopReason, errorMessage, content };
}

function text(...blocks: string[]) {
  return blocks.map((text) => ({ type: "text", text }));
}

test("isThrottleError: relay shape (error_finish + Bedrock JSON streamed as content)", () => {
  assert.equal(isThrottleError(assistant(RELAY_ERROR, text(BEDROCK_JSON))), true);
  assert.equal(isThrottleError(assistant(RELAY_ERROR, BEDROCK_JSON)), true);
});

test("isThrottleError: direct Bedrock provider path (throttling name in errorMessage)", () => {
  assert.equal(isThrottleError(assistant("ThrottlingException: Too many tokens, please wait before trying again.", [])), true);
  assert.equal(isThrottleError(assistant("Throttling error: Too many tokens, please wait before trying again.", [])), true);
  assert.equal(isThrottleError(assistant("Throttling: request rate increased too quickly.", [])), true);
});

test("isThrottleError: Bedrock phrase in errorMessage (relay variants)", () => {
  assert.equal(isThrottleError(assistant("Error: Too many tokens, please wait before trying again.", [])), true);
});

test("isThrottleError: real context-overflow signatures are rejected", () => {
  assert.equal(isThrottleError(assistant("prompt is too long: 213462 tokens > 200000 maximum", [])), false);
  assert.equal(isThrottleError(assistant("Your input exceeds the context window of this model.", [])), false);
  assert.equal(isThrottleError(assistant("Input length (265330) exceeds the model's maximum context length (200000).", [])), false);
  assert.equal(isThrottleError(assistant("request_too_large", [])), false);
});

test("isThrottleError: quota/billing exhaustion is rejected", () => {
  assert.equal(isThrottleError(assistant("You exceeded your current quota, please check your plan and billing details", [])), false);
  assert.equal(isThrottleError(assistant("Model quota exceeded for the current billing plan", [])), false);
  assert.equal(isThrottleError(assistant("insufficient_quota", [])), false);
});

test("isThrottleError: Bedrock daily-quota message (no 'please wait' phrase) is rejected", () => {
  assert.equal(isThrottleError(assistant("Too many tokens per day is exceeded", [])), false);
});

test("isThrottleError: generic 429 (already handled by pi native retry) is not ours", () => {
  assert.equal(isThrottleError(assistant("429 too many requests from upstream", [])), false);
});

test("isThrottleError: non-error stop reasons and non-assistant roles are rejected", () => {
  assert.equal(isThrottleError(assistant("ThrottlingException: x", [], "aborted")), false);
  assert.equal(isThrottleError(assistant("ThrottlingException: x", [], "stop")), false);
  assert.equal(isThrottleError({ role: "user", stopReason: "error", errorMessage: "ThrottlingException: x", content: [] }), false);
});

test("isThrottleError: bare error_finish without the Bedrock phrase is rejected", () => {
  assert.equal(isThrottleError(assistant(RELAY_ERROR, [])), false);
  assert.equal(isThrottleError(assistant(RELAY_ERROR, text("Something else went wrong"))), false);
  assert.equal(isThrottleError(assistant(undefined, [])), false);
});

test("isKickMessage: recognizes the ACP kick and rejects everything else", () => {
  assert.equal(isKickMessage({ role: "user", content: [{ type: "text", text: THROTTLE_KICK_TEXT }] }), true);
  assert.equal(isKickMessage({ role: "user", content: THROTTLE_KICK_TEXT }), true);
  assert.equal(isKickMessage({ role: "user", content: `  ${THROTTLE_KICK_SENTINEL} resumed` }), true);
  assert.equal(isKickMessage({ role: "user", content: [{ type: "text", text: "please continue" }] }), false);
  assert.equal(isKickMessage({ role: "assistant", content: THROTTLE_KICK_TEXT }), false);
});

test("resolveThrottleRetry: defaults", () => {
  assert.deepEqual(resolveThrottleRetry(undefined), { enabled: true, maxRetries: 10, baseDelayMs: 60_000, maxDelayMs: 300_000, backoffMode: "exponential" });
  assert.deepEqual(resolveThrottleRetry(true), { enabled: true, maxRetries: 10, baseDelayMs: 60_000, maxDelayMs: 300_000, backoffMode: "exponential" });
});

test("resolveThrottleRetry: boolean false shorthand disables", () => {
  const r = resolveThrottleRetry(false);
  assert.equal(r.enabled, false);
  assert.equal(r.maxRetries, 10);
});

test("resolveThrottleRetry: partial object overrides", () => {
  assert.deepEqual(resolveThrottleRetry({ maxRetries: 3 }), { enabled: true, maxRetries: 3, baseDelayMs: 60_000, maxDelayMs: 300_000, backoffMode: "exponential" });
  assert.equal(resolveThrottleRetry({ enabled: false }).enabled, false);
  assert.equal(resolveThrottleRetry({ backoffMode: "fixed" }).backoffMode, "fixed");
});

test("resolveThrottleRetry: clamps", () => {
  assert.equal(resolveThrottleRetry({ maxRetries: 0 }).maxRetries, 1);
  assert.equal(resolveThrottleRetry({ maxRetries: 2.9 }).maxRetries, 2);
  assert.equal(resolveThrottleRetry({ baseDelayMs: 0.4 }).baseDelayMs, 1);
  const r = resolveThrottleRetry({ baseDelayMs: 600_000 });
  assert.equal(r.maxDelayMs, 600_000, "cap must not go below base");
  assert.equal(resolveThrottleRetry({ baseDelayMs: 60_000, maxDelayMs: 120_000 }).maxDelayMs, 120_000, "explicit maxDelayMs is honored");
});

test("throttleDelayMs: exponential with cap", () => {
  const r = resolveThrottleRetry(undefined);
  assert.equal(throttleDelayMs(1, r), 60_000);
  assert.equal(throttleDelayMs(2, r), 120_000);
  assert.equal(throttleDelayMs(3, r), 240_000);
  assert.equal(throttleDelayMs(4, r), 300_000);
  assert.equal(throttleDelayMs(10, r), 300_000);
});

test("throttleDelayMs: fixed mode and custom base", () => {
  const r = resolveThrottleRetry({ backoffMode: "fixed", baseDelayMs: 30_000, maxDelayMs: 30_000 });
  assert.equal(throttleDelayMs(1, r), 30_000);
  assert.equal(throttleDelayMs(9, r), 30_000);
});

test("episode: full 10-retry timeline (3 native + kick + 3 native + kick + exhaustion)", () => {
  const ep = new ThrottleEpisode();
  const max = 10;
  assert.deepEqual(ep.state, INITIAL_THROTTLE_STATE);
  assert.equal(ep.onThrottleError(max), "rewrite");
  for (let i = 1; i <= 3; i++) assert.equal(ep.onThrottleError(max), "rewrite");
  assert.equal(ep.state.attempts, 4);
  assert.equal(ep.readyToKick(max), true);
  ep.onKickStarted();
  assert.equal(ep.state.kicks, 1);
  ep.onUserMessage(true);
  assert.equal(ep.state.attempts, 4, "kick user message must not reset the episode");
  for (let i = 4; i <= 7; i++) assert.equal(ep.onThrottleError(max), "rewrite");
  assert.equal(ep.state.attempts, 8);
  assert.equal(ep.readyToKick(max), true);
  ep.onKickStarted();
  assert.equal(ep.state.kicks, 2);
  ep.onUserMessage(true);
  assert.equal(ep.onThrottleError(max), "rewrite");
  assert.equal(ep.onThrottleError(max), "rewrite");
  assert.equal(ep.state.attempts, 10);
  assert.equal(ep.onThrottleError(max), "exhausted", "11th error exceeds the 10-retry budget");
  assert.equal(ep.state.candidate, false);
  assert.equal(ep.readyToKick(max), false, "no kick after exhaustion");
  assert.equal(ep.onThrottleError(max), "exhausted", "stays exhausted");
});

test("episode: resets", () => {
  const ep = new ThrottleEpisode();
  ep.onThrottleError(10);
  ep.onThrottleError(10);
  ep.onUserMessage(false);
  assert.deepEqual(ep.state, INITIAL_THROTTLE_STATE, "new user message starts a new episode");
  ep.onThrottleError(10);
  ep.onProgress();
  assert.deepEqual(ep.state, INITIAL_THROTTLE_STATE, "any non-error assistant response resets");
  ep.onThrottleError(10);
  ep.onKickStarted();
  ep.onKickCancelled();
  assert.deepEqual(ep.state, INITIAL_THROTTLE_STATE, "cancelled kick resets");
});

test("episode: non-throttle error clears candidate but keeps the budget", () => {
  const ep = new ThrottleEpisode();
  ep.onThrottleError(10);
  assert.equal(ep.state.candidate, true);
  ep.onNonThrottleError();
  assert.equal(ep.state.candidate, false);
  assert.equal(ep.state.attempts, 1);
  assert.equal(ep.readyToKick(10), false);
});

test("episode: exhaustion does not consume the budget", () => {
  const ep = new ThrottleEpisode();
  for (let i = 0; i < 10; i++) ep.onThrottleError(10);
  ep.onThrottleError(10);
  assert.equal(ep.state.attempts, 10);
});

test("episode: reset aborts a pending sleep controller", async () => {
  const ep = new ThrottleEpisode();
  const controller = ep.sleepController();
  assert.equal(controller.signal.aborted, false);
  ep.reset();
  assert.equal(controller.signal.aborted, true);
  assert.notEqual(ep.sleepController(), controller);
});

test("abortableSleep: resolves ok after the delay", async () => {
  const start = Date.now();
  const result = await abortableSleep(30, new AbortController().signal);
  assert.equal(result, "ok");
  assert.ok(Date.now() - start >= 25, "should sleep close to the requested duration");
});

test("abortableSleep: pre-aborted signal returns immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  const start = Date.now();
  const result = await abortableSleep(5_000, controller.signal);
  assert.equal(result, "aborted");
  assert.ok(Date.now() - start < 100);
});

test("abortableSleep: abort mid-sleep returns aborted promptly", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const start = Date.now();
  const result = await abortableSleep(10_000, controller.signal);
  assert.equal(result, "aborted");
  assert.ok(Date.now() - start < 1_000);
});

// Mirrors of the pi-ai patterns that the rewritten errorMessage must satisfy
// (pi-ai is not importable here: zero-runtime-deps constraint).
// These are COPIES of pi-ai's retry/overflow classifier (isRetryableAssistantError
// + context-overflow detection) as shipped in pi-stable 0.83.5 (2026-08-18). If
// pi-ai changes any of these patterns, update BOTH the mirrors below AND the
// THROTTLE_RETRY_ERROR_MESSAGE string so the rewrite keeps the native-retryable
// classification — the asserts at the bottom of this file pin that contract.
const NON_RETRYABLE = new RegExp(["GoUsageLimitError", "FreeUsageLimitError", "Monthly usage limit reached", "available balance", "insufficient_quota", "out of budget", "quota exceeded", "billing"].join("|"), "i");
const RETRYABLE = new RegExp(["overloaded", "rate.?limit", "too many requests", "429", "500", "502", "503", "504", "524", "service.?unavailable", "server.?error", "internal.?error", "provider.?returned.?error"].join("|"), "i");
const OVERFLOW = [/prompt is too long/i, /request_too_large/i, /exceeds the context window/i, /exceeded model token limit/i, /context[_ ]length[_ ]exceeded/i, /too many tokens/i, /token limit exceeded/i];
const NON_OVERFLOW = [/^(Throttling error|Service unavailable):/i, /rate limit/i, /too many requests/i];

function mirrorIsContextOverflow(errorMessage: string): boolean {
  if (!errorMessage) return false;
  return !NON_OVERFLOW.some((p) => p.test(errorMessage)) && OVERFLOW.some((p) => p.test(errorMessage));
}
function mirrorIsRetryable(errorMessage: string): boolean {
  if (!errorMessage) return false;
  if (NON_RETRYABLE.test(errorMessage)) return false;
  return RETRYABLE.test(errorMessage);
}

test("rewrite contract: THROTTLE_RETRY_ERROR_MESSAGE is retryable and NOT overflow to pi", () => {
  assert.ok(RETRYABLE.test(THROTTLE_RETRY_ERROR_MESSAGE), "must match a pi retryable pattern");
  assert.ok(!NON_RETRYABLE.test(THROTTLE_RETRY_ERROR_MESSAGE), "must not match any pi non-retryable (quota/billing) pattern");
  assert.ok(!mirrorIsContextOverflow(THROTTLE_RETRY_ERROR_MESSAGE), "must not be routed to pi compaction");
  assert.ok(mirrorIsRetryable(THROTTLE_RETRY_ERROR_MESSAGE), "must be accepted by pi's retry classifier");
  assert.ok(/429/.test(THROTTLE_RETRY_ERROR_MESSAGE) && /rate limit/i.test(THROTTLE_RETRY_ERROR_MESSAGE), "load-bearing tokens: 429 + rate limit");
});

test("rewrite contract: the original error is NOT retryable (the bug this feature fixes)", () => {
  assert.ok(!mirrorIsRetryable(RELAY_ERROR), "original 'Provider finish_reason: error_finish' matches no retryable pattern");
  assert.ok(!mirrorIsContextOverflow(RELAY_ERROR), "and no overflow pattern");
});
