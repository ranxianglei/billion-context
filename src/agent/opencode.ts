// Thin opencode plugin for the billion-context proxy (`bili opencode`).
//
// Activates ONLY when BILLION_CONTEXT_PROXY is set (the launcher sets it);
// otherwise it is a no-op so shipping it inside the package is harmless.
// Mirrors the pi/omp plugin (src/agent/pi.ts):
//   - registers the /acp command (config hook + command.execute.before)
//   - binds the opencode session id to the proxy session via the
//     pending-register queue (POST /__bili/plugin/register on session.created)
//   - renders the proxy's buildStatusPanel via an ignored chat message

import { fetchProxyVersion } from "./shared.js";

interface OpencodeCommandConfig {
    template: string;
    description?: string;
}

interface OpencodeConfig {
    command?: Record<string, OpencodeCommandConfig>;
    [key: string]: unknown;
}

interface OpencodeSessionInfo {
    id?: unknown;
}

interface OpencodeEvent {
    type?: string;
    properties?: { info?: OpencodeSessionInfo; [key: string]: unknown };
}

interface OpencodeEventInput {
    event?: OpencodeEvent;
}

interface OpencodeCommandInput {
    command: string;
    sessionID: string;
    arguments?: string;
}

interface OpencodePromptPart {
    type: string;
    text: string;
    ignored?: boolean;
}

interface OpencodeClient {
    session?: {
        prompt?: (args: {
            path: { id: string };
            body: { noReply: boolean; parts: OpencodePromptPart[] };
        }) => Promise<unknown>;
    };
}

interface OpencodePluginContext {
    client?: OpencodeClient;
}

interface OpencodeHooks {
    config?: (input: OpencodeConfig) => Promise<void>;
    event?: (input: OpencodeEventInput) => Promise<void>;
    "command.execute.before"?: (input: OpencodeCommandInput, output: { parts: unknown[] }) => Promise<void>;
}

const proxyBase = process.env.BILLION_CONTEXT_PROXY ?? "";

async function showText(ctx: OpencodePluginContext, sid: string, text: string): Promise<void> {
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

const server = async (ctx: OpencodePluginContext): Promise<OpencodeHooks> => {
    if (!proxyBase) return {};
    console.log("[bili-opencode] plugin active (proxy " + proxyBase + ")");
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
            let text: string;
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
                    text = version !== undefined
                        ? `billion-context@${version} — proxy connected, no ACP session yet. Send a model request, then run /acp again.`
                        : "bili: no ACP session yet (send a model request first, then run /acp)";
                } else {
                    text = "bili: proxy returned no status panel";
                }
            } catch (err) {
                text = `bili: /acp failed (${err instanceof Error ? err.message : String(err)})`;
            }
            await showText(ctx, sid, text);
            throw new Error("__BILI_ACP_HANDLED__");
        },
    };
};

export default server;
