import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import {
  makeDelegateTool,
  makeDelegateWaitTool,
  makeDelegateCancelTool,
  runningRunsSnapshot,
  resetDelegateUsage,
  setDelegateDisplayUsage,
  setDelegatePolicy,
  setDelegateDefaults,
  setDelegateNotifyIfRead,
  markDelegateResultRead,
  markDelegateRunReadByCommand,
} from "./delegate-tool.js";
import {
  DEFAULT_DELEGATE_POLICY,
  loadSubagentsUserConfig,
  resolveDelegate,
  type DelegatePolicy,
  type SubagentsAdapterConfig,
} from "./config.js";
import { ACP_DELEGATE_PROMPT } from "./system-prompt.js";
import { delegateStatusWidget } from "./fleet-widget.js";
import { openFleetInspector } from "./fleet-inspector.js";
import { findPiSubagentsInstalls, resolveAgentDir, DELEGATE_STAND_DOWN_MESSAGE } from "./pi-subagents-detect.js";
import { closeLogStream, logInfo, logThrow, logWarn, setDebugEnabled } from "./log.js";
import { injectSystemPromptAppendix } from "./compat.js";
import { isDeclaredForkHost, isPiHost } from "./host.js";

declare const CURRENT_VERSION: string;

const UNSUPPORTED_HOST_MESSAGE = [
  "[billion-context-pi-subagents] unsupported host: acp_delegate requires Pi's buildContextEntries() session API.",
  "Tools are not registered for this session. Pi-compatible forks can opt in with PI_ACP_FORK_HOST=1.",
].join("\n");

const EMBEDDED_GLOBAL_KEY = Symbol.for("acp-delegate.embedded");

/** billion-context-pi inlines this package (exact devDependency, tsup-bundled)
 *  and re-wires acp_delegate itself with its pre-split wiring shape. It calls
 *  markEmbedded() at factory init so a separately installed copy of this
 *  extension stands down instead of double-registering tools, shortcuts,
 *  commands or prompt sections. */
export function markEmbedded(): void {
  (globalThis as Record<symbol, unknown>)[EMBEDDED_GLOBAL_KEY] = true;
}

/** Whether THIS process already has an acp_delegate owner (an embedder that
 *  called markEmbedded(), e.g. billion-context-pi or billion-context's pi
 *  lane). Exported so embedders can implement check-before-claim: whoever
 *  wires the delegate surface first owns it process-wide, and a second
 *  embedder must stand down instead of double-registering tools, prompt
 *  sections and widgets. */
export function isEmbedded(): boolean {
  return (globalThis as Record<symbol, unknown>)[EMBEDDED_GLOBAL_KEY] === true;
}

export function createSubagentsExtension(inline?: SubagentsAdapterConfig): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const state = {
      policy: DEFAULT_DELEGATE_POLICY as DelegatePolicy,
      stoodDown: false,
      delegatePrompt: inline?.delegatePrompt,
    };
    let standDownWarned = false;
    let unsupportedWarned = false;
    let fleetCommandRegistered = false;

    // Read-tracking for completion notifications (notifyIfRead: "skip"): when
    // the model reads a delegate's result file, mark the run as read so the
    // notification is skipped if the run finishes after that read. Registered
    // once per process; nested delegate child processes track their own runs.
    pi.on("tool_result", (event) => {
      if (isEmbedded()) return;
      if (event.isError) return;
      if (event.toolName === "read") {
        const p = (event.input as { path?: unknown }).path;
        if (typeof p === "string") markDelegateResultRead(p);
      } else if (event.toolName === "bash") {
        const cmd = (event.input as { command?: unknown }).command;
        if (typeof cmd === "string") markDelegateRunReadByCommand(cmd);
      }
    });

    pi.on("session_start", async (_event, ctx) => {
      const sid = ctx.sessionManager.getSessionId();
      const cwd = ctx.cwd ?? process.cwd();
      // Embedded mode: billion-context-pi inlined this package and owns the
      // whole acp_delegate surface itself - do nothing here. Checked at event
      // time because cross-package factory load order is undefined, but all
      // factories run before any session_start.
      if (isEmbedded()) {
        logInfo("delegate", { event: "stand-down-embedded", sid });
        return;
      }
      // /acp-fleet registers here (not at factory time) for the same reason:
      // an embedded host registers its own copy, so the standalone one must
      // wait until the marker state is final.
      if (!fleetCommandRegistered) {
        fleetCommandRegistered = true;
        pi.registerCommand("acp-fleet", {
          description: "Inspect acp_delegate sub-agent runs: live list + transcript overlay (TUI), text snapshot elsewhere.",
          handler: async (_args, c) => {
            if (!state.policy.enabled) {
              c.ui.notify("acp_delegate is not enabled in this session's config.");
              return;
            }
            await openFleetInspector(c);
          },
        });
      }
      if (!isPiHost(ctx.sessionManager) && !isDeclaredForkHost()) {
        if (!unsupportedWarned) {
          unsupportedWarned = true;
          logWarn("host", { event: "host-unsupported", sid, action: "not-registered" });
          if (ctx.hasUI) ctx.ui.notify(UNSUPPORTED_HOST_MESSAGE, "warning");
          else console.error(UNSUPPORTED_HOST_MESSAGE);
        }
        return;
      }
      resetDelegateUsage();
      setDelegateDisplayUsage("separate");
      setDelegatePolicy(DEFAULT_DELEGATE_POLICY);
      state.stoodDown = false;
      try {
        const user = await loadSubagentsUserConfig(cwd);
        if (user.debug !== undefined) setDebugEnabled(user.debug === true);
        const adapter: SubagentsAdapterConfig = { ...inline, ...user };
        state.policy = resolveDelegate(adapter);
        state.delegatePrompt = user.delegatePrompt !== undefined ? user.delegatePrompt : inline?.delegatePrompt;
        setDelegateDisplayUsage(state.policy.displayUsage);
        setDelegatePolicy(state.policy);
        setDelegateDefaults({ thinkingLevel: state.policy.thinkingLevel, agents: state.policy.agents });
        setDelegateNotifyIfRead(state.policy.notifyIfRead);
        // Third-party subagent overlap guard (#415): a PROJECT-scope pi-subagents
        // install stands acp_delegate down unless delegate.forceEnable opts back
        // in; a USER-scope-only install logs a warning and stays active, so a
        // global install can't silently disable it in every project.
        if (state.policy.enabled && !state.policy.forceEnable) {
          const scopes = findPiSubagentsInstalls(resolveAgentDir(), cwd);
          if (scopes.project[0] !== undefined) {
            state.stoodDown = true;
            logWarn("delegate", { event: "delegate-auto-disabled", sid, install: scopes.project[0], scope: "project", hint: "run /acp-subagents (billion-context-pi) to give its agents ACP compression tools; delegate.forceEnable=true keeps acp_delegate" });
            if (!standDownWarned) {
              standDownWarned = true;
              if (ctx.hasUI) ctx.ui.notify(DELEGATE_STAND_DOWN_MESSAGE, "warning");
              else console.error(DELEGATE_STAND_DOWN_MESSAGE);
            }
          } else if (scopes.user[0] !== undefined) {
            logWarn("delegate", { event: "delegate-user-scope-detected", sid, install: scopes.user[0], action: "warn-only" });
          }
        }
      } catch (e) {
        logThrow("config", e, { sid, phase: "session_start" });
      }
      if (state.policy.enabled && !state.stoodDown) {
        pi.registerTool(makeDelegateTool(pi));
        pi.registerTool(makeDelegateWaitTool(pi));
        pi.registerTool(makeDelegateCancelTool(pi));
        // Not every host implements the full ExtensionAPI surface (older pi,
        // embedded hosts) — shortcuts are a TUI nicety, never load-bearing.
        if (typeof pi.registerShortcut === "function" && state.policy.fleetShortcut !== "") {
          pi.registerShortcut(state.policy.fleetShortcut as KeyId, {
            description: "Inspect acp_delegate runs (live list + transcript)",
            handler: (c) => { void openFleetInspector(c); },
          });
        }
      }
      delegateStatusWidget.setContext(ctx, runningRunsSnapshot, state.policy.fleetShortcut);
      const modelInfo = ctx.model as { id?: string } | undefined;
      logInfo("delegate", { event: "start", sid, cwd, version: typeof CURRENT_VERSION !== "undefined" ? CURRENT_VERSION : null, model: modelInfo?.id ?? null, enabled: state.policy.enabled, stoodDown: state.stoodDown });
    });

    pi.on("session_shutdown", () => {
      delegateStatusWidget.dispose();
      closeLogStream();
    });

    pi.on("before_agent_start", (event) => {
      if (isEmbedded()) return;
      if (!state.policy.enabled || state.stoodDown) return;
      const text = state.delegatePrompt !== undefined ? state.delegatePrompt : ACP_DELEGATE_PROMPT;
      if (text === null) return;
      return injectSystemPromptAppendix(event, text);
    });
  };
}

// Embedding surface: billion-context-pi inlines this package (exact
// devDependency, tsup-bundled) and re-wires acp_delegate with its pre-split
// wiring shape by importing these building blocks instead of invoking the
// standalone factory above. Keep this list in sync with billion-context-pi's
// imports from this package.
export {
  makeDelegateTool,
  makeDelegateWaitTool,
  makeDelegateCancelTool,
  runningRunsSnapshot,
  resetDelegateUsage,
  getDelegateUsage,
  setDelegateDisplayUsage,
  setDelegatePolicy,
  setDelegateDefaults,
  setDelegateNotifyIfRead,
  markDelegateResultRead,
  markDelegateRunReadByCommand,
  type RunStatus,
  type FleetRunView,
} from "./delegate-tool.js";
export {
  resolveDelegate,
  DEFAULT_DELEGATE_POLICY,
  DEFAULT_FLEET_SHORTCUT,
  loadSubagentsUserConfig,
  type DelegateRoleConfig,
  type DelegateConfig,
  type DelegatePolicy,
  type SubagentsAdapterConfig,
} from "./config.js";
export { ACP_DELEGATE_PROMPT } from "./system-prompt.js";
export { injectSystemPromptAppendix } from "./compat.js";
export { delegateStatusWidget } from "./fleet-widget.js";
export { openFleetInspector } from "./fleet-inspector.js";
export { findPiSubagentsInstalls, resolveAgentDir, DELEGATE_STAND_DOWN_MESSAGE, type PiSubagentsScopes } from "./pi-subagents-detect.js";
export { setDebugEnabled } from "./log.js";

export default createSubagentsExtension();
