import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** XDG base-directory paths for billion-context.
 *
 *  Follows the XDG Base Directory Specification so the proxy lands in the
 *  conventional Linux/macOS locations instead of a bespoke ~/.bili/:
 *
 *    config (user-edited, dotfile-managed):
 *      $XDG_CONFIG_HOME/billion-context/billion-context.json
 *      default: ~/.config/billion-context/billion-context.json
 *
 *    data (persisted session state, grows over time):
 *      $XDG_DATA_HOME/billion-context/sessions/
 *      default: ~/.local/share/billion-context/sessions/
 *
 *  Env overrides (highest priority) are kept so test runners and container
 *  setups can relocate everything without touching the config file. */

function xdg(envVar: string, fallback: string): string {
    const v = process.env[envVar];
    if (v && v.length > 0) return path.resolve(v);
    return path.join(homedir(), fallback);
}

/** Root config dir: user-editable configuration lives here. */
export function configDir(): string {
    return path.join(xdg("XDG_CONFIG_HOME", ".config"), "billion-context");
}

/** Resolve a config ref (BILI_CONFIG_FILE / -c/--config value): a path
 *  (contains a separator, or names an existing file in CWD) stays a path;
 *  a bare NAME selects <configDir>/NAME.json — "billion-context" is the
 *  default file itself, so per-purpose siblings ("dsh-test", "ework-qq")
 *  switch the whole config without touching env vars. */
export function resolveConfigFileRef(ref: string): string {
    if (ref.includes("/") || ref.includes("\\") || existsSync(ref)) return path.resolve(ref);
    return path.join(configDir(), `${ref}.json`);
}

/** Fail-fast check for a -c/--config ref (keeps main() exit-free for tests):
 *  a bare NAME (no separator, no CWD file) whose <configDir>/NAME.json is
 *  missing is an error — the message names the resolved path plus every
 *  available sibling so a typo can't silently start the proxy on an empty
 *  config. Explicit PATHS (and refs naming an existing CWD file) keep their
 *  historical missing→empty behavior and return null. */
export function checkNamedConfigRef(ref: string): string | null {
    if (!ref || ref.trim().length === 0) return null;
    if (ref.includes("/") || ref.includes("\\") || existsSync(ref)) return null;
    const dir = configDir();
    if (existsSync(path.join(dir, `${ref}.json`))) return null;
    let names: string[] = [];
    try {
        names = readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.includes(".json."))
            .map((e) => e.name.slice(0, -5))
            .sort();
    } catch {
        // config dir absent — fresh install, no siblings to list
    }
    const hint = names.length > 0 ? ` Available: ${names.join(", ")} (in ${dir}).` : "";
    return `bili: named config "${ref}" not found (looked for ${path.join(dir, `${ref}.json`)}.${hint}`;
}

/** Main config file path. */
export function configFile(): string {
    const env = process.env.BILI_CONFIG_FILE;
    if (env && env.length > 0) return resolveConfigFileRef(env);
    return path.join(configDir(), "billion-context.json");
}

/** Root data dir: persistent session state lives here. */
export function dataDir(): string {
    return path.join(xdg("XDG_DATA_HOME", ".local/share"), "billion-context");
}

/** Sessions dir: one JSON file per session. */
export function sessionsDir(): string {
    const env = process.env.BILI_SESSIONS_DIR;
    if (env && env.length > 0) return path.resolve(env);
    return path.join(dataDir(), "sessions");
}

/** Root cache dir: transient/ephemeral data (update-check throttle, etc.). */
export function cacheDir(): string {
    return path.join(xdg("XDG_CACHE_HOME", ".cache"), "billion-context");
}

/** Root state dir: log files and other per-host state. */
export function stateDir(): string {
    return path.join(xdg("XDG_STATE_HOME", ".local/state"), "billion-context");
}

/** Default log file path. */
export function defaultLogFile(): string {
    return path.join(stateDir(), "bili.log");
}

/** Last-detected routing bypass for the claude lane (#2290): written by the
 *  SessionStart hook when the session environment indicates the managed
 *  ANTHROPIC_BASE_URL will not be honored (e.g. Claude Desktop overrides it),
 *  read by `bili doctor` to surface the finding after the fact. */
export function claudeRoutingWarningFile(): string {
    return path.join(stateDir(), "claude-routing-warning.json");
}
/** Body-dump dir (ACP_DUMP_BODY / BILI_DUMP_4XX): ACP_DUMP_DIR override first,
 *  else the XDG state dir so dumps co-locate with bili.log on every platform. */
export function dumpsDir(): string {
    const env = process.env.ACP_DUMP_DIR;
    if (env && env.length > 0) return env;
    return path.join(stateDir(), "dumps");
}

/** CA dir: root CA + dynamically-signed host certificates for MITM mode.
 *  Lives under the data dir (the private key is sensitive but regenerable).
 *  Created lazily by ca.ts on first MITM use. */
export function caDir(): string {
    return path.join(dataDir(), "ca");
}
