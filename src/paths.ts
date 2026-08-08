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
