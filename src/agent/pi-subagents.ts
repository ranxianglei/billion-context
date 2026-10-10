// #2186/#2384: acp_delegate surface for bili's pi lane, inlined from
// billion-context-pi-subagents (vendored under pi-subagents/, consumed via
// file: devDependency, tsup-bundled the same way acp-kernel is — see
// AGENTS.md "Pi-Subagents Boundary"). The package ships its own
// standalone factory (createSubagentsExtension); bili re-wires the building
// blocks instead so the surface rides bili's registration lifecycle, stays
// out of omp (no buildContextEntries), and stands down when another embedder
// (billion-context-pi, or a standalone install that claimed first) already
// owns it for this process.

import type { ExtensionAPI as PiExtensionAPI, ExtensionContext as PiExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import {
    ACP_DELEGATE_PROMPT,
    DEFAULT_DELEGATE_POLICY,
    DELEGATE_STAND_DOWN_MESSAGE,
    delegateStatusWidget,
    findPiSubagentsInstalls,
    injectSystemPromptAppendix,
    loadSubagentsUserConfig,
    makeDelegateCancelTool,
    makeDelegateTool,
    makeDelegateWaitTool,
    markDelegateResultRead,
    markDelegateRunReadByCommand,
    markEmbedded,
    openFleetInspector,
    resetDelegateUsage,
    resolveAgentDir,
    resolveDelegate,
    runningRunsSnapshot,
    setDelegateDefaults,
    setDelegateDisplayUsage,
    setDelegateNotifyIfRead,
    setDelegatePolicy,
    setDebugEnabled,
    type DelegatePolicy,
    type SubagentsAdapterConfig,
} from "billion-context-pi-subagents";
import type { ExtensionAPI, ToolDefinition } from "./pi.js";
import { loadConfigFile, type PiSubagentsFileConfig } from "../config.js";

const EMBEDDED_GLOBAL_KEY = Symbol.for("acp-delegate.embedded");

function embeddedClaimed(): boolean {
    return (globalThis as Record<symbol, unknown>)[EMBEDDED_GLOBAL_KEY] === true;
}

// Same check as the package's host.ts isPiHost: the delegate tools need Pi's
// buildContextEntries() session API. Structural on purpose — forks that
// reached this lane without the API get the same refusal as omp, not a crash.
function hasBuildContextEntries(ctx: unknown): boolean {
    const sm = (ctx as { sessionManager?: unknown } | undefined)?.sessionManager as { buildContextEntries?: unknown } | undefined;
    return typeof sm?.buildContextEntries === "function";
}

// #2230 config-home: map the `pi.subagents` section of billion-context.json
// onto the package's adapter shape. Mirrors the package's
// piSubagentsToAdapter deliberately — no shared code across the two loaders;
// the FILE FORMAT (documented in CONFIGURATION.md) is the contract. Renames:
// `prompt` replaces acp.json's delegatePrompt; `debug` is scoped to the
// sub-agent subsystem (the top-level proxy `debug` is untouched).
export function piSubagentsAdapter(section: PiSubagentsFileConfig | boolean): SubagentsAdapterConfig {
    if (section === false) return { delegate: { enabled: false } };
    if (section === true) return {};
    const { prompt, debug, ...delegate } = section;
    const adapter: SubagentsAdapterConfig = {};
    if (Object.keys(delegate).length > 0) adapter.delegate = delegate;
    if (prompt !== undefined) adapter.delegatePrompt = prompt;
    if (debug !== undefined) adapter.debug = debug;
    return adapter;
}

let warnedAcpJsonFallback = false;

export function wirePiSubagents(pi: ExtensionAPI, agent: string): void {
    // omp never gets the delegate surface: it lacks buildContextEntries, the
    // exact host gap the package's UNSUPPORTED_HOST_MESSAGE describes.
    if (agent !== "pi") return;
    // The embedded marker decides process-wide ownership of acp_delegate.
    // Whoever claims first wires it; a second embedder registering the same
    // tool names, prompt section and widgets would double-render. Cross-
    // extension factory load order is undefined, so check before claiming.
    if (embeddedClaimed()) return;
    markEmbedded();

    const piCast = pi as unknown as PiExtensionAPI;
    const state = { policy: DEFAULT_DELEGATE_POLICY as DelegatePolicy, stoodDown: false, delegatePrompt: undefined as string | null | undefined };
    let standDownWarned = false;
    let fleetCommandRegistered = false;

    // Read-tracking for completion notifications (notifyIfRead: "skip"): when
    // the model reads a delegate's result file, mark the run as read so the
    // notification is skipped if the run finishes after that read.
    pi.on("tool_result", (rawEvent) => {
        const event = rawEvent as unknown as { isError?: unknown; toolName?: unknown; input?: unknown };
        if (event.isError) return;
        if (event.toolName === "read") {
            const p = (event.input as { path?: unknown } | undefined)?.path;
            if (typeof p === "string") markDelegateResultRead(p);
        } else if (event.toolName === "bash") {
            const cmd = (event.input as { command?: unknown } | undefined)?.command;
            if (typeof cmd === "string") markDelegateRunReadByCommand(cmd);
        }
    });

    pi.on("session_start", async (_event, ctx) => {
        // /acp-fleet registers once per process (not per session): the host
        // command table is process-global.
        if (fleetCommandRegistered === false) {
            fleetCommandRegistered = true;
            pi.registerCommand?.("acp-fleet", {
                description: "Inspect acp_delegate sub-agent runs: live list + transcript overlay (TUI), text snapshot elsewhere.",
                handler: async (_args, c) => {
                    if (!state.policy.enabled) {
                        c.ui?.notify?.("acp_delegate is not enabled in this session's config.");
                        return;
                    }
                    await openFleetInspector(c as unknown as PiExtensionContext);
                },
            });
        }
        if (!hasBuildContextEntries(ctx)) return;
        const cwd = ctx.cwd ?? process.cwd();
        resetDelegateUsage();
        setDelegateDisplayUsage("separate");
        setDelegatePolicy(DEFAULT_DELEGATE_POLICY);
        state.stoodDown = false;
        try {
            // #2230 config-home: bili's own config file owns the delegate
            // config — the `pi.subagents` section of billion-context.json,
            // read through bili's loader so its validation/warning surface
            // applies. The package's acp.json loader stays as a deprecated
            // fallback for pre-move files (removal after a few releases).
            const section = loadConfigFile().pi?.subagents;
            let user: SubagentsAdapterConfig;
            if (section !== undefined) {
                user = piSubagentsAdapter(section);
            } else {
                user = await loadSubagentsUserConfig(cwd);
                if (Object.keys(user).length > 0 && !warnedAcpJsonFallback) {
                    warnedAcpJsonFallback = true;
                    console.error("bili-plugin(pi): delegate config in acp.json is deprecated — move it to the \"pi\": {\"subagents\": {…}} section of billion-context.json (delegatePrompt renames to prompt); it will be removed in a future release");
                }
            }
            if (user.debug !== undefined) setDebugEnabled(user.debug === true);
            state.policy = resolveDelegate(user);
            state.delegatePrompt = user.delegatePrompt;
            setDelegateDisplayUsage(state.policy.displayUsage);
            setDelegatePolicy(state.policy);
            setDelegateDefaults({ thinkingLevel: state.policy.thinkingLevel, agents: state.policy.agents });
            setDelegateNotifyIfRead(state.policy.notifyIfRead);
            // Third-party pi-subagents overlap guard (#415, same contract as
            // the standalone package): a PROJECT-scope install stands
            // acp_delegate down unless delegate.forceEnable opts back in; a
            // USER-scope-only install stays active (warn-only there too, but
            // silently here — bili's lane already reports overlap through its
            // own log surface).
            if (state.policy.enabled && !state.policy.forceEnable) {
                const scopes = findPiSubagentsInstalls(resolveAgentDir(), cwd);
                if (scopes.project[0] !== undefined) {
                    state.stoodDown = true;
                    if (!standDownWarned) {
                        standDownWarned = true;
                        ctx.ui?.notify?.(DELEGATE_STAND_DOWN_MESSAGE, "warning");
                    }
                }
            }
        } catch (err) {
            // Config load failure keeps the defaults — delegate stays enabled,
            // but a broken acp.json must not vanish silently (the standalone
            // package logs this via logThrow; bili's lane has no such channel).
            console.error(`bili-plugin(pi): subagents user config unreadable, using defaults: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (state.policy.enabled && !state.stoodDown) {
            // The package's ToolDefinition carries typed params + its own
            // update-callback shape; bili's registration surface is the
            // minimal structural one. Compatible at runtime (pi duck-types
            // the execute contract); the cast crosses the two static shapes.
            pi.registerTool(makeDelegateTool(piCast) as unknown as ToolDefinition);
            pi.registerTool(makeDelegateWaitTool(piCast) as unknown as ToolDefinition);
            pi.registerTool(makeDelegateCancelTool(piCast) as unknown as ToolDefinition);
            if (typeof pi.registerShortcut === "function" && state.policy.fleetShortcut !== "") {
                pi.registerShortcut(state.policy.fleetShortcut as KeyId, {
                    description: "Inspect acp_delegate runs (live list + transcript)",
                    handler: (c) => {
                        void openFleetInspector(c as unknown as PiExtensionContext);
                    },
                });
            }
        }
        delegateStatusWidget.setContext(ctx as unknown as PiExtensionContext, runningRunsSnapshot, state.policy.fleetShortcut, "billion-context");
    });

    pi.on("session_shutdown", () => {
        delegateStatusWidget.dispose();
    });

    pi.on("before_agent_start", (rawEvent) => {
        if (!state.policy.enabled || state.stoodDown) return;
        const text = state.delegatePrompt !== undefined ? state.delegatePrompt : ACP_DELEGATE_PROMPT;
        if (typeof text !== "string") return;
        return injectSystemPromptAppendix(rawEvent, text);
    });
}
