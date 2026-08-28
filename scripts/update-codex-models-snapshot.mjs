#!/usr/bin/env node
/** Refresh src/codex-models-snapshot.json from openai/codex's model table
 *  (codex-rs/models-manager/models.json on the main branch).
 *
 * The snapshot is committed to the repo and bundled into dist at build time
 * (same offline-floor pattern as registry-snapshot.json). It feeds the
 * #320 PR-E1 budget clamp: when a codex client (x-codex-turn-metadata header)
 * requests a model that is in this table, bili's effective window is clamped
 * to min(bili window, codex window) so ACP always compresses before codex's
 * own auto-compact ledger trips.
 *
 * Only the window fields are kept per model: auto_compact_token_limit is
 * null for every current entry (codex clamps to 90% of the window in code),
 * so it carries no information.
 *
 * Run manually or before a release:
 *     npm run codex:snapshot
 *
 * Node's global fetch ignores http(s)_proxy env vars, so the script tries the
 * configured shell proxy first (undici ProxyAgent) and falls back to a direct
 * connection. If BOTH fail, or the fetched table has no usable windows, the
 * existing snapshot is left untouched (exit 1).
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODELS_URL = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "codex-models-snapshot.json");
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;

async function attempt(dispatcher) {
    const res = await fetch(MODELS_URL, {
        ...(dispatcher ? { dispatcher } : {}),
        signal: AbortSignal.timeout(20_000),
        headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function fetchTable() {
    if (proxyUrl) {
        try {
            const { ProxyAgent } = await import("undici");
            const table = await attempt(new ProxyAgent({ uri: proxyUrl }));
            console.log(`fetched codex model table via proxy ${proxyUrl}`);
            return table;
        } catch (e) {
            console.log(`proxy attempt failed (${e.message}); trying direct`);
        }
    }
    const table = await attempt(undefined);
    console.log("fetched codex model table direct");
    return table;
}

let table;
try {
    table = await fetchTable();
} catch (e) {
    console.error(`could not fetch ${MODELS_URL}: ${e.message}`);
    console.error(`keeping the existing ${path.basename(OUT_FILE)} untouched`);
    process.exit(1);
}

const entries = Array.isArray(table?.models) ? table.models : [];
const models = {};
for (const entry of entries) {
    if (!entry || typeof entry.slug !== "string") continue;
    const slim = {};
    if (typeof entry.context_window === "number" && entry.context_window > 0) slim.context_window = entry.context_window;
    if (typeof entry.max_context_window === "number" && entry.max_context_window > 0) slim.max_context_window = entry.max_context_window;
    if (Object.keys(slim).length > 0) models[entry.slug] = slim;
}
const count = Object.keys(models).length;
if (count === 0) {
    console.error(`fetched table has ${entries.length} entries but no usable context windows — refusing to publish an empty snapshot`);
    console.error(`keeping the existing ${path.basename(OUT_FILE)} untouched`);
    process.exit(1);
}

const slim = { fetchedAt: new Date().toISOString(), source: "openai/codex codex-rs/models-manager/models.json", models };
const body = JSON.stringify(slim);
await writeFile(OUT_FILE, body, "utf8");
console.log(`wrote ${OUT_FILE} (${count} models with windows, ${(body.length / 1024).toFixed(1)} KB)`);
