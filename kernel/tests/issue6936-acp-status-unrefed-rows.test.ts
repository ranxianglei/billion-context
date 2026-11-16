/**
 * #6936: acp_status must never leak the internal BLOCKED sentinel into
 * model-facing output.
 *
 * Successful compress call/result pairs are stored with ref = "BLOCKED"
 * (the kernel deliberately mints no number for them). They are real
 * resident mass and must stay in the token accounting, but:
 *   - a span touching one used to render as "m00644–BLOCKED"
 *   - projecting such a span threw, rendered as
 *     "⚠ not foldable: refs unresolvable" — which a live 27B model read as
 *     "my refs are broken" (session 01a1e20d: 17 acp_status polls, ~9 min
 *     of failed compression attempts on spans that can never be foldable
 *     by name)
 *   - the per-message listing printed "BLOCKED" per row
 *
 * Now: spans are named by their resolvable endpoints, fully-unrefed spans
 * render as "(unrefed)" with a calm factual flag, and the old panic phrase
 * survives only as a genuine anomaly canary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusReport } from "../src/report.js";
import { createInitialState } from "../src/state.js";
import { defaultCountTokens } from "../src/tokenize.js";
import { defaultConfig } from "../src/config.js";
import { BLOCKED_REF, indexToRef } from "../src/refs.js";
import type { CoreMessage } from "../src/types.js";

const TEXT = "hello world, enough text to register";

function mk(
  id: string,
  role: CoreMessage["role"],
  contentType: CoreMessage["contentType"],
  extra: Partial<CoreMessage> = {},
): CoreMessage {
  return { id, role, contentType, text: TEXT, ...extra } as CoreMessage;
}

/**
 * u1 a1 [tc1 tr1] u2 a2 [tc2 tr2] — with `blocked: true` the compress
 * pairs carry the BLOCKED sentinel (the 01a1e20d incident shape); with
 * `blocked: false` every message gets a minted ref in ARRAY order (the
 * pre-fix world — refs stay monotonic in array position).
 */
function fixture(blocked: boolean) {
  const messages: CoreMessage[] = [
    mk("u1", "user", "text"),
    mk("a1", "assistant", "text"),
    mk("tc1", "assistant", "tool-call", { toolName: "compress", toolCallId: "c1" }),
    mk("tr1", "tool", "tool-result", { toolCallId: "c1" }),
    mk("u2", "user", "text"),
    mk("a2", "assistant", "text"),
    mk("tc2", "assistant", "tool-call", { toolName: "compress", toolCallId: "c2" }),
    mk("tr2", "tool", "tool-result", { toolCallId: "c2" }),
  ];
  const state = createInitialState();
  let n = 0;
  for (const m of messages) {
    if (blocked && (m.id.startsWith("tc") || m.id.startsWith("tr"))) {
      state.messageRefs.byRaw[m.id] = BLOCKED_REF;
      continue;
    }
    const ref = indexToRef(++n);
    state.messageRefs.byRaw[m.id] = ref;
    state.messageRefs.byRef[ref] = m.id;
  }
  // preserveRecent* 0: no soft zone (both the count rule AND the token rule
  // would otherwise swallow the tiny fixture), so the doom-flag matrix is
  // deterministic and only the unrefed treatment is under test.
  const config = defaultConfig(100_000, {
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  });
  return { messages, state, config };
}

test("#6936: ranges view never prints the sentinel or the panic phrase", () => {
  const { messages, state, config } = fixture(true);
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    config,
    originalMessages: messages,
  });
  assert.ok(
    !report.includes("BLOCKED"),
    `sentinel leaked into ranges view:\n${report}`,
  );
  assert.ok(
    !report.includes("refs unresolvable"),
    `panic phrase leaked into ranges view:\n${report}`,
  );
});

test("#6936: mixed spans are named by resolvable endpoints, unrefed mass kept", () => {
  const { messages, state, config } = fixture(true);
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    config,
    originalMessages: messages,
  });
  const lines = report.split("\n");
  // Group 1 = u1,a1,tc1,tr1 → label from resolvable endpoints only, all 4
  // rows still counted, and the unrefed-rows note replaces the old throw.
  const row1 = lines.find((l) => l.includes("m00001–m00002"));
  assert.ok(row1, `expected m00001–m00002 row:\n${report}`);
  assert.ok(row1!.includes("(4 msgs"), `unrefed rows must stay counted: ${row1}`);
  assert.ok(
    row1!.includes("unrefed rows inside stay after fold"),
    `foldable mixed span must note the unrefed rows: ${row1}`,
  );
  const row2 = lines.find((l) => l.includes("m00003–m00004"));
  assert.ok(row2, `expected m00003–m00004 row:\n${report}`);
  assert.ok(row2!.includes("(4 msgs"), `unrefed rows must stay counted: ${row2}`);
});

test("#6936: a fully-unrefed span renders as (unrefed) with a calm flag", () => {
  const messages: CoreMessage[] = [
    mk("tc3", "assistant", "tool-call", { toolName: "compress", toolCallId: "c3" }),
    mk("tr3", "tool", "tool-result", { toolCallId: "c3" }),
  ];
  const state = createInitialState();
  for (const m of messages) state.messageRefs.byRaw[m.id] = BLOCKED_REF;
  const config = defaultConfig(100_000, {
    preserveRecentMessages: 0,
    preserveRecentTokens: 0,
  });
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    config,
    originalMessages: messages,
  });
  const row = report.split("\n").find((l) => l.includes("(2 msgs"));
  assert.ok(row, `expected the unrefed span row:\n${report}`);
  assert.ok(
    row!.includes("(unrefed)"),
    `fully-unrefed span must carry the marker: ${row}`,
  );
  assert.ok(
    row!.includes("⚠ not foldable: rows carry no refs"),
    `fully-unrefed span must carry the calm flag: ${row}`,
  );
  assert.ok(!report.includes("refs unresolvable"));
});

test("#6936: per-message listing renders unrefed rows as (unrefed)", () => {
  const { messages, state, config } = fixture(true);
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "messages",
    config,
    originalMessages: messages,
  });
  assert.ok(
    !report.includes("BLOCKED"),
    `sentinel leaked into messages view:\n${report}`,
  );
  const unrefedRows = report
    .split("\n")
    .filter((l) => l.includes("(unrefed)")).length;
  assert.equal(unrefedRows, 4, `4 unrefed rows expected:\n${report}`);
});

test("#6936: clean sessions (no BLOCKED rows) render unchanged", () => {
  const { messages, state, config } = fixture(false);
  const report = buildStatusReport(state, messages, defaultCountTokens, {
    scope: "uncompressed",
    view: "ranges",
    config,
    originalMessages: messages,
  });
  assert.ok(!report.includes("(unrefed)"), `clean session gains the marker:\n${report}`);
  assert.ok(
    !report.includes("stay after fold"),
    `clean session gains the unrefed note:\n${report}`,
  );
  const row1 = report.split("\n").find((l) => l.includes("m00001–m00004"));
  assert.ok(
    row1 && !row1.includes("⚠"),
    `clean foldable row must stay unflagged:\n${report}`,
  );
});
