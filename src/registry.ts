import type { PriceProfile } from "acp-kernel";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { cacheDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { fetchWithTimeout } from "./fetch-util.js";
import bundledSnapshot from "./registry-snapshot.json" with { type: "json" };

// catalog.json (not models.json): models.json carries no pricing fields at
// all; the per-model $/Mtok cost rows live nested under
// providers.<host>.models.<id>.cost in catalog.json (#1279 follow-up).
const REGISTRY_URL = "https://models.dev/catalog.json";
const CACHE_FILE = path.join(cacheDir(), "models-dev.json");
const TTL_MS = 24 * 60 * 60 * 1000;

type ModelEntry = { limit?: { context?: number; output?: number } };
type RegistryShape = Record<string, ModelEntry>;
// Per-host pricing row flattened from catalog.json's
// providers.<host>.models.<id>.cost ($/Mtok). Only rows with a usable input
// price are stored — without an input anchor there is nothing to normalize
// against, and half-inventing a profile would misprice every fold.
type CostRow = { input: number; output?: number; cache_read?: number; cache_write?: number };
type CostsShape = Record<string, CostRow>;
type LoadedRegistry = { reg: RegistryShape; costs: CostsShape | null };

let cache: RegistryShape | null = null;
let costCache: CostsShape | null = null;
let loading: Promise<RegistryShape | null> | null = null;
const warnedConflicts = new Set<string>();
const warnedPriceConflicts = new Set<string>();

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
type SnapshotShape = { fetchedAt?: unknown; models?: Record<string, ModelEntry>; costs?: Record<string, unknown> };
let snapshotReg: RegistryShape | null = null;
let snapshotCosts: CostsShape | null = null;
let snapshotMs = 0;
function bundledSnapshotRegistry(): RegistryShape | null {
    if (snapshotReg) return snapshotReg;
    const snap = bundledSnapshot as SnapshotShape;
    if (!snap || typeof snap !== "object" || !snap.models || typeof snap.models !== "object") return null;
    // Full entries are structurally valid ModelEntry (extra fields beyond
    // the declared shape ride along harmlessly — registryLookup only reads
    // limit.context and validates it at lookup time).
    snapshotReg = snap.models;
    snapshotCosts = sanitizeCosts(snap.costs);
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
    if (seed && !cache) {
        cache = seed;
        costCache = snapshotCosts;
    }
}

function sanitizeCosts(raw: unknown): CostsShape | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out: CostsShape = {};
    let any = false;
    for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const input = (value as { input?: unknown }).input;
        if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) continue;
        out[key] = value as CostRow;
        any = true;
    }
    return any ? out : null;
}

function parse(raw: string): LoadedRegistry | null {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        // New format {models, costs}; legacy flat maps (pre-cost disk caches
        // written by older releases) remain readable after an upgrade.
        if (parsed.models && typeof parsed.models === "object" && !Array.isArray(parsed.models)) {
            return { reg: parsed.models as RegistryShape, costs: sanitizeCosts((parsed as { costs?: unknown }).costs) };
        }
        return { reg: parsed as RegistryShape, costs: null };
    } catch {
        // malformed — treat as miss
    }
    return null;
}

async function readDiskCache(): Promise<LoadedRegistry | null> {
    try {
        const raw = await readFile(CACHE_FILE, "utf8");
        return parse(raw);
    } catch {
        return null;
    }
}

async function writeDiskCache(data: LoadedRegistry): Promise<void> {
    try {
        await mkdir(path.dirname(CACHE_FILE), { recursive: true });
        await writeFile(CACHE_FILE, JSON.stringify({ models: data.reg, costs: data.costs }), "utf8");
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
function flattenProviderCosts(providers: unknown): CostsShape | null {
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return null;
    const out: CostsShape = {};
    let any = false;
    for (const [pid, p] of Object.entries(providers as Record<string, { models?: Record<string, { cost?: unknown }> }>)) {
        const models = p?.models;
        if (!models || typeof models !== "object" || Array.isArray(models)) continue;
        for (const [mid, m] of Object.entries(models)) {
            const c = m?.cost;
            if (!c || typeof c !== "object" || Array.isArray(c)) continue;
            const input = (c as { input?: unknown }).input;
            if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) continue;
            out[`${pid}/${mid}`] = c as CostRow;
            any = true;
        }
    }
    return any ? out : null;
}

function parseCatalog(raw: string): LoadedRegistry | null {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        if (!parsed.models || typeof parsed.models !== "object" || Array.isArray(parsed.models)) return null;
        return { reg: parsed.models as RegistryShape, costs: flattenProviderCosts((parsed as { providers?: unknown }).providers) };
    } catch {
        // malformed — treat as miss
    }
    return null;
}

async function fetchFresh(): Promise<LoadedRegistry | null> {
    const dispatcher = proxyDispatcher(process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY, 15_000);
    const attempts: Array<{ opts: Parameters<typeof fetchWithTimeout>[1]; label: string }> = dispatcher
        ? [{ opts: { dispatcher }, label: "via proxy" }, { opts: {}, label: "direct" }]
        : [{ opts: {}, label: "direct" }];
    for (const { opts, label } of attempts) {
        try {
            const { response, clearTimer } = await fetchWithTimeout(REGISTRY_URL, {
                ...opts,
                headers: { Accept: "application/json" },
                redirect: "follow",
            }, 15_000);
            const text = await response.text();
            clearTimer();
            if (!response.ok) continue;
            const loaded = parseCatalog(text);
            if (loaded) {
                await writeDiskCache(loaded);
                loggerLog("info", `[acp-registry] loaded models.dev (${Object.keys(loaded.reg).length} models, ${loaded.costs ? Object.keys(loaded.costs).length : 0} price rows, ${label})`);
                return loaded;
            }
            loggerLog("warn", "[acp-registry] models.dev returned unparseable JSON");
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
            cache = disk.reg;
            costCache = disk.costs;
            // A legacy flat disk cache (pre-costs release) carries no price
            // rows: serving it wholesale would silently blank stamps for the
            // whole 24h TTL even though the bundled snapshot has prices. Fall
            // through to a fresh fetch instead (offline keeps it as net via
            // pickFallback, matching the pre-costs status quo).
            if (disk.costs !== null) return cache;
        }
    }
    if (loading) return loading;
    loading = (async () => {
        const fresh = await fetchFresh();
        if (fresh) {
            cache = fresh.reg;
            costCache = fresh.costs;
            loggerLog("info", `[acp-registry] loaded models.dev (${Object.keys(fresh.reg).length} models, ${fresh.costs ? Object.keys(fresh.costs).length : 0} price rows)`);
            return fresh.reg;
        }
        // Fetch failed. Last resort: stale disk cache vs the bundled snapshot —
        // whichever is newer wins (a release's snapshot can postdate a disk
        // cache that has been offline for months, and vice versa).
        const fallback = await pickFallback();
        if (fallback) {
            cache = fallback.reg;
            costCache = fallback.costs;
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

async function pickFallback(): Promise<{ reg: RegistryShape; costs: CostsShape | null; label: string } | null> {
    const snap = bundledSnapshotRegistry();
    let disk: LoadedRegistry | null = null;
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
        return { reg: disk.reg, costs: disk.costs, label: `using stale disk cache (${Object.keys(disk.reg).length} models, ${new Date(diskMs).toISOString()})` };
    }
    if (choice === "snapshot" && snap) {
        return { reg: snap, costs: snapshotCosts, label: `using bundled snapshot (${Object.keys(snap).length} models, ${new Date(snapshotMs).toISOString()})` };
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

/** #853: synchronous cache-only OUTPUT-ceiling lookup for the preflight
 *  summary cap. Same residency rules as peekRegistryContext: the cache is
 *  pre-warmed with the bundled snapshot at module load (offline floor) and
 *  upgrades to the disk cache / live models.dev data once loadRegistry runs
 *  (server traffic resolves windows, warming it) — so this never fetches,
 *  never blocks, and never returns stale-beyond-the-last-registry-sync data.
 *  Callers clamp their own default against the result; undefined = no known
 *  ceiling. */
export function peekRegistryOutputLimit(model: string, host?: string): number | undefined {
    return registryLookup(cache, model, host, "output");
}

/** #1279 follow-up: synchronous cache-only PRICE lookup for the cache-
 *  economics report. Same residency rules as peekRegistryContext (pre-warmed
 *  bundled floor, upgraded by loadRegistry, never fetches). Returns ABSOLUTE
 *  $/Mtok values (w=cache-write — input when the provider charges no write
 *  premium —, r=cache-read, q=output), not relative ratios —
 *  out-of-box reports read in real money; kernel-side conventions fill
 *  partial rows (r = 0.1×input, q = 1.5×input). Rows without a usable input
 *  price yield undefined: a profile anchored on nothing would misprice every
 *  fold. Name resolution mirrors registryLookup (#736 roots/variants);
 *  known-provider hosts resolve their own listing first, unknown relays take
 *  the FIRST listing in key order (deterministic per snapshot) and warn once
 *  on conflicting prices — unlike windows there is no max to take, because
 *  prices are not comparable across deployments. User config at any level
 *  wins wholesale at the stamp site; this is only the unconfigured default. */
export function peekRegistryPriceProfile(model: string | undefined, host?: string): PriceProfile | undefined {
    const costs = costCache;
    if (!costs || !model) return undefined;
    const provider = host ? providerFromHost(host) : undefined;
    const roots = [model];
    const slash = model.lastIndexOf("/");
    if (slash > 0 && slash < model.length - 1) roots.push(model.slice(slash + 1));
    const names: string[] = [];
    for (const root of roots) {
        for (const variant of modelVariants(root)) {
            if (!names.includes(variant)) names.push(variant);
        }
    }
    for (const name of names) {
        const candidates = provider ? [`${provider}/${name}`, name] : [name];
        for (const key of candidates) {
            const profile = priceProfileFromRow(costs[key]);
            if (profile) return profile;
        }
        if (provider === undefined) {
            const suffix = `/${name}`;
            let chosen: PriceProfile | undefined;
            const seen = new Set<string>();
            const parts: string[] = [];
            for (const key of Object.keys(costs)) {
                if (!key.endsWith(suffix)) continue;
                const profile = priceProfileFromRow(costs[key]);
                if (!profile) continue;
                const sig = `${profile.w}|${profile.r}|${profile.q}`;
                if (!seen.has(sig)) {
                    seen.add(sig);
                    parts.push(`${key}=in:${profile.w}/out:${profile.q}`);
                }
                if (!chosen) chosen = profile;
            }
            if (chosen !== undefined) {
                if (seen.size > 1 && !warnedPriceConflicts.has(name)) {
                    warnedPriceConflicts.add(name);
                    loggerLog("warn", `[acp-registry] conflicting prices for "${name}" (${parts.join(", ")}) — using the first listing; set compress.priceProfile to override`);
                }
                return chosen;
            }
        }
    }
    return undefined;
}

function priceProfileFromRow(row: CostRow | undefined): PriceProfile | undefined {
    if (!row) return undefined;
    // Kernel contract (cache-report): w prices the cache-WRITE re-upload of
    // the fold — (w−r)·T. Providers charging a write premium (Anthropic-style
    // 1.25×) carry cache_write; everyone else reuses the input price.
    const w = typeof row.cache_write === "number" && Number.isFinite(row.cache_write) && row.cache_write > 0 ? row.cache_write : row.input;
    if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) return undefined;
    const r = typeof row.cache_read === "number" && Number.isFinite(row.cache_read) && row.cache_read >= 0 ? row.cache_read : 0.1 * w;
    const q = typeof row.output === "number" && Number.isFinite(row.output) && row.output >= 0 ? row.output : 4 * w;
    // Derived multipliers carry binary float noise (0.1 * 6 = 0.6000000000000001);
    // the profile is printed verbatim in the report header, so normalize it away.
    const norm = (x: number): number => Math.round(x * 1e10) / 1e10;
    return { w: norm(w), r: norm(r), q: norm(q) };
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

/** Bundled-snapshot-only output ceiling (#853) — the offline floor a fresh
 *  install resolves before any cache exists. Exposed for tests/diagnostics
 *  (what ships in the box), like bundledSnapshotLookup above. */
export function bundledSnapshotOutputLimit(model: string, host?: string): number | undefined {
    return registryLookup(bundledSnapshotRegistry(), model, host, "output");
}

// Inference-mode suffixes denoting the SAME base model under a different
// reasoning setting (a "-thinking" variant shares the base model's context
// window). Longest-first so "-interleaved-thinking" wins over "-thinking".
const VARIANT_SUFFIXES = [
    "-interleaved-thinking",
    "-thinking",
    "-reasoning",
    "-extended",
    "-fast",
    "-high",
    "-medium",
    "-low",
];

export function modelVariants(name: string): string[] {
    const variants: string[] = [name];
    let current = name;
    for (;;) {
        let stripped = false;
        for (const suffix of VARIANT_SUFFIXES) {
            if (current.length > suffix.length && current.endsWith(suffix)) {
                current = current.slice(0, -suffix.length);
                variants.push(current);
                stripped = true;
                break;
            }
        }
        if (!stripped) break;
    }
    return variants;
}

function registryLookup(reg: RegistryShape | null, model: string, host: string | undefined, field: "context" | "output"): number | undefined;
function registryLookup(reg: RegistryShape | null, model: string, host?: string): number | undefined;
function registryLookup(reg: RegistryShape | null, model: string, host?: string, field: "context" | "output" = "context"): number | undefined {
    if (!reg || !model) return undefined;
    const provider = host ? providerFromHost(host) : undefined;
    // Relay/vLLM deployments serve models under arbitrary "prefix/name" ids
    // ("qwen/qwen3.8-27b") that match no models.dev provider key (the registry
    // stores "alibaba/qwen3.8-27b"): the exact key misses and the suffix scan
    // looks for keys ending in "/qwen/qwen3.8-27b", which also never exist —
    // the registry data was present and fresh yet unreachable, so the stale
    // built-in table won forever (#736). Try the bare basename after the full
    // name so a genuinely listed prefixed id still keeps precedence.
    const roots = [model];
    const slash = model.lastIndexOf("/");
    if (slash > 0 && slash < model.length - 1) roots.push(model.slice(slash + 1));
    const names: string[] = [];
    for (const root of roots) {
        for (const variant of modelVariants(root)) {
            if (!names.includes(variant)) names.push(variant);
        }
    }
    for (const name of names) {
        const candidates = provider ? [`${provider}/${name}`, name] : [name];
        for (const key of candidates) {
            const entry = reg[key];
            const value = entry?.limit?.[field];
            if (typeof value === "number" && value > 0) return value;
        }
        // Relay host (not in HOST_TO_PROVIDER): the bare name can miss while
        // the model exists under a provider-prefixed key (a relay serving
        // "deepseek-v4-flash" is stored as "deepseek/deepseek-v4-flash"). Scan
        // */<name> and take the MAXIMUM window across matches when they
        // disagree: max is never smaller than any single declared deployment,
        // so compression thresholds never fire earlier than some real
        // deployment would allow; conflicts are logged once per name. Zero
        // valid matches falls through to the next (stripped) variant.
        // Known-provider hosts do not cross-provider scan: a miss means the
        // model is genuinely unlisted for that provider (its stripped
        // variants still get their exact-key chance above).
        if (provider === undefined) {
            const suffix = `/${name}`;
            let max: number | undefined;
            const distinct = new Set<number>();
            const parts: string[] = [];
            for (const key of Object.keys(reg)) {
                if (!key.endsWith(suffix)) continue;
                const value = reg[key].limit?.[field];
                if (typeof value !== "number" || value <= 0) continue;
                if (max === undefined || value > max) max = value;
                distinct.add(value);
                parts.push(`${key}=${value}`);
            }
            if (max !== undefined) {
                if (distinct.size > 1 && !warnedConflicts.has(name)) {
                    warnedConflicts.add(name);
                    loggerLog("warn", `[acp-registry] conflicting ${field === "context" ? "context windows" : "output ceilings"} for "${name}" (${parts.join(", ")}) — using max ${max}`);
                }
                return max;
            }
        }
    }
    return undefined;
}

export function _resetForTest(): void {
    cache = null;
    costCache = null;
    loading = null;
    warnedConflicts.clear();
    warnedPriceConflicts.clear();
}

export function _setForTest(data: RegistryShape, costs?: CostsShape | null): void {
    cache = data;
    costCache = costs ?? null;
    loading = null;
}
