// #5548 P2+P3: owner-dropped local announcements (source B) + the shared
// gates/validation the remote GitHub-raw source (C, src/remote-notices.ts)
// reuses verbatim. One plain-JSON file per record in
// ~/.config/billion-context/announcements/*.json (dirname of the effective
// config file, so BILI_CONFIG_FILE relocates it too). This module is read-only
// and never throws: a missing dir yields nothing, a bad file is skipped so one
// typo can never blank the other entries. Dismissal semantics per record:
// persistent (default, stored as id@content-hash16 so edited content re-nags
// once), instance (process memory only), always (no dismiss button rendered).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "./version.js";
import { configFile } from "./paths.js";
import { rolloutInstallId } from "./rollout.js";
import { dismissedUpgradeNotices } from "./pck-notice.js";
import { visibleNotices } from "./notices.js";

const KINDS = new Set(["new-feature", "upgrade-advisory", "warning", "suggestion", "incident", "deprecation", "other"]);
const TONES = new Set(["ok", "warn", "info"]);
const DISMISS_MODES = new Set(["persistent", "instance", "always"]);
const KIND_PRIORITY: Record<string, number> = { incident: 90, "upgrade-advisory": 80, warning: 70, deprecation: 60, suggestion: 50, "new-feature": 40, other: 30 };
const MAX_FILE_BYTES = 64 * 1024;
const CAP_TITLE = 120, CAP_DESC = 600, CAP_HINT = 300;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

type NoticeKind = "new-feature" | "upgrade-advisory" | "warning" | "suggestion" | "incident" | "deprecation" | "other";
type ToneName = "ok" | "warn" | "info";

interface LocText { [locale: string]: string }
export interface NoticeRecord {
    id: string;
    kind: NoticeKind;
    tone: ToneName;
    title: string | LocText;
    desc?: string | LocText;
    hint?: string | LocText;
    ctaLabel?: string;
    ctaUrl?: string;
    versions?: string[];
    percent?: number;
    dismiss: "persistent" | "instance" | "always";
    priority: number;
    since?: string;
    until?: string;
    publishedAt?: string;
}

interface AnnouncementPayload {
    source: "local" | "remote";
    id: string;
    tone: ToneName;
    kind: NoticeKind;
    title: string | LocText;
    desc?: string | LocText;
    hint?: string | LocText;
    ctaLabel?: string;
    ctaUrl?: string;
    suppressDismiss?: boolean;
    priority: number;
    publishedAt?: string;
}

// ---- version targeting ----------------------------------------------------

function parseTriple(v: string): [number, number, number] | undefined {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")] : undefined;
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
}

/** Parse ONE matcher element. Accepts a semver-ish range ("0.1.212",
 *  ">=0.1.210 <0.1.220", "^0.1.210", "~0.1.21") or an inclusive range list
 *  ("[0.1.210 0.1.214]", "[a b] || [c d]"). Returns a predicate or null when
 *  unparseable. */
function matcherPredicate(spec: string): ((cur: [number, number, number]) => boolean) | null {
    const s = spec.trim();
    if (!s) return null;
    if (s.startsWith("[")) {
        const parts = s.split(/\s*\|\|\s*/);
        const preds: Array<(cur: [number, number, number]) => boolean> = [];
        for (const part of parts) {
            const m = /^\[\s*(\S+)\s*,?\s*(\S+)\s*\]$/.exec(part);
            if (!m) return null;
            const lo = parseTriple(m[1]);
            const hi = parseTriple(m[2]);
            if (!lo || !hi || cmp(lo, hi) > 0) return null;
            preds.push((cur) => cmp(cur, lo) >= 0 && cmp(cur, hi) <= 0);
        }
        return preds.length > 0 ? (cur) => preds.some((p) => p(cur)) : null;
    }
    const tokens = s.split(/\s+/);
    const clauses: Array<(cur: [number, number, number]) => boolean> = [];
    for (const tok of tokens) {
        const m = /^(>=|<=|>|<|=|\^|~)?(\d+\.\d+(?:\.\d+)?)$/.exec(tok);
        if (!m) return null;
        const op = m[1] ?? "=";
        const v = parseTriple(m[2])!;
        let test: (cur: [number, number, number]) => boolean;
        if (op === "^") {
            const hi: [number, number, number] = v[0] > 0 ? [v[0] + 1, 0, 0] : v[1] > 0 ? [0, v[1] + 1, 0] : [0, 0, v[2] + 1];
            test = (cur) => cmp(cur, v) >= 0 && cmp(cur, hi) < 0;
        } else if (op === "~") {
            test = (cur) => cmp(cur, v) >= 0 && cmp(cur, [v[0], v[1] + 1, 0]) < 0;
        } else {
            test = (cur) => op === ">=" ? cmp(cur, v) >= 0 : op === "<=" ? cmp(cur, v) <= 0 : op === ">" ? cmp(cur, v) > 0 : op === "<" ? cmp(cur, v) < 0 : cmp(cur, v) === 0;
        }
        clauses.push(test);
    }
    return clauses.length > 0 ? (cur) => clauses.every((c) => c(cur)) : null;
}

export function matchesVersion(spec: string, version: string): boolean {
    const cur = parseTriple(version);
    const pred = matcherPredicate(spec);
    return !!cur && !!pred && pred(cur);
}

// ---- determinism helpers ---------------------------------------------------

/** 0–99 bucket for (announcement id, install identity): same pair always
 *  lands in the same bucket; different ids use different salts so buckets do
 *  not correlate across announcements or with feature-rollout buckets. */
export function noticeBucket(announcementId: string, identity: string): number {
    const h = crypto.createHash("sha256").update(`${announcementId}\x1e${identity}`).digest();
    return ((h[h.length - 2] << 8) | h[h.length - 1]) % 100;
}

const CANON_ORDER = ["id", "kind", "title", "desc", "hint", "ctaLabel", "ctaUrl", "versions", "percent", "dismiss", "priority", "since", "until", "publishedAt"] as const;

/** Content digest for dismissal keys: fixed key order so file/key order never
 *  changes the hash; only whitelisted fields count. */
export function contentHash16(record: object): string {
    // Single structural cast: callers pass validated NoticeRecords (no index
    // signature), the read set is the fixed CANON_ORDER whitelist.
    const src = record as Record<string, unknown>;
    const canon: Record<string, unknown> = {};
    for (const k of CANON_ORDER) if (src[k] !== undefined) canon[k] = src[k];
    return crypto.createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

// ---- validation (whitelist copy — extra fields are dropped, not fatal) -----

function locText(v: unknown, cap: number): string | LocText | null {
    if (typeof v === "string" && v.length <= cap) return v;
    if (v && typeof v === "object" && !Array.isArray(v)) {
        const out: LocText = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            if (!k || typeof val !== "string" || val.length === 0 || val.length > cap) return null;
            out[k] = val;
        }
        return Object.keys(out).length > 0 ? out : null;
    }
    return null;
}

export function validateRecord(raw: unknown): NoticeRecord | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const doc = raw as Record<string, unknown>;
    const id = doc["id"];
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    const kind = doc["kind"];
    if (typeof kind !== "string" || !KINDS.has(kind)) return null;
    const title = locText(doc["title"], CAP_TITLE);
    if (title === null) return null;
    const rec: NoticeRecord = { id, kind: kind as NoticeKind, tone: "info", title, dismiss: "persistent", priority: KIND_PRIORITY[kind] };
    if (doc["tone"] !== undefined) {
        if (typeof doc["tone"] !== "string" || !TONES.has(doc["tone"])) return null;
        rec.tone = doc["tone"] as ToneName;
    } else if (kind === "new-feature") rec.tone = "ok";
    else if (kind === "warning" || kind === "incident" || kind === "deprecation") rec.tone = "warn";
    const desc = doc["desc"] === undefined ? undefined : locText(doc["desc"], CAP_DESC);
    if (desc === null) return null;
    if (desc !== undefined) rec.desc = desc;
    const hint = doc["hint"] === undefined ? undefined : locText(doc["hint"], CAP_HINT);
    if (hint === null) return null;
    if (hint !== undefined) rec.hint = hint;
    if (doc["ctaLabel"] !== undefined || doc["ctaUrl"] !== undefined) {
        const label = doc["ctaLabel"];
        const url = doc["ctaUrl"];
        if (typeof label !== "string" || label.length === 0 || label.length > 60 || typeof url !== "string" || !/^https?:\/\/\S{1,199}$/.test(url)) return null;
        rec.ctaLabel = label;
        rec.ctaUrl = url;
    }
    if (doc["versions"] !== undefined) {
        if (!Array.isArray(doc["versions"]) || doc["versions"].length === 0 || doc["versions"].length > 4) return null;
        const specs: string[] = [];
        for (const v of doc["versions"]) {
            if (typeof v !== "string" || v.length > 120 || matcherPredicate(v) === null) return null;
            specs.push(v.trim());
        }
        rec.versions = specs;
    }
    if (doc["percent"] !== undefined) {
        const p = doc["percent"];
        if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 100) return null;
        rec.percent = p;
    }
    if (doc["dismiss"] !== undefined) {
        if (typeof doc["dismiss"] !== "string" || !DISMISS_MODES.has(doc["dismiss"])) return null;
        rec.dismiss = doc["dismiss"] as NoticeRecord["dismiss"];
    }
    if (doc["priority"] !== undefined) {
        const p = doc["priority"];
        if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 100) return null;
        rec.priority = p;
    }
    for (const f of ["since", "until", "publishedAt"] as const) {
        if (doc[f] !== undefined) {
            const v = doc[f];
            if (typeof v !== "string" || !ISO_RE.test(v) || !Number.isFinite(Date.parse(v))) return null;
            rec[f] = v;
        }
    }
    return rec;
}

// ---- loading + gates --------------------------------------------------------

const instanceDismissed = new Set<string>();
/** Process-lifetime dismissal for `dismiss: "instance"` records; never written
 *  to disk and cleared on restart by construction. */
export function markInstanceDismissal(id: string): void {
    instanceDismissed.add(id);
}

function announcementsDir(): string {
    return path.join(path.dirname(configFile()), "announcements");
}

function loadLocalRecords(): NoticeRecord[] {
    let names: string[];
    try {
        names = fs.readdirSync(announcementsDir()).filter((n) => n.endsWith(".json")).sort();
    } catch {
        return [];
    }
    const out: NoticeRecord[] = [];
    const seen = new Set<string>();
    for (const name of names) {
        try {
            const file = path.join(announcementsDir(), name);
            const st = fs.statSync(file);
            if (st.size > MAX_FILE_BYTES) continue;
            const rec = validateRecord(JSON.parse(fs.readFileSync(file, "utf8")));
            if (rec && !seen.has(rec.id)) {
                seen.add(rec.id);
                out.push(rec);
            }
        } catch {
            // one bad file must never blank the others
        }
    }
    return out;
}

/** The three gates every external (B/C) record must pass; shared verbatim by
 *  the local loader and the remote watcher so the two sources cannot drift. */
export function noticePassesGates(record: NoticeRecord, now: Date, env: NodeJS.ProcessEnv): boolean {
    if (record.versions) {
        const cur = parseTriple(VERSION);
        if (!cur) return false;
        for (const spec of record.versions) if (!matchesVersion(spec, cur.join("."))) return false;
    }
    if (record.percent !== undefined && noticeBucket(record.id, rolloutInstallId()) >= record.percent) return false;
    if (record.since && now.getTime() < Date.parse(record.since)) return false;
    if (record.until && now.getTime() > Date.parse(record.until)) return false;
    if (record.dismiss === "always") return true;
    if (record.dismiss === "instance") return !instanceDismissed.has(record.id);
    return !dismissedUpgradeNotices(env).has(`${record.id}@${contentHash16(record)}`);
}

/** Wire-shape a gated record for the web UI (source tags the lane). */
export function announcementPayload(source: "local" | "remote", r: NoticeRecord): AnnouncementPayload {
    const p: AnnouncementPayload = { source, id: r.id, tone: r.tone, kind: r.kind, title: r.title, priority: r.priority };
    if (r.desc !== undefined) p.desc = r.desc;
    if (r.hint !== undefined) p.hint = r.hint;
    if (r.ctaLabel !== undefined) p.ctaLabel = r.ctaLabel;
    if (r.ctaUrl !== undefined) p.ctaUrl = r.ctaUrl;
    if (r.publishedAt !== undefined) p.publishedAt = r.publishedAt;
    if (r.dismiss === "always") p.suppressDismiss = true;
    return p;
}

/** Visible local announcements after every gate, wire-shaped for the web UI. */
export function visibleLocalNotices(now: Date = new Date(), env: NodeJS.ProcessEnv = process.env): AnnouncementPayload[] {
    return loadLocalRecords().filter((r) => noticePassesGates(r, now, env)).map((r) => announcementPayload("local", r));
}

/** What dismiss mode a raw local id currently carries (for the dismiss
 *  endpoint); "absent" means not a local announcement at all. */
export function localDismissMode(id: string): "persistent" | "instance" | "always" | "absent" {
    for (const r of loadLocalRecords()) if (r.id === id) return r.dismiss;
    return "absent";
}

/** Content-addressed dismiss key for a currently VISIBLE local record (the
 *  same key the visibility gate filters on), else undefined (#5548 fix). */
export function localDismissKey(id: string): string | undefined {
    const rec = loadLocalRecords().find((r) => r.id === id && noticePassesGates(r, new Date(), process.env));
    return rec ? `${id}@${contentHash16(rec)}` : undefined;
}

type MergedNotice = { source: "builtin"; id: string; tone: ToneName; keys: Record<string, string>; priority: number } | AnnouncementPayload;

/** Single ordered payload for GET /__bili/notices and the overview field:
 *  on equal id local (B) shadows remote (C), both shadow builtin (A); then
 *  priority desc with stable order for ties (builtins first). Never throws. */
export function mergedNotices(env: NodeJS.ProcessEnv = process.env, remote: AnnouncementPayload[] = []): MergedNotice[] {
    const local = visibleLocalNotices(new Date(), env);
    const localIds = new Set(local.map((l) => l.id));
    // B over A over S: a local record with an equal id replaces BOTH the remote
    // twin and any builtin under that id.
    const remoteIn = remote.filter((r) => !localIds.has(r.id));
    const shadow = new Set([...localIds, ...remoteIn.map((r) => r.id)]);
    const builtins: MergedNotice[] = visibleNotices().filter((n) => !shadow.has(n.id)).map((n) => ({ source: "builtin", id: n.id, tone: n.tone, keys: n.keys, priority: 50 }));
    return [...builtins, ...remoteIn, ...local].sort((a, b) => b.priority - a.priority);
}
