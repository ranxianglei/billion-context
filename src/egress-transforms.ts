// #6003 phase 2 — user-registerable egress request-body rewrite pipeline.
//
// Runs AFTER all session processing (shed / compress-loop rewrites) and BEFORE
// transport (v1Wrap / re-sign / dispatcher / fetch), so the re-sign invariant
// holds: the signature always covers the final shipped bytes. Purely additive —
// with no `egressTransforms` configured the callers short-circuit and nothing
// here ever runs (zero regression). Shared by the relay lane (main send + the
// five recovery re-sends) and the compress-loop lane (fetchUpstream).

import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { log as loggerLog } from "./logger.js";
import type { Logger } from "./logger.js";
import { configFile } from "./paths.js";

/** Optional scope filter: only rewrite outbound traffic whose upstream matches.
 *  All supplied keys are AND-ed together; an absent/empty `match` matches every
 *  upstream. */
export type EgressTransformMatch = {
    /** Rewrite only requests whose full upstream URL starts with this prefix. */
    urlPrefix?: string;
    /** Rewrite only requests whose upstream origin (scheme://host[:port]) equals
     *  this value, compared case-insensitively. */
    provider?: string;
};

/** One configured plugin, parsed from the top-level `egressTransforms` array.
 *  `module` is resolved to an absolute path at parse time; the remaining module
 *  fields (its own id/priority/match/timeoutMs) are merged in at load time as
 *  fallbacks for anything the config entry leaves unset. */
export type EgressTransformEntry = {
    /** Registration identity (config-side); falls back to the module's own `id`,
     *  then the module file basename, for logging. */
    id: string | undefined;
    module: string;
    enabled: boolean;
    priority: number | undefined;
    match: EgressTransformMatch | undefined;
    /** Original registration index — the stable tie-breaker for equal/unset
     *  priorities (spec: "同优先级并列时同样按注册顺序"). */
    order: number;
};

/** Context handed to each plugin's `transform`. `headers` is a LIVE reference to
 *  the outgoing header map — a successful plugin may mutate it directly, or
 *  return `headers` to merge. `body` is the current stage's outbound copy
 *  (string JSON text or Buffer). */
export type EgressTransformCtx = {
    sessionId: string | undefined;
    upstreamUrl: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | Buffer;
    protocol: string;
    model: string | undefined;
    /** "initial" (first send) | "retry" (relays recovery re-send) | "loop"
     *  (compress-loop round). */
    stage: "initial" | "retry" | "loop";
};

/** Everything `transform` needs except the per-stage body. Callers build this
 *  once per outbound request and hand it to {@link applyEgressTransforms}. */
export type EgressTransformBase = Omit<EgressTransformCtx, "body">;

/** What a plugin's `transform` returns. `undefined`/void = leave the body
 *  untouched. Returning a `body` replaces the outbound copy; `headers` merges;
 *  `reason` is a short human note for the debug log. */
export type EgressTransformResult =
    | undefined
    | { body?: string | Buffer; headers?: Record<string, string>; reason?: string };

/** Raw shape of a user egress-transform ESM default export (validated at load). */
export type EgressTransformModule = {
    id?: string;
    priority?: number;
    match?: EgressTransformMatch;
    timeoutMs?: number;
    transform: (ctx: EgressTransformCtx) => EgressTransformResult | Promise<EgressTransformResult>;
};

const DEFAULT_TIMEOUT_MS = 1000;

/** Resolve a configured `module` path to an absolute filesystem path. Relative
 *  paths are anchored at the directory holding the config file (matching the
 *  issue's `./plugins/tunnel.mjs` idiom); absolute paths pass through. */
function resolveEgressModulePath(module: string): string {
    if (isAbsolute(module)) return module;
    return resolve(dirname(configFile()), module);
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function coerceMatch(raw: unknown): EgressTransformMatch | undefined {
    if (!isRecord(raw)) return undefined;
    const out: EgressTransformMatch = {};
    if (typeof raw.urlPrefix === "string") out.urlPrefix = raw.urlPrefix;
    if (typeof raw.provider === "string") out.provider = raw.provider;
    return out.urlPrefix !== undefined || out.provider !== undefined ? out : undefined;
}

/** Parse the raw top-level `egressTransforms` config value into validated
 *  entries. Tolerant and fail-open: a malformed array becomes `[]` (with a warn),
 *  a malformed item is skipped (with a warn) — never throws, never breaks boot. */
export function parseEgressTransformEntries(raw: unknown): EgressTransformEntry[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
        loggerLog("warn", "[egress] config key \"egressTransforms\" must be an array; ignoring value");
        return [];
    }
    const out: EgressTransformEntry[] = [];
    raw.forEach((item, i) => {
        if (!isRecord(item)) {
            loggerLog("warn", `[egress] egressTransforms[${i}] is not an object; skipping`);
            return;
        }
        const module = typeof item.module === "string" ? item.module : undefined;
        if (!module) {
            loggerLog("warn", `[egress] egressTransforms[${i}] is missing a string "module"; skipping`);
            return;
        }
        const id = typeof item.id === "string" && item.id !== "" ? item.id : undefined;
        const enabled = typeof item.enabled === "boolean" ? item.enabled : true;
        const priority = typeof item.priority === "number" && Number.isFinite(item.priority) ? item.priority : undefined;
        const match = coerceMatch(item.match);
        out.push({ id, module: resolveEgressModulePath(module), enabled, priority, match, order: i });
    });
    return out;
}

// ---- Module loading (pinned per process generation, invalidated on reload) ----

type LoadedModule =
    | { ok: true; mod: EgressTransformModule }
    | { ok: false; err: string };

const moduleCache = new Map<string, LoadedModule>();

/** Clear the loaded-module cache. Called on `POST /__bili/config/reload` so a
 *  plugin's code (and any newly-added/removed entry) takes effect on the next
 *  request without a restart. Modules stay stable WITHIN a generation so a
 *  running session never swaps transform behavior mid-flight. */
export function resetEgressModuleCache(): void {
    moduleCache.clear();
}

function coerceModule(def: unknown): EgressTransformModule | null {
    if (!isRecord(def) || typeof def.transform !== "function") return null;
    const mod: EgressTransformModule = { transform: def.transform as EgressTransformModule["transform"] };
    if (typeof def.id === "string") mod.id = def.id;
    if (typeof def.priority === "number" && Number.isFinite(def.priority)) mod.priority = def.priority;
    mod.match = coerceMatch(def.match);
    if (typeof def.timeoutMs === "number" && Number.isFinite(def.timeoutMs) && def.timeoutMs > 0) mod.timeoutMs = def.timeoutMs;
    return mod;
}

async function loadModule(absPath: string): Promise<LoadedModule> {
    const cached = moduleCache.get(absPath);
    if (cached) return cached;
    let result: LoadedModule;
    try {
        if (!existsSync(absPath)) throw new Error(`module not found: ${absPath}`);
        // Cache-bust by mtime: Node's ESM loader caches by URL, so without this a
        // config reload would re-import the SAME stale namespace and an edited
        // plugin would never take effect. Within one generation the file is
        // stable, so the same URL is reused (consistent mid-session behavior).
        const v = statSync(absPath).mtimeMs;
        const ns = await import(`${pathToFileURL(absPath).href}?v=${v}`);
        const coerced = coerceModule(ns.default);
        if (coerced === null) throw new Error("default export must be an object with a transform(ctx) function");
        result = { ok: true, mod: coerced };
    } catch (e) {
        result = { ok: false, err: String(e instanceof Error ? e.message : e) };
    }
    moduleCache.set(absPath, result);
    return result;
}

// ---- The fail-open runner ----

function byteLen(body: string | Buffer): number {
    return Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, "utf8");
}

function deleteHeaderInsensitive(headers: Record<string, string>, name: string): void {
    const target = name.toLowerCase();
    for (const key of Object.keys(headers)) if (key.toLowerCase() === target) delete headers[key];
}

function matchUpstream(match: EgressTransformMatch | undefined, upstreamUrl: string): boolean {
    if (!match) return true;
    if (match.urlPrefix !== undefined && !upstreamUrl.startsWith(match.urlPrefix)) return false;
    if (match.provider !== undefined) {
        let origin: string | undefined;
        try { origin = new URL(upstreamUrl).origin; } catch { origin = undefined; }
        if (origin === undefined || origin.toLowerCase() !== match.provider.toLowerCase()) return false;
    }
    return true;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

/** Apply the registered egress transforms to one outbound body, in priority
 *  order (unset priority runs after all set ones, ties by registration order).
 *  FAIL-OPEN throughout: a plugin that throws, times out, or returns an illegal
 *  body is logged and skipped, and the pipeline continues with the PREVIOUS
 *  body — a single bad plugin can never break the request. Returns the final
 *  body (unchanged if nothing ran). Mutates `base.headers` only on a successful
 *  transform, and drops a now-stale `content-length` whenever the body bytes
 *  change. Emits one debug line per plugin that actually ran. */
export async function applyEgressTransforms(
    body: string | Buffer,
    base: EgressTransformBase,
    entries: readonly EgressTransformEntry[],
    log: Logger = loggerLog,
): Promise<string | Buffer> {
    if (entries.length === 0) return body;

    const resolved: Array<{ id: string; priority: number; order: number; match: EgressTransformMatch | undefined; timeoutMs: number; transform: EgressTransformModule["transform"] }> = [];
    for (const entry of entries) {
        if (!entry.enabled) continue;
        const loaded = await loadModule(entry.module);
        if (!loaded.ok) {
            log("error", `[egress] cannot load module "${entry.module}" (skipping, fail-open): ${loaded.err}`);
            continue;
        }
        const mod = loaded.mod;
        resolved.push({
            id: entry.id ?? mod.id ?? entry.module.split(/[\\/]/).pop()?.replace(/\.[cm]?[jt]s$/, "") ?? "egress",
            priority: entry.priority ?? mod.priority ?? Number.POSITIVE_INFINITY,
            order: entry.order,
            match: entry.match ?? mod.match,
            timeoutMs: mod.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            transform: mod.transform,
        });
    }
    if (resolved.length === 0) return body;

    // Stable: smaller priority first; unset (Infinity) sinks to the end; equal
    // priorities keep registration order.
    resolved.sort((a, b) => (a.priority - b.priority) || (a.order - b.order));

    let current = body;
    for (const t of resolved) {
        if (!matchUpstream(t.match, base.upstreamUrl)) continue;
        const ctx: EgressTransformCtx = { ...base, body: current };
        const inBytes = byteLen(current);
        let result: EgressTransformResult;
        try {
            result = await withTimeout(Promise.resolve(t.transform(ctx)), t.timeoutMs);
        } catch (e) {
            log("error", `[egress:${t.id}] stage=${base.stage} failed (fail-open, keeping previous body): ${String(e instanceof Error ? e.message : e)}`);
            continue;
        }
        if (result === undefined || result === null) {
            log("debug", `[${base.sessionId ?? "-"}] [egress:${t.id}] stage=${base.stage} in=${inBytes}B out=${inBytes}B (unchanged)`);
            continue;
        }
        if (result.body !== undefined && !Buffer.isBuffer(result.body) && typeof result.body !== "string") {
            log("error", `[egress:${t.id}] stage=${base.stage} returned an illegal body type (fail-open, keeping previous body)`);
            continue;
        }
        if (result.body !== undefined) current = result.body;
        if (result.headers !== undefined) {
            for (const [k, v] of Object.entries(result.headers)) {
                if (v === undefined) deleteHeaderInsensitive(base.headers, k);
                else base.headers[k] = String(v);
            }
        }
        const outBytes = byteLen(current);
        if (outBytes !== inBytes) deleteHeaderInsensitive(base.headers, "content-length");
        log("debug", `[${base.sessionId ?? "-"}] [egress:${t.id}] stage=${base.stage} in=${inBytes}B out=${outBytes}B${result.reason ? ` (${result.reason})` : ""}`);
    }
    return current;
}
