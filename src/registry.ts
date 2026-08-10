import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { cacheDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";

const REGISTRY_URL = "https://models.dev/models.json";
const CACHE_FILE = path.join(cacheDir(), "models-dev.json");
const TTL_MS = 24 * 60 * 60 * 1000;

type ModelEntry = { limit?: { context?: number; output?: number } };
type RegistryShape = Record<string, ModelEntry>;

let cache: RegistryShape | null = null;
let loading: Promise<RegistryShape | null> | null = null;

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
        const { mtimeMs } = require("node:fs").statSync(CACHE_FILE);
        return Date.now() - mtimeMs < TTL_MS;
    } catch {
        return false;
    }
}

async function fetchFresh(): Promise<RegistryShape | null> {
    try {
        const res = await fetch(REGISTRY_URL, {
            signal: AbortSignal.timeout(15_000),
            headers: { Accept: "application/json" },
        });
        if (!res.ok) return null;
        const text = await res.text();
        const parsed = parse(text);
        if (parsed) await writeDiskCache(parsed);
        return parsed;
    } catch {
        return null;
    }
}

export async function loadRegistry(): Promise<RegistryShape | null> {
    if (cache) return cache;
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
        const disk = await readDiskCache();
        if (disk) {
            cache = disk;
            loggerLog("info", `[acp-registry] using stale disk cache (${Object.keys(disk).length} models, fetch failed)`);
            return disk;
        }
        loggerLog("warn", `[acp-registry] could not load models.dev registry (offline + no cache)`);
        return null;
    })();
    const result = await loading;
    loading = null;
    return result;
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
