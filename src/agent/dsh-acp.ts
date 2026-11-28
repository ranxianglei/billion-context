// Native dsh (deepseek-harness) cordis plugin: registers the `/acp` command.
// Injected by the `bili dsh` launcher through a `--patch` overlay that
// inserts this module (as a file:// URL) into the loader entry tree — the
// same plugin shape as dsh-command-compact. Pure protocol client, same
// discipline as the other agent plugins: no acp-kernel import, every byte of
// displayed data comes from the proxy's HTTP endpoints.

import { proxyBaseFromEnv, fetchProxyVersion, fetchStatusLatest, forwardTool, armedIdleNotice, isTransientConnectionError, PROXY_TRANSIENT_UNREACHABLE_TEXT, withConnectionRetry } from "./shared.js";

export const name = "bili-acp";
export const inject = ["commands"];

export type CommandOutcome = { kind: "success" | "error"; text: string };

export type CommandsService = {
    register: (command: { name: string; description: string; handler: () => Promise<CommandOutcome> }) => unknown;
};

type PluginContext = { commands: CommandsService };

/** One `/acp` invocation: latest session panel, else armed-but-idle, else a
 *  reachable-proxy failure. dsh conversations carry no client-side id we can
 *  bind to, so the read asks for the most recently active session. */
async function readStatusPanel(base: string): Promise<CommandOutcome> {
    const status = await fetchStatusLatest(base);
    const panel = status?.panel;
    if (status && typeof panel === "string" && panel.length > 0) {
        return { kind: "success", text: panel };
    }
    const version = await fetchProxyVersion(base);
    if (version) {
        return { kind: "success", text: armedIdleNotice(version, base) };
    }
    return {
        kind: "error",
        text: `bili: proxy not reachable at ${base} — is the bili proxy still running?`,
    };
}

async function statusOutcome(): Promise<CommandOutcome> {
    const base = proxyBaseFromEnv();
    if (!base) {
        return {
            kind: "error",
            text: "bili: no proxy detected — launch dsh through `bili dsh` so /acp can read context status.",
        };
    }
    // #7758: a fast proxy respawn opens a ~1.4s window where the port is momentarily dead —
    // retry the read briefly, then show the friendly "temporarily unreachable" notice instead
    // of a bare `fetch failed`.
    try {
        return await withConnectionRetry(() => readStatusPanel(base));
    } catch (err) {
        if (isTransientConnectionError(err)) {
            return { kind: "error", text: PROXY_TRANSIENT_UNREACHABLE_TEXT };
        }
        throw err;
    }
}

/** One `/acp-cache` invocation (#1146): same report as the acp_cache tool.
 *  dsh conversations carry no client-side id we can bind to, so resolve the
 *  most recently active conversation from the status endpoint first, then
 *  forward the tool call. The host's command API passes no arguments, so this
 *  lane always shows the default (summary-ledger) report — no `full`. */
async function readCacheReport(base: string): Promise<CommandOutcome> {
    let status: Record<string, unknown> | undefined;
    try {
        status = await fetchStatusLatest(base);
    } catch (err) {
        // #7758: a connection error means the port is momentarily dead (fast respawn) —
        // re-throw so withConnectionRetry can retry; other errors keep the historical
        // swallow-to-undefined behavior.
        if (isTransientConnectionError(err)) throw err;
        status = undefined;
    }
    const cid = typeof status?.conversationId === "string" && status.conversationId.length > 0 ? status.conversationId : undefined;
    if (cid === undefined) {
        let version: string | undefined;
        try {
            version = await fetchProxyVersion(base);
        } catch (err) {
            if (isTransientConnectionError(err)) throw err;
            version = undefined;
        }
        if (version) {
            return { kind: "success", text: `billion-context@${version} — proxy connected via ${base}, compression armed. No model request yet; send one, then run /acp-cache again.` };
        }
        return {
            kind: "error",
            text: `bili: proxy not reachable at ${base} — is the bili proxy still running?`,
        };
    }
    try {
        const out = await forwardTool(base, cid, "acp_cache", {}, undefined, true);
        return out.failed ? { kind: "error", text: out.text } : { kind: "success", text: out.text };
    } catch (err) {
        if (isTransientConnectionError(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("no model request has arrived")) {
            return { kind: "success", text: "bili: no ACP session yet for this conversation (send a model request first, then run /acp-cache)" };
        }
        return { kind: "error", text: `bili: cache report failed: ${msg}` };
    }
}

async function cacheOutcome(): Promise<CommandOutcome> {
    const base = proxyBaseFromEnv();
    if (!base) {
        return {
            kind: "error",
            text: "bili: no proxy detected — launch dsh through `bili dsh` so /acp-cache can read the cache report.",
        };
    }
    // #7758: a fast proxy respawn opens a ~1.4s window where the port is momentarily dead —
    // retry the read briefly, then show the friendly "temporarily unreachable" notice instead
    // of a bare `fetch failed`.
    try {
        return await withConnectionRetry(() => readCacheReport(base));
    } catch (err) {
        if (isTransientConnectionError(err)) {
            return { kind: "error", text: PROXY_TRANSIENT_UNREACHABLE_TEXT };
        }
        throw err;
    }
}

export function apply(ctx: PluginContext): void {
    ctx.commands.register({
        name: "acp",
        description: "Show bili context-compression status",
        handler: statusOutcome,
    });
    ctx.commands.register({
        name: "acp-cache",
        description: "Prompt-cache reconciliation (same report as the acp_cache tool)",
        handler: cacheOutcome,
    });
}
