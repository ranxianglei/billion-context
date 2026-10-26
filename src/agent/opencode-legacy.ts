// opencode-acp absorption for LEGACY V1 sessions (#920).
//
// Users migrating from the standalone `opencode-acp` extension (DCP protocol,
// its own ref space + block store) to `bili plugin install opencode` still
// need their OLD sessions to work: those sessions' history is annotated with
// `<dcp-message-id>` tags and their refs live in acp's store — bili's kernel
// cannot serve them. Routing requirement: legacy sessions keep running
// through opencode-acp, new sessions go through bili.
//
// Probed facts (opencode-acp 1.18.x, ~/projects/opencode-acp):
//   - package exports ONLY `default server` (index.ts); `server(ctx)` returns
//     `{}` immediately when BILLION_CONTEXT_PROXY is set — the env is checked
//     ONLY there (index.ts:38); executors never re-check it, so calling
//     `server(ctx)` with the env temporarily unset yields the armed hooks.
//   - its `config` hook self-disables the whole plugin when any provider
//     baseURL contains `/bili/` (findBiliProxyProviders) AND denies the tools
//     via permission.deny — so we call it with `provider` hidden and merge
//     back only the keys it legitimately owns (permission / command /
//     experimental.primary_tools / agent snapshot side effects).
//   - adoption of NEW sessions happens in messages.transform via
//     registry.getOrCreate(lastUserMessage.info.sessionID) — gating that hook
//     (and system.transform / text.complete) on legacy state keeps new
//     sessions out of acp's registry entirely.
//   - legacy session marker: acp's persisted state file at
//     `<XDG_DATA_HOME|~/.local/share>/opencode/storage/plugin/acp/<sid>.json`
//     (getDefaultStorageDir, lib/state/persistence.ts:67). config storagePath
//     overrides are NOT probed (documented limitation).
//   - tool args are kernel-compatible: compress `content:
//     [{topic,startId,endId,summary}]` is the kernel's accepted object form
//     (verified: parseCompressArgs maps startId/endId → ranges[].startRef/
//     endRef), decompress/search_context/acp_status args match the kernel
//     shapes — so NEW-session calls can be forwarded to the proxy verbatim
//     with zero translation. `acp_context_recap` has no proxy counterpart
//     (rejected by /__bili/plugin/tool) — legacy-only, documented.
//   - the v1 host loads tool defs from the hooks table statically; ONE def
//     per name process-wide. The slots therefore carry acp's DCP schemas for
//     everyone, and the WRAPPED executors route per session: legacy → acp
//     executor, new → forwardTool to the proxy (plugin-mode carrier).
//
// Degradation: package not found / import fails / unexpected shape → the
// caller falls back to bili's own V1 tools (current behavior); legacy
// sessions then degrade as documented (read-only archives).

import { accessSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface LegacyAcpToolDef {
    description?: unknown;
    args?: unknown;
    execute?: (args: Record<string, unknown>, ctx: { sessionID: string; messageID?: string }) => Promise<unknown>;
}

export interface LegacyAcpModule {
    /** acp's full hooks table (config/tool/hooks keys as returned by server()). */
    hooks: Record<string, unknown>;
    /** hooks.tool — the DCP tool slots (compress/decompress/search_context/acp_status/acp_context_recap). */
    tools: Record<string, LegacyAcpToolDef>;
    /** hooks.config — must be called with `provider` hidden (self-disable neutered). */
    configHook: ((cfg: Record<string, unknown>) => Promise<void>) | undefined;
    /** hooks["command.execute.before"] — /acp + /dcp handler for legacy sessions. */
    commandHook: ((input: { command: string; sessionID: string; arguments?: string }, output?: { parts?: unknown[] }) => Promise<void>) | undefined;
    /** resolved dist/index.js path (for logs). */
    source: string;
}

/** Candidate `opencode-acp/dist/index.js` paths, most specific first:
 *  the launcher's `BILI_OPENCODE_ACP_SPEC` hint when its cache slot exists
 *  (#920 launcher path — the launcher knows exactly which entry it stripped
 *  from the temp config), then project plugin scope, plain project
 *  node_modules, opencode's v1 package cache (`opencode plugin opencode-acp`
 *  — global AND project installs land in
 *  `~/.cache/opencode/packages/opencode-acp@<ver>/node_modules`; every
 *  version present is offered, newest first), global user npm root, and
 *  opencode's config-scope node_modules. */
function legacyAcpCandidates(cwd: string | undefined): string[] {
    const dirs: string[] = [];
    if (cwd !== undefined && cwd.length > 0) {
        dirs.push(path.join(cwd, ".opencode", "node_modules"));
        dirs.push(path.join(cwd, "node_modules"));
    }
    const out: string[] = [];
    const pushDir = (d: string): void => {
        out.push(path.join(d, "opencode-acp", "dist", "index.js"));
    };
    for (const d of dirs) pushDir(d);
    const cacheHome = process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache");
    const packages = path.join(cacheHome, "opencode", "packages");
    const spec = process.env.BILI_OPENCODE_ACP_SPEC;
    if (spec !== undefined && spec.length > 0) {
        // the spec is the package-cache slot name ("opencode-acp@1.18.1");
        // authoritative when present — avoid guessing among cache versions.
        const hinted = path.join(packages, spec, "node_modules", "opencode-acp", "dist", "index.js");
        try {
            accessSync(hinted);
            out.unshift(hinted);
        } catch {
            // hint does not resolve — fall through to discovery
        }
    }
    try {
        const versions = readdirSync(packages)
            .filter((e) => e.startsWith("opencode-acp@"))
            .sort()
            .reverse();
        for (const v of versions) {
            pushDir(path.join(packages, v, "node_modules"));
        }
    } catch {
        // no package cache
    }
    pushDir(path.join(homedir(), ".local", "lib", "node_modules"));
    pushDir(path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "opencode", "node_modules"));
    return out;
}

/** acp's default persisted-state location for a session id. */
export function legacyAcpStatePath(sessionId: string): string {
    const dataHome = process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share");
    return path.join(dataHome, "opencode", "storage", "plugin", "acp", `${sessionId}.json`);
}

/** A session is legacy iff acp has a state file for it. Ids are sanitized
 *  (no separators, bounded length) before touching the filesystem. */
export function isLegacyAcpSession(sessionId: string | undefined): boolean {
    if (sessionId === undefined || sessionId.length === 0 || sessionId.length > 200) return false;
    if (/[/\\\s]/.test(sessionId)) return false;
    try {
        return existsSync(legacyAcpStatePath(sessionId));
    } catch {
        return false;
    }
}

export async function loadLegacyAcp(ctx: { directory?: string; client?: unknown }, log: (msg: string) => void = () => {}): Promise<LegacyAcpModule | undefined> {
    let found: string | undefined;
    for (const p of legacyAcpCandidates(ctx.directory)) {
        if (existsSync(p)) {
            found = p;
            break;
        }
    }
    if (found === undefined) return undefined;
    // acp's server() refuses to arm when BILLION_CONTEXT_PROXY is set; the
    // check runs only at entry, so it is unset strictly around the call and
    // restored in finally. Concurrent readers on this event loop see either
    // value only across our own awaits here.
    const prev = process.env.BILLION_CONTEXT_PROXY;
    try {
        if (prev !== undefined) delete process.env.BILLION_CONTEXT_PROXY;
        const mod = (await import(pathToFileURL(found).href)) as { default?: unknown };
        const server = mod.default;
        if (typeof server !== "function") {
            log(`[bili-opencode-native] legacy: ${found} exports no server function — ignored`);
            return undefined;
        }
        const hooks = (await (server as (c: unknown) => Promise<Record<string, unknown>>)(ctx)) ?? {};
        if (typeof hooks !== "object") return undefined;
        const toolsRaw = hooks.tool;
        const tools = toolsRaw !== null && typeof toolsRaw === "object" && !Array.isArray(toolsRaw) ? (toolsRaw as Record<string, LegacyAcpToolDef>) : {};
        if (Object.keys(tools).length === 0) {
            log(`[bili-opencode-native] legacy: ${found} armed but registered no tools (acp disabled by its own config?) — ignored`);
            return undefined;
        }
        const configHook = typeof hooks.config === "function" ? (hooks.config as LegacyAcpModule["configHook"]) : undefined;
        const commandHook = typeof hooks["command.execute.before"] === "function" ? (hooks["command.execute.before"] as LegacyAcpModule["commandHook"]) : undefined;
        log(`[bili-opencode-native] legacy opencode-acp absorbed from ${found} (tools: ${Object.keys(tools).join(", ")})`);
        return { hooks, tools, configHook, commandHook, source: found };
    } catch (err) {
        log(`[bili-opencode-native] legacy: failed to load ${found}: ${String(err)} — legacy sessions degrade to read-only`);
        return undefined;
    } finally {
        if (prev === undefined) delete process.env.BILLION_CONTEXT_PROXY;
        else process.env.BILLION_CONTEXT_PROXY = prev;
    }
}

/** Call acp's config hook without letting it see (and self-disable on) the
 *  /bili/-wrapped provider URLs, then merge back the top-level keys it may
 *  have replaced on the shadow copy (it writes via `??=`/spread-replace, so a
 *  reference change marks an owned write; in-place mutations already hit the
 *  real object). */
export async function callLegacyAcpConfig(configHook: NonNullable<LegacyAcpModule["configHook"]>, cfg: Record<string, unknown>): Promise<void> {
    const shadow: Record<string, unknown> = { ...cfg };
    delete shadow.provider;
    await configHook(shadow);
    for (const key of ["permission", "command", "experimental"] as const) {
        if (shadow[key] !== cfg[key]) cfg[key] = shadow[key];
    }
}
