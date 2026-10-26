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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ensureProxyRunning, LAUNCHER_DEFAULT_HOST } from "./launcher.js";
import { resolveClaudeNativePort } from "./config.js";
import { postIdentityRegister } from "./agent/shared.js";
import { lanePreferredPort } from "./instance.js";
import { claudeNativeInstalled, isBiliClaudeBaseUrl, repinClaudeManagedBaseUrl } from "./plugin-install.js";
import { claudeRoutingWarningFile } from "./paths.js";
import { nativeBootstrapGate, proxyEnvOrigin } from "./agent/native-bootstrap.js";
import { vertexEnabled } from "./vertex.js";

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
export function planClaudeNativeBootstrap(env: NodeJS.ProcessEnv): { action: "exit" | "passthrough" | "start"; port: number; strict: boolean } {
    // #1660 zone semantics: an EXPLICIT override (BILI_CLAUDE_NATIVE_PORT /
    // claude.nativePort) keeps strict-port behavior (#964 — refuse a squatter
    // rather than serve through it); otherwise the claude lane's zone
    // preference (sticky record > 18787 base), with the proxy child's
    // EADDRINUSE +1 ladder resolving collisions zero-config.
    const explicit = resolveClaudeNativePort(env);
    const port = explicit ?? lanePreferredPort("claude", env);
    const strict = explicit !== undefined;
    if (proxyEnvOrigin(env) !== undefined) return { action: "exit", port, strict };
    if (env.BILLION_CONTEXT_PLUGIN === "0" || env.BILI_NATIVE_CLAUDE === "0") return { action: "passthrough", port, strict };
    if (!nativeBootstrapGate(env, "BILI_NATIVE_CLAUDE")) return { action: "exit", port, strict };
    return { action: "start", port, strict };
}

// — routing bypass detection (#2290) ——————————————————————————
// The managed settings block assumes the session dials the pinned /bili/ URL.
// Some hosts violate that: Claude Desktop spawns embedded Claude Code with its
// own ANTHROPIC_BASE_URL (claude.ai host auth) that wins over settings.json,
// while DISABLE_AUTO_COMPACT=1 from the same block still applies — the session
// then loses BOTH compression paths silently. We cannot fix the running
// session (the hook cannot mutate its parent's env, and the block is shared
// with the CLI host), so we detect and warn loudly instead of staying quiet.

/** Entry-points with traffic evidence of overriding the managed base URL.
 *  Exact permitlist by design: new hosts are added here WITH evidence, never
 *  generalized ("any non-cli entrypoint") — other hosts may route fine. */
const BYPASS_ENTRYPOINTS = new Set(["claude-desktop"]);

/** Pure detection (#2290): does this session environment indicate the managed
 *  ANTHROPIC_BASE_URL will not be honored? Three signals, any of which
 *  suffices:
 *   - CLAUDE_CODE_ENTRYPOINT names a known overriding host (Claude Desktop);
 *   - the session env carries an ANTHROPIC_BASE_URL that is not a bili URL;
 *   - the session is a Vertex session (CLAUDE_CODE_USE_VERTEX on, which makes
 *     ANTHROPIC_BASE_URL inert) whose ANTHROPIC_VERTEX_BASE_URL is missing or
 *     is not a bili URL — without this third check a Vertex session passes the
 *     two above and bypasses the managed block unreported.
 *  In a healthy terminal session none fire: claude does not inject its
 *  settings.env into hook children, so the vars are absent unless something
 *  external set them. Exported for tests. */
export function claudeNativeRoutingCheck(env: NodeJS.ProcessEnv): { bypassed: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const entrypoint = env.CLAUDE_CODE_ENTRYPOINT?.trim().toLowerCase();
    if (entrypoint !== undefined && BYPASS_ENTRYPOINTS.has(entrypoint)) {
        reasons.push(`CLAUDE_CODE_ENTRYPOINT=${entrypoint} — this host sets its own ANTHROPIC_BASE_URL for API routing, overriding the managed settings.json value`);
    }
    const url = env.ANTHROPIC_BASE_URL?.trim();
    if (url !== undefined && url.length > 0 && !isBiliClaudeBaseUrl(url)) {
        reasons.push(`session environment carries ANTHROPIC_BASE_URL=${url}, which is not the managed bili URL`);
    }
    // Vertex routes on ANTHROPIC_VERTEX_BASE_URL and ignores ANTHROPIC_BASE_URL
    // entirely, so the checks above can pass while nothing reaches bili: either
    // the variable is absent (claude then derives the aiplatform host itself)
    // or it points somewhere that is not a bili URL.
    if (vertexEnabled(env)) {
        const vertexUrl = env.ANTHROPIC_VERTEX_BASE_URL?.trim();
        if (vertexUrl === undefined || vertexUrl.length === 0) {
            reasons.push("CLAUDE_CODE_USE_VERTEX is on and ANTHROPIC_VERTEX_BASE_URL is unset — claude derives the Vertex host itself, so the managed ANTHROPIC_BASE_URL cannot route this session through bili");
        } else if (!isBiliClaudeBaseUrl(vertexUrl)) {
            reasons.push(`session environment carries ANTHROPIC_VERTEX_BASE_URL=${vertexUrl}, which is not the managed bili URL`);
        }
    }
    return { bypassed: reasons.length > 0, reasons };
}

/** Persist a detection so `bili doctor` can surface it later (hook stderr is
 *  only visible in debug/transcript mode). Best-effort: must never throw. */
export function recordClaudeRoutingWarning(reasons: string[]): void {
    try {
        const file = claudeRoutingWarningFile();
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ at: Date.now(), reasons }, null, 2) + "\n");
    } catch {
        // persistence is diagnostic sugar — a failure here must not fail the hook
    }
}

function warnRoutingBypass(): void {
    const check = claudeNativeRoutingCheck(process.env);
    if (!check.bypassed) return;
    const dacNote = claudeNativeInstalled()
        ? " In addition, the managed settings block sets DISABLE_AUTO_COMPACT=1, so native auto-compaction is OFF too — long sessions grow unbounded."
        : "";
    log(`WARNING: this Claude session will BYPASS bili compression — ${check.reasons.join("; ")}.`);
    log(`Model requests go direct to the upstream: bili sees no traffic for this conversation (acp_status / acp_cache / the bili MCP tools report "unknown plugin conversation").${dacNote}`);
    log("Fix: terminal sessions route through bili via settings.json as usual; use the `bili claude` launcher when in doubt. If you ONLY use Claude Desktop, run `bili plugin remove claude` to restore your original settings (.bili-bak) — native auto-compact returns. A documented desktop lane is tracked in #2290.");
    recordClaudeRoutingWarning(check.reasons);
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

/** #2441: exec options for the process-table lookups below (ps on POSIX, the
 *  PowerShell fallback on Windows — fired on every claude SessionStart hook,
 *  the closest analog of the #2439 console flash: a host that owns no console
 *  makes Windows allocate a NEW console window for any unhidden console child).
 *  windowsHide is a documented no-op off Windows, so the ps path is untouched.
 *  #2834: explicit stdio keeps a failed probe's stderr off the host terminal
 *  (default stdio forwards it); the catch degrades to null either way.
 *  Exported pure so tests can pin it without spawning anything. */
export function procTableExecOptions(): { encoding: BufferEncoding; timeout: number; windowsHide: boolean; stdio: ["ignore", "pipe", "ignore"] } {
    return { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] };
}

function defaultExec(cmd: string, args: string[]): string | null {
    try {
        return execFileSync(cmd, args, procTableExecOptions());
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

/** Windows CommandLineToArgvW semantics (#1388): whitespace separates
 *  tokens, double quotes group (spaces inside stay one token), and
 *  backslashes escape quotes per the classic 2n/2n+1 rule. Win32_Process
 *  quotes paths that contain spaces (reporter-verified), so a naive
 *  whitespace split shreds `"C:\Program Files\\..."` into C:\, Program,
 *  Files... and the host-argv match below fails. Parsing can only GAIN a
 *  match the old code lost — never invent one. Exported for tests. */
export function splitWindowsCommandLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let has = false;
    let quoted = false;
    let i = 0;
    while (i < line.length) {
        const c = line[i]!;
        if (c === "\\") {
            let n = 0;
            while (line[i + n] === "\\") n++;
            const next = line[i + n] ?? "";
            if (next === '"') {
                cur += "\\".repeat(Math.floor(n / 2));
                if (n % 2 === 1) cur += '"';
                i += n % 2 === 1 ? n + 1 : n;
                has = true;
                continue;
            }
            cur += "\\".repeat(n);
            i += n;
            has = true;
            continue;
        }
        if (c === '"') {
            quoted = !quoted;
            has = true;
            i++;
            continue;
        }
        if (!quoted && (c === " " || c === "\t")) {
            if (has) {
                out.push(cur);
                cur = "";
                has = false;
            }
            i++;
            continue;
        }
        cur += c;
        has = true;
        i++;
    }
    if (has || cur.length > 0) out.push(cur);
    return out;
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
    // #1388: quote-aware tokenize (paths with spaces survive as one token);
    // trailing \r from PowerShell's CRLF endings is trimmed first.
    const argv = splitWindowsCommandLine(line.slice(tab + 1).trim().replace(/\r$/, ""));
    return { argv: argv.length > 0 ? argv : null, ppid: Number.isFinite(ppid) ? ppid : null };
}

/** The platform's process-table reader: /proc on linux (microseconds, no
 *  subprocess), PowerShell on windows, ps elsewhere. */
function defaultProcReader(): ProcReader {
    if (process.platform === "win32") return (pid) => readWinProcInfo(pid);
    if (process.platform === "linux") return readProcInfo;
    return (pid) => readPsProcInfo(pid);
}

/** Windows keeps the surrounding quotes on a CommandLine token whose path
 *  needs them (PowerShell Win32_Process.CommandLine, #1377); strip leading/
 *  trailing quote chars so basename + flag matching sees the bare name. A
 *  no-op for already-clean inputs (Unix NUL-split /proc argv, macOS ps). */
function stripQuotes(s: string): string {
    return s.replace(/^["']+|["']+$/g, "");
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
 *  installs. Basename matching is quote-tolerant (Windows CommandLine keeps
 *  token quotes — #1377). Exported for tests. */
export function isClaudeHostArgv(argv: string[]): boolean {
    const base = (p: string): string => {
        const parts = stripQuotes(p).split(/[\\/]/).filter((seg) => seg.length > 0);
        return stripQuotes(parts[parts.length - 1] ?? "");
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
function findClaudeHost(opts: { read?: ProcReader; startPid?: number } = {}): { pid: number; argv: string[] } | undefined {
    const read = opts.read ?? defaultProcReader();
    let pid = opts.startPid ?? process.pid;
    for (let hop = 0; hop < CLAUDE_HOST_MAX_WALK; hop++) {
        const info = read(pid);
        if (info === null) return undefined;
        if (info.argv !== null && isClaudeHostArgv(info.argv)) return { pid, argv: info.argv };
        if (info.ppid === null || info.ppid <= 1) return undefined;
        pid = info.ppid;
    }
    return undefined;
}

export function resolveClaudeHostArgv(opts: { read?: ProcReader; startPid?: number } = {}): string[] | undefined {
    return findClaudeHost(opts)?.argv;
}

export function resolveClaudeHostPid(opts: { read?: ProcReader; startPid?: number } = {}): number | undefined {
    return findClaudeHost(opts)?.pid;
}

/** #2408: the parent session id of a `claude --resume <id> --fork-session`
 * launch, parsed off the claude host's argv (`--resume <uuid>`,
 * `--resume=<uuid>`, `-r <uuid>`). UUID-tight on purpose: a loose token
 * match could adopt an unrelated flag value as the parent. `--continue
 * --fork-session` carries no id and returns undefined (no declaration, the
 * proxy's content matching decides on its own). Exported for tests. */
export function claudeForkParentFromArgv(argv: string[]): string | undefined {
    const isSessionToken = (token: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
    for (let i = 0; i < argv.length; i++) {
        const arg = stripQuotes(argv[i] ?? "");
        let candidate: string | undefined;
        if (arg === "--resume" || arg === "-r") candidate = stripQuotes(argv[i + 1] ?? "");
        else if (arg.startsWith("--resume=")) candidate = stripQuotes(arg.slice("--resume=".length));
        if (candidate !== undefined && isSessionToken(candidate)) return candidate;
    }
    return undefined;
}

/** Is this argv a shell running a run-and-exit one-shot — the transient hook
 *  wrapper shape? Covers POSIX `sh -c` (also -lc/-ic flag clusters), Windows
 *  `cmd /c` (/k stays open — not transient), and `powershell -Command`
 *  (claude uses one of these to launch SessionStart hooks on every OS).
 *  Such wrappers exit the moment their command does. Exported for tests. */
export function isTransientShArgv(argv: string[]): boolean {
    const parts = stripQuotes(argv[0] ?? "").split(/[\\/]/).filter((seg) => seg.length > 0);
    const shell = stripQuotes(parts[parts.length - 1] ?? "");
    if (/^(sh|bash|dash|zsh|ksh|ash)(\.exe)?$/i.test(shell)) {
        return argv.some((arg, i) => i > 0 && /^-[^-]*c$/.test(stripQuotes(arg)));
    }
    if (/^cmd(\.exe)?$/i.test(shell)) {
        return argv.some((arg, i) => i > 0 && /^[-/]c$/i.test(stripQuotes(arg)));
    }
    if (/^(powershell|pwsh)(\.exe)?$/i.test(shell)) {
        return argv.some((arg, i) => i > 0 && /^-?(command|encodedcommand)$/i.test(stripQuotes(arg)));
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

/** #2408: declare fork lineage to the proxy. A `claude --resume <parent>
 * --fork-session` launch fires SessionStart with source:"fork" and a FRESH
 * session_id while replaying the parent's wire history on it. The
 * declaration scopes the proxy's #1486 resume-inheritance to the declared
 * parent chain (refs/blocks seed when the replay matches) and otherwise
 * leaves the #1333 read-only parent link as fallback. Best-effort by
 * design — never fails the hook. */
async function declareForkLineage(payloadJson: string, origin: string): Promise<void> {
    try {
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(payloadJson) as Record<string, unknown>;
        } catch {
            return;
        }
        if (payload.source !== "fork") return;
        const child = typeof payload.session_id === "string" ? payload.session_id : "";
        if (child.length === 0) return;
        const argv = resolveClaudeHostArgv();
        if (argv === undefined) return;
        const parent = claudeForkParentFromArgv(argv);
        if (parent === undefined || parent === child) return;
        await postIdentityRegister(origin, child, "claude", parent);
        log(`fork session ${child.slice(0, 8)} declared parent ${parent.slice(0, 8)} (#2408)`);
    } catch (err) {
        log(`fork lineage declaration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
}

async function run(payloadJson: string): Promise<void> {
    const plan = planClaudeNativeBootstrap(process.env);
    if (plan.action === "exit") return;
    // #2290: detect a host that will not honor the managed base URL BEFORE
    // proxy bring-up — the warning stands even when bring-up then fails (the
    // two failures compound: no compression AND no lifecycle guarantee).
    try {
        warnRoutingBypass();
    } catch (err) {
        log(`routing-bypass check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        // The direct parent is the transient `/bin/sh -c` wrapper claude used
        // to launch this hook — it exits with the hook, and a watchdog on it
        // killed a healthy proxy ~2s into every session. Watch the claude
        // host itself; when the walk cannot find it, chooseWatchdogParentPid
        // degrades via the wrapper's parent instead of the wrapper.
        const watchPid = chooseWatchdogParentPid();
        // #1660: an EXPLICIT pin stays exact + strict; otherwise pass port 0
        // so the launcher resolves the zone preference and settles the
        // actually-bound port sticky (a pre-resolved port > 0 would skip the
        // zone wiring entirely and never write the sticky record).
        const handle = await ensureProxyRunning(
            {
                host: LAUNCHER_DEFAULT_HOST,
                port: plan.strict ? plan.port : 0,
                passthrough: plan.action === "passthrough",
                debug: false,
                parentPid: watchPid,
                strictPort: plan.strict,
                lane: "claude",
            },
            { scriptPath: proxyScriptPath() },
        );
        // #1190: watcher registration on attach lives in ensureProxyRunning
        // (every native client registers there; claude's earlier copy was
        // redundant once the chokepoint covered all callers).
        log(`proxy ${handle.attached ? "attached" : "started"} at ${handle.origin}${plan.action === "passthrough" ? " (passthrough — compression off)" : ""}`);
        // #1660: the zone port can drift (+1 ladder on EADDRINUSE, sticky
        // record). The managed block's baked ANTHROPIC_BASE_URL points at the
        // LAST session's port — repin it to the origin we hold so the NEXT
        // session dials correctly. The CURRENT session rides whatever base
        // URL claude already loaded into its process env, so a failure here
        // is non-fatal by construction; still, never let it kill the hook.
        try {
            const notes = repinClaudeManagedBaseUrl(handle.origin);
            if (notes.length > 0) log(`managed settings repinned: ${notes.join("; ")}`);
        } catch (err) {
            log(`managed settings repin failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
        if (handle.refusedWatcher) {
            // #1322: attach landed on a daemon proxy (no BILI_PARENT_PID) whose
            // watchdog refused our owner — the README's "lives and dies with the
            // session" contract is void here. Say so loudly instead of silently
            // serving a proxy that will outlive every session.
            log(
                `WARNING: proxy at ${handle.origin} has NO session-lifecycle watchdog (it was started without BILI_PARENT_PID, e.g. manually on this port) — it will outlive every session, and config edits only apply after that process is restarted. Kill it or start a session-owned proxy to restore the lifecycle contract (#1322).`,
            );
        }
        // #2408: fork lineage only matters when the proxy compresses — a
        // passthrough proxy ignores lineage entirely.
        if (plan.action === "start") await declareForkLineage(payloadJson, handle.origin);
    } catch (err) {
        log(
            `proxy bring-up failed on port ${plan.port} — ${err instanceof Error ? err.message : String(err)}` +
                (plan.action === "start" ? ` — this port is NOT served by a session-managed proxy: model calls ride whatever answers there (an unmanaged or stale bili daemon has no lifecycle guarantees) or fail outright. Fix: kill the listener on this port or set BILI_CLAUDE_NATIVE_PORT, then reinstall (bili plugin install claude)` : ""),
        );
    }
}

/** Safety net for the stdin drain below: claude writes the SessionStart
 *  JSON and closes the pipe, so 'end' fires within milliseconds — but a
 *  never-closed or exotic pipe must not hang the hook (claude blocks session
 *  start until this process exits). Two seconds is far above any real
 *  SessionStart payload latency while staying invisible to the user. */
export const HOOK_STDIN_DRAIN_TIMEOUT_MS = 2_000;

/** The hook entrypoint's stdin wiring, isolated for tests (#2408 review):
 *  collect the SessionStart payload chunks, call `runImpl` with the FULL
 *  payload exactly once — only after the stream has drained ('end'/'error',
 *  or the timeout safety net) — then exit 0. Node delivers 'data'
 *  asynchronously: calling run with the accumulator before drain would ship
 *  an empty string on every session (the bug the entrypoint tests pin).
 *  Exported with injectable deps so the real wiring — not a re-implementation
 *  — is what the tests drive. */
export function hookMainWithDeps(deps: {
    input?: NodeJS.ReadableStream;
    runImpl?: (payload: string) => Promise<void>;
    exit?: (code: number) => void;
    drainTimeoutMs?: number;
} = {}): void {
    const input = deps.input ?? process.stdin;
    const runImpl = deps.runImpl ?? run;
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    const destroyInput = (): void => {
        try {
            (input as { destroy?: () => void }).destroy?.();
        } catch {
            // already closed
        }
    };
    let payload = "";
    let started = false;
    const start = (): void => {
        if (started) return;
        started = true;
        clearTimeout(timer);
        void runImpl(payload).finally(() => {
            destroyInput();
            exit(0);
        });
    };
    const timer = setTimeout(start, deps.drainTimeoutMs ?? HOOK_STDIN_DRAIN_TIMEOUT_MS);
    if (typeof (input as { setEncoding?: (e: string) => void }).setEncoding === "function") {
        (input as { setEncoding: (e: string) => void }).setEncoding("utf8");
    }
    input.on("data", (chunk: string) => {
        payload += chunk;
    });
    input.on("end", start);
    input.on("error", start);
}

function hookMain(): void {
    // claude waits for this process to exit, and draining avoids a blocked
    // writer if the payload ever exceeds the socket buffer.
    hookMainWithDeps();
}

// Direct entry (dist/claude-native-bootstrap.js spawned by claude's hook, or
// the ts source under tsx in tests): run only when invoked as the script
// itself, never when imported for planClaudeNativeBootstrap.
if (process.argv[1] && /claude-native-bootstrap\.(?:ts|js)$/.test(process.argv[1])) {
    hookMain();
}
