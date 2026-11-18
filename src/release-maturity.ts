/**
 * #7139: pnpm minimumReleaseAge gate for the dsh desktop in-place lane.
 *
 * The dsh desktop profile is a pnpm-managed project. Its host can pin a
 * package-maturity policy — `minimumReleaseAge` (minutes) plus
 * `minimumReleaseAgeExclude` — a supply-chain rule that refuses to resolve
 * versions published less than N minutes ago. bili's in-place desktop refresh
 * (refreshDshDesktopCopy) installs the selected release's tarball directly and
 * converges the profile ledger, bypassing pnpm's resolver — so the policy has
 * to be enforced HERE, before the swap. Without it, a fresh release lands in
 * the profile before its maturity window elapses: the manifest then requests
 * a version the lockfile cannot resolve, and every subsequent pnpm operation
 * on the profile (even for unrelated packages) fails until the release
 * matures.
 *
 * Policy resolution mirrors pnpm's own precedence — per key, the FIRST source
 * that defines it wins:
 *   env pnpm_config_* → env npm_config_* → project pnpm-workspace.yaml →
 *   project .npmrc → user ~/.npmrc → global $XDG_CONFIG_HOME/pnpm/config.yaml
 *   → global $PREFIX/etc/npmrc.
 * Excludes travel with the source that defined them. A null/empty value in a
 * file (e.g. `minimumReleaseAge:` with nothing after, or a bare
 * `minimumReleaseAgeExclude:` with no list) is "not provided" and does not
 * shadow a value in a lower-precedence source; only an explicit value wins —
 * a number for the age (0 = policy off), or a list for the excludes (an
 * explicit empty list `[]` IS provided: it clears the excludes).
 *
 * Publish time comes from the registry packument's `time` map — the same
 * field pnpm's resolver reads (the tarball's Last-Modified is NOT reliable:
 * measured 12 s off the registry time). The full packument is large (tens of
 * MB for this package), so it is fetched at most once per target version: the
 * extracted time map is cached under cacheDir() as .registry-time-<pkg>.json,
 * and a hit for the target version means zero registry traffic on later
 * checks (the time map is append-only — entries never change). An in-process
 * memo bounds traffic when the cache dir is unwritable (the same degradation
 * the backoff state already accepts).
 *
 * Fail closed: whenever the policy or the publish time cannot be established
 * (unreadable/malformed config, registry without a time field, fetch failure),
 * the caller defers the refresh for this cycle — the host policy is never
 * bypassed, and no exclusion is silently added.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cacheDir } from "./paths.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import type { FetchOptions } from "./fetch-util.js";

const PACKUMENT_FETCH_TIMEOUT_MS = 30_000;

type MaturityVerdict =
    | { kind: "no-policy" }
    | { kind: "excluded"; spec: string; source: string }
    | { kind: "mature"; publishedAt: string; minAgeMinutes: number }
    | { kind: "immature"; publishedAt: string; minAgeMinutes: number; source: string }
    | { kind: "undatable"; reason: string };

interface ResolvedPolicy {
    /** undefined = no minimumReleaseAge defined in any source */
    minAgeMinutes: number | undefined;
    minAgeSource: string;
    excludeSpecs: string[];
    excludeSource: string;
}

type PolicyResolution = { ok: true; policy: ResolvedPolicy } | { ok: false; reason: string };

/** Resolve the profile's effective pnpm maturity policy (see module header
 *  for the source precedence). `ok: false` = the policy cannot be established
 *  — callers fail closed. */
export function resolveMaturityPolicy(projectDir: string, env: NodeJS.ProcessEnv): PolicyResolution {
    interface Source { label: string; minAgeRaw?: string; excludeRaw?: string }
    const sources: Source[] = [];
    for (const varName of ["pnpm_config_minimum_release_age", "npm_config_minimum_release_age"]) {
        const v = env[varName];
        if (v !== undefined && v.trim() !== "") sources.push({ label: `env ${varName}`, minAgeRaw: v.trim() });
    }
    for (const varName of ["pnpm_config_minimum_release_age_exclude", "npm_config_minimum_release_age_exclude"]) {
        const v = env[varName];
        if (v !== undefined && v.trim() !== "") sources.push({ label: `env ${varName}`, excludeRaw: v.trim() });
    }
    const home = env.HOME?.trim() ? env.HOME : os.homedir();
    const fileSources: Array<{ label: string; file: string; kind: "yaml" | "npmrc" }> = [
        { label: "project pnpm-workspace.yaml", file: path.join(projectDir, "pnpm-workspace.yaml"), kind: "yaml" },
        { label: "project .npmrc", file: path.join(projectDir, ".npmrc"), kind: "npmrc" },
        { label: "user ~/.npmrc", file: path.join(home, ".npmrc"), kind: "npmrc" },
        { label: "global pnpm config.yaml", file: path.join(env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"), "pnpm", "config.yaml"), kind: "yaml" },
    ];
    if (env.PREFIX?.trim()) fileSources.push({ label: "global $PREFIX/etc/npmrc", file: path.join(env.PREFIX.trim(), "etc", "npmrc"), kind: "npmrc" });
    for (const rs of fileSources) {
        let text: string;
        try {
            text = readFileSync(rs.file, "utf-8");
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") continue;
            return { ok: false, reason: `cannot read ${rs.label}: ${err instanceof Error ? err.message : String(err)}` };
        }
        const parsed = rs.kind === "yaml" ? parseYamlPolicyKeys(text) : parseNpmrcPolicyKeys(text);
        if (parsed.error) return { ok: false, reason: `${rs.label}: ${parsed.error}` };
        if (parsed.minAgeRaw !== undefined || parsed.excludeRaw !== undefined) {
            sources.push({ label: rs.label, minAgeRaw: parsed.minAgeRaw, excludeRaw: parsed.excludeRaw });
        }
    }
    let minAgeMinutes: number | undefined;
    let minAgeSource = "";
    let excludeSpecs: string[] | undefined;
    let excludeSource = "";
    for (const s of sources) {
        // a null/empty file value is "not provided" (pnpm semantics) — it does
        // NOT shadow a positive value in a lower-precedence source; only an
        // explicit number (including 0 = policy off) wins.
        if (minAgeMinutes === undefined && s.minAgeRaw !== undefined && s.minAgeRaw !== "") {
            const parsed = parseMinAgeMinutes(s.minAgeRaw);
            if (!parsed.ok) return { ok: false, reason: `${s.label}: ${parsed.reason}` };
            minAgeMinutes = parsed.minutes;
            minAgeSource = s.label;
        }
        if (excludeSpecs === undefined && s.excludeRaw !== undefined) {
            excludeSpecs = parseExcludeList(s.excludeRaw);
            excludeSource = s.label;
        }
    }
    return { ok: true, policy: { minAgeMinutes, minAgeSource, excludeSpecs: excludeSpecs ?? [], excludeSource } };
}

/** pnpm's exclude rule grammar (version-policy crate): `<name-pattern>[@<version-union>]`.
 *  A bare name (or a wildcard name WITHOUT a version part) excludes every
 *  version of a matching package; `name@1.0.0 || 2.0.0` excludes exactly the
 *  listed versions. A wildcard name combined with a version part is a pnpm
 *  config error — surfaced here as a parse error so the caller fails closed. */
export function matchMaturityExclude(
    specs: string[],
    packageName: string,
    version: string,
): { matched: true; spec: string } | { matched: false } | { error: string } {
    for (const spec of specs) {
        const rule = parseExcludeRule(spec);
        if ("error" in rule) return rule;
        if (!nameMatches(rule.name, packageName)) continue;
        if (rule.versions.length === 0) return { matched: true, spec };
        if (rule.versions.includes(version)) return { matched: true, spec };
    }
    return { matched: false };
}

/** The gate. `no-policy` / `excluded` / `mature` → the refresh may proceed;
 *  `immature` → defer (not a failure — the version matures on its own);
 *  `undatable` → fail closed (defer AND report — the caller records a strike). */
export async function checkReleaseMaturity(args: {
    projectDir: string;
    packageName: string;
    version: string;
    registryBase: string;
    env: NodeJS.ProcessEnv;
    resolveProxy?: (url: string) => string | undefined;
}): Promise<MaturityVerdict> {
    const resolution = resolveMaturityPolicy(args.projectDir, args.env);
    if (!resolution.ok) return { kind: "undatable", reason: resolution.reason };
    const { minAgeMinutes, minAgeSource, excludeSpecs, excludeSource } = resolution.policy;
    if (minAgeMinutes === undefined || minAgeMinutes <= 0) return { kind: "no-policy" };
    const excluded = matchMaturityExclude(excludeSpecs, args.packageName, args.version);
    if ("error" in excluded) return { kind: "undatable", reason: `invalid minimumReleaseAgeExclude rule: ${excluded.error}` };
    if (excluded.matched) return { kind: "excluded", spec: excluded.spec, source: excludeSource };
    const t = await fetchPublishTime({ packageName: args.packageName, version: args.version, registryBase: args.registryBase, resolveProxy: args.resolveProxy });
    if (!t.publishedAt) return { kind: "undatable", reason: t.error ?? `no publish time for ${args.packageName}@${args.version}` };
    const publishedMs = Date.parse(t.publishedAt);
    if (!Number.isFinite(publishedMs)) return { kind: "undatable", reason: `unparseable publish time "${t.publishedAt}" for ${args.packageName}@${args.version}` };
    if (Date.now() - publishedMs >= minAgeMinutes * 60_000) {
        return { kind: "mature", publishedAt: t.publishedAt, minAgeMinutes };
    }
    return { kind: "immature", publishedAt: t.publishedAt, minAgeMinutes, source: minAgeSource };
}

function parseMinAgeMinutes(raw: string): { ok: true; minutes: number } | { ok: false; reason: string } {
    if (!/^\d+$/.test(raw)) return { ok: false, reason: `minimumReleaseAge value "${raw}" is not a non-negative integer number of minutes` };
    const minutes = Number(raw);
    if (!Number.isSafeInteger(minutes)) return { ok: false, reason: `minimumReleaseAge value "${raw}" overflows` };
    return { ok: true, minutes };
}

function parseExcludeList(raw: string): string[] {
    return raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

function parseExcludeRule(spec: string): { name: string; versions: string[] } | { error: string } {
    const s = spec.trim();
    if (!s) return { error: "empty minimumReleaseAgeExclude entry" };
    const at = s.startsWith("@") ? s.indexOf("@", 1) : s.indexOf("@");
    const name = at === -1 ? s : s.slice(0, at);
    const rest = at === -1 ? "" : s.slice(at + 1);
    if (!name) return { error: `exclude rule "${spec}" has no package name` };
    if (rest === "") return { name, versions: [] };
    if (name.includes("*") || name.includes("?")) return { error: `wildcard name combined with a version part: "${spec}"` };
    const versions = rest.split("||").map((v) => v.trim());
    if (versions.some((v) => v === "")) return { error: `malformed version union in exclude rule "${spec}"` };
    return { name, versions };
}

function nameMatches(pattern: string, name: string): boolean {
    if (!/[*?]/.test(pattern)) return pattern === name;
    const rx = "^" + pattern.split("").map((c) => (c === "*" ? "[^]*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("") + "$";
    return new RegExp(rx).test(name);
}

// ——— config file readers (minimal, line-based; same hand-rolled precedent as
// ——— the pnpm-lock parsing in dsh-ledger.ts — zero runtime deps) ———

function parseNpmrcPolicyKeys(text: string): { minAgeRaw?: string; excludeRaw?: string; error?: string } {
    const out: { minAgeRaw?: string; excludeRaw?: string; error?: string } = {};
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim().toLowerCase();
        const val = line.slice(eq + 1).trim();
        if (key === "minimumreleaseage") {
            if (out.minAgeRaw !== undefined) { out.error = "duplicate minimumReleaseAge entry"; return out; }
            out.minAgeRaw = stripQuotes(val);
        } else if (key === "minimumreleaseageexclude") {
            if (out.excludeRaw !== undefined) { out.error = "duplicate minimumReleaseAgeExclude entry"; return out; }
            out.excludeRaw = stripQuotes(val);
        }
    }
    return out;
}

/** Top-level `minimumReleaseAge` / `minimumReleaseAgeExclude` only — the
 *  policy keys live at column 0 in pnpm-workspace.yaml / config.yaml. Other
 *  keys and their indented bodies are skipped; malformed content in OTHER
 *  keys cannot affect these two, but malformed content in OUR keys fails
 *  closed (returns an error). */
function parseYamlPolicyKeys(text: string): { minAgeRaw?: string; excludeRaw?: string; error?: string } {
    const out: { minAgeRaw?: string; excludeRaw?: string; error?: string } = {};
    const lines = text.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        i++;
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (/^\s/.test(line)) continue; // indented content under a key we don't parse
        const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/.exec(line);
        if (!m) continue; // not a `key: value` line (document marker, top-level list item, ...)
        const key = m[1];
        const rest = m[2] ?? "";
        if (key === "minimumReleaseAge") {
            if (out.minAgeRaw !== undefined) { out.error = "duplicate minimumReleaseAge key"; return out; }
            const v = stripInlineComment(rest).trim();
            if (v === "" || v === "~" || v.toLowerCase() === "null") { out.minAgeRaw = ""; continue; } // null value = "not set"
            out.minAgeRaw = stripQuotes(v);
        } else if (key === "minimumReleaseAgeExclude") {
            if (out.excludeRaw !== undefined) { out.error = "duplicate minimumReleaseAgeExclude key"; return out; }
            const v = stripInlineComment(rest).trim();
            if (v === "" || v === "~" || v.toLowerCase() === "null") {
                // a block list may follow; if none does, the value is null =
                // "not provided" (must not shadow a lower-precedence list)
                const items: string[] = [];
                let sawItem = false;
                while (i < lines.length) {
                    const l = lines[i];
                    const lt = l.trim();
                    if (!lt || lt.startsWith("#")) { i++; continue; }
                    if (!/^\s/.test(l)) break; // next top-level key — the value was null
                    const item = /^\s*-\s*(.*)$/.exec(l);
                    if (!item) { out.error = `expected a list of rules under minimumReleaseAgeExclude, got: ${lt}`; return out; }
                    i++;
                    sawItem = true;
                    items.push(stripQuotes(stripInlineComment(item[1]).trim()));
                }
                if (sawItem) out.excludeRaw = items.join(",");
            } else if (v.startsWith("[")) {
                if (!v.endsWith("]")) { out.error = "multi-line flow list for minimumReleaseAgeExclude is not supported"; return out; }
                const items = v.slice(1, -1).split(",").map((s) => stripQuotes(stripInlineComment(s).trim())).filter((s) => s !== "");
                out.excludeRaw = items.join(",");
            } else {
                out.error = `minimumReleaseAgeExclude must be a list of rules, got scalar "${v}"`;
                return out;
            }
        }
    }
    return out;
}

function stripInlineComment(s: string): string {
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inSingle) { if (c === "'") inSingle = false; continue; }
        if (inDouble) { if (c === '"') inDouble = false; continue; }
        if (c === "'") { inSingle = true; continue; }
        if (c === '"') { inDouble = true; continue; }
        if (c === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) return s.slice(0, i);
    }
    return s;
}

function stripQuotes(s: string): string {
    if (s.length >= 2) {
        const a = s[0];
        const b = s[s.length - 1];
        if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
    }
    return s;
}

// ——— publish time: registry packument `time` map, cached ———

interface TimeCacheDoc { fetchedAt: string; time: Record<string, string>; }

// In-process memo: bounds registry traffic when the cache dir is unwritable.
const timeMemo = new Map<string, string>();

function timeCachePath(packageName: string): string {
    return path.join(cacheDir(), `.registry-time-${packageName.replace(/[^a-zA-Z0-9@._-]/g, "_")}.json`);
}

async function readTimeCache(packageName: string): Promise<Record<string, string> | undefined> {
    try {
        const raw = await readFile(timeCachePath(packageName), "utf-8");
        const doc = JSON.parse(raw) as TimeCacheDoc;
        if (!doc || typeof doc !== "object" || !doc.time || typeof doc.time !== "object" || Array.isArray(doc.time)) return undefined;
        for (const v of Object.values(doc.time)) if (typeof v !== "string") return undefined;
        return doc.time;
    } catch {
        return undefined;
    }
}

async function writeTimeCache(packageName: string, time: Record<string, string>): Promise<void> {
    const p = timeCachePath(packageName);
    await mkdir(path.dirname(p), { recursive: true });
    const doc: TimeCacheDoc = { fetchedAt: new Date().toISOString(), time };
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, p);
}

/** Locate the packument `time` map without parsing the whole (tens-of-MB)
 *  document: find each `"time"` key, brace-scan its object (string-aware),
 *  and accept the first one that carries the target version with all-string
 *  values. npmjs places the top-level map after `versions` (near the end);
 *  scanning occurrences keeps this correct for any key order. */
function extractTimeObject(text: string, version: string): Record<string, string> | undefined {
    let from = 0;
    while (from < text.length) {
        const key = text.indexOf('"time"', from);
        if (key === -1) return undefined;
        let i = key + 6; // '"time"'.length
        while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
        if (text[i] === ":") i++;
        while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
        if (text[i] !== "{") { from = key + 6; continue; }
        const braceStart = i;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let end = -1;
        for (; i < text.length; i++) {
            const c = text[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === "\\") esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') inStr = true;
            else if (c === "{") depth++;
            else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end === -1) return undefined; // truncated document
        try {
            const obj: unknown = JSON.parse(text.slice(braceStart, end + 1));
            if (obj && typeof obj === "object" && !Array.isArray(obj)) {
                const rec = obj as Record<string, unknown>;
                if (typeof rec[version] === "string" && Object.values(rec).every((v) => typeof v === "string")) {
                    return rec as Record<string, string>;
                }
            }
        } catch {
            // not valid JSON at this occurrence — keep scanning
        }
        from = key + 5;
    }
    return undefined;
}

async function fetchPublishTime(args: {
    packageName: string;
    version: string;
    registryBase: string;
    resolveProxy?: (url: string) => string | undefined;
}): Promise<{ publishedAt?: string; error?: string }> {
    const memoKey = `${args.packageName}@${args.version}`;
    const memoHit = timeMemo.get(memoKey);
    if (memoHit) return { publishedAt: memoHit };
    const cached = await readTimeCache(args.packageName);
    const cachedAt = cached?.[args.version];
    if (cachedAt) {
        timeMemo.set(memoKey, cachedAt);
        return { publishedAt: cachedAt };
    }
    const url = `${args.registryBase}/${encodeURIComponent(args.packageName)}`;
    const dispatcher = proxyDispatcher(args.resolveProxy?.(url), PACKUMENT_FETCH_TIMEOUT_MS);
    const init: FetchOptions = {
        signal: AbortSignal.timeout(PACKUMENT_FETCH_TIMEOUT_MS),
        headers: { Accept: "application/json" },
        ...(dispatcher ? { dispatcher } : {}),
    };
    let res: Response;
    try {
        res = await fetch(url, init as RequestInit);
    } catch (err) {
        return { error: `registry fetch failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { error: `registry returned HTTP ${res.status} for ${args.packageName}` };
    }
    let text: string;
    try {
        text = await res.text();
    } catch (err) {
        return { error: `registry response read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const time = extractTimeObject(text, args.version);
    if (!time) return { error: `registry packument for ${args.packageName} carries no publish time for ${args.version}` };
    timeMemo.set(memoKey, time[args.version]);
    // best-effort: an unwritable cache dir degrades to the per-process memo
    await writeTimeCache(args.packageName, time).catch(() => undefined);
    return { publishedAt: time[args.version] };
}
