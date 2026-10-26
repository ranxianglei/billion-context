import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

// Invariants: model-facing `content` text is untouched (previews live only in
// bounded `details` + the rendered screen); renderers never throw on bad input
// (they fall back to plain text; the host also try/catches renderer calls).
// Hosts < pi-coding-agent 0.62 ignore renderCall/renderResult and < 0.67.3
// ignore renderShell — no runtime feature detection needed.

// Method syntax keeps any host Theme (fg takes a narrower color union) assignable.
export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type DelegateStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

// Carried in tool-result `details`, which persists into the session
// transcript — keep payloads bounded (PREVIEW_MAX_CHARS).
export interface DelegateRenderMeta {
  kind: "delegate";
  agent?: string;
  runId?: string;
  task?: string;
  status?: DelegateStatus;
  exitLabel?: string;
  timedOut?: string;
  file?: string;
  durationMs?: number;
  preview?: string;
  previewTruncated?: boolean;
  queuedAhead?: number;
  resumedFrom?: string;
}

const PREVIEW_MAX_CHARS = 4096;
const PREVIEW_LINE_WIDTH = 110;
const PREVIEW_LINES_COLLAPSED = 3;
const PREVIEW_LINES_EXPANDED = 40;
const CALL_TASK_WIDTH = 160;

export function exitLabel(code: number | null, signal?: NodeJS.Signals | null): string {
  if (code === null && signal) return `exit ${signal}`;
  return `exit ${code ?? "?"}`;
}

export function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i === -1 ? s : s.slice(0, i)).trim();
}

export function delegatePreview(body: string): { preview: string; truncated: boolean } {
  if (!body) return { preview: "", truncated: false };
  const trimmed = body.replace(/\s+$/, "");
  if (trimmed.length <= PREVIEW_MAX_CHARS) return { preview: trimmed, truncated: false };
  const cut = trimmed.slice(0, PREVIEW_MAX_CHARS);
  const nl = cut.lastIndexOf("\n");
  return { preview: (nl > 0 ? cut.slice(0, nl) : cut).replace(/\s+$/, ""), truncated: true };
}

// Structural subset of DelegateRun; kept here (not imported from
// delegate-tool.ts) to avoid a module cycle.
export interface MetaRunSource {
  runId: string;
  agent: string;
  task: string;
  status: DelegateStatus;
  startedAt?: number;
  finishedAt?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  timedOut?: string | null;
  result?: { file: string; body: string };
}

export function makeResultMeta(run: MetaRunSource): DelegateRenderMeta {
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  const meta: DelegateRenderMeta = {
    kind: "delegate",
    agent: run.agent,
    runId: run.runId,
    task: firstLine(run.task),
    status: run.status,
  };
  if (!terminal) return meta;
  if (run.startedAt != null && run.finishedAt != null && run.finishedAt >= run.startedAt) {
    meta.durationMs = run.finishedAt - run.startedAt;
  }
  if (run.exitCode !== undefined || run.exitSignal !== undefined) {
    meta.exitLabel = exitLabel(run.exitCode ?? null, run.exitSignal);
  }
  if (run.timedOut) meta.timedOut = String(run.timedOut);
  if (run.result?.file) meta.file = run.result.file;
  if (run.result?.body) {
    const p = delegatePreview(run.result.body);
    meta.preview = p.preview;
    meta.previewTruncated = p.truncated;
  }
  return meta;
}

function isRenderMeta(x: unknown): x is DelegateRenderMeta {
  if (typeof x !== "object" || x === null) return false;
  return (x as Record<string, unknown>).kind === "delegate";
}

function plainTextOf(result: { content: { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text ?? "" : "";
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

export function renderDelegateCall(
  args: { agent?: string; task?: string; resumeFrom?: string },
  theme: RenderTheme,
): Component {
  const parts: string[] = [args.resumeFrom ? "↻" : "▸"];
  if (args.agent) parts.push(theme.fg("accent", theme.bold(args.agent)));
  const taskLine = firstLine(args.task ?? "");
  if (taskLine) parts.push(theme.fg("muted", truncateToWidth(taskLine, CALL_TASK_WIDTH)));
  if (args.resumeFrom) parts.push(theme.fg("dim", `(from ${args.resumeFrom})`));
  return new Text(parts.join(" "), 0, 0);
}

export function renderDelegateResult(
  result: { content: { type: string; text?: string }[]; details?: unknown },
  options: { expanded: boolean },
  theme: RenderTheme,
  ctx: { isError: boolean },
): Component {
  const plain = plainTextOf(result);
  const meta = isRenderMeta(result.details) ? result.details : undefined;
  if (ctx.isError || !meta || !meta.status) return new Text(plain, 0, 0);

  const lines: string[] = [];
  const label = meta.agent ?? "delegate";
  switch (meta.status) {
    case "completed":
      lines.push(
        theme.fg("success", `✓ ${label}`) +
          (meta.exitLabel ? ` · ${meta.exitLabel}` : "") +
          (meta.durationMs != null ? theme.fg("muted", ` · ${fmtDuration(meta.durationMs)}`) : ""),
      );
      break;
    case "failed":
      lines.push(
        theme.fg("error", `✗ ${label} · FAILED ⚠️`) +
          (meta.exitLabel ? ` · ${meta.exitLabel}` : "") +
          (meta.timedOut ? theme.fg("warning", ` · timed out: ${truncateToWidth(meta.timedOut, PREVIEW_LINE_WIDTH)}`) : ""),
      );
      break;
    case "cancelled":
      lines.push(theme.fg("warning", `◼ ${label} · cancelled`));
      break;
    case "running":
      lines.push(theme.fg("muted", `● ${label} · running in background${meta.runId ? ` · ${meta.runId}` : ""}`));
      break;
    case "queued":
      lines.push(theme.fg("muted", `○ ${label} · queued${meta.queuedAhead ? ` (${meta.queuedAhead} ahead)` : ""}`));
      break;
  }

  const previewLines = (meta.preview ?? "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  const maxLines = options.expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
  let shown = 0;
  for (const l of previewLines) {
    if (shown >= maxLines) break;
    lines.push(theme.fg("dim", `  ${truncateToWidth(l, PREVIEW_LINE_WIDTH)}`));
    shown++;
  }
  const hidden = previewLines.length - shown;
  if (hidden > 0 && !options.expanded) lines.push(theme.fg("dim", `  … ${hidden} more line(s) — Ctrl+O expand`));

  if (meta.file) lines.push(theme.fg("muted", `⎿ ${meta.file}`));
  else if (meta.status === "running") lines.push(theme.fg("muted", "⎿ notification injected on completion"));
  else if (meta.status === "queued") lines.push(theme.fg("muted", "⎿ starts automatically when a slot frees"));

  return new Text(lines.join("\n"), 0, 0);
}
