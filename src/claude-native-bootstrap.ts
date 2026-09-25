// #964 claude native bootstrap — the SessionStart hook command written into
// ~/.claude/settings.json by `bili plugin install claude`. Claude Code has no
// in-process extension point (hooks and MCP servers are child processes), so
// the native posture is a documented hybrid:
//
//   1. the installer pins env.ANTHROPIC_BASE_URL to a STABLE loopback port
//      (resolveClaudeNativePort: BILI_CLAUDE_NATIVE_PORT > config
//      claude.nativePort > 48787) with a /bili/-wrapped upstream — full
//      traffic visibility without MITM;
//   2. THIS hook (fired before the first model request) makes sure a proxy
//      is listening there: attach to a healthy compatible one, else spawn one
//      detached whose parent-pid watchdog watches CLAUDE's pid (resolved by
//      walking past the transient `/bin/sh -c` hook wrapper — the hook itself
//      exits immediately) so the proxy lives and dies with the session;
//   3. the MCP shim (dist/mcp.js, registered user-scope, pinned to the same
//      stable port) provides the native compress/decompress/acp_status tools
//      and identity-registers the conversation (CLAUDE_CODE_SESSION_ID =
//      x-claude-code-session-id on every request — the proxy's existing
//      plugin-mode gating, #162/#268; zero new protocol surface).
//
// Opt-out BILI_NATIVE_CLAUDE=0 (or the global BILLION_CONTEXT_PLUGIN=0):
// the hook still answers the now-static URL — by spawning a PASSTHROUGH-mode
// proxy on the same port (verbatim forward, compression off) so claude stays
// fully functional (#964 Q2). A launch that already owns routing
// (BILLION_CONTEXT_PROXY set — `bili claude` overrides the static URL with
// its own ephemeral proxy) needs nothing: exit 0 immediately.
//
// The hook must NEVER fail claude: every error prints to stderr and exits 0.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "./launcher.js";
import { resolveClaudeNativePort } from "./config.js";
import { nativeBootstrapGate, proxyEnvOrigin } from "./agent/native-bootstrap.js";

/** dist/claude-native-bootstrap.js → sibling dist/index.js (the package
 *  bin). ensureProxyRunning's default (process.argv[1]) would re-invoke THIS
 *  hook script as the proxy — infinite self-spawn. */
function proxyScriptPath(): string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
}

function log(msg: string): void {
    process.stderr.write(`[bili-claude-bootstrap] ${msg}\n`);
}

/** Pure decision (#964): what this hook does under the given environment.
 *  Exported for tests.
 *   - "exit": someone else owns routing (BILLION_CONTEXT_PROXY /
 *     BILI_PROVIDER_REWRITES) — spawn nothing.
 *   - "passthrough": opted out (BILI_NATIVE_CLAUDE=0 /
 *     BILLION_CONTEXT_PLUGIN=0) — serve the static URL verbatim-forward.
 *   - "start": bring up (or attach to) the compression proxy. */
export function planClaudeNativeBootstrap(env: NodeJS.ProcessEnv): { action: "exit" | "passthrough" | "start"; port: number } {
    const port = resolveClaudeNativePort(env);
    if (proxyEnvOrigin(env) !== undefined) return { action: "exit", port };
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_CLAUDE === "0") return { action: "passthrough", port };
    if (!nativeBootstrapGate(env, "BILI_NATIVE_CLAUDE")) return { action: "exit", port };
    return { action: "start", port };
}

// — claude host pid resolution ———————————————————————————————
// claude (2.x) runs SessionStart hooks as `/bin/sh -c <command>`: the hook's
// DIRECT parent is a transient sh that dies the moment the hook exits. A
// proxy watchdog pointed at that parent self-kills ~2s into every session
// (live "parent-gone (pid N)" failures) while claude itself lives on.

const CLAUDE_HOST_MAX_WALK = 8;

/** One process-table snapshot. argv is null when no command line is visible
 *  (zombies, kernel threads, protected processes) — the ppid chain still
 *  walks through those. null return means the pid is gone or its reader
 *  failed — callers fall back to the legacy direct parent. */
type ProcInfo = { argv: string[] | null; ppid: number | null };

type ProcReader = (pid: number) => ProcInfo | null;

type ExecFn = (cmd: string, args: string[]) => string | null;

function defaultExec(cmd: string, args: string[]): string | null {
    try {
        return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 });
    } catch {
        return null;
    }
}

function readProcInfo(pid: number): ProcInfo | null {
    let argv: string[] | null = null;
    let ppid: number | null = null;
    try {
        const parts = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((p) => p.length > 0);
        if (parts.length > 0) argv = parts;
    } catch {
        return null;
    }
    try {
        // comm can contain spaces and parens — only the text after the LAST
        // ')' is positional; field 2 of the remainder is ppid.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (tail.length > 1) ppid = Number(tail[1]);
    } catch {
        // stat unreadable: stop the walk after this hop
    }
    return { argv, ppid };
}

/** ps fallback for platforms without /proc (darwin/BSD; the flags work on
 *  linux too): one line "<ppid> <args...>". Whitespace-splitting a joined
 *  command line can only LOSE a match (paths containing spaces) — never
 *  invent one — so a miss degrades to the legacy fallback parent. Exported
 *  for tests (inject `exec`). */
export function readPsProcInfo(pid: number, exec: ExecFn = defaultExec): ProcInfo | null {
    const out = exec("ps", ["-ww", "-o", "ppid=", "-o", "args=", "-p", String(pid)]);
    if (out === null) return null;
    const line = out.split("\n").find((l) => l.trim().length > 0);
    if (line === undefined) return null;
    const [ppidToken, ...rest] = line.trim().split(/\s+/);
    const ppid = Number(ppidToken);
    return { argv: rest.length > 0 ? rest : null, ppid: Number.isFinite(ppid) ? ppid : null };
}

/** Windows fallback: one PowerShell call returns "<ppid>\t<CommandLine>"
 *  (ps/wmic are deprecated or absent). CommandLine can be empty for
 *  protected processes — argv null still lets the ppid chain walk on.
 *  Exported for tests (inject `exec`). */
export function readWinProcInfo(pid: number, exec: ExecFn = defaultExec): ProcInfo | null {
    const out = exec("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}') | ForEach-Object { "$($_.ParentProcessId)\`t$($_.CommandLine)" }`,
    ]);
    if (out === null) return null;
    const line = out.split("\n").find((l) => l.trim().length > 0);
    if (line === undefined) return null;
    const tab = line.indexOf("\t");
    if (tab < 0) return null;
    const ppid = Number(line.slice(0, tab).trim());
    const argv = line
        .slice(tab + 1)
        .trim()
        .split(/\s+/)
        .filter((part) => part.length > 0);
    return { argv: argv.length > 0 ? argv : null, ppid: Number.isFinite(ppid) ? ppid : null };
}

/** The platform's process-table reader: /proc on linux (microseconds, no
 *  subprocess), PowerShell on windows, ps elsewhere. */
function defaultProcReader(): ProcReader {
    if (process.platform === "win32") return (pid) => readWinProcInfo(pid);
    if (process.platform === "linux") return readProcInfo;
    return (pid) => readPsProcInfo(pid);
}

/** Is this argv the claude-code session binary? Matches `claude`/`claude.exe`
 *  and `node .../claude...` installs (`@anthropic-ai/claude-code` paths or a
 *  bare `claude` argument). Must NOT match this hook's own script
 *  (claude-native-bootstrap.js) or wrappers like `timeout 40 claude` /
 *  `sh -c ...` (their argv[0] is not claude). The bare-`claude` node form can
 *  false-positive on an unrelated `node /opt/claude`, but the walk is
 *  bottom-up and the REAL claude sits 2 hops up in every session — a closer
 *  match always wins, so a lookalike higher in the tree is unreachable.
 *  Tightening it would instead break real `node ~/bin/claude` launcher
 *  installs. Exported for tests. */
export function isClaudeHostArgv(argv: string[]): boolean {
    const base = (p: string): string => {
        const parts = p.split(/[\\/]/).filter((seg) => seg.length > 0);
        return parts[parts.length - 1] ?? "";
    };
    if (/^claude(\.exe)?$/i.test(base(argv[0] ?? ""))) return true;
    if (/^(node|bun|deno)(\.exe)?$/i.test(base(argv[0] ?? ""))) {
        return argv.slice(1).some((arg) => /^claude(\.exe)?$/i.test(base(arg)) || /@anthropic-ai[\\/]claude-code/.test(arg));
    }
    return false;
}

/** The claude session process that transitively owns this hook, found by
 *  walking up from `startPid` (default: this hook) through the platform
 *  process table (/proc on linux, ps elsewhere, PowerShell on windows).
 *  undefined when no claude host sits within CLAUDE_HOST_MAX_WALK hops —
 *  callers then fall back to the legacy direct parent (strictly no worse
 *  than before). Exported for tests (inject `read` to stub the process
 *  table). */
export function resolveClaudeHostPid(opts: { read?: ProcReader; startPid?: number } = {}): number | undefined {
    const read = opts.read ?? defaultProcReader();
    let pid = opts.startPid ?? process.pid;
    for (let hop = 0; hop < CLAUDE_HOST_MAX_WALK; hop++) {
        const info = read(pid);
        if (info === null) return undefined;
        if (info.argv !== null && isClaudeHostArgv(info.argv)) return pid;
        if (info.ppid === null || info.ppid <= 1) return undefined;
        pid = info.ppid;
    }
    return undefined;
}

/** Is this argv a shell running a run-and-exit one-shot — the transient hook
 *  wrapper shape? Covers POSIX `sh -c` (also -lc/-ic flag clusters), Windows
 *  `cmd /c` (/k stays open — not transient), and `powershell -Command`
 *  (claude uses one of these to launch SessionStart hooks on every OS).
 *  Such wrappers exit the moment their command does. Exported for tests. */
export function isTransientShArgv(argv: string[]): boolean {
    const parts = (argv[0] ?? "").split(/[\\/]/).filter((seg) => seg.length > 0);
    const shell = parts[parts.length - 1] ?? "";
    if (/^(sh|bash|dash|zsh|ksh|ash)(\.exe)?$/i.test(shell)) {
        return argv.some((arg, i) => i > 0 && /^-[^-]*c$/.test(arg));
    }
    if (/^cmd(\.exe)?$/i.test(shell)) {
        return argv.some((arg, i) => i > 0 && /^[-/]c$/i.test(arg));
    }
    if (/^(powershell|pwsh)(\.exe)?$/i.test(shell)) {
        return argv.some((arg, i) => i > 0 && /^-?(command|encodedcommand)$/i.test(arg));
    }
    return false;
}

/** The pid the spawned proxy's watchdog should watch. The resolved claude
 *  host when the walk finds one. Otherwise: a SessionStart hook's direct
 *  parent is always the transient `sh -c` wrapper — watching it re-arms the
 *  2s self-kill — so fall back to ITS parent instead (in a real session that
 *  is claude itself, even when an exotic install form went unrecognized);
 *  when the direct parent is anything else (manual run under an interactive
 *  shell) or unreadable, keep the legacy direct parent. Exported for tests
 *  (inject `read` to stub the process table). */
export function chooseWatchdogParentPid(opts: { read?: ProcReader; parentPid?: number } = {}): number {
    const read = opts.read ?? defaultProcReader();
    const host = resolveClaudeHostPid({ read });
    if (host !== undefined) return host;
    const parentPid = opts.parentPid ?? process.ppid;
    const parentInfo = read(parentPid);
    if (parentInfo !== null && parentInfo.argv !== null && isTransientShArgv(parentInfo.argv)) {
        const grandPid = parentInfo.ppid;
        if (grandPid !== null && grandPid > 1) return grandPid;
    }
    return parentPid;
}

async function run(): Promise<void> {
    const plan = planClaudeNativeBootstrap(process.env);
    if (plan.action === "exit") return;
    try {
        // The direct parent is the transient `/bin/sh -c` wrapper claude used
        // to launch this hook — it exits with the hook, and a watchdog on it
        // killed a healthy proxy ~2s into every session. Watch the claude
        // host itself; when the walk cannot find it, chooseWatchdogParentPid
        // degrades via the wrapper's parent instead of the wrapper.
        const watchPid = chooseWatchdogParentPid();
        const handle = await ensureProxyRunning(
            {
                host: LAUNCHER_DEFAULT_HOST,
                port: plan.port,
                passthrough: plan.action === "passthrough",
                debug: false,
                parentPid: watchPid,
                strictPort: true,
                lane: "claude",
            },
            { scriptPath: proxyScriptPath() },
        );
        // #1190: watcher registration on attach lives in ensureProxyRunning
        // (every native client registers there; claude's earlier copy was
        // redundant once the chokepoint covered all callers).
        log(`proxy ${handle.attached ? "attached" : "started"} at ${handle.origin}${plan.action === "passthrough" ? " (passthrough — compression off)" : ""}`);
        if (handle.refusedWatcher) {
            // #1322: attach landed on a daemon proxy (no BILI_PARENT_PID) whose
            // watchdog refused our owner — the README's "lives and dies with the
            // session" contract is void here. Say so loudly instead of silently
            // serving a proxy that will outlive every session.
            log(
                `WARNING: proxy at ${handle.origin} has NO session-lifecycle watchdog (it was started without BILI_PARENT_PID, e.g. manually on this port) — it will outlive every session, and config edits only apply after that process is restarted. Kill it or start a session-owned proxy to restore the lifecycle contract (#1322).`,
            );
        }
    } catch (err) {
        log(
            `proxy bring-up failed on port ${plan.port} — ${err instanceof Error ? err.message : String(err)}` +
                (plan.action === "start" ? ` — this port is NOT served by a session-managed proxy: model calls ride whatever answers there (an unmanaged or stale bili daemon has no lifecycle guarantees) or fail outright. Fix: kill the listener on this port or set BILI_CLAUDE_NATIVE_PORT, then reinstall (bili plugin install claude)` : ""),
        );
    }
}

function hookMain(): void {
    // Drain the hook's stdin payload (session_id etc.) — claude waits for
    // this process to exit; we never read the payload, but draining avoids a
    // blocked writer if the payload ever exceeds the socket buffer.
    process.stdin.resume();
    void run().finally(() => {
        process.stdin.destroy();
        process.exit(0);
    });
}

// Direct entry (dist/claude-native-bootstrap.js spawned by claude's hook, or
// the ts source under tsx in tests): run only when invoked as the script
// itself, never when imported for planClaudeNativeBootstrap.
if (process.argv[1] && /claude-native-bootstrap\.(?:ts|js)$/.test(process.argv[1])) {
    hookMain();
}
