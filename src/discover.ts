// MITM domain auto-discovery. Cycle-free: imports only from client-config.js.
// MUST NOT import from launcher.ts (launcher → mitm → discover → launcher).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadClientConfig, resolvePiHome, resolveOmpHome, resolveCodebuddyHome, resolveQoderHome, resolveTraeHome, resolveZcodeHome, zcodePersonalConfigFiles, opencodeConfigFiles, aiderConfFiles, nonEmpty, QODER_DEFAULT_MODEL_HOSTS, TRAE_DEFAULT_MODEL_HOSTS, AIDER_DEFAULT_MODEL_HOSTS, OPENCODE_DEFAULT_MODEL_HOSTS, type ClientConfig } from "./client-config.js";

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
    // opencode/omp ride cert-MITM via HTTPS_PROXY; custom providers declared in
    // their configs (options.baseURL / baseUrl) blind-tunnel without this (#1411).
    for (const prov of Object.values(config.opencode?.providers ?? {})) {
        if (typeof prov.baseURL === "string") push(prov.baseURL);
    }
    for (const prov of Object.values(config.omp?.providers ?? {})) {
        if (typeof prov.baseUrl === "string") push(prov.baseUrl);
    }
    if (config.codebuddy) {
        push(config.codebuddy.codebuddyBaseUrl);
        for (const u of config.codebuddy.modelUrls ?? []) push(u);
    }
    if (config.qoder) {
        // qoder's model hosts are binary-hardcoded (no config file), so the
        // discovery set is the static default map — replaced entirely by an
        // explicit QODER_MODEL_SERVER_HOST (qoder's own resolution order).
        const hosts = nonEmpty(config.qoder.modelServerHost) ? [config.qoder.modelServerHost] : QODER_DEFAULT_MODEL_HOSTS;
        for (const h of hosts) push(`https://${h}`);
    }
    if (config.trae) {
        const hosts = nonEmpty(config.trae.modelApiHost) ? [config.trae.modelApiHost] : TRAE_DEFAULT_MODEL_HOSTS;
        for (const h of hosts) push(`https://${h}`);
    }
    if (config.aider) {
        // #1048: aider's endpoints come from runtime env / .aider.conf.yml /
        // CLI args (no persistent store). Declared URLs are full URLs (push
        // keeps the https ones); nothing declared → the common defaults.
        const urls = config.aider.baseUrls ?? [];
        if (urls.length > 0) {
            for (const u of urls) push(u);
        } else {
            for (const h of AIDER_DEFAULT_MODEL_HOSTS) push(`https://${h}`);
        }
    }
    if (config.opencode || config.omp) {
        // #1405: opencode's built-in zen gateway has no config file to
        // discover (auth-login users get their baseURL from the models.dev
        // catalog). Seeded for both pi-family lanes — omp runs zen models too
        // — and coexists with explicit provider base URLs (a user can mix
        // custom providers with zen models in one setup).
        for (const h of OPENCODE_DEFAULT_MODEL_HOSTS) push(`https://${h}`);
    }
    return out;
}

function configFilePaths(env: NodeJS.ProcessEnv): string[] {
    const home = os.homedir();
    const codexHome = nonEmpty(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, ".codex");
    const codebuddyHome = resolveCodebuddyHome(env);
    return [
        path.join(home, ".claude", "settings.json"),
        path.join(process.cwd(), ".claude", "settings.json"),
        path.join(codexHome, "config.toml"),
        path.join(resolvePiHome(env), "models.json"),
        path.join(resolveZcodeHome(env), "v2", "config.json"),
        ...zcodePersonalConfigFiles(resolveZcodeHome(env), env),
        path.join(codebuddyHome, "settings.json"),
        path.join(codebuddyHome, "models.json"),
        path.join(process.cwd(), ".codebuddy", "models.json"),
        path.join(resolveQoderHome(env), "settings.json"),
        path.join(resolveTraeHome(env), "traecli.yaml"),
        // Must mirror exactly what loadClientConfig reads for the fields
        // extractHttpsHosts consumes, or edits go stale in the mtime cache (#1411).
        ...opencodeConfigFiles(env),
        path.join(resolveOmpHome(env), "models.yml"),
        ...aiderConfFiles(process.cwd(), env),
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
