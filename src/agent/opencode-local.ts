// No-launcher OpenCode deployment (#809): `plugins: ["billion-context"]` in
// opencode.jsonc, resolved via package.json exports["./server"]. Unlike the
// launcher entry this one OWNS its proxy: on first need it spawns a loopback
// bili and rewrites provider requests to `/bili/<url>`. Inert when the launcher
// already owns the proxy (BILLION_CONTEXT_PROXY set) or the kill switch is on.
// Loopback-only by construction — the host is hardcoded to 127.0.0.1 so the
// spawned proxy can never be reached off-machine.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findNodeRuntime, probeProxy } from "./shared.js";
import { createOpencodeV2Setup, isProtocolSupported, pluginDisabled, type EnsureProxyResult, type V2PluginContext } from "./opencode-v2.js";

export const DEFAULT_LOCAL_PORT = 18787;
const SPAWN_POLL_ATTEMPTS = 25;
const SPAWN_POLL_INTERVAL_MS = 200;

interface LocalOptionsResult {
    proxyBase: string;
    warnings: string[];
}

export function parseLocalOptions(raw: unknown): LocalOptionsResult {
    const warnings: string[] = [];
    let port = DEFAULT_LOCAL_PORT;
    if (raw && typeof raw === "object") {
        const value = (raw as Record<string, unknown>).port;
        if (value !== undefined) {
            const num = typeof value === "number" ? value : (/^\d+$/.test(String(value)) ? Number.parseInt(String(value), 10) : NaN);
            if (Number.isInteger(num) && num >= 1 && num <= 65535) {
                port = num;
            } else {
                warnings.push(`billion-context: invalid plugin option "port" (${JSON.stringify(value)}) — using default ${DEFAULT_LOCAL_PORT}`);
            }
        }
    }
    return { proxyBase: `http://127.0.0.1:${port}`, warnings };
}

export function rewriteToBili(url: string, proxyBase: string): string | undefined {
    const prefix = `${proxyBase}/bili/`;
    if (url.startsWith(prefix)) return url;
    if (/^https?:\/\//i.test(url)) return `${prefix}${url}`;
    return undefined;
}

export function resolvePackageRoot(): string {
    // Built layout: <root>/dist/agent/opencode-local.js → two levels up is <root>.
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function buildSpawnArgs(packageRoot: string, port: number): string[] {
    // --no-auto-update is MANDATORY here: the npm cache strips .git, so the
    // git-checkout guard in update.ts (#580) never fires and a self-updating
    // proxy would race the host mid-request. --host pins loopback explicitly.
    return [path.join(packageRoot, "dist", "index.js"), "start", "--port", String(port), "--host", "127.0.0.1", "--no-auto-update"];
}

function portOf(proxyBase: string): number {
    try {
        const p = new URL(proxyBase).port;
        return p !== "" ? Number(p) : DEFAULT_LOCAL_PORT;
    } catch {
        return DEFAULT_LOCAL_PORT;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

interface EnsureProxyDeps {
    spawn?: typeof spawn;
    packageRoot?: () => string;
}

export async function ensureProxyLoopback(base: string, deps: EnsureProxyDeps = {}): Promise<EnsureProxyResult> {
    const spawnFn = deps.spawn ?? spawn;
    const first = await probeProxy(base);
    if (first.connected && first.identityOk) {
        return { connected: true, identityOk: true, protocolSupported: isProtocolSupported(first.protocolVersion), version: first.version };
    }
    if (first.connected) {
        console.error(`[bili-opencode-local] ${base} answered but is not a billion-context proxy — refusing to adopt a foreign service, running inert`);
        return { connected: false, identityOk: false };
    }
    const packageRoot = deps.packageRoot ? deps.packageRoot() : resolvePackageRoot();
    const indexJs = path.join(packageRoot, "dist", "index.js");
    if (!existsSync(indexJs)) {
        console.error(`[bili-opencode-local] cannot start proxy: missing ${indexJs} — running inert`);
        return { connected: false, identityOk: false };
    }
    const node = findNodeRuntime();
    if (!node) {
        console.error("[bili-opencode-local] no Node runtime found (process.execPath is not node and 'node' is not on PATH; set BILLION_CONTEXT_NODE to override) — cannot start proxy, running inert");
        return { connected: false, identityOk: false };
    }
    try {
        const child = spawnFn(node, buildSpawnArgs(packageRoot, portOf(base)), { detached: true, stdio: "ignore", cwd: packageRoot });
        // spawn() reports ENOENT/EACCES ASYNCHRONOUSLY via 'error'; an unhandled
        // 'error' event throws and takes down the host process. Observe it so a
        // bad runtime degrades to inert (the poll below already times out).
        child.on?.("error", (err) => {
            console.error(`[bili-opencode-local] proxy child error: ${err instanceof Error ? err.message : String(err)} — running inert`);
        });
        child.unref?.();
    } catch (err) {
        console.error(`[bili-opencode-local] spawn failed: ${err instanceof Error ? err.message : String(err)} — running inert`);
        return { connected: false, identityOk: false };
    }
    for (let i = 0; i < SPAWN_POLL_ATTEMPTS; i++) {
        await sleep(SPAWN_POLL_INTERVAL_MS);
        const probe = await probeProxy(base);
        if (probe.connected && probe.identityOk) {
            return { connected: true, identityOk: true, protocolSupported: isProtocolSupported(probe.protocolVersion), version: probe.version };
        }
    }
    console.error(`[bili-opencode-local] proxy did not come up at ${base} within timeout — running inert`);
    return { connected: false, identityOk: false };
}

const plugin = {
    id: "billion-context-opencode-local",
    setup: async (ctx: V2PluginContext, maybeOptions?: unknown): Promise<() => void> => {
        const rawOptions = (ctx as { options?: unknown }).options ?? maybeOptions;
        const parsed = parseLocalOptions(rawOptions);
        for (const warning of parsed.warnings) console.warn(warning);
        return createOpencodeV2Setup({
            active: () => !process.env.BILLION_CONTEXT_PROXY && !pluginDisabled(),
            resolveInitialProxyBase: () => parsed.proxyBase,
            ensureProxy: ensureProxyLoopback,
            rewriteRequestUrl: rewriteToBili,
        })(ctx);
    },
};

export default plugin;
