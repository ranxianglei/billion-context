/**
 * #3619: staggered rollout + remote update-policy file.
 *
 * Two mechanisms around the self-updater's "newer version found" decision:
 *
 * 1. STAGGER — when an instance discovers a new version it does not upgrade
 *    immediately; it draws ONE random moment inside [minDelay, maxDelay]
 *    (default 15 min .. 48 h) and upgrades when that moment arrives. The draw
 *    is persisted under the cache dir keyed by (dist-tag, target version), so
 *    process restarts never re-roll — a restart-heavy machine must not keep
 *    drawing early values and defeat the spread. All copies on one machine
 *    share the same draw (one upgrade moment per machine; the spread happens
 *    ACROSS machines), consistent with the #1196 lockstep convergence design.
 *
 * 2. REMOTE POLICY FILE — a public JSON document in the official repo
 *    (auto-update-policy.json, served from raw.githubusercontent.com), fetched
 *    anonymously with ETag/If-None-Match. It controls WHEN to upgrade and which
 *    versions to skip/pin — NEVER what to install: the install target always
 *    comes from npm registry resolution (dist-tag doc / published version
 *    list), and the protocol has no field that can name a URL or force an
 *    arbitrary version number. Editing the file changes every instance's
 *    pacing within one check cycle, without a release.
 *
 * Security boundary (hard):
 *  - unknown schemaVersion = whole file ignored (forward-compat gate);
 *  - unknown fields are ignored (additive protocol);
 *  - blocked/pinned values must be PUBLISHED versions (validated against the
 *    registry packument); unverifiable entries are dropped;
 *  - pinned is an UPGRADE CEILING only — it never forces a downgrade (rollback
 *    is the advisory channel's job, #1481/#1588);
 *  - hold/stagger apply to AUTOMATIC updates only; an explicit `bili update`
 *    (force) bypasses timing but still respects blocked/pinned — those are
 *    version-level facts, not pacing.
 *
 * Fail-open everywhere: a fetch failure falls back to the last-good cached
 * copy (so a GitHub blip cannot lift an emergency hold) and then to local
 * defaults; a malformed document drops the cache and falls back to local
 * defaults. The updater keeps working in every degraded state.
 */
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { cacheDir } from "./paths.js";
import { log as loggerLog, type Logger } from "./logger.js";
import { proxyDispatcher } from "./upstream-proxy.js";
import { parseDurationField } from "./duration.js";

// --- defaults & constants ---

export const STAGGER_MIN_DELAY_DEFAULT_MS = 15 * 60_000; // 15 min
export const STAGGER_MAX_DELAY_DEFAULT_MS = 48 * 3_600_000; // 48 h
export const POLICY_URL_DEFAULT = "https://raw.githubusercontent.com/ranxianglei/billion-context/master/auto-update-policy.json";

const POLICY_SCHEMA_VERSION = 1;
const POLICY_FETCH_TIMEOUT_MS = 5_000;
const PACKUMENT_FETCH_TIMEOUT_MS = 10_000;
/** A cached policy older than this is too stale to act on after a fetch
 *  failure (its version references may be meaningless by then). */
const POLICY_STALE_CAP_MS = 30 * 86_400_000;
/** Typo guard: a delay field beyond one year would silently freeze upgrades
 *  for millennia — reject it instead of honoring it. */
const DELAY_SANITY_CAP_MS = 366 * 86_400_000;
const MAX_OVERRIDES = 64;
const MAX_BLOCKED = 100;
const PUBLISHED_VERSIONS_TTL_MS = 10 * 60_000;

const POLICY_CACHE_FILE_NAME = ".update-policy.json";
const STAGGER_FILE_NAME = ".update-stagger.json";
const STAGGER_PRUNE_MS = 7 * 86_400_000;

// --- semver (self-contained: this module must not import update.ts, which
//     imports this module — the gate lives inside the updater loop) ---

type ParsedSemver = { parts: [number, number, number]; pre: string[] };

const SEMVER_LOOSE_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.+)?$/;
/** Strict form for registry version identifiers (blocked/pinned values): no
 *  leading "v", no build-metadata-only tricks — exactly what npm publishes. */
const SEMVER_STRICT_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(version: string): ParsedSemver | undefined {
    const match = version.match(SEMVER_LOOSE_RE);
    if (!match) return undefined;
    return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4]?.split(".") ?? [] };
}

/** Full semver ordering: numeric tuple first, then prerelease rules
 *  (no-pre > pre; numeric pre-part < alphanumeric; shorter prefix < longer).
 *  Mirrors the comparison update.ts#isVersionNewer performs. */
function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
    for (let i = 0; i < 3; i++) {
        if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i] ? -1 : 1;
    }
    if (a.pre.length === 0 && b.pre.length === 0) return 0;
    if (a.pre.length === 0) return 1;
    if (b.pre.length === 0) return -1;
    const len = Math.max(a.pre.length, b.pre.length);
    for (let i = 0; i < len; i++) {
        const x = a.pre[i];
        const y = b.pre[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        if (xn && yn) {
            if (x !== y) return Number(x) < Number(y) ? -1 : 1;
        } else if (xn) {
            return -1;
        } else if (yn) {
            return 1;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return 0;
}

// --- semver ranges (the subset `overrides[].range` accepts) ---

type ComparatorOp = "eq" | "gt" | "gte" | "lt" | "lte";
type Comparator = { op: ComparatorOp; v: ParsedSemver };
/** OR of AND-groups; an empty group is "*" (matches any RELEASE). */
type SemverRange = Comparator[][];

function expandCaret(v: string): Comparator[] | undefined {
    const base = parseSemver(v);
    if (!base) return undefined;
    const [maj, min, pat] = base.parts;
    let upper: ParsedSemver;
    if (maj > 0) upper = { parts: [maj + 1, 0, 0], pre: [] };
    else if (min > 0) upper = { parts: [0, min + 1, 0], pre: [] };
    else upper = { parts: [0, 0, pat + 1], pre: [] };
    return [{ op: "gte", v: base }, { op: "lt", v: upper }];
}

function expandTilde(v: string): Comparator[] | undefined {
    const base = parseSemver(v);
    if (!base) return undefined;
    const [maj, min] = base.parts;
    return [{ op: "gte", v: base }, { op: "lt", v: { parts: [maj, min + 1, 0], pre: [] } }];
}

function parseComparatorToken(token: string): Comparator[] | undefined {
    const t = token.trim();
    if (t === "" || t === "*") return [];
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^\^(.+)$/))) return expandCaret(m[1]);
    if ((m = t.match(/^~(.+)$/))) return expandTilde(m[1]);
    if ((m = t.match(/^(>=|<=|>|<|=)?\s*(.+)$/))) {
        const v = parseSemver(m[2].trim());
        if (!v) return undefined;
        const opRaw = m[1] ?? "=";
        const op: ComparatorOp = opRaw === ">=" ? "gte" : opRaw === "<=" ? "lte" : opRaw === ">" ? "gt" : opRaw === "<" ? "lt" : "eq";
        return [{ op, v }];
    }
    return undefined;
}

/** Parse a range: `||`-separated OR groups of whitespace-ANDed comparators
 *  (=, >, >=, <, <=, bare version, *, ^caret, ~tilde). Returns undefined when
 *  any token is unparseable — callers fail open (entry/range ignored). */
export function parseSemverRange(range: string): SemverRange | undefined {
    const groups = range.split("||").map((g) => g.trim()).filter((g) => g.length > 0);
    if (groups.length === 0) return [[]];
    const out: SemverRange = [];
    for (const group of groups) {
        const comps: Comparator[] = [];
        for (const token of group.split(/\s+/)) {
            const parsed = parseComparatorToken(token);
            if (!parsed) return undefined;
            comps.push(...parsed);
        }
        out.push(comps);
    }
    return out;
}

function compareWithOp(cmp: number, op: ComparatorOp): boolean {
    switch (op) {
        case "eq": return cmp === 0;
        case "gt": return cmp > 0;
        case "gte": return cmp >= 0;
        case "lt": return cmp < 0;
        case "lte": return cmp <= 0;
    }
}

function satisfiesGroup(v: ParsedSemver, group: Comparator[]): boolean {
    // npm prerelease rule: a prerelease version satisfies a comparator set
    // only when some comparator carries a prerelease tag with the SAME
    // [major,minor,patch] tuple — otherwise prereleases never match.
    if (v.pre.length > 0) {
        const tagged = group.some((c) => c.v.pre.length > 0 && c.v.parts[0] === v.parts[0] && c.v.parts[1] === v.parts[1] && c.v.parts[2] === v.parts[2]);
        if (!tagged) return false;
    }
    return group.every((c) => compareWithOp(compareSemver(v, c.v), c.op));
}

export function satisfiesRange(version: string, range: SemverRange): boolean {
    const v = parseSemver(version);
    if (!v) return false;
    return range.some((group) => satisfiesGroup(v, group));
}

// --- policy document ---

type PolicyStaggerWindow = { minDelayMs?: number; maxDelayMs?: number };

type PolicyOverride = PolicyStaggerWindow & {
    /** Exact version match (mutually exclusive with `range`). */
    version?: string;
    /** Semver range match (mutually exclusive with `version`). */
    range?: SemverRange;
};

type UpdatePolicyDoc = {
    defaultWindow: PolicyStaggerWindow | undefined;
    overrides: PolicyOverride[];
    hold: boolean;
    /** Syntactically valid; published-ness validated at decision time. */
    blocked: string[];
    pinned: string | null;
};

function delayField(value: unknown, label: string, warnings: string[]): number | undefined {
    if (value === undefined) return undefined;
    // 0 is valid and meaningful: it means "no delay" (legacy immediate upgrade).
    if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= DELAY_SANITY_CAP_MS) return value;
    // Human-readable durations ("15m" / "2d" / "1d12h") — the preferred form
    // for hand-edited files; raw ms numbers stay valid for programmatic use.
    if (typeof value === "string") {
        const ms = parseDurationField(value);
        if (ms !== undefined && ms <= DELAY_SANITY_CAP_MS) return ms;
    }
    warnings.push(`${label}: invalid value ${JSON.stringify(value)} (a duration like "15m"/"2d"/"1d12h", or a non-negative integer ms ≤ ${DELAY_SANITY_CAP_MS}) — field ignored`);
    return undefined;
}

/** Validate + normalize the raw policy document. `doc: undefined` means
 *  "ignore the file entirely, use local defaults" (wrong shape or unknown
 *  schemaVersion). Malformed SUB-fields are dropped individually with a
 *  warning — one typo must not kill the rest of the document. */
export function normalizePolicyDoc(raw: unknown): { doc: UpdatePolicyDoc | undefined; error?: string; warnings: string[] } {
    const warnings: string[] = [];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { doc: undefined, error: "document is not a JSON object", warnings };
    }
    const p = raw as Record<string, unknown>;
    if (p.schemaVersion !== POLICY_SCHEMA_VERSION) {
        return { doc: undefined, error: `unsupported schemaVersion ${JSON.stringify(p.schemaVersion)} (supported: ${POLICY_SCHEMA_VERSION})`, warnings };
    }

    let defaultWindow: PolicyStaggerWindow | undefined;
    if (p.default !== undefined) {
        if (typeof p.default === "object" && p.default !== null && !Array.isArray(p.default)) {
            const d = p.default as Record<string, unknown>;
            const mn = delayField(d.minDelay, "default.minDelay", warnings);
            const mx = delayField(d.maxDelay, "default.maxDelay", warnings);
            if (mn !== undefined && mx !== undefined) {
                if (mn <= mx) defaultWindow = { minDelayMs: mn, maxDelayMs: mx };
                else warnings.push("default: minDelay > maxDelay — block ignored");
            } else if (mn !== undefined || mx !== undefined) {
                defaultWindow = {};
                if (mn !== undefined) defaultWindow.minDelayMs = mn;
                if (mx !== undefined) defaultWindow.maxDelayMs = mx;
            }
        } else {
            warnings.push("default: not an object — ignored");
        }
    }

    const overrides: PolicyOverride[] = [];
    if (p.overrides !== undefined) {
        if (!Array.isArray(p.overrides)) {
            warnings.push("overrides: not an array — ignored");
        } else {
            if (p.overrides.length > MAX_OVERRIDES) warnings.push(`overrides: more than ${MAX_OVERRIDES} entries — extras ignored`);
            for (const item of p.overrides.slice(0, MAX_OVERRIDES)) {
                if (typeof item !== "object" || item === null) {
                    warnings.push("overrides: non-object entry ignored");
                    continue;
                }
                const o = item as Record<string, unknown>;
                const entry: PolicyOverride = {};
                let selectorCount = 0;
                let usable = true;
                if (o.version !== undefined) {
                    if (typeof o.version === "string" && SEMVER_STRICT_RE.test(o.version)) {
                        entry.version = o.version;
                        selectorCount++;
                    } else {
                        warnings.push(`overrides: entry with invalid version ${JSON.stringify(o.version)} ignored`);
                        usable = false;
                    }
                }
                if (o.range !== undefined) {
                    if (typeof o.range === "string") {
                        const r = parseSemverRange(o.range);
                        if (r) {
                            entry.range = r;
                            selectorCount++;
                        } else {
                            warnings.push(`overrides: unparseable range ${JSON.stringify(o.range)} — ignored`);
                        }
                    } else {
                        warnings.push("overrides: range must be a string — ignored");
                    }
                }
                if (selectorCount === 0) {
                    warnings.push("overrides: entry without a usable version/range selector ignored");
                    continue;
                }
                if (selectorCount === 2) {
                    warnings.push(`overrides: entry has both version and range (${JSON.stringify({ version: o.version, range: o.range })}) — entry ignored`);
                    continue;
                }
                const mn = delayField(o.minDelay, "overrides[].minDelay", warnings);
                const mx = delayField(o.maxDelay, "overrides[].maxDelay", warnings);
                if (mn === undefined && mx === undefined) {
                    warnings.push("overrides: entry without min/max delay has no effect — ignored");
                    continue;
                }
                if (mn !== undefined && mx !== undefined && mn > mx) {
                    warnings.push("overrides: entry minDelay > maxDelay — entry ignored");
                    continue;
                }
                if (!usable) continue;
                if (mn !== undefined) entry.minDelayMs = mn;
                if (mx !== undefined) entry.maxDelayMs = mx;
                overrides.push(entry);
            }
        }
    }

    let hold = false;
    if (p.hold !== undefined) {
        if (typeof p.hold === "boolean") hold = p.hold;
        else warnings.push(`hold: not a boolean (${JSON.stringify(p.hold)}) — treated as false`);
    }

    let blocked: string[] = [];
    if (p.blocked !== undefined) {
        if (!Array.isArray(p.blocked)) {
            warnings.push("blocked: not an array — ignored");
        } else {
            if (p.blocked.length > MAX_BLOCKED) warnings.push(`blocked: more than ${MAX_BLOCKED} entries — extras ignored`);
            for (const item of p.blocked.slice(0, MAX_BLOCKED)) {
                if (typeof item === "string" && SEMVER_STRICT_RE.test(item) && !blocked.includes(item)) blocked.push(item);
                else warnings.push(`blocked: invalid version ${JSON.stringify(item)} (must be a published semver like "0.1.200") — entry ignored`);
            }
        }
    }

    let pinned: string | null = null;
    if (p.pinned !== undefined && p.pinned !== null) {
        if (typeof p.pinned === "string" && SEMVER_STRICT_RE.test(p.pinned)) pinned = p.pinned;
        else warnings.push(`pinned: invalid version ${JSON.stringify(p.pinned)} (must be null or a published semver) — treated as null`);
    }

    return { doc: { defaultWindow, overrides, hold, blocked, pinned }, warnings };
}

// --- stagger window resolution ---

/** Compose the effective stagger window for `candidate`:
 *  local config/env replaces the BASE window (remote `default` or the built-in
 *  15min..48h); remote `overrides` then stack ON TOP per version (an operator
 *  tuning a specific release outranks a single-machine preference). Exact
 *  `version` matches beat `range` matches; the first matching override wins.
 *  A min>max result clamps to a single point at max (conservative). */
export function resolveStaggerWindow(
    candidate: string,
    policy: UpdatePolicyDoc | undefined,
    localMinMs?: number,
    localMaxMs?: number,
): { minMs: number; maxMs: number } {
    const d = policy?.defaultWindow;
    let minMs = localMinMs ?? d?.minDelayMs ?? STAGGER_MIN_DELAY_DEFAULT_MS;
    let maxMs = localMaxMs ?? d?.maxDelayMs ?? STAGGER_MAX_DELAY_DEFAULT_MS;
    if (minMs > maxMs) minMs = maxMs;
    const overs = policy?.overrides ?? [];
    const match = overs.find((o) => o.version === candidate)
        ?? overs.find((o) => o.range !== undefined && satisfiesRange(candidate, o.range));
    if (match) {
        const nMin = match.minDelayMs ?? minMs;
        const nMax = match.maxDelayMs ?? maxMs;
        if (nMin > nMax) {
            // A one-sided override may cross the untouched side (e.g. base
            // min 10min + override max 60s — the issue's own fast-rollout
            // example). Collapse to the tighter bound: the operator's
            // explicit limit outranks the inherited side.
            minMs = nMax;
            maxMs = nMax;
        } else {
            minMs = nMin;
            maxMs = nMax;
        }
    }
    return { minMs, maxMs };
}

// --- stagger draw store (persisted, no re-roll across restarts) ---

type StaggerFile = { v: 1; draws: Record<string, number> };

async function readStaggerDraws(): Promise<Record<string, number>> {
    try {
        const text = await readFile(path.join(cacheDir(), STAGGER_FILE_NAME), "utf-8");
        const data = JSON.parse(text) as Partial<StaggerFile>;
        if (data.v !== 1 || typeof data.draws !== "object" || data.draws === null) return {};
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(data.draws)) {
            if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
        }
        return out;
    } catch {
        return {};
    }
}

async function persistStaggerDraw(key: string, at: number, now: number): Promise<void> {
    try {
        await mkdir(cacheDir(), { recursive: true });
        const draws = await readStaggerDraws();
        // Earliest draw wins: two processes racing on the same key converge
        // on the earlier moment (machine-wide consistency, #1196 lockstep).
        draws[key] = Math.min(draws[key] ?? at, at);
        for (const k of Object.keys(draws)) {
            if (now - draws[k] > STAGGER_PRUNE_MS) delete draws[k];
        }
        const file = path.join(cacheDir(), STAGGER_FILE_NAME);
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, JSON.stringify({ v: 1, draws }), "utf-8");
        await rename(tmp, file);
    } catch {
        // best-effort: the drawn moment is still returned in memory; a lost
        // persist just means a possible re-roll after the next restart
    }
}

export function staggerKey(tag: string, version: string): string {
    return `${tag}:${version}`;
}

/** Look up the persisted draw for `key`, or draw a fresh uniform moment in
 *  [now+minDelayMs, now+maxDelayMs] and persist it. `rand` is a test seam
 *  (fixed sources make draws deterministic). Never throws. */
export async function ensureStaggerDraw(args: {
    key: string;
    minDelayMs: number;
    maxDelayMs: number;
    now: number;
    rand?: () => number;
}): Promise<{ at: number; drawnNow: boolean }> {
    const span = Math.max(0, args.maxDelayMs - args.minDelayMs);
    const existing = (await readStaggerDraws())[args.key];
    if (existing !== undefined) return { at: existing, drawnNow: false };
    const rand = args.rand ?? Math.random;
    const at = args.now + args.minDelayMs + Math.floor(rand() * (span + 1));
    await persistStaggerDraw(args.key, at, args.now);
    return { at, drawnNow: true };
}

// --- remote policy fetch (ETag-cached, fail-open) ---

type PolicyCacheFile = { v: 1; etag?: string; fetchedAt: number; body: string };

async function readPolicyCache(): Promise<PolicyCacheFile | undefined> {
    try {
        const text = await readFile(path.join(cacheDir(), POLICY_CACHE_FILE_NAME), "utf-8");
        const data = JSON.parse(text) as Partial<PolicyCacheFile>;
        if (data.v !== 1 || typeof data.body !== "string" || typeof data.fetchedAt !== "number") return undefined;
        return { v: 1, etag: typeof data.etag === "string" ? data.etag : undefined, fetchedAt: data.fetchedAt, body: data.body };
    } catch {
        return undefined;
    }
}

async function writePolicyCache(c: PolicyCacheFile): Promise<void> {
    try {
        await mkdir(cacheDir(), { recursive: true });
        const file = path.join(cacheDir(), POLICY_CACHE_FILE_NAME);
        const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(tmp, JSON.stringify(c), "utf-8");
        await rename(tmp, file);
    } catch {
        // best-effort: worst case the next fetch re-downloads
    }
}

async function clearPolicyCache(): Promise<void> {
    try {
        await unlink(path.join(cacheDir(), POLICY_CACHE_FILE_NAME));
    } catch {
        // absent already — fine
    }
}

type PolicySource = "remote" | "stale-cache" | "local-default";

type PolicyState = {
    /** undefined = local defaults apply (no usable remote document). */
    doc: UpdatePolicyDoc | undefined;
    source: PolicySource;
    /** Last SUCCESSFUL remote fetch (epoch ms), whenever source came from. */
    fetchedAt?: number;
    error?: string;
    url: string;
};

let lastPolicyState: PolicyState | undefined;
const policyWarnedKeys = new Set<string>();

function policyLogOnce(log: Logger, key: string, level: "info" | "warn", message: string): void {
    if (policyWarnedKeys.has(key)) return;
    policyWarnedKeys.add(key);
    log(level, message);
}

function parseCachedBody(body: string): UpdatePolicyDoc | undefined {
    try {
        return normalizePolicyDoc(JSON.parse(body)).doc;
    } catch {
        return undefined;
    }
}

/** Visible state for /__bili/status (#3619: frozen/pinned must be visible). */
export function getUpdatePolicyState(): PolicyState | undefined {
    return lastPolicyState;
}

/** Fetch + validate the remote policy document. Fail-open ladder:
 *  live 200 → use it; 304 → keep the cache; failure → last-good cache within
 *  the staleness cap (keeps an emergency hold alive through GitHub blips);
 *  then local defaults. Malformed/unknown-schema documents drop the cache and
 *  fall back to local defaults NOW. Never throws. */
export async function loadUpdatePolicy(opts: {
    url: string;
    resolveProxy?: (url: string) => string | undefined;
    log?: Logger;
}): Promise<PolicyState> {
    const log = opts.log ?? loggerLog;
    const failOpen = async (error: string): Promise<PolicyState> => {
        const cached = await readPolicyCache();
        const doc = cached ? parseCachedBody(cached.body) : undefined;
        if (cached && doc && Date.now() - cached.fetchedAt <= POLICY_STALE_CAP_MS) {
            policyLogOnce(log, `stale:${opts.url}`, "warn", `[update-policy] fetch failed (${error}) — using last good policy from ${new Date(cached.fetchedAt).toISOString()} (#3619)`);
            const state: PolicyState = { doc, source: "stale-cache", fetchedAt: cached.fetchedAt, error, url: opts.url };
            lastPolicyState = state;
            return state;
        }
        policyLogOnce(log, `fetchfail:${error}`, "info", `[update-policy] fetch failed (${error}) — using local defaults (#3619)`);
        const state: PolicyState = { doc: undefined, source: "local-default", error, url: opts.url };
        lastPolicyState = state;
        return state;
    };

    const cached = await readPolicyCache();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;

    let res: Response;
    try {
        const dispatcher = proxyDispatcher(opts.resolveProxy?.(opts.url));
        res = await fetch(opts.url, {
            headers,
            signal: AbortSignal.timeout(POLICY_FETCH_TIMEOUT_MS),
            ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
    } catch (e) {
        return await failOpen(String(e));
    }

    if (res.status === 304) {
        if (cached) {
            const doc = parseCachedBody(cached.body);
            if (doc) {
                const state: PolicyState = { doc, source: "remote", fetchedAt: cached.fetchedAt, url: opts.url };
                lastPolicyState = state;
                return state;
            }
        }
        // 304 with no usable cache: nothing to validate against — defaults
        const state: PolicyState = { doc: undefined, source: "local-default", error: "304 without a local cache", url: opts.url };
        lastPolicyState = state;
        return state;
    }
    if (!res.ok) {
        return await failOpen(`policy source returned HTTP ${res.status}`);
    }

    let body: string;
    try {
        body = await res.text();
    } catch (e) {
        return await failOpen(`reading the policy body failed: ${String(e)}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        await clearPolicyCache();
        policyLogOnce(log, "malformed:invalid-json", "warn", `[update-policy] document is not valid JSON — ignoring it and using local defaults (#3619)`);
        const state: PolicyState = { doc: undefined, source: "local-default", error: "invalid JSON", url: opts.url };
        lastPolicyState = state;
        return state;
    }
    const norm = normalizePolicyDoc(parsed);
    if (!norm.doc) {
        await clearPolicyCache();
        policyLogOnce(log, `malformed:${norm.error}`, "warn", `[update-policy] ignoring policy document (${norm.error}) — using local defaults (#3619)`);
        const state: PolicyState = { doc: undefined, source: "local-default", error: norm.error, url: opts.url };
        lastPolicyState = state;
        return state;
    }
    const etag = res.headers.get("etag") ?? undefined;
    const fetchedAt = Date.now();
    await writePolicyCache({ v: 1, etag, fetchedAt, body });
    for (const w of norm.warnings) policyLogOnce(log, `warn:${w}`, "warn", `[update-policy] ${w}`);
    if (norm.doc.hold) {
        policyLogOnce(log, "hold-active", "warn", `[update-policy] HOLD active in the remote policy — auto-upgrades are frozen fleet-wide until the owner lifts it (#3619)`);
    }
    if (norm.doc.pinned !== null) {
        policyLogOnce(log, `pinned:${norm.doc.pinned}`, "warn", `[update-policy] fleet pinned at ${norm.doc.pinned} — nothing newer will be auto-installed until unpinned (#3619)`);
    }
    const state: PolicyState = { doc: norm.doc, source: "remote", fetchedAt, url: opts.url };
    lastPolicyState = state;
    return state;
}

// --- planned-upgrade surface (status visibility) ---

type PlannedUpgrade = { tag: string; version: string; at: number };

let lastPlannedUpgrade: PlannedUpgrade | undefined;

export function setPlannedUpgrade(p: PlannedUpgrade | undefined): void {
    lastPlannedUpgrade = p;
}

export function getPlannedUpgrade(): PlannedUpgrade | undefined {
    return lastPlannedUpgrade;
}

// --- published-version list (packument) + candidate resolution ---

let publishedVersionsCache: { url: string; fetchedAt: number; versions: string[] } | undefined;

/** The registry's full packument version list for one package, TTL-cached per
 *  process. Only fetched when pin/block controls are active. undefined on any
 *  failure — callers treat that as "cannot validate, defer this cycle". */
export async function fetchPublishedVersions(opts: {
    url: string;
    resolveProxy?: (url: string) => string | undefined;
}): Promise<string[] | undefined> {
    if (publishedVersionsCache && publishedVersionsCache.url === opts.url && Date.now() - publishedVersionsCache.fetchedAt < PUBLISHED_VERSIONS_TTL_MS) {
        return publishedVersionsCache.versions;
    }
    try {
        const dispatcher = proxyDispatcher(opts.resolveProxy?.(opts.url));
        const res = await fetch(opts.url, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(PACKUMENT_FETCH_TIMEOUT_MS),
            ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
        if (!res.ok) return undefined;
        const data = (await res.json()) as { versions?: Record<string, unknown> };
        if (typeof data.versions !== "object" || data.versions === null) return undefined;
        const versions = Object.keys(data.versions).filter((v) => SEMVER_STRICT_RE.test(v));
        publishedVersionsCache = { url: opts.url, fetchedAt: Date.now(), versions };
        return versions;
    } catch {
        return undefined;
    }
}

type CandidateResolution =
    | { kind: "proceed"; candidate: string }
    | { kind: "none"; reason: string }
    | { kind: "deferred"; reason: string };

/** Pure core: pick the install candidate under pin/block controls. The
 *  candidate ALWAYS comes from the registry's published list — the policy
 *  file can only subtract (ceiling / skip), never name what gets installed.
 *  Unpublished pinned/blocked values are dropped (spec security boundary). */
export function resolveCandidateAgainstPolicy(args: {
    currentVersion: string;
    latest: string;
    doc: UpdatePolicyDoc;
    publishedVersions: readonly string[];
}): CandidateResolution {
    const { currentVersion, doc, publishedVersions } = args;
    const publishedSet = new Set(publishedVersions);
    let pinned = doc.pinned;
    if (pinned !== null && !publishedSet.has(pinned)) pinned = null;
    const blocked = new Set(doc.blocked.filter((v) => publishedSet.has(v)));
    const current = parseSemver(currentVersion);
    const candidates = publishedVersions
        .filter((v) => !blocked.has(v))
        .map((v) => ({ v, p: parseSemver(v)! }))
        .filter((x) => (current ? compareSemver(x.p, current) > 0 : true))
        .sort((a, b) => compareSemver(b.p, a.p));
    if (pinned !== null) {
        const pinP = parseSemver(pinned)!;
        const ceiled = candidates.filter((x) => compareSemver(x.p, pinP) <= 0);
        if (ceiled.length === 0) {
            return { kind: "none", reason: `fleet pinned at ${doc.pinned}: nothing newer than ${currentVersion} sits under the ceiling` };
        }
        candidates.length = 0;
        candidates.push(...ceiled);
    }
    if (candidates.length === 0) {
        const reason = blocked.size > 0
            ? `all newer versions are blocked by the remote policy (${[...blocked].join(", ")})`
            : "no published version newer than the current one";
        return { kind: "none", reason };
    }
    return { kind: "proceed", candidate: candidates[0].v };
}

/** Async wrapper: fetches the packument when needed, logs validation drops
 *  once, defers (retry next cycle) when the registry cannot be consulted —
 *  installing anything requires the registry anyway, so deferring is safe. */
export async function resolveUpgradeCandidate(args: {
    currentVersion: string;
    latest: string;
    doc: UpdatePolicyDoc;
    packumentUrl: string;
    resolveProxy?: (url: string) => string | undefined;
    log?: Logger;
}): Promise<CandidateResolution> {
    const log = args.log ?? loggerLog;
    if (args.doc.pinned === null && args.doc.blocked.length === 0) {
        return { kind: "proceed", candidate: args.latest };
    }
    const versions = await fetchPublishedVersions({ url: args.packumentUrl, resolveProxy: args.resolveProxy });
    if (!versions) {
        return { kind: "deferred", reason: "pin/block controls are active but the registry packument could not be fetched — retrying next cycle" };
    }
    const droppedPinned = args.doc.pinned !== null && !versions.includes(args.doc.pinned);
    const droppedBlocked = args.doc.blocked.filter((v) => !versions.includes(v));
    if (droppedPinned) {
        policyLogOnce(log, `unpublished-pin:${args.doc.pinned}`, "warn", `[update-policy] pinned value ${args.doc.pinned} is not a published version — pin ignored (#3619)`);
    }
    for (const v of droppedBlocked) {
        policyLogOnce(log, `unpublished-block:${v}`, "warn", `[update-policy] blocked value ${v} is not a published version — entry ignored (#3619)`);
    }
    return resolveCandidateAgainstPolicy({ currentVersion: args.currentVersion, latest: args.latest, doc: args.doc, publishedVersions: versions });
}

// --- test seams ---

export function _resetUpdatePolicyForTest(): void {
    lastPolicyState = undefined;
    lastPlannedUpgrade = undefined;
    policyWarnedKeys.clear();
    publishedVersionsCache = undefined;
}
