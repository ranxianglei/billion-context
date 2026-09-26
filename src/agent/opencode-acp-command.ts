// Shared /acp command hooks for the OpenCode 1.x plugin surface (V1 `.server()`
// hooks). Extracted from src/agent/opencode.ts so both deployments register
// the identical command: the launcher-gated plugin (BILLION_CONTEXT_PROXY set
// by `bili opencode`) and the native V1 entry (src/agent/opencode-native.ts,
// self-spawned/attached proxy whose origin resolves asynchronously).
//
// The proxy base is read through a getter because the native entry learns its
// origin only after bootstrap; the launcher variant captures the env value at
// module load and serves it verbatim.

import { wrapCacheReport } from "../acp-panel.js";
import { armedIdleNotice, fetchProxyVersion, forwardTool, noSessionWarning } from "./shared.js";

export interface OpencodeCommandConfig {
    template: string;
    description?: string;
}

export interface OpencodeConfig {
    command?: Record<string, OpencodeCommandConfig>;
    [key: string]: unknown;
}

export interface OpencodePromptPart {
    type: string;
    text: string;
    ignored?: boolean;
}

export interface OpencodeClient {
    session?: {
        prompt?: (args: {
            path: { id: string };
            body: { noReply: boolean; parts: OpencodePromptPart[] };
        }) => Promise<unknown>;
        // #1362: SDK session.get — child sessions declare their parent via
        // data.parentID (opencode mints a fresh id per persona/subagent).
        get?: (args: { path: { id: string } }) => Promise<{ data?: { id?: unknown; parentID?: unknown } } | undefined>;
    };
}

export interface OpencodeCommandInput {
    command: string;
    sessionID: string;
    arguments?: string;
}

export interface OpencodeAcpHooks {
    config?: (input: OpencodeConfig) => Promise<void>;
    "command.execute.before"?: (input: OpencodeCommandInput) => Promise<void>;
}

export async function showAcpText(ctx: { client?: OpencodeClient }, sid: string, text: string): Promise<void> {
    // Direct method call — `const p = ctx.client.session.prompt; p(...)` loses `this` (this._client) and throws.
    const session = ctx.client?.session;
    if (!session || typeof session.prompt !== "function") {
        console.error("[bili-opencode] /acp render failed: session.prompt unavailable");
        return;
    }
    try {
        await session.prompt({
            path: { id: sid },
            body: { noReply: true, parts: [{ type: "text", text, ignored: true }] },
        });
    } catch (err) {
        console.error(`[bili-opencode] /acp render failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/** The /acp + /acp-cache command hooks (registration + render). `getProxyBase`
 *  returns the proxy origin or undefined when unavailable — an undefined base
 *  renders a diagnostic instead of failing silently. The config hook ONLY
 *  registers the commands; callers layer provider rewriting on top. */
export function createAcpCommandHooks(getProxyBase: () => string | undefined, ctx: { client?: OpencodeClient }): OpencodeAcpHooks {
    return {
        config: async (opencodeConfig) => {
            opencodeConfig.command ??= {};
            opencodeConfig.command["acp"] = {
                template: "",
                description: "Show ACP status (billion-context proxy)",
            };
            // #1146: same report as the acp_cache tool; the [acp-cache] wrap at
            // render time is what lets the proxy strip it from model context
            // by content signature (src/acp-panel.ts) — do not drop it.
            opencodeConfig.command["acp-cache"] = {
                template: "",
                description: "Prompt-cache reconciliation for this session (same report as the acp_cache tool). Usage: /acp-cache [full]",
            };
        },
        "command.execute.before": async (input) => {
            if (input.command !== "acp" && input.command !== "acp-cache") return;
            const sid = input.sessionID;
            const proxyBase = getProxyBase();
            let text: string;
            if (proxyBase === undefined || proxyBase.length === 0) {
                text = input.command === "acp-cache"
                    ? "bili: no bili proxy detected — /acp-cache needs the proxy to run the cache report (launch opencode through `bili opencode` or install the native plugin)"
                    : "bili: proxy not running (native bootstrap failed) — model traffic goes direct";
            } else if (input.command === "acp-cache") {
                const toolArgs = /(^|\s)(--)?full(\s|$)/.test(input.arguments ?? "") ? { detail: "full" as const } : {};
                try {
                    const report = await forwardTool(proxyBase, sid, "acp_cache", toolArgs);
                    await showAcpText(ctx, sid, wrapCacheReport(report));
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    text = msg.includes("no model request has arrived")
                        ? "bili: no ACP session yet for this conversation (send a model request first, then run /acp-cache)"
                        : `bili: cache report failed (${msg})`;
                    await showAcpText(ctx, sid, text);
                }
                throw new Error("__BILI_ACP_HANDLED__");
            } else {
                try {
                    const res = await fetch(`${proxyBase}/__bili/plugin/status?conversationId=${encodeURIComponent(sid)}&fallback=latest`);
                    const status = (await res.json()) as { ok?: boolean; panel?: string; error?: string };
                    if (typeof status.panel === "string" && status.panel.length > 0) {
                        text = status.panel;
                    } else if (status.ok === false) {
                        // zero sessions on the proxy (fresh launch) — friendly idle notice
                        let version: string | undefined;
                        try {
                            version = await fetchProxyVersion(proxyBase);
                        } catch {
                            version = undefined;
                        }
                        text = version !== undefined ? armedIdleNotice(version) : noSessionWarning();
                    } else {
                        text = "bili: proxy returned no status panel";
                    }
                } catch (err) {
                    text = `bili: /acp failed (${err instanceof Error ? err.message : String(err)})`;
                }
            }
            await showAcpText(ctx, sid, text);
            throw new Error("__BILI_ACP_HANDLED__");
        },
    };
}
