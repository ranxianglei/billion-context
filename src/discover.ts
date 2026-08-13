// MITM domain auto-discovery. Cycle-free: imports only from client-config.js.
// MUST NOT import from launcher.ts (launcher → mitm → discover → launcher).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadClientConfig, resolvePiHome, nonEmpty, type ClientConfig } from "./client-config.js";

const TTL_MS = 2000;

// Local copy of launcher.ts's unwrapUpstream: importing it from launcher.ts
// would close the discover → launcher → mitm → discover cycle.
function unwrapUpstream(url: string): string {
    const idx = url.indexOf("/bili/");
    return idx >= 0 ? url.slice(idx + "/bili/".length) : url;
}

export function extractHttpsHosts(config: ClientConfig): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (raw: string | undefined): void => {
        if (typeof raw !== "string" || raw.length === 0) return;
        let url: URL;
        try {
            url = new URL(unwrapUpstream(raw));
        } catch {
            return;
        }
        if (url.protocol !== "https:") return;
        const host = url.hostname.toLowerCase();
        if (!host || seen.has(host)) return;
        seen.add(host);
        out.push(host);
    };

    if (nonEmpty(config.claude?.anthropicBaseUrl)) push(config.claude!.anthropicBaseUrl);
    if (config.codex) {
        for (const prov of Object.values(config.codex.providers)) push(prov.baseUrl);
        push(config.codex.openaiBaseUrl);
    }
    if (config.pi) {
        for (const prov of Object.values(config.pi.providers)) push(prov.baseUrl);
    }
    if (config.zcode) {
        for (const prov of Object.values(config.zcode.providers)) push(prov.baseURL);
    }
    return out;
}

function configFilePaths(env: NodeJS.ProcessEnv): string[] {
    const home = os.homedir();
    const codexHome = nonEmpty(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex");
    const zcodeHome = nonEmpty(env.ZCODE_DATA_BASE_DIR) ? env.ZCODE_DATA_BASE_DIR : path.join(home, ".zcode");
    return [
        path.join(home, ".claude", "settings.json"),
        path.join(process.cwd(), ".claude", "settings.json"),
        path.join(codexHome, "config.toml"),
        path.join(resolvePiHome(env), "models.json"),
        path.join(zcodeHome, "v2", "config.json"),
    ];
}

function readMtimes(paths: string[]): Map<string, number> {
    const mtimes = new Map<string, number>();
    for (const p of paths) {
        try {
            const st = fs.statSync(p);
            mtimes.set(p, st.mtimeMs);
        } catch {}
    }
    return mtimes;
}

function mtimesEqual(a: Map<string, number>, b: Map<string, number>): boolean {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
        if (b.get(k) !== v) return false;
    }
    return true;
}

interface Cache {
    checkedAt: number;
    mtimes: Map<string, number>;
    domains: string[];
}

let cache: Cache | null = null;

export function discoverMitmDomains(env: NodeJS.ProcessEnv = process.env): string[] {
    const now = Date.now();
    if (cache && (now - cache.checkedAt) < TTL_MS) {
        return cache.domains;
    }
    const paths = configFilePaths(env);
    const mtimes = readMtimes(paths);
    if (cache && mtimesEqual(mtimes, cache.mtimes)) {
        cache.checkedAt = now;
        return cache.domains;
    }
    const config = loadClientConfig(env, process.cwd());
    const domains = extractHttpsHosts(config);
    cache = { checkedAt: now, mtimes, domains };
    return domains;
}

export function _resetDiscoveryCacheForTest(): void {
    cache = null;
}
