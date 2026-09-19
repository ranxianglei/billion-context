// Shared /acp command hooks for the OpenCode 1.x plugin surface (V1 `.server()`
// hooks). Extracted from src/agent/opencode.ts so both deployments register
// the identical command: the launcher-gated plugin (BILLION_CONTEXT_PROXY set
// by `bili opencode`) and the native V1 entry (src/agent/opencode-native.ts,
// self-spawned/attached proxy whose origin resolves asynchronously).
//
// The proxy base is read through a getter because the native entry learns its
// origin only after bootstrap; the launcher variant captures the env value at
// module load and serves it verbatim.

import { armedIdleNotice, fetchProxyVersion, noSessionWarning } from "./shared.js";

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

/** The /acp command hooks (registration + render). `getProxyBase` returns the
 *  proxy origin or undefined when unavailable — an undefined base renders a
 *  diagnostic instead of failing silently. The config hook ONLY registers the
 *  command; callers layer provider rewriting on top. */
export function createAcpCommandHooks(getProxyBase: () => string | undefined, ctx: { client?: OpencodeClient }): OpencodeAcpHooks {
    return {
        config: async (opencodeConfig) => {
            opencodeConfig.command ??= {};
            opencodeConfig.command["acp"] = {
                template: "",
                description: "Show ACP status (billion-context proxy)",
            };
        },
        "command.execute.before": async (input) => {
            if (input.command !== "acp") return;
            const sid = input.sessionID;
            const proxyBase = getProxyBase();
            let text: string;
            if (proxyBase === undefined || proxyBase.length === 0) {
                text = "bili: proxy not running (native bootstrap failed) — model traffic goes direct";
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
