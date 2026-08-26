// Native dsh (deepseek-harness) cordis plugin: registers the `/acp` command.
// Injected by the `bili dsh` launcher through a `--patch` overlay that
// inserts this module (as a file:// URL) into the loader entry tree — the
// same plugin shape as dsh-command-compact. Pure protocol client, same
// discipline as the other agent plugins: no acp-kernel import, every byte of
// displayed data comes from the proxy's HTTP endpoints.

import { proxyBaseFromEnv, fetchProxyVersion, fetchStatusLatest } from "./shared.js";

export const name = "bili-acp";
export const inject = ["commands"];

type CommandOutcome = { kind: "success" | "error"; text: string };

type CommandsService = {
    register: (command: { name: string; description: string; handler: () => Promise<CommandOutcome> }) => unknown;
};

type PluginContext = { commands: CommandsService };

/** One `/acp` invocation: latest session panel, else armed-but-idle, else a
 *  reachable-proxy failure. dsh conversations carry no client-side id we can
 *  bind to, so the read asks for the most recently active session. */
async function statusOutcome(): Promise<CommandOutcome> {
    const base = proxyBaseFromEnv();
    if (!base) {
        return {
            kind: "error",
            text: "bili: no proxy detected — launch dsh through `bili dsh` so /acp can read context status.",
        };
    }
    const status = await fetchStatusLatest(base).catch(() => undefined);
    const panel = status?.panel;
    if (status && typeof panel === "string" && panel.length > 0) {
        return { kind: "success", text: panel };
    }
    const version = await fetchProxyVersion(base).catch(() => undefined);
    if (version) {
        return {
            kind: "success",
            text: `billion-context@${version} — proxy connected, compression armed. No model request seen yet; send one, then run /acp again.`,
        };
    }
    return {
        kind: "error",
        text: `bili: proxy not reachable at ${base} — is the bili proxy still running?`,
    };
}

export function apply(ctx: PluginContext): void {
    ctx.commands.register({
        name: "acp",
        description: "Show bili context-compression status",
        handler: statusOutcome,
    });
}
