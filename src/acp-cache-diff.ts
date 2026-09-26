// #1266: offline prefix-diff attribution over ACP_DUMP_BODY dumps. Pairs
// adjacent requests per session (INCOMING = client raw wire, REQ = proxy
// rebuilt wire) and classifies each pair so a cache break is attributed to
// its producer instead of surfacing as an unattributed TTL bucket (#1254).
import fs from "node:fs";
import path from "node:path";
import { defaultLogFile } from "./paths.js";
import { safeSessionId } from "./server/headers.js";

export type PairCategory = "pure-append" | "mid-stream-rewrite" | "prefix-stable-miss";
export type Attribution = "proxy" | "client" | "both" | "unknown";

export interface DivergenceDetail {
    offset: number;
    messageIndex: number | null;
    roleType: string | null;
    before: string;
    after: string;
}

export interface UsagePair {
    inputA: number;
    cachedB: number;
    inputB: number;
    missedPrefix: number;
    hitPctB: number | null;
}

export interface AppendInfo {
    // strict: B's bytes start with A's bytes verbatim.
    // json-tail: every shared message element is byte-identical; the only
    //   divergence sits at/after the last shared element (array closer +
    //   appended elements) — the healthy shape for array-appending clients.
    // tail-fields: same element stability, but the divergence is trailing
    //   fields after the message array.
    kind: "strict" | "json-tail" | "tail-fields";
    countA: number;
    countB: number;
}

export interface PairReport {
    index: number;
    tsA: number;
    tsB: number;
    category: PairCategory;
    attribution: Attribution | null;
    incoming: "append" | "diverge" | "missing";
    outgoing: "append" | "diverge";
    outgoingAppend: AppendInfo | null;
    incomingAppend: AppendInfo | null;
    outgoingExtra: number;
    incomingExtra: number | null;
    divergence: DivergenceDetail | null;
    incomingDivergenceOffset: number | null;
    usage: UsagePair | null;
    usageAvailable: boolean;
    modelA: string | null;
    modelB: string | null;
    notes: string[];
}

export interface SessionReport {
    sid: string;
    requests: number;
    unpairedIncoming: number;
    legacyIncoming: number;
    pairs: PairReport[];
}

export interface DiffReport {
    dir: string;
    logSource: string | null;
    usageSamples: number;
    sessions: SessionReport[];
    totalPairs: number;
    byCategory: Record<PairCategory, number>;
    worst: Array<{ session: string; pair: PairReport }>;
}

interface DumpMeta {
    ts: number;
    sid: string | null;
    kind: "incoming" | "outgoing";
    file: string;
    legacy: boolean;
}

interface DumpContent {
    body: Buffer;
    headers: Record<string, string>;
    model: string | null;
    cacheHeaders: Record<string, string>;
}

const INC_NEW_RE = /^(\d+)-([a-zA-Z0-9._-]+)-INCOMING\.txt$/;
const INC_LEGACY_RE = /^(\d+)-INCOMING\.txt$/;
const REQ_RE = /^(\d+)-([a-zA-Z0-9._-]+)-REQ\.txt$/;

export function collectDumps(root: string): DumpMeta[] {
    const dirs: string[] = [root];
    for (const sub of ["raw", "dumps"]) {
        const p = path.join(root, sub);
        try { if (fs.statSync(p).isDirectory()) dirs.push(p); } catch { /* absent */ }
    }
    const seen = new Set<string>();
    const all: DumpMeta[] = [];
    for (const d of dirs) {
        let names: string[];
        try { names = fs.readdirSync(d); } catch { continue; }
        for (const name of names) {
            const file = path.resolve(d, name);
            if (seen.has(file)) continue;
            seen.add(file);
            let m = INC_NEW_RE.exec(name);
            if (m) { all.push({ ts: Number(m[1]), sid: m[2]!, kind: "incoming", file, legacy: false }); continue; }
            m = INC_LEGACY_RE.exec(name);
            if (m) { all.push({ ts: Number(m[1]), sid: null, kind: "incoming", file, legacy: true }); continue; }
            m = REQ_RE.exec(name);
            if (m) all.push({ ts: Number(m[1]), sid: m[2]!, kind: "outgoing", file, legacy: false });
        }
    }
    return all.sort((a, b) => a.ts - b.ts || a.kind.localeCompare(b.kind));
}

function parseDumpFile(file: string): DumpContent | null {
    let buf: Buffer;
    try { buf = fs.readFileSync(file); } catch { return null; }
    const sep = buf.indexOf("\n\n");
    if (sep < 0) return null;
    const head = buf.subarray(0, sep).toString("utf8");
    const body = buf.subarray(sep + 2);
    const headers: Record<string, string> = {};
    const lines = head.split("\n");
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i]!;
        if (!line.trim()) continue;
        const c = line.indexOf(": ");
        if (c > 0) headers[line.slice(0, c).toLowerCase()] = line.slice(c + 2);
    }
    let model: string | null = null;
    try {
        const parsed: unknown = JSON.parse(body.toString("utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const md = (parsed as Record<string, unknown>).model;
            if (typeof md === "string") model = md;
        }
    } catch { /* non-JSON body */ }
    const cacheHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (/cache/i.test(k)) cacheHeaders[k] = v;
    return { body, headers, model, cacheHeaders };
}

function prefixCompare(a: Buffer, b: Buffer): { rel: "append" | "diverge"; offset: number; extra: number } {
    const n = Math.min(a.length, b.length);
    const CHUNK = 65536;
    let off = 0;
    while (off < n) {
        const end = Math.min(off + CHUNK, n);
        const ca = a.subarray(off, end);
        const cb = b.subarray(off, end);
        if (!ca.equals(cb)) {
            for (let i = 0; i < ca.length; i++) {
                if (ca[i] !== cb[i]) return { rel: "diverge", offset: off + i, extra: b.length - a.length };
            }
            return { rel: "append", offset: a.length, extra: b.length - a.length };
        }
        off = end;
    }
    if (b.length >= a.length) return { rel: "append", offset: a.length, extra: b.length - a.length };
    return { rel: "diverge", offset: n, extra: b.length - a.length };
}

const MSG_KEYS = ["messages", "input", "contents"];

interface MsgArrayInfo {
    key: string;
    spans: Array<[number, number]>;
    items: unknown[];
}

function msgArrayInfo(text: string): MsgArrayInfo | null {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return null; }
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    for (const key of MSG_KEYS) {
        const arr = obj[key];
        if (!Array.isArray(arr)) continue;
        const re = new RegExp(`"${key}"\\s*:\\s*\\[`, "g");
        let firstStart = -1;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const start = m.index + m[0].length - 1;
            if (firstStart < 0) firstStart = start;
            const spans = elementSpans(text, start);
            if (spans.length === arr.length) return { key, spans, items: arr };
        }
        if (firstStart >= 0) return { key, spans: elementSpans(text, firstStart), items: arr };
    }
    return null;
}

function elementSpans(text: string, arrStart: number): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    const len = text.length;
    let i = arrStart + 1;
    while (i < len) {
        while (i < len && " \t\n\r".includes(text[i]!)) i++;
        if (i >= len || text[i] === "]") break;
        const s = i;
        const ch = text[i]!;
        if (ch === "{" || ch === "[") {
            let depth = 0;
            let inStr = false;
            let esc = false;
            while (i < len) {
                const c = text[i]!;
                if (inStr) {
                    if (esc) esc = false;
                    else if (c === "\\") esc = true;
                    else if (c === '"') inStr = false;
                } else if (c === '"') {
                    inStr = true;
                } else if (c === "{" || c === "[") {
                    depth++;
                } else if (c === "}" || c === "]") {
                    depth--;
                    if (depth === 0) { i++; break; }
                }
                i++;
            }
        } else if (ch === '"') {
            i++;
            while (i < len) {
                const c = text[i]!;
                if (c === "\\") { i += 2; continue; }
                if (c === '"') { i++; break; }
                i++;
            }
        } else {
            while (i < len && text[i] !== "," && text[i] !== "]") i++;
        }
        spans.push([s, i]);
        if (text[i] === ",") i++;
        else break;
    }
    return spans;
}

function describeElement(e: unknown): string {
    if (e && typeof e === "object" && !Array.isArray(e)) {
        const o = e as Record<string, unknown>;
        if (typeof o.role === "string") return o.role;
        if (typeof o.type === "string") return o.type;
        if (typeof o.object === "string") return o.object;
        return "object";
    }
    if (e === null) return "null";
    return typeof e;
}

function snippetAround(text: string, off: number): { before: string; after: string } {
    const clean = (s: string) => JSON.stringify(s).slice(1, -1);
    return { before: clean(text.slice(Math.max(0, off - 48), off)), after: clean(text.slice(off, off + 96)) };
}

function locateMessage(items: unknown[], spans: Array<[number, number]>, offset: number): { index: number | null; roleType: string | null } {
    for (let i = 0; i < spans.length; i++) {
        const s = spans[i]![0];
        const e = spans[i]![1];
        if (offset >= s && offset <= e) return { index: i, roleType: describeElement(items[i]) };
        if (s > offset) break;
    }
    return { index: null, roleType: null };
}

// Two-tier wire comparison. Tier 1: strict byte prefix. Tier 2 (JSON-tail):
// appending to a message array moves the array's closing bracket, so a
// perfectly healthy append never satisfies tier 1 — instead we require every
// SHARED element to be byte-identical and the first divergence to sit at/after
// the last shared element (glue-only gaps tolerated). Anything else is a
// genuine mid-stream rewrite.
export interface WireRel {
    rel: "append" | "diverge";
    byteOffset: number;
    extra: number;
    append: AppendInfo | null;
    preArray: boolean;
}

export function compareWires(aBody: Buffer, bBody: Buffer): WireRel {
    const byteRel = prefixCompare(aBody, bBody);
    const aText = aBody.toString("utf8");
    const bText = bBody.toString("utf8");
    if (byteRel.rel === "append") {
        const ia = msgArrayInfo(aText);
        const ib = msgArrayInfo(bText);
        return {
            rel: "append", byteOffset: byteRel.offset, extra: byteRel.extra, preArray: false,
            append: { kind: "strict", countA: ia ? ia.items.length : 0, countB: ib ? ib.items.length : 0 },
        };
    }
    const O = byteRel.offset;
    const ia = msgArrayInfo(aText);
    const ib = msgArrayInfo(bText);
    if (ia && ib && ia.key === ib.key && ia.items.length > 0 && ib.items.length >= ia.items.length) {
        const n = Math.min(ia.items.length, ib.items.length);
        if (ia.spans.length >= n && ib.spans.length >= n) {
            let sharedOk = true;
            for (let i = 0; i < n; i++) {
                const sa = ia.spans[i]!;
                const sb = ib.spans[i]!;
                if (sa[0] !== sb[0] || sa[1] !== sb[1] || aText.slice(sa[0], sa[1]) !== bText.slice(sb[0], sb[1])) { sharedOk = false; break; }
            }
            if (sharedOk) {
                const lastEnd = ib.spans[n - 1]![1];
                if (O >= lastEnd) {
                    return {
                        rel: "append", byteOffset: O, extra: byteRel.extra, preArray: false,
                        append: { kind: ib.items.length > ia.items.length ? "json-tail" : "tail-fields", countA: ia.items.length, countB: ib.items.length },
                    };
                }
                if (O < ib.spans[0]![0]) {
                    return { rel: "diverge", byteOffset: O, extra: byteRel.extra, append: null, preArray: true };
                }
                // O sits in the glue between two shared elements: tolerate
                // whitespace/comma-only reshaping (pretty vs compact).
                let gi = -1;
                for (let i = 0; i < n - 1; i++) {
                    if (O >= ib.spans[i]![1] && O <= ib.spans[i + 1]![0]) { gi = i; break; }
                }
                if (gi >= 0) {
                    const strip = (s: string) => s.replace(/[,\s]/g, "");
                    const glueA = strip(aText.slice(ia.spans[gi]![1], ia.spans[gi + 1]![0]));
                    const glueB = strip(bText.slice(ib.spans[gi]![1], ib.spans[gi + 1]![0]));
                    if (glueA === glueB) {
                        return {
                            rel: "append", byteOffset: O, extra: byteRel.extra, preArray: false,
                            append: { kind: ib.items.length > ia.items.length ? "json-tail" : "tail-fields", countA: ia.items.length, countB: ib.items.length },
                        };
                    }
                }
            }
        }
    }
    return { rel: "diverge", byteOffset: O, extra: byteRel.extra, append: null, preArray: false };
}

export interface UsageSample { ts: number; input: number; cached: number; }

const USAGE_LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?) \[[a-z]+\] \[([^\]]+)\] (?:\[plugin\] )?\[acp-usage\](?: round \d+)? input=(\d+) cached=(\d+)/;

export function parseUsageLog(file: string): Map<string, UsageSample[]> {
    const bySession = new Map<string, UsageSample[]>();
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch { return bySession; }
    for (const line of text.split("\n")) {
        const m = USAGE_LINE_RE.exec(line);
        if (!m) continue;
        const ts = Date.parse(m[1]!);
        if (Number.isNaN(ts)) continue;
        const sid = safeSessionId(m[2]!);
        const list = bySession.get(sid) ?? [];
        list.push({ ts, input: Number(m[3]), cached: Number(m[4]) });
        bySession.set(sid, list);
    }
    for (const list of bySession.values()) list.sort((a, b) => a.ts - b.ts);
    return bySession;
}

// Same-process clocks write the dump and the usage line; a request's dump
// ALWAYS precedes its own response's usage line, so the skew window only
// absorbs write-ordering noise — never lets a LATER request claim an EARLIER
// response's line. The old +2000ms window did exactly that whenever adjacent
// requests sat < 2s apart (the compress-loop regime this tool exists to
// diagnose): sample 1 piled onto request 2, request 1 lost its usage data and
// prefix-stable-miss detection silently disabled for the dense case.
const USAGE_SKEW_MS = 50;

function alignUsage(outTs: number[], samples: UsageSample[]): UsageSample[][] {
    // A usage line belongs to the latest request whose dump predates it —
    // responses (and their usage logs) always land after the request dump.
    const assigned: UsageSample[][] = outTs.map(() => []);
    for (const s of samples) {
        for (let i = outTs.length - 1; i >= 0; i--) {
            if (outTs[i]! <= s.ts + USAGE_SKEW_MS) { assigned[i]!.push(s); break; }
        }
    }
    return assigned;
}

const MISS_ABS_FLOOR = 512;
const MISS_REL_FLOOR = 0.02;
const PAIR_TOL_MS = 2000;
const LEGACY_WINDOW_MS = 30_000;

function classifyPair(index: number, tsA: number, tsB: number, aOut: DumpContent, bOut: DumpContent, aInc: DumpContent | null, bInc: DumpContent | null, aSamples: UsageSample[], bSamples: UsageSample[], hasLegacy: boolean): PairReport {
    const notes: string[] = [];
    const outRel = compareWires(aOut.body, bOut.body);
    const inRel = aInc && bInc ? compareWires(aInc.body, bInc.body) : null;
    const modelA = aOut.model;
    const modelB = bOut.model;
    if (modelA !== modelB && (modelA || modelB)) notes.push(`model changed ${modelA ?? "?"}→${modelB ?? "?"} (different cache pool)`);
    for (const [k, va] of Object.entries(aOut.cacheHeaders)) {
        const vb = bOut.cacheHeaders[k];
        if (vb !== undefined && vb !== va) notes.push(`cache header ${k} changed (${va}→${vb})`);
    }
    const aFirst = aSamples[0];
    const bFirst = bSamples[0];
    const usageAvailable = Boolean(aFirst && bFirst);
    let usage: UsagePair | null = null;
    if (aFirst && bFirst) {
        const missedPrefix = Math.max(0, aFirst.input - bFirst.cached);
        usage = {
            inputA: aFirst.input,
            cachedB: bFirst.cached,
            inputB: bFirst.input,
            missedPrefix,
            hitPctB: bFirst.input > 0 ? Math.round((bFirst.cached / bFirst.input) * 100) : null,
        };
    }
    let category: PairCategory;
    let attribution: Attribution | null = null;
    let divergence: DivergenceDetail | null = null;
    let incomingDivergenceOffset: number | null = null;
    if (outRel.rel === "diverge") {
        category = "mid-stream-rewrite";
        const passthroughPair = Boolean(aInc && bInc && aInc.body.equals(aOut.body) && bInc.body.equals(bOut.body));
        attribution = !inRel ? "unknown"
            : inRel.rel === "append" ? "proxy"
            : outRel.byteOffset > inRel.byteOffset ? "client"
            : outRel.byteOffset < inRel.byteOffset ? "both"
            : passthroughPair ? "client" : "both";
        const bText = bOut.body.toString("utf8");
        const info = msgArrayInfo(bText);
        const loc = info ? locateMessage(info.items, info.spans, outRel.byteOffset) : { index: null, roleType: null };
        const snip = snippetAround(bText, outRel.byteOffset);
        divergence = { offset: outRel.byteOffset, messageIndex: loc.index, roleType: loc.roleType, before: snip.before, after: snip.after };
        if (outRel.preArray) notes.push("divergence before the message array (field-level change)");
        if (inRel && inRel.rel === "diverge") incomingDivergenceOffset = inRel.byteOffset;
        if (attribution === "proxy") notes.push("incoming stayed pure-append — drift introduced by proxy rebuild (#1249 shape)");
    } else {
        if (inRel && inRel.rel === "diverge") {
            incomingDivergenceOffset = inRel.byteOffset;
            notes.push("client rewrote history but outgoing prefix stayed stable (proxy normalized)");
        }
        category = usage && usage.missedPrefix > MISS_ABS_FLOOR && usage.missedPrefix > MISS_REL_FLOOR * usage.inputA ? "prefix-stable-miss" : "pure-append";
    }
    if (category === "pure-append" && !usageAvailable) notes.push("no [acp-usage] data — verify hit rate via bili.log");
    if (hasLegacy) notes.push("legacy INCOMING filename (no session id) — paired by timestamp proximity");
    return {
        index, tsA, tsB, category, attribution,
        incoming: !inRel ? "missing" : inRel.rel,
        outgoing: outRel.rel,
        outgoingAppend: outRel.append,
        incomingAppend: inRel ? inRel.append : null,
        outgoingExtra: outRel.extra,
        incomingExtra: inRel ? inRel.extra : null,
        divergence, incomingDivergenceOffset, usage, usageAvailable, modelA, modelB, notes,
    };
}

export interface DiffOptions {
    logFile?: string;
    noLog?: boolean;
    session?: string;
}

export function runDiff(root: string, opts: DiffOptions = {}): DiffReport {
    const rootResolved = path.resolve(root);
    let st: fs.Stats;
    try { st = fs.statSync(rootResolved); } catch (error) { throw new Error(`cannot access ${root}: ${error instanceof Error ? error.message : String(error)}`); }
    if (!st.isDirectory()) throw new Error(`${root} is not a directory`);

    const metas = collectDumps(rootResolved);
    if (metas.length === 0) {
        throw new Error(`no ACP_DUMP_BODY dumps found under ${rootResolved} (expected *-REQ.txt / *-INCOMING.txt in ., ./raw or ./dumps) — enable ACP_DUMP_BODY=1 first`);
    }
    const outgoing = metas.filter((m) => m.kind === "outgoing");
    for (const inc of metas) {
        if (inc.sid !== null || inc.kind !== "incoming") continue;
        let best: DumpMeta | null = null;
        let bestDelta = Infinity;
        for (const out of outgoing) {
            const d = Math.abs(out.ts - inc.ts);
            if (d < bestDelta) { bestDelta = d; best = out; }
        }
        if (best && bestDelta <= LEGACY_WINDOW_MS) inc.sid = best.sid;
    }

    let logSource: string | null = null;
    let usageBySession = new Map<string, UsageSample[]>();
    if (!opts.noLog) {
        const candidates = opts.logFile ? [path.resolve(opts.logFile)] : [path.join(rootResolved, "bili.log"), defaultLogFile()];
        for (const c of candidates) {
            try {
                if (fs.statSync(c).isFile()) { logSource = c; usageBySession = parseUsageLog(c); break; }
            } catch { /* try next candidate */ }
        }
    }
    const usageSamples = [...usageBySession.values()].reduce((n, l) => n + l.length, 0);

    const bySession = new Map<string, { inc: DumpMeta[]; out: DumpMeta[] }>();
    for (const m of metas) {
        if (m.sid === null) continue;
        let g = bySession.get(m.sid);
        if (!g) { g = { inc: [], out: [] }; bySession.set(m.sid, g); }
        (m.kind === "incoming" ? g.inc : g.out).push(m);
    }

    const contentCache = new Map<string, DumpContent | null>();
    const read = (m: DumpMeta): DumpContent | null => {
        if (!contentCache.has(m.file)) contentCache.set(m.file, parseDumpFile(m.file));
        return contentCache.get(m.file) ?? null;
    };

    const sessions: SessionReport[] = [];
    const allPairs: Array<{ session: string; pair: PairReport }> = [];
    for (const [sid, g] of [...bySession.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (opts.session && !sid.includes(opts.session)) continue;
        g.out.sort((a, b) => a.ts - b.ts);
        g.inc.sort((a, b) => a.ts - b.ts);
        const bundles: Array<{ out: DumpMeta; inc: DumpMeta | null }> = [];
        let j = 0;
        let unpairedIncoming = 0;
        for (const out of g.out) {
            while (j < g.inc.length && g.inc[j]!.ts < out.ts - PAIR_TOL_MS) { j++; unpairedIncoming++; }
            const inc = j < g.inc.length && g.inc[j]!.ts <= out.ts + PAIR_TOL_MS ? g.inc[j]! : null;
            if (inc) j++;
            bundles.push({ out, inc });
        }
        unpairedIncoming += g.inc.length - j;
        const assigned = alignUsage(g.out.map((o) => o.ts), usageBySession.get(sid) ?? []);
        const pairs: PairReport[] = [];
        for (let i = 1; i < bundles.length; i++) {
            const prevB = bundles[i - 1]!;
            const curB = bundles[i]!;
            const prevOut = read(prevB.out);
            const curOut = read(curB.out);
            if (!prevOut || !curOut) continue;
            const prevInc = prevB.inc ? read(prevB.inc) : null;
            const curInc = curB.inc ? read(curB.inc) : null;
            const pair = classifyPair(i, prevB.out.ts, curB.out.ts, prevOut, curOut, prevInc, curInc, assigned[i - 1]!, assigned[i]!, prevB.inc?.legacy || curB.inc?.legacy || false);
            pairs.push(pair);
            allPairs.push({ session: sid, pair });
        }
        sessions.push({ sid, requests: g.out.length, unpairedIncoming, legacyIncoming: g.inc.filter((m) => m.legacy).length, pairs });
    }

    const byCategory: Record<PairCategory, number> = { "pure-append": 0, "mid-stream-rewrite": 0, "prefix-stable-miss": 0 };
    for (const { pair } of allPairs) byCategory[pair.category]++;
    const severity = (p: PairReport): number => {
        if (p.category === "mid-stream-rewrite") return 1e15 - (p.divergence?.offset ?? 0);
        if (p.category === "prefix-stable-miss") return 1e12 + (p.usage?.missedPrefix ?? 0);
        return 0;
    };
    const worst = allPairs
        .filter(({ pair }) => pair.category !== "pure-append")
        .sort((x, y) => severity(y.pair) - severity(x.pair))
        .slice(0, 5);

    return { dir: rootResolved, logSource, usageSamples, sessions, totalPairs: allPairs.length, byCategory, worst };
}

function fmtTime(ts: number): string { return new Date(ts).toISOString().slice(11, 23); }
function fmtTok(n: number): string { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n); }
function fmtBytes(n: number): string { return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`; }

function appendLabel(p: Pick<PairReport, "outgoingAppend" | "incomingAppend">, side: "out" | "in"): string {
    const info = side === "out" ? p.outgoingAppend : p.incomingAppend;
    if (!info) return "";
    if (info.kind === "strict") return "";
    const cnt = info.countA === info.countB ? "" : `, msgs ${info.countA}→${info.countB}`;
    return `(${info.kind}${cnt})`;
}

function describePair(p: PairReport): string {
    const parts: string[] = [];
    parts.push(`${p.category.toUpperCase()}${p.attribution ? `(${p.attribution})` : ""}`);
    parts.push(`in=${p.incoming === "missing" ? "missing" : p.incoming === "diverge" ? `diverge@${p.incomingDivergenceOffset}` : `append${p.incomingExtra !== null ? `(${p.incomingExtra >= 0 ? "+" : ""}${fmtBytes(p.incomingExtra)})` : ""}${appendLabel(p, "in")}`}`);
    if (p.outgoing === "diverge" && p.divergence) {
        const d = p.divergence;
        const msg = d.messageIndex !== null ? ` msg[${d.messageIndex}]${d.roleType ? `(${d.roleType})` : ""}` : "";
        parts.push(`out@${d.offset}${msg}`);
        parts.push(`«${d.before}|${d.after}»`);
    } else {
        parts.push(`out=append(${p.outgoingExtra >= 0 ? "+" : ""}${fmtBytes(p.outgoingExtra)})${appendLabel(p, "out")}`);
    }
    if (p.usage) {
        const u = p.usage;
        parts.push(`cached ${fmtTok(u.cachedB)}/${fmtTok(u.inputB)}${u.hitPctB !== null ? ` (${u.hitPctB}%)` : ""}${u.missedPrefix > 0 ? `, missed≈${fmtTok(u.missedPrefix)}` : ""}`);
    }
    if (p.notes.length > 0) parts.push(`notes: ${p.notes.join("; ")}`);
    return parts.join("  ");
}

export function renderText(r: DiffReport): string {
    const lines: string[] = [];
    lines.push(`bili acp-cache diff — ${r.dir}`);
    lines.push(`log: ${r.logSource ?? "none"}${r.logSource ? ` (${r.usageSamples} [acp-usage] samples)` : ""}`);
    lines.push(`sessions: ${r.sessions.length} · pairs: ${r.totalPairs} · pure-append: ${r.byCategory["pure-append"]} · mid-stream-rewrite: ${r.byCategory["mid-stream-rewrite"]} · prefix-stable-miss: ${r.byCategory["prefix-stable-miss"]}`);
    if (r.worst.length > 0) {
        lines.push("");
        lines.push("worst offenders:");
        for (const { session, pair } of r.worst) lines.push(`  ⚠ ${session} #${pair.index} ${describePair(pair)}`);
    }
    lines.push("");
    lines.push("pairs:");
    for (const s of r.sessions) {
        for (const p of s.pairs) {
            lines.push(`  ${s.sid} #${p.index} ${fmtTime(p.tsA)}→${fmtTime(p.tsB)}  ${describePair(p)}`);
        }
    }
    return lines.join("\n") + "\n";
}

export function renderJson(r: DiffReport): string { return JSON.stringify(r, null, 2) + "\n"; }
