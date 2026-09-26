#!/usr/bin/env node
/** Refresh src/registry-snapshot.json from models.dev.

The FULL registry is committed to the repo and bundled into dist at build
-time (hard-coded into the code), so a fresh install on a network where
models.dev is unreachable (and no upstream proxy is configured) still has
the entire dataset — every field models.dev ships (name, description,
family, reasoning, tool_call, modalities, limits, benchmarks, …), not just
context windows. limit.context and per-model pricing (cost rows) are
consumed today; everything else rides along for future features.

Source endpoint: https://models.dev/catalog.json — NOT models.json.
models.json carries NO pricing fields at all (verified 0 cost keys across
all 427 models); the per-model $/Mtok cost rows (input/output/cache_read/…)
live nested under providers.<host>.models.<id>.cost in catalog.json, whose
top-level `models` object is identical to models.json (verified entry-for-
entry), so windows data is unchanged while the offline floor gains prices
(#1279 follow-up). The snapshot stores both: `models` (flat, as before) and
`costs` flattened to "<host>/<model-id>" keys, keeping host-specific
pricing distinct (the same model listed by several hosts at different
prices). Only rows with a usable numeric input price are stored — without
an input anchor there is nothing to normalize against.

Run manually or before a release:
    npm run registry:snapshot

Node's global fetch ignores http(s)_proxy env vars, so the script tries the
configured shell proxy first (undici ProxyAgent) and falls back to a direct
connection. If BOTH fail the existing snapshot is left untouched (exit 1).
*/
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_URL = "https://models.dev/catalog.json";
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

let catalog;
try {
    catalog = await fetchFull();
} catch (e) {
    console.error(`could not fetch ${REGISTRY_URL}: ${e.message}`);
    console.error(`keeping the existing ${path.basename(OUT_FILE)} untouched`);
    process.exit(1);
}

if (!catalog || typeof catalog !== "object" || !catalog.models || typeof catalog.models !== "object" || Array.isArray(catalog.models)) {
    console.error(`unexpected catalog.json shape (missing top-level "models") — refusing to overwrite the snapshot`);
    process.exit(1);
}

function flattenCosts(providers) {
    const costs = {};
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return costs;
    for (const [pid, p] of Object.entries(providers)) {
        const models = p && typeof p === "object" ? p.models : null;
        if (!models || typeof models !== "object" || Array.isArray(models)) continue;
        for (const [mid, m] of Object.entries(models)) {
            const c = m && typeof m === "object" ? m.cost : null;
            if (!c || typeof c !== "object" || Array.isArray(c)) continue;
            if (typeof c.input !== "number" || !Number.isFinite(c.input) || c.input <= 0) continue;
            costs[`${pid}/${mid}`] = c;
        }
    }
    return costs;
}

const slim = { fetchedAt: new Date().toISOString(), count: Object.keys(catalog.models).length, models: catalog.models, costs: flattenCosts(catalog.providers) };
const body = JSON.stringify(slim) + "\n";
await writeFile(OUT_FILE, body, "utf8");
console.log(`wrote ${OUT_FILE} (${slim.count} models, ${Object.keys(slim.costs).length} cost rows, ${(body.length / 1024).toFixed(1)} KB)`);
