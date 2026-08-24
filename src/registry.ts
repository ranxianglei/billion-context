import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { cacheDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { fetchWithTimeout } from "./fetch-util.js";
import bundledSnapshot from "./registry-snapshot.json" with { type: "json" };

const REGISTRY_URL = "https://models.dev/models.json";
const CACHE_FILE = path.join(cacheDir(), "models-dev.json");
const TTL_MS = 24 * 60 * 60 * 1000;

type ModelEntry = { limit?: { context?: number; output?: number } };
type RegistryShape = Record<string, ModelEntry>;

let cache: RegistryShape | null = null;
let loading: Promise<RegistryShape | null> | null = null;

/** Full models.dev snapshot committed at src/registry-snapshot.json
 *  (refresh with `npm run registry:snapshot`) and inlined into dist at build
 *  time — the ENTIRE registry (all fields models.dev ships: name,
 *  description, reasoning, tool_call, modalities, limits, benchmarks, …),
 *  not a projection. Today only limit.context is consumed; the rest rides
 *  along so future features get the offline floor for free. Covers the
 *  cold-start-forever-offline case: a fresh install with no disk cache, an
 *  unreachable models.dev, and no upstream proxy still resolves exact
 *  per-model windows from the very first request, and the sync
 *  peekRegistryContext path is pre-warmed before any async fetch runs. */
type SnapshotShape = { fetchedAt?: unknown; models?: Record<string, ModelEntry> };
let snapshotReg: RegistryShape | null = null;
let snapshotMs = 0;
function bundledSnapshotRegistry(): RegistryShape | null {
    if (snapshotReg) return snapshotReg;
    const snap = bundledSnapshot as SnapshotShape;
    if (!snap || typeof snap !== "object" || !snap.models || typeof snap.models !== "object") return null;
    // Full entries are structurally valid ModelEntry (extra fields beyond
    // the declared shape ride along harmlessly — registryLookup only reads
    // limit.context and validates it at lookup time).
    snapshotReg = snap.models;
    const ts = typeof snap.fetchedAt === "string" ? Date.parse(snap.fetchedAt) : NaN;
    snapshotMs = Number.isFinite(ts) ? ts : 0;
    return snapshotReg;
}
// Pre-warm the sync peek path with the bundled snapshot. loadRegistry still
// upgrades `cache` past it (fresh disk cache / live fetch both outrank the
// build-time data); the identity check `cache !== snapshotReg` marks "still
// the seed, keep upgrading".
{
    const seed = bundledSnapshotRegistry();
    if (seed && !cache) cache = seed;
}

function parse(raw: string): RegistryShape | null {
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as RegistryShape;
        }
    } catch {
        // malformed — treat as miss
    }
    return null;
}

async function readDiskCache(): Promise<RegistryShape | null> {
    try {
        const raw = await readFile(CACHE_FILE, "utf8");
        return parse(raw);
    } catch {
        return null;
    }
}

async function writeDiskCache(data: RegistryShape): Promise<void> {
    try {
        await mkdir(path.dirname(CACHE_FILE), { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify(data), "utf8");
    } catch {
        // best-effort
    }
}

function diskCacheFresh(): boolean {
    if (!existsSync(CACHE_FILE)) return false;
    try {
        const { mtimeMs } = statSync(CACHE_FILE);
        return Date.now() - mtimeMs < TTL_MS;
    } catch {
        return false;
    }
}

/** Fetch the registry. Node's global fetch IGNORES http(s)_proxy env vars,
 *  so on networks where models.dev is unreachable directly (observed:
 *  direct connections time out while the shell proxy works) the registry
 *  was permanently dead and the stale built-in table became the only data
 *  source. Route through the configured upstream proxy when one exists
 *  (proxyDispatcher caches the ProxyAgent); fall back to a direct fetch
 *  when no proxy is configured or the proxied attempt fails. */
async function fetchFresh(): Promise<RegistryShape | null> {
    const dispatcher = proxyDispatcher(process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY);
    const attempts: Array<{ opts: Parameters<typeof fetchWithTimeout>[1]; label: string }> = dispatcher
        ? [{ opts: { dispatcher }, label: "via proxy" }, { opts: {}, label: "direct" }]
        : [{ opts: {}, label: "direct" }];
    for (const { opts, label } of attempts) {
        try {
            const { response, clearTimer } = await fetchWithTimeout(REGISTRY_URL, {
                ...opts,
                headers: { Accept: "application/json" },
            }, 15_000);
            const text = await response.text();
            clearTimer();
            if (!response.ok) continue;
            const parsed = parse(text);
            if (parsed) {
                await writeDiskCache(parsed);
                loggerLog("info", `[acp-registry] loaded models.dev (${Object.keys(parsed).length} models, ${label})`);
                return parsed;
            }
        } catch {
            // try the next transport
        }
    }
    return null;
}

export async function loadRegistry(): Promise<RegistryShape | null> {
    if (cache && cache !== snapshotReg) return cache;
    if (diskCacheFresh()) {
        const disk = await readDiskCache();
        if (disk) {
            cache = disk;
            return cache;
        }
    }
    if (loading) return loading;
    loading = (async () => {
        const fresh = await fetchFresh();
        if (fresh) {
            cache = fresh;
            loggerLog("info", `[acp-registry] loaded models.dev (${Object.keys(fresh).length} models)`);
            return fresh;
        }
        // Fetch failed. Last resort: stale disk cache vs the bundled snapshot —
        // whichever is newer wins (a release's snapshot can postdate a disk
        // cache that has been offline for months, and vice versa).
        const fallback = await pickFallback();
        if (fallback) {
            cache = fallback.reg;
            loggerLog("info", `[acp-registry] ${fallback.label}; fetch failed`);
            return fallback.reg;
        }
        loggerLog("warn", `[acp-registry] could not load models.dev registry (offline + no cache + no snapshot)`);
        return null;
    })();
    const result = await loading;
    loading = null;
    return result;
}

/** Pick between the stale on-disk cache and the build-time bundled snapshot
 *  by timestamp (newer wins). Exported for tests. */
export function newerFallback(diskMs: number | undefined, snapMs: number): "disk" | "snapshot" | "none" {
    const d = diskMs ?? 0;
    if (d > 0 && snapMs > 0) return d >= snapMs ? "disk" : "snapshot";
    if (d > 0) return "disk";
    if (snapMs > 0) return "snapshot";
    return "none";
}

async function pickFallback(): Promise<{ reg: RegistryShape; label: string } | null> {
    const snap = bundledSnapshotRegistry();
    let disk: RegistryShape | null = null;
    let diskMs = 0;
    if (existsSync(CACHE_FILE)) {
        disk = await readDiskCache();
        if (disk) {
            try {
                diskMs = statSync(CACHE_FILE).mtimeMs;
            } catch {
                diskMs = 0;
            }
        }
    }
    const choice = newerFallback(disk ? diskMs : undefined, snapshotMs);
    if (choice === "disk" && disk) {
        return { reg: disk, label: `using stale disk cache (${Object.keys(disk).length} models, ${new Date(diskMs).toISOString()})` };
    }
    if (choice === "snapshot" && snap) {
        return { reg: snap, label: `using bundled snapshot (${Object.keys(snap).length} models, ${new Date(snapshotMs).toISOString()})` };
    }
    return null;
}

const HOST_TO_PROVIDER: Record<string, string> = {
    "api.anthropic.com": "anthropic",
    "api.openai.com": "openai",
    "open.bigmodel.cn": "zhipuai",
    "open.bigmodel.com": "zhipuai",
    "coding.dashscope.aliyuncs.com": "dashscope",
    "api.deepseek.com": "deepseek",
    "api.moonshot.cn": "moonshot",
    "generativelanguage.googleapis.com": "google",
    "ai.comfly.org": "comfly",
    "api.minimax.chat": "minimax",
    "api.minimaxi.com": "minimax",
    "api.minimax.io": "minimax",
};

export function providerFromHost(host: string): string | undefined {
    const lower = host.toLowerCase();
    if (HOST_TO_PROVIDER[lower]) return HOST_TO_PROVIDER[lower];
    for (const [h, p] of Object.entries(HOST_TO_PROVIDER)) {
        // Boundary-safe suffix match: "api.openai.com" must NOT match a key
        // like "penai.com". Require an exact host match or a "."-delimited
        // subdomain (h === lower || lower.endsWith("." + h)). The reverse
        // direction (h.endsWith(lower)) is dropped — it matched arbitrary
        // substrings of the host and mis-classified providers.
        if (lower === h || lower.endsWith("." + h)) return p;
    }
    return undefined;
}

export async function contextFromRegistry(model: string, host?: string): Promise<number | undefined> {
    const reg = await loadRegistry();
    return registryLookup(reg, model, host);
}

/** Synchronous cache-only lookup: returns the window when the models.dev
 *  registry is ALREADY resident in memory, undefined otherwise (never
 *  triggers a fetch). Used to let a warm registry outrank the built-in
 *  CONTEXT_LIMIT_TABLE — the table is a static fallback that goes stale
 *  (DeepSeek was pinned at 64K long after the real window grew to 128K+),
 *  while the cached registry refreshes every 24h. Cold start still falls
 *  back to the table instantly; the async contextFromRegistry path later
 *  warms the cache for subsequent requests. */
export function peekRegistryContext(model: string, host?: string): number | undefined {
    return registryLookup(cache, model, host);
}

/** Test-only escape hatch: raw access to the bundled snapshot registry
 *  (for asserting the snapshot ships full entries, not projections). */
export function bundledRegistryForTestsOnly(): RegistryShape | null {
    return bundledSnapshotRegistry();
}

/** Lookup against the bundled build-time snapshot ONLY — never the runtime
 *  caches, never a fetch. Exposed for tests and diagnostics (verifying what
 *  the offline floor actually ships). */
export function bundledSnapshotLookup(model: string, host?: string): number | undefined {
    return registryLookup(bundledSnapshotRegistry(), model, host);
}

function registryLookup(reg: RegistryShape | null, model: string, host?: string): number | undefined {
    if (!reg || !model) return undefined;
    const provider = host ? providerFromHost(host) : undefined;
    const candidates = provider ? [`${provider}/${model}`, model] : [model];
    for (const key of candidates) {
        const entry = reg[key];
        const ctx = entry?.limit?.context;
        if (typeof ctx === "number" && ctx > 0) return ctx;
    }
    return undefined;
}

export function _resetForTest(): void {
    cache = null;
    loading = null;
}

export function _setForTest(data: RegistryShape): void {
    cache = data;
    loading = null;
}
