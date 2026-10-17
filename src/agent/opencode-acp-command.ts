// Shared /acp command hooks for the OpenCode 1.x plugin surface (V1 `.server()`
// hooks). Extracted from src/agent/opencode.ts so both deployments register
// the identical command: the launcher-gated plugin (BILLION_CONTEXT_PROXY set
// by `bili opencode`) and the native V1 entry (src/agent/opencode-native.ts,
// self-spawned/attached proxy whose origin resolves asynchronously).
//
// The proxy base is read through a getter because the native entry learns its
// origin only after bootstrap; the launcher variant captures the env value at
// module load and serves it verbatim.

import { wrapCacheReport, wrapRuleReport } from "../acp-panel.js";
import { armedIdleNotice, fetchProxyVersion, fetchStaleNotice, forwardTool, noSessionWarning } from "./shared.js";

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

// /acp-rule handler (parity with the pi lane, src/agent/pi.ts): argument
// semantics are byte-identical to pi — record by passing text, remove one via
// `remove <id>`, wipe all via bare `clear`. The report renders wrapped so the
// proxy strips it from model context by content signature (src/acp-panel.ts);
// diagnostics render unwrapped, like /acp-cache.
async function runAcpRule(ctx: { client?: OpencodeClient }, proxyBase: string | undefined, sid: string, argsText: string): Promise<void> {
    if (proxyBase === undefined || proxyBase.length === 0) {
        await showAcpText(ctx, sid, "bili: no bili proxy detected — /acp-rule needs the proxy to run the rule ops (launch opencode through `bili opencode` or install the native plugin)");
        return;
    }
    const raw = argsText.trim();
    let toolArgs: Record<string, unknown>;
    if (raw === "") {
        toolArgs = {};
    } else if (raw === "clear") {
        toolArgs = { clear: true };
    } else if (raw === "remove" || raw.startsWith("remove ")) {
        const id = raw.slice("remove".length).trim();
        if (id === "") {
            await showAcpText(ctx, sid, "Usage: /acp-rule remove <rule-id> — bare /acp-rule lists the recorded ids");
            return;
        }
        toolArgs = { delete: id };
    } else {
        toolArgs = { rule: raw };
    }
    try {
        const report = await forwardTool(proxyBase, sid, "acp_rule", toolArgs, undefined, true);
        if (report.failed) {
            await showAcpText(ctx, sid, `bili: acp_rule failed: ${report.text}`);
            return;
        }
        if (report.text.startsWith("acp_rule is not enabled")) {
            // #1192 note channel — surface the enablement hint instead of echoing
            // the model-facing note into the transcript.
            await showAcpText(ctx, sid, "bili: acp_rule is not enabled on this bili proxy — set compress.rules.enabled: true in your bili config");
        } else {
            await showAcpText(ctx, sid, wrapRuleReport(report.text));
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const text = msg.includes("no model request has arrived")
            ? "bili: no ACP session yet for this conversation (send a model request first, then run /acp-rule)"
            : `bili: acp_rule failed (${msg})`;
        await showAcpText(ctx, sid, text);
    }
}

/** The /acp + /acp-cache + /acp-rule command hooks (registration + render). `getProxyBase`
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
            // #3594 parity with the pi lane (src/agent/pi.ts): same ops as the
            // acp_rule tool. Description string kept byte-identical across lanes.
            opencodeConfig.command["acp-rule"] = {
                template: "",
                description: "Persistent rules for this session (same ops as the acp_rule tool). Usage: /acp-rule [text to record] | /acp-rule remove <id> | /acp-rule clear",
            };
        },
        "command.execute.before": async (input) => {
            if (input.command === "acp-rule") {
                await runAcpRule(ctx, getProxyBase(), input.sessionID, input.arguments ?? "");
                throw new Error("__BILI_ACP_HANDLED__");
            }
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
                    const report = await forwardTool(proxyBase, sid, "acp_cache", toolArgs, undefined, true);
                    await showAcpText(ctx, sid, wrapCacheReport(report.text));
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
                const staleNotice = await fetchStaleNotice(proxyBase).catch(() => undefined);
                if (staleNotice !== undefined) text += `\n\n${staleNotice}`;
            }
            await showAcpText(ctx, sid, text);
            throw new Error("__BILI_ACP_HANDLED__");
        },
    };
}
