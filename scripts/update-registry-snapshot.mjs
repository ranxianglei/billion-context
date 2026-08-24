#!/usr/bin/env node
/** Refresh src/registry-snapshot.json from models.dev.

The slim snapshot is committed to the repo and bundled into dist at build
time, so a fresh install on a network where models.dev is unreachable (and
no upstream proxy is configured) still resolves exact model context windows
on the very first request — the hand-written CONTEXT_LIMIT_TABLE regex
fallback only has to cover custom/renamed models.

Run manually or before a release:
    npm run registry:snapshot

Node's global fetch ignores http(s)_proxy env vars, so the script tries the
configured shell proxy first (undici ProxyAgent) and falls back to a direct
connection. If BOTH fail the existing snapshot is left untouched (exit 1).
*/
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_URL = "https://models.dev/models.json";
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "registry-snapshot.json");
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;

async function attempt(dispatcher) {
    const res = await fetch(REGISTRY_URL, {
        ...(dispatcher ? { dispatcher } : {}),
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function fetchFull() {
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import("undici");
            const full = await attempt(new ProxyAgent({ uri: proxyUrl }));
            console.log(`fetched models.dev via proxy ${proxyUrl}`);
            return full;
        } catch (e) {
            console.log(`proxy attempt failed (${e.message}); trying direct`);
        }
    }
    const full = await attempt(undefined);
    console.log("fetched models.dev direct");
    return full;
}

let full;
try {
    full = await fetchFull();
} catch (e) {
    console.error(`could not fetch ${REGISTRY_URL}: ${e.message}`);
    console.error(`keeping the existing ${path.basename(OUT_FILE)} untouched`);
    process.exit(1);
}

const models = {};
for (const [key, entry] of Object.entries(full)) {
    const ctx = entry?.limit?.context;
    if (typeof ctx === "number" && ctx > 0) models[key] = ctx;
}
const slim = { fetchedAt: new Date().toISOString(), count: Object.keys(models).length, models };
const body = JSON.stringify(slim) + "\n";
await writeFile(OUT_FILE, body, "utf8");
console.log(`wrote ${OUT_FILE} (${slim.count} models, ${(body.length / 1024).toFixed(1)} KB)`);
