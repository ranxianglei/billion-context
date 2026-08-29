#!/usr/bin/env node
/** Refresh src/codex-models-snapshot.json from openai/codex (main branch).

The snapshot is the SLIM form of codex's bundled model table
(codex-rs/models-manager/models.json) — only the fields bili consumes for
budget alignment (#321 PR-E1): slug, contextWindow, maxContextWindow, and the
optional autoCompactTokenLimit / effectiveContextWindowPercent. The full
upstream file is ~424KB of tool/modality metadata bili never reads; the slim
form keeps the bundle small and the contract explicit.

Run manually or before a release:
    npm run codex-models:snapshot

Node's global fetch ignores http(s)_proxy env vars, so the script tries the
configured shell proxy first (undici ProxyAgent) and falls back to a direct
connection. If BOTH fail the existing snapshot is left untouched (exit 1).
*/
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json";
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "codex-models-snapshot.json");
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;

async function attempt(dispatcher) {
    const res = await fetch(SOURCE_URL, {
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
            console.log(`fetched openai/codex via proxy ${proxyUrl}`);
            return full;
        } catch (e) {
            console.log(`proxy attempt failed (${e.message}); trying direct`);
        }
    }
    const full = await attempt(undefined);
    console.log("fetched openai/codex direct");
    return full;
}

let full;
try {
    full = await fetchFull();
} catch (e) {
    console.error(`could not fetch ${SOURCE_URL}: ${e.message}`);
    console.error(`keeping the existing ${path.basename(OUT_FILE)} untouched`);
    process.exit(1);
}

const models = Array.isArray(full?.models) ? full.models : null;
if (!models || models.length === 0) {
    console.error("unexpected upstream shape: expected { models: [...] }");
    console.error(`keeping the existing ${path.basename(OUT_FILE)} untouched`);
    process.exit(1);
}

const slim = models.map((m) => {
    const e = { slug: m.slug };
    for (const [k, key] of [
        ["context_window", "contextWindow"],
        ["max_context_window", "maxContextWindow"],
        ["auto_compact_token_limit", "autoCompactTokenLimit"],
        ["effective_context_window_percent", "effectiveContextWindowPercent"],
    ]) {
        if (m[k] !== null && m[k] !== undefined) e[key] = m[k];
    }
    return e;
});

const body = JSON.stringify({
    source: `openai/codex main — codex-rs/models-manager/models.json`,
    fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    count: slim.length,
    models: slim,
}) + "\n";
await writeFile(OUT_FILE, body, "utf8");
console.log(`wrote ${OUT_FILE} (${slim.length} models, ${(body.length / 1024).toFixed(1)} KB)`);
