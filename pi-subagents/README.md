# billion-context-pi-subagents

[English](./README.md) | [中文](./README.zh-CN.md)

`acp_delegate` sub-agent tools for the [Pi coding agent](https://pi.dev) — split out of [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) ([#612](https://github.com/ranxianglei/billion-context-pi/issues/612)). Hand a self-contained task to a fresh pi process running in a **clean context**; the result comes back as a file path, keeping your main session lean.

<p align="center">
<code>pi install npm:billion-context-pi-subagents</code>
</p>

## Relationship to the other packages

| Package | Role |
|---|---|
| [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) | Context compression (`compress` / `decompress` / `search_context` / `acp_status`) |
| **billion-context-pi-subagents** (this) | Sub-agent delegation (`acp_delegate*` + fleet inspector) |
| [billion-context](https://github.com/ranxianglei/billion-context) | Multi-host proxy launcher (opencode/omp/…) — no code sharing with this package; its "subagent" support tracks opencode-native task sessions only |

**billion-context-pi bundles this package.** Since the split (#612), billion-context-pi pins this package as an exact devDependency and inlines it into its dist at build time (the same mechanism it uses for acp-kernel). If you use billion-context-pi you already have `acp_delegate` — **do not install this package separately**. If both end up loaded, the standalone copy detects the bundled copy at session start and stands down automatically (no duplicate tools or prompt sections).

Install this package directly only if you want delegation **without** billion-context-pi: the delegate children then rely on Pi's native context management instead of ACP compression, and the `/acp-subagents` command is not available.

When the two run together they coexist in one Pi process: same `acp.json` convention (each reads only its own keys) and same log file (`~/.pi/acp.log`).

## Install

**billion-context-pi users: skip this — it is already bundled.** This install is only for standalone use without billion-context-pi:

```bash
pi install npm:billion-context-pi-subagents
```

No configuration needed — delegates are enabled by default. Restart Pi after installing.

> ⚠️ **v0.1.x has no auto-update.** Standalone installs must be upgraded manually (`pi install npm:billion-context-pi-subagents@latest` or re-install). The copy bundled inside billion-context-pi updates with billion-context-pi releases.

## Model-facing tools

| Tool | What it does |
|------|-------------|
| `acp_delegate` | Spawn a clean-context sub-agent for a task (review / research / implement / plan / advise) |
| `acp_delegate_wait` | Block until a delegate run finishes (returns its result; times out otherwise) |
| `acp_delegate_cancel` | Cancel a running delegate by runId |

### Roles

Five built-in roles, each with a system prompt and a **soft tool guardrail**:

| Role | Tools | Best for |
|------|-------|----------|
| `reviewer` | read, bash, grep, find, ls + ACP | Read-only code review (bugs, risks, file:line) |
| `researcher` | read, bash, grep, find, ls + ACP | Read-only codebase investigation |
| `worker` | read, edit, write, bash | Make code changes |
| `planner` | read, bash, grep, find, ls + ACP | Analyze + propose a step-by-step plan |
| `oracle` | read, bash, grep, find, ls + ACP | Answer questions / advise |

Read-only roles receive a restricted tool allowlist plus ACP context tools so they can manage their own context. This prevents accidental file modifications, but `bash` can bypass it — **it is a guardrail, not a security boundary**. Worker runs on Pi's full default toolset (any loaded extension or custom tools stay available).

### Execution model

- **Interactive (TUI) & RPC modes**: `async:true` (default) runs the child in the background; a short completion notification is injected into the chat when it finishes — **unless the model already read the result file after the run finished** (detected via the `read` tool or a bash command referencing the file), in which case the notification is skipped: the model already has the result, so re-injecting it would only waste context. Set `delegate: { notifyIfRead: "always" }` in `acp.json` to restore always-inject.
- **Print / JSON modes** (`pi -p`, SDK): `async:true` auto-downgrades to **synchronous** — the result returns as the tool result in the same turn.
- **Failures are loud, never silent.** A failed run (nonzero exit, spawn error, watchdog timeout) injects a `FAILED ⚠️` notification carrying a short error excerpt. If a notification cannot be delivered at all, a recovery notice is attached to the next delegate notification or tool result.
- **Result delivery**: the full delegate output is saved to `$TMPDIR/acp-delegate/<runId>.out`; the tool result and notification carry only the **task title + file path** (no preview) — use `read` for the details.
- **Live visibility (TUI)**: async runs show a status widget below the editor and a footer line with cumulative token/cost usage; a running row appends `⚠ no activity Nm` when the child has been silent for over 2 minutes. `/acp-fleet` (or the `ctrl+alt+d` shortcut) opens the interactive fleet inspector: live list + transcript overlay. Disabled automatically in RPC/print/JSON.
- **Compact tool blocks (TUI)**: when the host supports custom tool rendering (pi-coding-agent ≥ 0.62; borderless self-shell since 0.67.3), `acp_delegate*` calls render as compact blocks — the call line shows agent + first task line, the result line shows a status icon, exit label, duration and up to 3 preview lines of the run's output (`Ctrl+O` expands to 40). The preview is screen-only: the model-facing text is unchanged (task title + file path). Older hosts ignore the renderers and show the default tool output.
- **Resumable runs**: a run can be resumed from its saved session (`.session.jsonl` next to the result file) — earlier tool calls are restored instead of replayed.

## Configuration

Same file convention as billion-context-pi: `~/.pi/acp.json` (global) and `<project>/.pi/acp.json` (project overrides global). This package reads only the keys below; all other keys in the same file belong to other packages and are ignored here.

```json
{ "delegate": false }
```

or object form:

```json
{
  "delegate": {
    "enabled": true,
    "maxDepth": 2,
    "maxConcurrent": 3,
    "syncTimeoutMinutes": 5,
    "idleTimeoutMinutes": 5,
    "asyncTimeoutMinutes": 30,
    "thinkingLevel": "medium",
    "notifyIfRead": "skip",
    "displayUsage": "separate",
    "forceEnable": false,
    "fleetShortcut": "ctrl+alt+d",
    "agents": {
      "reviewer": { "model": "anthropic/claude-sonnet-4-5", "thinkingLevel": "high" },
      "worker":   { "model": "zhipu/glm-4.7" }
    }
  }
}
```

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `delegate` | `boolean \| object` | enabled | Master switch. `false` removes the three tools, the system-prompt section and the fleet shortcut (new session required). |
| `delegate.enabled` | boolean | `true` | Same as above, object form. |
| `delegate.forceEnable` | boolean | `false` | Keep `acp_delegate` active even when a project-scope pi-subagents install would otherwise stand it down (#415). Env `PI_ACP_DELEGATE_FORCE_ENABLE=true/false` overrides. |
| `delegate.displayUsage` | `"separate" \| "merged"` | `"separate"` | `"separate"`: delegate tokens tracked outside the main session totals (own footer block). `"merged"`: folded into the tool-result usage field. Legacy flat alias: top-level `"displayUsage"`. |
| `delegate.maxDepth` | number | `2` | Max nesting depth (main → child → grandchild). `1` = no nested delegation. Propagated to children via `PI_ACP_DELEGATE_MAX_DEPTH`. Env override: `PI_ACP_DELEGATE_MAX_DEPTH`. |
| `delegate.syncTimeoutMinutes` | number \| null | `5` | Hard timeout for synchronous delegates. `0`/`null` disables. Env: `PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES`. |
| `delegate.idleTimeoutMinutes` | number \| null | `5` | Idle watchdog for async delegates (kill when no output). `0`/`null` disables (warns — hung children must then be cancelled manually via `acp_delegate_cancel`). Env: `PI_ACP_DELEGATE_IDLE_TIMEOUT_MINUTES`. |
| `delegate.asyncTimeoutMinutes` | number \| null | `30` | Hard time limit for async delegates. `0`/`null` disables. Env: `PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES`. |
| `delegate.maxConcurrent` | number | unlimited | Cap on concurrent background delegates (`1` = strict serial; extras queue). Invalid values fall back to unlimited with a warning. Env: `PI_ACP_DELEGATE_MAX_CONCURRENT`. |
| `delegate.thinkingLevel` | string | unset | Global default thinking level (off\|minimal\|low\|medium\|high\|xhigh\|max). Priority: per-call > role > global > Pi default. |
| `delegate.agents` | object | unset | Per-role defaults: `{ "<role>": { "model": "provider/id", "thinkingLevel": "…" } }`. Invalid models fall back to the parent model with a warning (never fail). |
| `delegate.notifyIfRead` | `"skip" \| "always"` | `"skip"` | Skip the completion notification when the model already read the result file after the run finished. |
| `delegate.fleetShortcut` | string | `"ctrl+alt+d"` | TUI shortcut for the fleet inspector. `""` disables keyboard registration (`/acp-fleet` still works). Moved off `ctrl+alt+f`, which pi-subagents also claims (#412). |
| `delegatePrompt` | string \| null | built-in | Replace (string) or remove (`null`) the `ACP_DELEGATE NOTIFICATIONS` system-prompt appendix. |
| `debug` | boolean | `false` | Debug-level events in `~/.pi/acp.log` (shared with billion-context-pi). Env `ACP_DEBUG=1` too. |

Invalid values never fail the session — they warn in `~/.pi/acp.log` and fall back to defaults. Precedence: env > project acp.json > global acp.json > default.

A change to any `delegate.*` key takes effect on a **new session** (tools register at session start).

## Using your own sub-agent instead

If you also run [pi-subagents](https://github.com/nicobailon/pi-subagents) (or similar), two overlapping sub-agent systems make the model's choice noisier. Detection happens at session start:

- **Project-scope install** (`<cwd>/.pi/npm/node_modules/pi-subagents` or `<cwd>/.pi/extensions/pi-subagents`) → `acp_delegate` **stands down automatically** for that project (tools, shortcut and prompt section skipped); a reminder points at `/acp-subagents` (from billion-context-pi) so the third-party agents still get ACP compression.
- **User-scope-only install** (`~/.pi/npm`, user extensions dir) → `acp_delegate` stays active; a warning is logged instead.
- Keep both anyway: `{ "delegate": { "forceEnable": true } }`.
- Drop this package entirely: `pi remove npm:billion-context-pi-subagents`.

Pi's `--exclude-tools acp_delegate,acp_delegate_wait,acp_delegate_cancel` is **not** a substitute for `delegate: false`: it hides the tools but the model still receives the `ACP_DELEGATE NOTIFICATIONS` section describing tools it cannot call.

## Host support

Built for **Pi** (`@earendil-works/pi-coding-agent` >= 0.83). On hosts without Pi's `buildContextEntries()` session API (e.g. OMP), nothing is registered and a warning is printed once per process; Pi-compatible forks can opt in with `PI_ACP_FORK_HOST=1` (same contract as billion-context-pi's [docs/host-adapter.md](https://github.com/ranxianglei/billion-context-pi/blob/master/docs/host-adapter.md)).

## Logging

Writes to the shared ACP log `~/.pi/acp.log` (override with `ACP_LOG_FILE`), same format as billion-context-pi:

```sh
tail -f ~/.pi/acp.log                 # watch the session live
grep '\[error\]' ~/.pi/acp.log        # surface every recorded failure
```

Delegate lifecycle events (spawn/done/fail/cancel, stand-down decisions, config warnings) are always-on; `debug: true` adds verbose diagnostics.

## License

MIT.
