import { test } from "node:test";
import assert from "node:assert/strict";
import {
  delegatePreview,
  firstLine,
  exitLabel,
  makeResultMeta,
  renderDelegateCall,
  renderDelegateResult,
  type DelegateRenderMeta,
  type MetaRunSource,
  type RenderTheme,
} from "../src/delegate-render.js";
import { makeDelegateTool, makeDelegateWaitTool, makeDelegateCancelTool } from "../src/delegate-tool.js";
import { delegateStatusWidget } from "../src/fleet-widget.js";
import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// #3047 tier-1 beautification: the render layer is screen-only — model-facing
// content text stays untouched, previews live in bounded `details`, and every
// renderer must degrade to plain text on bad input instead of throwing.

type CallFn = (args: Record<string, unknown>, theme: RenderTheme) => Component;
type ResultFn = (
  result: { content: { type: string; text?: string }[]; details?: unknown },
  options: { expanded: boolean },
  theme: RenderTheme,
  ctx: { isError: boolean },
) => Component;

function fakeTheme(): { theme: RenderTheme; colors: string[] } {
  const colors: string[] = [];
  return {
    colors,
    theme: {
      fg: (color: string, text: string) => {
        colors.push(color);
        return text;
      },
      bold: (text: string) => text,
    },
  };
}

// Text.render pads every row out to the terminal width, so assertions work
// on right-trimmed rows.
function rendered(comp: Component, width = 500): string[] {
  return comp.render(width).map((l) => l.trimEnd());
}

test("firstLine takes the first line and trims", () => {
  assert.equal(firstLine("single"), "single");
  assert.equal(firstLine("first\nsecond\nthird"), "first");
  assert.equal(firstLine("  padded  \nnext"), "padded");
  assert.equal(firstLine(""), "");
});

test("exitLabel covers code, signal, and unknown exits", () => {
  assert.equal(exitLabel(0), "exit 0");
  assert.equal(exitLabel(1), "exit 1");
  assert.equal(exitLabel(null, "SIGTERM"), "exit SIGTERM");
  assert.equal(exitLabel(null, null), "exit ?");
  assert.equal(exitLabel(null, undefined), "exit ?");
});

test("delegatePreview passes short bodies through untouched (minus trailing whitespace)", () => {
  assert.deepEqual(delegatePreview(""), { preview: "", truncated: false });
  assert.deepEqual(delegatePreview("abc"), { preview: "abc", truncated: false });
  assert.deepEqual(delegatePreview("abc\n\n  "), { preview: "abc", truncated: false });
});

test("delegatePreview caps at PREVIEW_MAX_CHARS exactly without truncating", () => {
  const body = "x".repeat(4096);
  const r = delegatePreview(body);
  assert.equal(r.truncated, false);
  assert.equal(r.preview.length, 4096);
});

test("delegatePreview truncates oversized bodies on a line boundary", () => {
  const body = Array.from({ length: 500 }, (_, i) => `line-${i}-${"x".repeat(16)}`).join("\n");
  const { preview, truncated } = delegatePreview(body);
  assert.equal(truncated, true);
  assert.ok(preview.length <= 4096);
  // Cut must land on a newline so no partial line leaks into persisted details.
  assert.equal(body.slice(preview.length, preview.length + 1), "\n");
  assert.equal(preview, preview.trimEnd());
});

test("delegatePreview truncates even when there is no newline in budget", () => {
  const body = "y".repeat(5000);
  const { preview, truncated } = delegatePreview(body);
  assert.equal(truncated, true);
  assert.equal(preview.length, 4096);
});

const COMPLETED_RUN: MetaRunSource = {
  runId: "run-1",
  agent: "worker",
  task: "do X\nand more",
  status: "completed",
  startedAt: 1000,
  finishedAt: 43_000,
  exitCode: 0,
  result: { file: "/tmp/out.txt", body: "l1\nl2\nl3\nl4\nl5" },
};

test("makeResultMeta fills terminal extras only for terminal states", () => {
  const meta = makeResultMeta(COMPLETED_RUN);
  assert.equal(meta.kind, "delegate");
  assert.equal(meta.agent, "worker");
  assert.equal(meta.runId, "run-1");
  assert.equal(meta.task, "do X");
  assert.equal(meta.status, "completed");
  assert.equal(meta.durationMs, 42_000);
  assert.equal(meta.exitLabel, "exit 0");
  assert.equal(meta.file, "/tmp/out.txt");
  assert.equal(meta.preview, "l1\nl2\nl3\nl4\nl5");
  assert.equal(meta.previewTruncated, false);

  const running = makeResultMeta({ runId: "r2", agent: "researcher", task: "scan", status: "running" });
  assert.equal(running.durationMs, undefined);
  assert.equal(running.exitLabel, undefined);
  assert.equal(running.file, undefined);
  assert.equal(running.preview, undefined);
});

test("makeResultMeta carries timeout and signal info for failed runs", () => {
  const meta = makeResultMeta({
    runId: "r3",
    agent: "oracle",
    task: "think",
    status: "failed",
    exitCode: null,
    exitSignal: "SIGTERM",
    timedOut: "idle timeout",
    result: { file: "/tmp/f.txt", body: "" },
  });
  assert.equal(meta.exitLabel, "exit SIGTERM");
  assert.equal(meta.timedOut, "idle timeout");
  assert.equal(meta.file, "/tmp/f.txt");
  assert.equal(meta.preview, undefined);
});

test("renderDelegateCall renders one compact line", () => {
  const { theme } = fakeTheme();
  const lines = rendered(renderDelegateCall({ agent: "worker", task: "Review auth module" }, theme));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("▸"));
  assert.ok(lines[0].includes("worker"));
  assert.ok(lines[0].includes("Review auth module"));
});

test("renderDelegateCall marks resume calls and tolerates missing agent", () => {
  const { theme } = fakeTheme();
  const resume = rendered(renderDelegateCall({ agent: "worker", task: "t", resumeFrom: "abc123" }, theme));
  assert.equal(resume.length, 1);
  assert.ok(resume[0].includes("↻"));
  assert.ok(resume[0].includes("(from abc123)"));

  const noAgent = rendered(renderDelegateCall({ task: "del_xxx" }, theme));
  assert.equal(noAgent.length, 1);
  assert.ok(noAgent[0].startsWith("▸ "));
  assert.ok(noAgent[0].includes("del_xxx"));
});

test("renderDelegateCall truncates long tasks", () => {
  const { theme } = fakeTheme();
  const longTask = "a".repeat(300);
  const lines = rendered(renderDelegateCall({ agent: "worker", task: longTask }, theme));
  assert.equal(lines.length, 1);
  // "▸ worker " prefix (9 cells) + task truncated to CALL_TASK_WIDTH (160).
  assert.ok(visibleWidth(lines[0]) <= 169, `call line too wide: ${visibleWidth(lines[0])}`);
  assert.ok(!lines[0].includes("a".repeat(180)));
});

function completedMeta(): DelegateRenderMeta {
  return makeResultMeta(COMPLETED_RUN);
}

test("renderDelegateResult falls back to plain text on error, missing, or statusless meta", () => {
  const { theme } = fakeTheme();
  const plain = { content: [{ type: "text", text: "boom" }] };
  assert.deepEqual(rendered(renderDelegateResult(plain, { expanded: false }, theme, { isError: true })), ["boom"]);
  assert.deepEqual(rendered(renderDelegateResult(plain, { expanded: false }, theme, { isError: false })), ["boom"]);
  const statusless = { content: [{ type: "text", text: "queued note" }], details: { kind: "delegate" } };
  assert.deepEqual(rendered(renderDelegateResult(statusless, { expanded: false }, theme, { isError: false })), ["queued note"]);
});

test("renderDelegateResult completed collapsed shows 3 preview lines plus expand hint and file trailer", () => {
  const { theme, colors } = fakeTheme();
  const lines = rendered(renderDelegateResult({ content: [{ type: "text", text: "irrelevant for screen" }], details: completedMeta() }, { expanded: false }, theme, { isError: false }));
  assert.ok(lines[0].includes("✓ worker"));
  assert.ok(lines[0].includes("exit 0"));
  assert.ok(lines[0].includes("42s"));
  assert.deepEqual(colors[0], "success");
  // 1 header + 3 preview lines + 1 expand hint + 1 file trailer
  assert.equal(lines.length, 6);
  assert.ok(lines[1].includes("l1"));
  assert.ok(lines[3].includes("l3"));
  assert.ok(lines[4].includes("… 2 more line(s) — Ctrl+O expand"));
  assert.ok(lines[5].includes("⎿ /tmp/out.txt"));
});

test("renderDelegateResult completed expanded shows all preview lines without the hint", () => {
  const { theme } = fakeTheme();
  const lines = rendered(renderDelegateResult({ content: [{ type: "text", text: "" }], details: completedMeta() }, { expanded: true }, theme, { isError: false }));
  // 1 header + 5 preview lines + 1 file trailer
  assert.equal(lines.length, 7);
  assert.ok(!lines.some((l) => l.includes("more line(s)")));
  assert.ok(lines[5].includes("l5"));
  assert.ok(lines[6].includes("⎿ /tmp/out.txt"));
});

test("renderDelegateResult failed shows failure label, exit, and timeout reason", () => {
  const { theme, colors } = fakeTheme();
  const meta = makeResultMeta({
    runId: "r4",
    agent: "worker",
    task: "build",
    status: "failed",
    exitCode: 1,
    timedOut: "sync timeout",
    startedAt: 0,
    finishedAt: 5000,
  });
  const lines = rendered(renderDelegateResult({ content: [], details: meta }, { expanded: false }, theme, { isError: false }));
  assert.ok(lines[0].includes("✗ worker"));
  assert.ok(lines[0].includes("FAILED ⚠️"));
  assert.ok(lines[0].includes("exit 1"));
  assert.ok(lines[0].includes("timed out: sync timeout"));
  assert.ok(colors.includes("error"));
});

test("renderDelegateResult cancelled/running/queued each get their own shape", () => {
  const { theme } = fakeTheme();
  const cancel = rendered(renderDelegateResult({ content: [], details: { kind: "delegate", agent: "worker", status: "cancelled" } }, { expanded: false }, theme, { isError: false }));
  assert.ok(cancel[0].includes("◼ worker · cancelled"));

  const running = rendered(renderDelegateResult({ content: [], details: { kind: "delegate", agent: "oracle", runId: "r9", status: "running" } }, { expanded: false }, theme, { isError: false }));
  assert.ok(running[0].includes("● oracle · running in background · r9"));
  assert.ok(running[1].includes("⎿ notification injected on completion"));

  const queued = rendered(renderDelegateResult({ content: [], details: { kind: "delegate", agent: "worker", status: "queued", queuedAhead: 2 } }, { expanded: false }, theme, { isError: false }));
  assert.ok(queued[0].includes("○ worker · queued (2 ahead)"));
  assert.ok(queued[1].includes("⎿ starts automatically when a slot frees"));
});

test("renderDelegateResult keeps preview lines within the width budget", () => {
  const { theme } = fakeTheme();
  const meta = makeResultMeta({
    runId: "r5",
    agent: "worker",
    task: "t",
    status: "completed",
    exitCode: 0,
    result: { file: "/tmp/w.txt", body: Array.from({ length: 5 }, (_, i) => `${i}:${"z".repeat(300)}`).join("\n") },
  });
  const lines = rendered(renderDelegateResult({ content: [], details: meta }, { expanded: true }, theme, { isError: false }));
  for (const l of lines) {
    // 2-space indent + PREVIEW_LINE_WIDTH (110) for preview rows; header and
    // trailer stay well under that.
    assert.ok(visibleWidth(l) <= 112, `line too wide (${visibleWidth(l)}): ${l.slice(0, 40)}`);
  }
});

test("all three delegate tools expose self-shell rendering hooks", () => {
  const pi = {} as unknown as Parameters<typeof makeDelegateTool>[0];
  const tools = [makeDelegateTool(pi), makeDelegateWaitTool(pi), makeDelegateCancelTool(pi)];
  for (const tool of tools) {
    assert.equal(tool.renderShell, "self");
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
  }
  const { theme } = fakeTheme();
  const callFn = tools[0].renderCall as unknown as CallFn;
  const callLines = rendered(callFn({ agent: "worker", task: "t" }, theme));
  assert.equal(callLines.length, 1);
  const resultFn = tools[0].renderResult as unknown as ResultFn;
  const resultLines = rendered(resultFn({ content: [{ type: "text", text: "" }], details: completedMeta() }, { expanded: false }, theme, { isError: false }));
  assert.ok(resultLines[0].includes("✓ worker"));
});

test("fleet widget flags stalled runs with a no-activity warning", () => {
  const calls: Array<{ key: string; lines: string[] | undefined }> = [];
  const ui = {
    setWidget(key: string, lines: string[] | undefined): void {
      calls.push({ key, lines });
    },
    setStatus(): void {},
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui,
    model: { provider: "test", id: "test-model" },
    sessionManager: { buildContextEntries: () => [] },
  } as unknown as ExtensionContext;
  const now = Date.now();
  const snapshot = (): Array<{ runId: string; agent: string; task: string; startedAt: number; lastActivityAt?: number }> => [
    { runId: "stale", agent: "worker", task: "long task", startedAt: now - 5_000, lastActivityAt: now - 130_000 },
    { runId: "fresh", agent: "oracle", task: "quick task", startedAt: now - 5_000, lastActivityAt: now - 1_000 },
  ];

  delegateStatusWidget.setContext(ctx, snapshot);
  try {
    assert.ok(calls.length >= 1);
    const lines = calls[calls.length - 1]?.lines ?? [];
    const staleRow = lines.find((l) => l.includes("worker")) ?? "";
    const freshRow = lines.find((l) => l.includes("oracle")) ?? "";
    assert.ok(staleRow.includes("⚠ no activity 2m"), `stale row missing marker: ${staleRow}`);
    assert.ok(!freshRow.includes("⚠"), `fresh row should not warn: ${freshRow}`);
  } finally {
    delegateStatusWidget.dispose();
  }
});
