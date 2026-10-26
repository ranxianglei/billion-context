import { promises as fs } from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { CONFIG_DIR_NAME } from "./config-dir.js";
import { logWarn } from "./log.js";

/** Default TUI shortcut for the acp_delegate fleet inspector. Moved off
 *  "ctrl+alt+f" (also claimed by pi-subagents) to avoid a cross-extension
 *  conflict Pi's loader only warns about — last-loaded silently wins (#412). */
export const DEFAULT_FLEET_SHORTCUT = "ctrl+alt+d";

/** Per-role delegate defaults. Lets long-lived automation pin a cheaper or
 *  more capable model and a thinking level per delegate role, so the main
 *  agent doesn't have to fill them in on every `acp_delegate()` call. */
export interface DelegateRoleConfig {
  /** Default model for this role, as `"provider/id"`. Resolution priority:
   *  per-call `model` > this role default > parent agent's current model. A
   *  value that isn't a valid `"provider/id"` is ignored (treated as unset).
   *  If the configured model doesn't exist in the live registry, the child
   *  falls back to the parent model and a warning is logged — it never fails. */
  model?: string;
  /** Default thinking level for this role: one of off|minimal|low|medium|
   *  high|xhigh|max. Resolution priority: per-call `thinkingLevel` > this role
   *  default > global `delegate.thinkingLevel` > Pi's own default. An invalid
   *  value is ignored with a warning (never fails). */
  thinkingLevel?: string;
}

/** Delegate sub-agent configuration. */
export interface DelegateConfig {
  /** Enable acp_delegate tools (delegate/wait/cancel) and their system-prompt
   *  section. Default: true. Set `enabled: false` to skip registering them. */
  enabled?: boolean;
  /** Keep acp_delegate active even when a third-party subagent extension
   *  (pi-subagents) is installed. Default: false — when pi-subagents is
   *  detected at session start, acp_delegate stands down (tools, fleet
   *  shortcut and system-prompt section skipped) to avoid two overlapping
   *  sub-agent systems (#415). */
  forceEnable?: boolean;
  /** How delegate usage is reported back to the main session.
   *  "separate" (default) — delegate tokens tracked in a separate accumulator;
   *  main session totals stay clean, delegate usage shows as its own block.
   *  "merged" — delegate token usage folded into the tool-result usage field,
   *  counted as part of the main session totals. */
  displayUsage?: "merged" | "separate";
  /** Maximum acp_delegate nesting depth. Default: 2 (main → child → grandchild;
   *  the grandchild cannot delegate further). Set 1 to forbid nested delegation
   *  (orchestrator → leaf workers only). The resolved value is propagated to
   *  child processes via PI_ACP_DELEGATE_MAX_DEPTH so the cap follows the whole
   *  delegation tree, even when a child loads a different project acp.json. */
  maxDepth?: number;
  /** Hard timeout for synchronous delegates (async=false, or async auto-downgraded
   *  on one-shot hosts), in minutes. Default: 5. 0 or null disables the timeout
   *  (the run blocks until the child exits or the tool call is cancelled). */
  syncTimeoutMinutes?: number | null;
  /** Idle watchdog for async delegates: kill when no output arrives for this many
   *  minutes. Default: 5. This is the main defense against a stuck child holding
   *  its stdout fd open, so disabling it (0/null) logs a warning — use
   *  acp_delegate_cancel as the manual escape hatch. */
  idleTimeoutMinutes?: number | null;
  /** Hard time limit for async delegates, in minutes. Default: 30. 0 or null
   *  disables the limit. */
  asyncTimeoutMinutes?: number | null;
  /** Cap on how many background (async) delegate processes run at once.
   *  `1` forces strict serial execution; `N` allows up to N in parallel;
   *  omitted means unlimited (existing behavior). Extra launches are queued and
   *  start automatically as slots free. Invalid values (non-integer, <1) fall
   *  back to unlimited with a warning. Env `PI_ACP_DELEGATE_MAX_CONCURRENT`
   *  overrides this. See #294. */
  maxConcurrent?: number;
  /** Global default thinking level applied to every delegate when neither the
   *  per-call `thinkingLevel` nor the role's own `thinkingLevel` is set. One of
   *  off|minimal|low|medium|high|xhigh|max. When unset at all levels, no
   *  `--thinking` flag is passed and each child uses Pi's own default. */
  thinkingLevel?: string;
  /** Per-role defaults keyed by role name (reviewer/researcher/worker/planner/
   *  oracle, or any custom role). See DelegateRoleConfig. Only affects roles
   *  that are named here; other roles inherit the parent model + Pi defaults. */
  agents?: Record<string, DelegateRoleConfig>;
  /** What happens to the completion notification when the model has already
   *  read the delegate's result file after the run finished.
   *  "skip" (default) — the notification is not injected; the model already
   *  saw the result, so re-injecting it would only waste context.
   *  "always" — always inject the notification (previous behavior). */
  notifyIfRead?: "skip" | "always";
  /** Keybinding for the interactive TUI shortcut that opens the acp_delegate
   *  fleet inspector (live list + transcript). Default: "ctrl+alt+d". Set to
   *  "" (empty string) to disable keyboard registration entirely — the
   *  inspector stays reachable via /acp-fleet. Moved off the previous hardcoded
   *  "ctrl+alt+f" because pi-subagents also claims ctrl+alt+f, and Pi's loader
   *  only warns + last-loaded-wins on cross-extension conflicts (#412). */
  fleetShortcut?: string;
}

/** Resolved delegate policy: what actually takes effect after merging acp.json,
 *  env overrides and defaults. Timeout fields are milliseconds; null means the
 *  corresponding timeout/watchdog is disabled. */
export interface DelegatePolicy {
  enabled: boolean;
  /** Resolved delegate.forceEnable (default false): keep acp_delegate even
   *  when a third-party subagent extension (pi-subagents) is installed (#415). */
  forceEnable: boolean;
  displayUsage: "merged" | "separate";
  maxDepth: number;
  syncTimeoutMs: number | null;
  idleMs: number | null;
  asyncTimeoutMs: number | null;
  /** Resolved cap on concurrent background delegates; Infinity = unlimited. */
  maxConcurrent: number;
  /** Global default thinking level (undefined when unset). */
  thinkingLevel?: string;
  /** Per-role defaults keyed by role name (undefined when unset). */
  agents?: Record<string, DelegateRoleConfig>;
  /** Whether to suppress the completion notification when the model already
   *  read the result file after the run finished. Always resolved ("skip" default). */
  notifyIfRead: "skip" | "always";
  /** Resolved TUI shortcut for the fleet inspector ("" = registration disabled). */
  fleetShortcut: string;
}

export const DEFAULT_DELEGATE_POLICY: DelegatePolicy = {
  enabled: true,
  forceEnable: false,
  displayUsage: "separate",
  maxDepth: 2,
  syncTimeoutMs: 5 * 60_000,
  idleMs: 5 * 60_000,
  asyncTimeoutMs: 30 * 60_000,
  maxConcurrent: Infinity,
  notifyIfRead: "skip",
  fleetShortcut: DEFAULT_FLEET_SHORTCUT,
};

/** The acp.json slice this package reads. Project-level acp.json overrides
 *  global; unknown keys (including billion-context-pi's compression keys) are
 *  ignored by both packages. */
export interface SubagentsAdapterConfig {
  /** Delegate sub-agent config. Accepts a boolean shorthand (`true` →
   *  `{ enabled: true }`, `false` → `{ enabled: false }`) or a DelegateConfig
   *  object. Default: enabled. */
  delegate?: boolean | DelegateConfig;
  /** Legacy flat alias for `delegate.displayUsage`. Kept for backward
   *  compatibility with existing acp.json files. Prefer `delegate.displayUsage`. */
  displayUsage?: "merged" | "separate";
  /** Replace (string) or remove (null) the ACP_DELEGATE NOTIFICATIONS appendix
   *  injected when the delegate tool is enabled. */
  delegatePrompt?: string | null;
  /** Enable debug-level events in the shared ACP log file (~/.pi/acp.log).
   *  Same key and semantics as billion-context-pi's `debug`. */
  debug?: boolean;
}

/** Resolve delegate config from the adapter, handling the boolean shorthand
 *  and the legacy flat `displayUsage` alias. Precedence: env > acp.json >
 *  default (same convention as billion-context-pi). Invalid values fall
 *  back to the default with a logged warning — they never fail the session. */
export function resolveDelegate(adapter: SubagentsAdapterConfig): DelegatePolicy {
  const d = adapter.delegate;
  const cfg: DelegateConfig = typeof d === "object" && d !== null ? d : {};
  const enabled = typeof d === "object" && d !== null ? d.enabled !== false : d !== false;
  const displayUsage = cfg.displayUsage ?? adapter.displayUsage ?? "separate";
  const maxDepth = resolveMaxDepth(process.env.PI_ACP_DELEGATE_MAX_DEPTH ?? cfg.maxDepth);
  const syncTimeoutMs = resolveTimeoutMinutes(
    process.env.PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES ?? cfg.syncTimeoutMinutes,
    "syncTimeoutMinutes",
    DEFAULT_DELEGATE_POLICY.syncTimeoutMs!,
  );
  const idleMs = resolveTimeoutMinutes(
    process.env.PI_ACP_DELEGATE_IDLE_TIMEOUT_MINUTES ?? cfg.idleTimeoutMinutes,
    "idleTimeoutMinutes",
    DEFAULT_DELEGATE_POLICY.idleMs!,
  );
  const asyncTimeoutMs = resolveTimeoutMinutes(
    process.env.PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES ?? cfg.asyncTimeoutMinutes,
    "asyncTimeoutMinutes",
    DEFAULT_DELEGATE_POLICY.asyncTimeoutMs!,
  );
  const maxConcurrent = resolveMaxConcurrent(process.env.PI_ACP_DELEGATE_MAX_CONCURRENT, cfg.maxConcurrent);
  const forceEnable = resolveForceEnable(process.env.PI_ACP_DELEGATE_FORCE_ENABLE, cfg.forceEnable);
  if (idleMs === null) {
    logWarn("config", {
      event: "delegate-idle-watchdog-disabled",
      hint: "no-output watchdog is off; hung async runs must be cancelled manually via acp_delegate_cancel",
    });
  }
  return { enabled, forceEnable, displayUsage, maxDepth, syncTimeoutMs, idleMs, asyncTimeoutMs, maxConcurrent, thinkingLevel: cfg.thinkingLevel, agents: cfg.agents, notifyIfRead: cfg.notifyIfRead ?? "skip", fleetShortcut: resolveFleetShortcut(cfg.fleetShortcut) };
}

/** Resolve the fleet-inspector TUI shortcut: a string passes through verbatim
 *  ("" disables registration); a non-string falls back to the default with a
 *  logged warning rather than failing the session (#412). */
function resolveFleetShortcut(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== undefined) logWarn("config", { event: "delegate-config-invalid", field: "fleetShortcut", value: String(value), fallback: DEFAULT_FLEET_SHORTCUT });
  return DEFAULT_FLEET_SHORTCUT;
}

/** Resolve the force-enable override (#415): an explicit env value wins over
 *  acp.json; anything unparseable falls back to the config value with a logged
 *  warning rather than failing the session. */
function resolveForceEnable(envValue: string | undefined, cfgValue: boolean | undefined): boolean {
  if (envValue === "true") return true;
  if (envValue === "false") return false;
  if (envValue !== undefined) {
    logWarn("config", { event: "delegate-config-invalid", field: "forceEnable", value: envValue, fallback: cfgValue === true });
  }
  return cfgValue === true;
}

function resolveMaxDepth(value: number | string | undefined): number {
  if (value === undefined) return DEFAULT_DELEGATE_POLICY.maxDepth;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    logWarn("config", { event: "delegate-config-invalid", field: "maxDepth", value, fallback: DEFAULT_DELEGATE_POLICY.maxDepth });
    return DEFAULT_DELEGATE_POLICY.maxDepth;
  }
  return n;
}

function resolveTimeoutMinutes(value: number | string | null | undefined, field: string, defaultMs: number): number | null {
  if (value === undefined) return defaultMs;
  if (value === null) return null;
  const n = Number(value);
  if (n === 0) return null;
  if (!Number.isFinite(n) || n < 0) {
    logWarn("config", { event: "delegate-config-invalid", field, value, fallback: `${defaultMs / 60_000}m` });
    return defaultMs;
  }
  return n * 60_000;
}

function resolveMaxConcurrent(envValue: string | undefined, cfgValue: number | undefined): number {
  // Two-source resolution (env > acp.json > unlimited). Unlike the timeout/depth
  // fields (env ?? cfg), an INVALID env value falls through to acp.json rather
  // than to the default — preserving #294's original setDelegateMaxConcurrent
  // semantics. Invalid values warn and never fail the session.
  const sources: Array<[string, string | number | undefined]> = [
    ["PI_ACP_DELEGATE_MAX_CONCURRENT", envValue],
    ["acp.json delegate.maxConcurrent", cfgValue],
  ];
  for (const [name, raw] of sources) {
    if (raw === undefined || raw === "") continue;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (Number.isInteger(n) && n >= 1) return n;
    logWarn("config", { event: "delegate-config-invalid", field: "maxConcurrent", source: name, value: String(raw), fallback: "unlimited" });
  }
  return DEFAULT_DELEGATE_POLICY.maxConcurrent;
}

const KNOWN_KEYS = new Set(["delegate", "displayUsage", "delegatePrompt", "debug"]);

/** Read global + project acp.json (project overrides global) and pick the keys
 *  this package owns. Returns {} on any error (missing file, bad JSON) — never
 *  throws. Malformed-but-repairable files are salvaged with a loud warning
 *  instead of silently meaning "no config" (billion-context-pi #467 parity). */
export async function loadSubagentsUserConfig(cwd: string): Promise<SubagentsAdapterConfig> {
  const home = homedir();
  const merged: SubagentsAdapterConfig = {};
  for (const base of [path.join(home, CONFIG_DIR_NAME), path.join(cwd, CONFIG_DIR_NAME)]) {
    const file = path.join(base, "acp.json");
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const r = parseAcpJson(file, raw);
    if (r.status === "failed") {
      console.warn(`[bcp-subagents] ${r.reason}`);
      continue;
    }
    if (r.status === "repaired") {
      console.warn(`[bcp-subagents] ${r.reason}`);
    }
    if (r.value && typeof r.value === "object") {
      Object.assign(merged, pickKnown(r.value));
    }
  }
  return merged;
}

export interface AcpJsonParse {
  status: "ok" | "repaired" | "failed";
  value?: Record<string, unknown>;
  reason?: string;
}

/** Lenient parse of a hand-edited acp.json (billion-context-pi #467 parity):
 *  strict JSON first, then repair the common hand-edit shapes (BOM head,
 *  trailing commas, unquoted keys) with a loud warning, then give up with a
 *  diagnosed reason. */
export function parseAcpJson(file: string, raw: string): AcpJsonParse {
  const stripped = raw.replace(/^\uFEFF/, "");
  const strict = tryJson(stripped);
  if (strict.ok) return { status: "ok", value: strict.value };
  const repaired = tryJson(
    stripped
      .replace(/,(?=\s*[}\]])/g, "")
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3'),
  );
  if (repaired.ok) {
    return {
      status: "repaired",
      value: repaired.value,
      reason: `${file}: repaired non-strict JSON (BOM / unquoted keys / trailing commas) — prefer strict JSON so future config stays portable`,
    };
  }
  return { status: "failed", reason: `${file}: failed to parse (${diagnoseJsonFailure(stripped, strict.error)}) — fix the file; this acp.json is ignored` };
}

function tryJson(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: unknown } {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? { ok: true, value: v as Record<string, unknown> } : { ok: false, error: new Error("top-level value is not an object") };
  } catch (e) {
    return { ok: false, error: e };
  }
}

// Ordered heuristics: most specific common cause first, parser msg as fallback.
function diagnoseJsonFailure(raw: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) {
    return 'file starts with a BOM (byte-order mark); save it as plain UTF-8 without BOM (Windows Notepad → Save as → encoding "UTF-8", not "UTF-8 with BOM")';
  }
  if (/\,\s*[}\]]/.test(raw)) {
    return "trailing comma is not allowed in JSON (remove the last comma before } or ])";
  }
  if (/\/\/|\/\*/.test(raw)) {
    return "comments are not allowed in JSON (delete // and /* */ lines)";
  }
  if (/property name/i.test(msg)) {
    return 'object keys must be wrapped in double quotes (write "enabled": false, not enabled: false)';
  }
  if (/Unexpected token/i.test(msg)) {
    return `invalid JSON syntax (${msg})`;
  }
  return msg;
}

function pickKnown(parsed: Record<string, unknown>): SubagentsAdapterConfig {
  const out: SubagentsAdapterConfig = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (KNOWN_KEYS.has(k)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
