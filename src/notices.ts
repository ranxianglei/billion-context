// #5548 unified announcement surface (design v2, owner-approved): three sources
// (A built-in declarations / B local JSON / C remote GitHub raw) feed ONE
// renderer through shared pure filter/sort functions and one dismissal store.
// P1 landed lane A; P2 adds lane B's machinery here: the whitelist validator,
// the targeting gates (versions matcher / percent bucketing / since-until
// window), the id@hash16 dismissal keys, and layer merging (B > C > A).
// Pure module: no fs, no io — the dismissal store stays in pck-notice.ts, the
// local-file loader in local-announcements.ts.

import { createHash } from "node:crypto";

export type NoticeKind = "new-feature" | "upgrade-advisory" | "warning" | "suggestion" | "incident" | "deprecation" | "other";
type NoticeTone = "ok" | "warn" | "info";
type NoticeDismiss = "persistent" | "instance" | "always";
/** Multilang copy: locale object (keys like "zh-CN"/"en") or a plain string. */
type NoticeText = string | Record<string, string>;

export interface NoticeRecord {
    id: string;
    kind: NoticeKind;
    title: NoticeText;
    desc?: NoticeText;
    hint?: NoticeText;
    ctaLabel?: NoticeText;
    ctaUrl?: string;
    /** Explicit tone overrides the kind-derived one (toneOf). */
    tone?: NoticeTone;
    /** persistent (default) | instance (process-only) | always (never hidden, no close button). */
    dismiss?: NoticeDismiss;
    /** 0–100; absent/null falls back to the kind default in KIND_PRIORITY. */
    priority?: number | null;
    /** ISO8601 UTC; sort tiebreak after priority (newer first). */
    publishedAt?: string;
    // Targeting dimensions (§4.1) — AND-combined, applied to EVERY source:
    versions?: string[];
    percent?: number | null;
    since?: string;
    until?: string;
}

/** Server-side state a built-in declaration's active predicate may read. */
interface BuiltInContext {
    /** effectivePromptCacheRouting() result ("disabled"/"auto"/"enabled"). */
    promptCacheRouting: string;
    /** True when the user wrote an explicit pluginFullResendWatermark rollout override. */
    wmOverridePresent: boolean;
}

interface BuiltinNotice extends NoticeRecord {
    active: (ctx: BuiltInContext) => boolean;
}

const KIND_PRIORITY: Record<NoticeKind, number> = {
    incident: 90,
    "upgrade-advisory": 80,
    warning: 70,
    deprecation: 60,
    suggestion: 50,
    "new-feature": 40,
    other: 30,
};

export function priorityOf(rec: Pick<NoticeRecord, "kind" | "priority">): number {
    return typeof rec.priority === "number" ? rec.priority : KIND_PRIORITY[rec.kind];
}

/** Kind-derived tone: new-feature→ok, warning/incident/deprecation→warn, rest→info. */
export function toneOf(rec: Pick<NoticeRecord, "kind" | "tone">): NoticeTone {
    if (rec.tone) return rec.tone;
    if (rec.kind === "new-feature") return "ok";
    if (rec.kind === "warning" || rec.kind === "incident" || rec.kind === "deprecation") return "warn";
    return "info";
}

export function dismissModeOf(rec: Pick<NoticeRecord, "dismiss">): NoticeDismiss {
    return rec.dismiss ?? "persistent";
}

/** Visible under the record's dismiss mode. Persistent keys are
 *  `id@hash16(record)`; a legacy bare-id entry (pre-P2 stores) still counts,
 *  so an upgrade never re-shows a banner the user already closed. */
export function noticeVisible(
    rec: NoticeRecord,
    dismissedPersistent: ReadonlySet<string>,
    dismissedInstance: ReadonlySet<string> = new Set(),
): boolean {
    const mode = dismissModeOf(rec);
    if (mode === "always") return true;
    if (mode === "instance") return !dismissedInstance.has(rec.id);
    return !(dismissedPersistent.has(dismissKeyOf(rec)) || dismissedPersistent.has(rec.id));
}

/** Stable sort: priority desc, then publishedAt desc (missing timestamps last). */
export function sortNotices<T extends NoticeRecord>(list: readonly T[]): T[] {
    const ts = (r: NoticeRecord): number => {
        const t = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
        return Number.isNaN(t) ? -Infinity : t;
    };
    return [...list].sort((a, b) => {
        const pa = priorityOf(a), pb = priorityOf(b);
        if (pa !== pb) return pb - pa;
        const ta = ts(a), tb = ts(b);
        if (ta !== tb) return tb - ta;
        return 0;
    });
}

/** Merge notice layers by id — earlier layers win (B local > C remote > A
 *  built-in, §三). Input order within a layer is preserved. */
export function mergeNoticeLayers(layers: readonly (readonly NoticeRecord[])[]): NoticeRecord[] {
    const seen = new Set<string>();
    const out: NoticeRecord[] = [];
    for (const layer of layers) {
        for (const rec of layer) {
            if (seen.has(rec.id)) continue;
            seen.add(rec.id);
            out.push(rec);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// P2 lane B: validation, targeting gates, dismissal hashing (§4)
// ---------------------------------------------------------------------------

export const NOTICE_KINDS: readonly NoticeKind[] = ["new-feature", "upgrade-advisory", "warning", "suggestion", "incident", "deprecation", "other"];
const NOTICE_TONES: readonly NoticeTone[] = ["ok", "warn", "info"];
const DISMISS_MODES: readonly NoticeDismiss[] = ["persistent", "instance", "always"];
const NOTICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TEXT_LIMITS = { title: 120, desc: 600, hint: 300, ctaLabel: 120 } as const;
const CTA_URL_MAX = 200;
const NOTICE_FIELDS: readonly string[] = [
    "id", "kind", "title", "desc", "hint", "ctaLabel", "ctaUrl",
    "tone", "dismiss", "priority", "publishedAt", "versions", "percent", "since", "until",
];

type TextCheck = { ok: true; value: NoticeText } | { ok: false; reason: string };

function checkText(v: unknown, field: string, limit: number): TextCheck {
    if (typeof v === "string") {
        return v.length <= limit ? { ok: true, value: v } : { ok: false, reason: `${field} exceeds ${limit} chars` };
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
        const entries = Object.entries(v as Record<string, unknown>);
        if (entries.length === 0) return { ok: false, reason: `${field}: empty locale object` };
        for (const [k, val] of entries) {
            if (typeof val !== "string" || val.length > limit) {
                return { ok: false, reason: `${field}[${k}] must be a string ≤${limit} chars` };
            }
        }
        return { ok: true, value: v as Record<string, string> };
    }
    return { ok: false, reason: `${field} must be a string or locale object` };
}

function isKind(v: unknown): v is NoticeKind {
    return typeof v === "string" && (NOTICE_KINDS as readonly string[]).includes(v);
}

function isIso8601(v: unknown): v is string {
    return typeof v === "string" && Number.isFinite(Date.parse(v));
}

function isIntInRange(v: unknown, lo: number, hi: number): v is number {
    return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

/** Whitelist validator (§4): unknown fields are dropped (reported, not fatal);
 *  a bad value invalidates ONLY this record. Returns the cleaned record. */
export function validateNoticeRecord(raw: unknown): { ok: true; rec: NoticeRecord; droppedFields: string[] } | { ok: false; reason: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "record is not an object" };
    const src = raw as Record<string, unknown>;
    const droppedFields = Object.keys(src).filter((k) => !NOTICE_FIELDS.includes(k));
    const id = src["id"];
    if (typeof id !== "string" || !NOTICE_ID_RE.test(id)) return { ok: false, reason: "id must match ^[a-z0-9][a-z0-9-]{0,63}$" };
    const kind = src["kind"];
    if (!isKind(kind)) return { ok: false, reason: `kind must be one of: ${NOTICE_KINDS.join(" / ")}` };
    const title = checkText(src["title"], "title", TEXT_LIMITS.title);
    if (!title.ok) return { ok: false, reason: title.reason };
    const rec: NoticeRecord = { id, kind, title: title.value };
    if ("desc" in src) {
        const d = checkText(src["desc"], "desc", TEXT_LIMITS.desc);
        if (!d.ok) return { ok: false, reason: d.reason };
        rec.desc = d.value;
    }
    if ("hint" in src) {
        const h = checkText(src["hint"], "hint", TEXT_LIMITS.hint);
        if (!h.ok) return { ok: false, reason: h.reason };
        rec.hint = h.value;
    }
    if ("ctaLabel" in src) {
        const c = checkText(src["ctaLabel"], "ctaLabel", TEXT_LIMITS.ctaLabel);
        if (!c.ok) return { ok: false, reason: c.reason };
        rec.ctaLabel = c.value;
    }
    if ("ctaUrl" in src) {
        const u = src["ctaUrl"];
        if (typeof u !== "string" || u.length > CTA_URL_MAX || !/^https?:\/\//.test(u)) {
            return { ok: false, reason: `ctaUrl must be http(s) ≤${CTA_URL_MAX} chars` };
        }
        rec.ctaUrl = u;
    }
    if ("tone" in src && !NOTICE_TONES.includes(src["tone"] as NoticeTone)) return { ok: false, reason: "tone must be ok/warn/info" };
    else if ("tone" in src) rec.tone = src["tone"] as NoticeTone;
    if ("dismiss" in src && !DISMISS_MODES.includes(src["dismiss"] as NoticeDismiss)) return { ok: false, reason: "dismiss must be persistent/instance/always" };
    else if ("dismiss" in src) rec.dismiss = src["dismiss"] as NoticeDismiss;
    if ("priority" in src) {
        if (src["priority"] !== null && !isIntInRange(src["priority"], 0, 100)) return { ok: false, reason: "priority must be an integer 0–100 or null" };
        rec.priority = src["priority"] as number | null;
    }
    for (const f of ["publishedAt", "since", "until"] as const) {
        if (!(f in src)) continue;
        if (!isIso8601(src[f])) return { ok: false, reason: `${f} must be ISO8601` };
        rec[f] = src[f];
    }
    if ("versions" in src) {
        const vs = src["versions"];
        if (!Array.isArray(vs) || vs.some((el) => typeof el !== "string")) return { ok: false, reason: "versions must be an array of matcher strings" };
        for (const el of vs as string[]) {
            if (parseVersionMatcher(el) === null) return { ok: false, reason: `versions element not parseable: ${el}` };
        }
        rec.versions = vs as string[];
    }
    if ("percent" in src) {
        if (src["percent"] !== null && !isIntInRange(src["percent"], 0, 100)) return { ok: false, reason: "percent must be an integer 0–100 or null" };
        rec.percent = src["percent"] as number | null;
    }
    return { ok: true, rec, droppedFields };
}

// ---- versions matcher (§4.1) ---------------------------------------------

type VerT = [number, number, number];
interface Constraint { op: ">" | ">=" | "<" | "<=" | "="; v: VerT }

/** Numeric body of a version string — dirty/pre-release builds compare by
 *  their major.minor.patch body only (§4.1). */
export function parseVersion(s: string): VerT | null {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpVer(a: VerT, b: VerT): number {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

function holds(c: Constraint, v: VerT): boolean {
    const d = cmpVer(v, c.v);
    switch (c.op) {
        case ">": return d > 0;
        case ">=": return d >= 0;
        case "<": return d < 0;
        case "<=": return d <= 0;
        default: return d === 0;
    }
}

function caretRange(tok: string): Constraint[] | null {
    const v = parseVersion(tok.slice(1));
    if (!v) return null;
    const upper: VerT = v[0] > 0 ? [v[0] + 1, 0, 0] : v[1] > 0 ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1];
    return [{ op: ">=", v }, { op: "<", v: upper }];
}

function parseTokenList(tokens: string[]): Constraint[] | null {
    const bare: VerT[] = [];
    const cons: Constraint[] = [];
    for (const tok of tokens) {
        if (tok.startsWith("^")) {
            const cr = caretRange(tok);
            if (!cr) return null;
            cons.push(...cr);
            continue;
        }
        const m = /^(>=|<=|>|<|=)?(.*)$/.exec(tok)!;
        const v = parseVersion(m[2]);
        if (!v) return null;
        if (m[1]) cons.push({ op: m[1] as Constraint["op"], v });
        else bare.push(v);
    }
    // One bare version is an exact pin; two bare versions inside brackets mean
    // the inclusive range "[c d]" (§4.1 example); mixed lists are ambiguous → invalid.
    if (bare.length === 1 && cons.length === 0) cons.push({ op: "=", v: bare[0] });
    else if (bare.length === 2 && cons.length === 0) cons.push({ op: ">=", v: bare[0] }, { op: "<=", v: bare[1] });
    else if (bare.length > 0) return null;
    return cons;
}

/** One matcher element → alternatives joined by OR (`||`); each alternative is
 *  an AND of constraints. Element forms: exact `0.1.212`, comparator list
 *  `>=a <b` / `^x.y.z`, interval list `[>=a <b] || [c d]`. */
export function parseVersionMatcher(el: string): Constraint[][] | null {
    const s = el.trim();
    if (!s) return null;
    if (s.includes("[")) {
        const alts: Constraint[][] = [];
        for (const part of s.split("||")) {
            const t = part.trim();
            if (!t.startsWith("[") || !t.endsWith("]")) return null;
            const inner = t.slice(1, -1).trim();
            if (!inner) return null;
            const cons = parseTokenList(inner.split(/\s+/).filter(Boolean));
            if (!cons) return null;
            alts.push(cons);
        }
        return alts.length > 0 ? alts : null;
    }
    const cons = parseTokenList(s.split(/\s+/).filter(Boolean));
    return cons ? [cons] : null;
}

/** Elements AND together; empty/absent list matches every version. An
 *  unparseable LOCAL version hides any gated record (宁缺毋滥, §4.1). */
export function versionMatches(elements: readonly string[], version: string | null): boolean {
    if (elements.length === 0) return true;
    const ver = version === null ? null : parseVersion(version);
    if (!ver) return false;
    return elements.every((el) => {
        const alts = parseVersionMatcher(el);
        return alts !== null && alts.some((alt) => alt.every((c) => holds(c, ver)));
    });
}

// ---- percent bucketing (§4.1) ---------------------------------------------

/** Deterministic per-install, per-notice bucket in [0,100): same install + id
 *  always lands in the same bucket; different ids use different salt so
 *  buckets don't correlate with business rollouts. */
export function percentBucket(installId: string, id: string): number {
    const h = createHash("sha256").update(`${installId}|${id}`).digest("hex");
    return parseInt(h.slice(0, 8), 16) % 100;
}

export interface TargetingContext {
    /** Running bili version string (null-safe: unparseable → gated records hide). */
    version: string | null;
    /** Stable install identity; "" when it cannot be persisted (read-only state). */
    installId: string;
    now: number;
}

/** The three common targeting gates, AND-combined (§4.1). since is inclusive,
 *  until exclusive. A missing installId hides percent-gated records rather
 *  than flicker buckets across restarts. */
export function passesTargeting(rec: Pick<NoticeRecord, "id" | "versions" | "percent" | "since" | "until">, ctx: TargetingContext): boolean {
    if (rec.versions && rec.versions.length > 0 && !versionMatches(rec.versions, ctx.version)) return false;
    if (typeof rec.percent === "number") {
        if (!ctx.installId) return false;
        if (percentBucket(ctx.installId, rec.id) >= rec.percent) return false;
    }
    if (rec.since && Number.isFinite(Date.parse(rec.since)) && Date.parse(rec.since) > ctx.now) return false;
    if (rec.until && Number.isFinite(Date.parse(rec.until)) && ctx.now >= Date.parse(rec.until)) return false;
    return true;
}

// ---- dismissal hashing (§4.4) ----------------------------------------------

function canonValue(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonValue);
    if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = canonValue((v as Record<string, unknown>)[k]);
        return out;
    }
    return v;
}

/** Canonical form of a validated record — key-sorted JSON, stable across
 *  processes and independent of source-file key order. */
export function normalizeRecord(rec: NoticeRecord): string {
    return JSON.stringify(canonValue(rec));
}

export function noticeHash16(rec: NoticeRecord): string {
    return createHash("sha1").update(normalizeRecord(rec)).digest("hex").slice(0, 16);
}

/** Store key: `id@hash16`. Content edits change the hash → the banner re-shows
 *  once (persistent mode); always-mode records never reach the store. */
export function dismissKeyOf(rec: NoticeRecord): string {
    return `${rec.id}@${noticeHash16(rec)}`;
}

export const PCK_NOTICE_ID = "pck-default-off";
export const WM_FASTPATH_INTRO_ID = "wm-fastpath-intro";

/** Lane A: built-in declarations (bound to code behavior, review-gated here). */
export const BUILTIN_NOTICES: readonly BuiltinNotice[] = [
    {
        // #5079: prompt_cache.routing default flip (auto → disabled) upgrade notice.
        // Explicit tone "warn": the derived tone for upgrade-advisory is info, but
        // this banner has rendered as .banner.warn since #5079 (byte-stable).
        id: PCK_NOTICE_ID,
        kind: "upgrade-advisory",
        tone: "warn",
        title: { "zh-CN": "prompt_cache_key 自注入已默认关闭（升级提示）", en: "prompt_cache_key self-stamping is now off by default (upgrade notice)" },
        desc: {
            "zh-CN": "本版本起 bili 不再自行向请求添加 OpenAI 的 prompt_cache_key 字段（此前默认开启）。如果你的上游是按该字段路由前缀缓存的中转站或号池（如 workbuddy panel/hub 等），请打开开关恢复注入，否则流量可能被随机路由、频繁未命中缓存。",
            en: "Since this version bili no longer adds OpenAI's prompt_cache_key field to requests on its own (previously on by default). If your upstream routes prefix cache by this key (relays such as workbuddy panel/hub, account pools), turn the switch back on — otherwise traffic may route randomly and miss the prefix cache.",
        },
        hint: {
            "zh-CN": "开关在「配置」页快速配置里（promptCache.routing：disabled/auto/enabled），也可直接改 billion-context.json；直连官方 API 的用户可忽略此提示。",
            en: "Switch: Configuration page → quick config (promptCache.routing: disabled/auto/enabled), or edit billion-context.json directly; direct official-API users can ignore this notice.",
        },
        active: (ctx) => ctx.promptCacheRouting === "disabled",
    },
    {
        // #5403/#5469: watermark fastpath experimental-grey intro — every install
        // sees it on first upgrade until closed or an explicit rollout override.
        id: WM_FASTPATH_INTRO_ID,
        kind: "new-feature",
        tone: "ok",
        title: { "zh-CN": "新功能提示：大上下文增量解析（增量压缩过渡功能 · 实验性）", en: "New: incremental parsing for large contexts (incremental-compression bridge feature, experimental)" },
        desc: {
            "zh-CN": "长会话每轮都要把整个历史重新发给代理解析一遍，现在改为增量解析：只解析本轮新增的那部分，优化长会话的解析性能（发给模型的内容不变；有任何疑点，当轮自动回退老路径并重新对齐）。当前版本对约 5% 的安装灰度开启，属实验性功能。",
            en: "Long conversations used to re-send their entire history for parsing on every turn. Now only the new part of each turn is parsed — faster parsing on long sessions (the request sent to the model is unchanged; any doubt falls back to the old path for that turn and re-aligns). This release rolls it out to roughly 5% of installs; it is marked experimental.",
        },
        hint: {
            "zh-CN": "开关在「配置」页快速配置（大上下文增量解析），也可在 billion-context.json 写 rollout.features.pluginFullResendWatermark: true/false，或设环境变量 BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK=1/0。",
            en: "Switch: Configuration page → quick config (incremental parsing for large contexts), or write rollout.features.pluginFullResendWatermark: true/false in billion-context.json, or set environment variable BILI_ROLLOUT_PLUGIN_FULL_RESEND_WATERMARK=1/0.",
        },
        active: (ctx) => !ctx.wmOverridePresent,
    },
];

const dynamicIds = new Set<string>();

/** Lanes B/C register their loaded ids so dismissal stays validated (#5548 §4.5). */
export function registerDynamicNoticeIds(ids: Iterable<string>): void {
    for (const id of ids) dynamicIds.add(id);
}

/** Every notice id a dismissal POST may name: built-ins + registered lanes B/C. */
export function knownNoticeIds(): ReadonlySet<string> {
    const all = new Set(BUILTIN_NOTICES.map((b) => b.id));
    for (const id of dynamicIds) all.add(id);
    return all;
}

interface VisibleNoticesOptions {
    dismissed: ReadonlySet<string>;
    instanceDismissed?: ReadonlySet<string>;
}

/** Lane-A visible set: active predicates AND dismiss mode, priority-sorted.
 *  Wire shape strips the active function — plain records only. */
export function visibleBuiltInNotices(ctx: BuiltInContext, opts: VisibleNoticesOptions): NoticeRecord[] {
    const live = BUILTIN_NOTICES.filter((b) => b.active(ctx) && noticeVisible(b, opts.dismissed, opts.instanceDismissed));
    return sortNotices(live).map(({ active: _active, ...wire }) => wire);
}
