// #5548 P2: stable per-install identity for percent bucketing (§4.1) — same
// persistence discipline as the dismissal store (state dir, best-effort fs).
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateDir } from "./paths.js";

const INSTALL_ID_FILE = "install-id";

function stateDirFor(env: NodeJS.ProcessEnv): string {
    const v = env.XDG_STATE_HOME;
    return v && v.length > 0 ? path.join(path.resolve(v), "billion-context") : stateDir();
}

let cached: { dir: string; id: string } | undefined;

/** Stable uuid persisted under the state dir. Returns "" when it cannot be
 *  persisted (read-only state) — percent-gated notices then hide rather than
 *  flicker buckets across restarts. */
export function installIdOf(env: NodeJS.ProcessEnv = process.env): string {
    const dir = stateDirFor(env);
    if (cached && cached.dir === dir) return cached.id;
    try {
        const file = path.join(dir, INSTALL_ID_FILE);
        try {
            const raw = fs.readFileSync(file, "utf8").trim();
            if (/^[0-9a-f-]{36}$/i.test(raw)) return (cached = { dir, id: raw }).id;
        } catch {
            // first run — no file yet
        }
        const id = randomUUID();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, id + "\n");
        return (cached = { dir, id }).id;
    } catch {
        return (cached = { dir, id: "" }).id;
    }
}
