import { createHash } from "node:crypto";
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

/** Main config file path. */
export function configFile(): string {
    const env = process.env.BILI_CONFIG_FILE;
    if (env && env.length > 0) return path.resolve(env);
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

/** Directory NAME (not path) for a session-scoped subtree under retrieve/.
 *  mNNNNN refs are PER-SESSION sequence numbers, so the session id must be part
 *  of the path — a flat layout lets two sessions' same-numbered refs silently
 *  overwrite each other's artifacts (#4699; the img-spill tree hit the same
 *  collision class first). The salt keeps id -> name injective for ids that
 *  sanitize to the same form ("a/b" vs "a-b", >100-char truncation); ids that
 *  need no sanitizing keep their historical unsalted name. */
export function retrieveSessionDirName(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
    return safe === sessionId
        ? (safe || "session")
        : `${safe || "session"}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 8)}`;
}

/** Per-session CCR text-export dir: <stateDir>/retrieve/<sessionId>/.
 *  Retrieval exports are pure cache — a re-retrieve regenerates the file — so
 *  they share the session's lifecycle (co-deleted and age-swept by GC, #4699). */
export function retrievalExportDir(sessionId: string): string {
    return path.join(stateDir(), "retrieve", retrieveSessionDirName(sessionId));
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
