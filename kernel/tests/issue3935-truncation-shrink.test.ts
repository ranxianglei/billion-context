// #3935: an "emergency truncation" that produces text LONGER than the
// original is a cache-seam bug two ways — it rewrites mid-history bytes that
// the prefix cache had already banked, and it inflates the context instead of
// relieving it (solver witness: 4001-char tool output clipped to 4064 —
// prefix 2000 + marker ~63 + suffix 2000; savedTokens NEGATIVE). The trigger
// only checked original.length > keepPrefix + keepSuffix; it never required
// the replacement to be strictly shorter. These pins freeze the fixed
// contract: every applied clip is strictly shorter than its original, big
// outputs keep the full keep-window (byte-stable with the #3941-era pins),
// and the whole thing stays deterministic and idempotent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../src/index.js";
import { truncateLargeToolOutputs } from "../src/truncate-tools.js";
import type { CoreMessage } from "../src/types.js";

const WINDOW = 100_000;
const config = () => ({ ...defaultConfig(WINDOW) });
const countTokens = (text: string) => Math.ceil(text.length / 4);

function toolResult(id: string, text: string): CoreMessage {
  return {
    id,
    role: "tool",
    contentType: "tool-result",
    toolCallId: `call-${id}`,
    toolName: "read",
    text,
  };
}

function history(text: string): CoreMessage[] {
  return [
    toolResult("t1", text),
    { id: "p1", role: "user", contentType: "text", text: "q1" },
    { id: "p2", role: "user", contentType: "text", text: "q2" },
    { id: "p3", role: "user", contentType: "text", text: "q3" },
  ];
}

test("pin: a just-over-window output clips to something strictly shorter (#3935)", () => {
  const original = "A".repeat(4001);
  const out = truncateLargeToolOutputs(
    history(original),
    96_000,
    config(),
    countTokens,
  );

  assert.equal(out.truncatedCount, 1);
  const text = out.messages[0]!.text!;
  assert.ok(text.includes("[truncated for context space]"));
  assert.ok(
    text.length < original.length,
    `replacement (${text.length}) must be strictly shorter than original (${original.length})`,
  );
  assert.ok(out.savedTokens > 0);
});

test("pin: the strictly-shorter guarantee holds across the whole bloat window", () => {
  for (const size of [4001, 4010, 4040, 4060, 4067, 4068, 4200, 6000]) {
    const original = "A".repeat(size);
    const out = truncateLargeToolOutputs(
      history(original),
      96_000,
      config(),
      countTokens,
    );
    assert.equal(out.truncatedCount, 1, `size ${size}`);
    const text = out.messages[0]!.text!;
    assert.ok(
      text.length < size,
      `size ${size}: replacement ${text.length} must be < original`,
    );
  }
});

test("pin: large outputs keep the full keep-window (byte-stable with the #3941 pins)", () => {
  const out = truncateLargeToolOutputs(
    history("A".repeat(400_000)),
    96_000,
    config(),
    countTokens,
  );
  assert.equal(out.truncatedCount, 1);
  assert.equal(out.messages[0]!.text!.length, 4066);
});

test("pin: clipping is deterministic — same input, same bytes", () => {
  const original = "B".repeat(4037);
  const a = truncateLargeToolOutputs(history(original), 96_000, config(), countTokens);
  const b = truncateLargeToolOutputs(history(original), 96_000, config(), countTokens);
  assert.equal(a.messages[0]!.text, b.messages[0]!.text);
});

test("pin: already-clipped text is never re-clipped (idempotency)", () => {
  const first = truncateLargeToolOutputs(
    history("C".repeat(5000)),
    96_000,
    config(),
    countTokens,
  );
  const clipped = first.messages[0]!.text!;
  const second = truncateLargeToolOutputs(
    history(clipped),
    96_000,
    config(),
    countTokens,
  );
  assert.equal(second.truncatedCount, 0);
  assert.equal(second.messages[0]!.text, clipped);
});

test("pin: a candidate too small to shrink meaningfully stays verbatim", () => {
  // keep windows of 0/0 with a 60-char text: the marker alone (~64 chars) is
  // longer than the original — clipping would bloat, so the candidate is
  // skipped entirely.
  const out = truncateLargeToolOutputs(
    history("short payload"),
    96_000,
    config(),
    countTokens,
    { keepPrefixChars: 0, keepSuffixChars: 0, minOutputTokens: 1 },
  );
  assert.equal(out.truncatedCount, 0);
  assert.equal(out.messages[0]!.text, "short payload");
});
