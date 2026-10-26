import { MESSAGES } from "./i18n.js";

// Dependency-free, DOM-free builders so they run in both the proxy (/__bili/session-report)
// and unit tests; title/label (user PII) masked by default, upstream host + metrics kept.
type Locale = "zh-CN" | "en";

interface ReportOpts {
    /** Mask title/label (user PII). Defaults to true. */
    mask?: boolean;
    /** Output locale. Defaults to zh-CN. */
    lang?: string;
}

/** Loose structural view of the session-detail payload the builders read. Every field is
 *  optional so callers may pass either the full WebSessionDetail or a partial fixture. */
interface ReportData {
    id?: string;
    title?: string;
    label?: string;
    protocol?: string;
    upstreamOrigin?: string;
    requests?: number;
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    systemPromptTokens?: number;
    contextTokens?: number;
    contextWindow?: number;
    contextTokensSource?: string;
    contextBest?: { tokens?: number };
    retrieveCalls?: number;
    retrieveHits?: number;
    retrieveMisses?: number;
    wholeBlockRestores?: number;
    wholeBlockRestoresPreciseAvailable?: number;
    rangeRestores?: number;
    blockDetails?: Array<{ active?: boolean }>;
    ledger?: ({
        totals?: { newContent?: number; compRepay?: number; ttlRepay?: number; residual?: number; balanced?: boolean };
        seam?: {
            suspects?: number;
            missed?: number;
            abortCorrelated?: number;
            providerSide?: { count?: number; missed?: number };
            rewinds?: { count?: number; missed?: number };
            events?: Array<{ seq?: number | string; at?: number; hitPct?: number; input?: number; lcpBytes?: number; msgIndex?: number | null }>;
        };
        stability?: { paired?: number; equal?: number; diverged?: number; head?: number; append?: number; mid?: number; unknownOffset?: number };
        folds?: Array<{ seq?: number | null; at?: number; S?: number; sigma?: number; hPct?: number | null; T?: number }>;
        lines?: Array<{ input?: number; cached?: number }>;
    }) | null;
}

interface SvgReport {
    svg: string;
    w: number;
    h: number;
}

function tr(lang: string, key: string, args?: Record<string, string | number>): string {
    const loc: Locale = lang === "en" ? "en" : "zh-CN";
    let s = MESSAGES[loc][key] ?? key;
    if (args) for (const [k, v] of Object.entries(args)) s = s.split("{" + k + "}").join(String(v));
    return s;
}

function escXml(s: unknown): string {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function truncStr(s: unknown, n: number): string {
    const v = String(s == null ? "" : s);
    return v.length > n ? v.slice(0, Math.max(1, n - 1)) + "…" : v;
}

interface Fmt {
    none: string;
    W: (n: unknown) => string;
    B: (n: unknown) => string;
    DT: (ms: number) => string;
    host: (u?: string) => string;
}

function makeFmt(lang: string): Fmt {
    const none = tr(lang, "common.none");
    const W = (n: unknown): string => {
        if (n === null || n === undefined || isNaN(Number(n))) return none;
        const v = Math.round(Number(n));
        const a = Math.abs(v);
        if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
        if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
        if (a >= 1e4) return Math.round(v / 1e3) + "K";
        if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
        return String(v);
    };
    const B = (n: unknown): string => {
        if (n == null || isNaN(Number(n))) return none;
        let x = Number(n);
        const units = ["B", "KB", "MB", "GB", "TB"];
        let i = 0;
        while (Math.abs(x) >= 1024 && i < units.length - 1) { x /= 1024; i++; }
        return (i > 0 ? x.toFixed(1) : String(Math.round(x))) + " " + units[i];
    };
    const DT = (ms: number): string => {
        const d = new Date(ms || 0);
        const p = (v: number) => String(v).padStart(2, "0");
        return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    };
    const host = (u?: string): string => {
        if (!u) return "";
        try { return new URL(u).host; } catch { return u; }
    };
    return { none, W, B, DT, host };
}

function reportTitle(d: ReportData, mask: boolean, lang: string): string {
    const raw = d.title || d.label || "";
    if (!mask && raw) return raw;
    if (raw) return tr(lang, "det.report_masked");
    return String(d.id ?? "").slice(0, 16);
}

function readLedger(d: ReportData) {
    const led = d.ledger ?? {};
    const tot = led.totals ?? null;
    const seam = led.seam && typeof led.seam === "object" ? led.seam : null;
    const st = led.stability && typeof led.stability === "object" ? led.stability : null;
    const folds = Array.isArray(led.folds) ? led.folds : [];
    const lines = Array.isArray(led.lines) ? led.lines : [];
    const seamEvents = seam && Array.isArray(seam.events) ? seam.events.filter((e) => e && (e.at ?? 0) > 0) : [];
    const ctxBest = (d.contextBest && d.contextBest.tokens) ? d.contextBest.tokens : (Number(d.contextTokens) || 0);
    const win = Number(d.contextWindow) || 0;
    return { led, tot, seam, st, folds, lines, seamEvents, ctxBest, win };
}

export function buildSessionReportMd(d: ReportData, opts: ReportOpts = {}): string {
    const mask = opts.mask !== false;
    const lang = opts.lang === "en" ? "en" : "zh-CN";
    const t = (k: string, a?: Record<string, string | number>) => tr(lang, k, a);
    const f = makeFmt(lang);
    const { tot, seam, st, folds, lines, seamEvents, ctxBest, win } = readLedger(d);
    const NL = String.fromCharCode(10);
    const L: string[] = [];
    L.push("# billion-context session report");
    L.push("");
    L.push("- generated: " + new Date().toISOString());
    L.push("- masking: " + (mask ? "on (title/label redacted)" : "off"));
    L.push("- session id: " + (d.id ?? ""));
    L.push("");
    L.push("## " + t("det.identity"));
    L.push("");
    L.push("- title: " + reportTitle(d, mask, lang));
    if (d.label && d.label !== d.id) L.push("- label: " + (mask ? t("det.report_masked") : truncStr(d.label, 80)));
    L.push("- protocol: " + (d.protocol || f.none));
    L.push("- upstream: " + (f.host(d.upstreamOrigin) || f.none));
    L.push("- requests: " + (d.requests != null ? d.requests : f.none));
    L.push("- context: " + f.W(ctxBest) + (win ? " / " + f.W(win) + " (" + (ctxBest / win * 100).toFixed(1) + "%)" : "") + (d.contextTokensSource === "estimate" ? " (estimate)" : ""));
    if (Number(d.systemPromptTokens)) L.push("- system prompt: " + f.W(d.systemPromptTokens));
    if (Array.isArray(d.blockDetails)) L.push("- blocks: " + d.blockDetails.filter((b) => b.active).length + " active / " + d.blockDetails.length + " total");
    L.push("- compressions (folds): " + folds.length);
    L.push("");
    L.push("## " + t("det.usage"));
    L.push("");
    L.push("| metric | value |");
    L.push("|---|---|");
    L.push("| input tokens | " + f.W(Number(d.inputTokens) || 0) + " |");
    L.push("| cached tokens | " + f.W(Number(d.cachedTokens) || 0) + " |");
    L.push("| output tokens | " + f.W(Number(d.outputTokens) || 0) + " |");
    L.push("| cache hit % | " + ((Number(d.inputTokens) > 0) ? ((Number(d.cachedTokens) || 0) / Number(d.inputTokens) * 100).toFixed(1) + "%" : f.none) + " |");
    if ((Number(d.retrieveCalls) || 0) > 0) L.push("| retrieve calls | " + d.retrieveCalls + " (hits " + (Number(d.retrieveHits) || 0) + " / misses " + (Number(d.retrieveMisses) || 0) + ") |");
    if ((Number(d.wholeBlockRestores) || 0) > 0 || (Number(d.rangeRestores) || 0) > 0) L.push("| decompress | " + (Number(d.wholeBlockRestores) || 0) + " whole-block (" + (Number(d.wholeBlockRestoresPreciseAvailable) || 0) + " cheaper precise path) · " + (Number(d.rangeRestores) || 0) + " range |");
    L.push("");
    L.push("## " + t("det.trajectory"));
    L.push("");
    if (!lines.length) { L.push(t("det.trajectory_empty")); L.push(""); }
    else {
        L.push("| # | input | cached | missed | hit % |");
        L.push("|---|---|---|---|---|");
        const cap = 500;
        lines.slice(0, cap).forEach((ln, i) => {
            const inp = Number(ln.input) || 0, cac = Number(ln.cached) || 0;
            L.push("| " + (i + 1) + " | " + f.W(inp) + " | " + f.W(cac) + " | " + f.W(inp - cac) + " | " + (inp > 0 ? (cac / inp * 100).toFixed(1) + "%" : "-") + " |");
        });
        if (lines.length > cap) L.push("| … +" + (lines.length - cap) + " more | | | | |");
        L.push("");
    }
    L.push("## " + t("det.seam_events", { n: seamEvents.length }));
    L.push("");
    if (seamEvents.length) {
        L.push("| # | time | hit % | input | divergence |");
        L.push("|---|---|---|---|---|");
        seamEvents.forEach((ev) => {
            L.push("| " + ev.seq + " | " + (ev.at ? f.DT(ev.at) : "-") + " | " + (typeof ev.hitPct === "number" ? ev.hitPct.toFixed(1) + "%" : "-") + " | " + f.W(ev.input || 0) + " | " + f.B(ev.lcpBytes || 0) + " @m" + (ev.msgIndex != null ? ev.msgIndex : "?") + " |");
        });
        L.push("");
        if (Number(seam!.missed) > 0) L.push("- attributed missed: " + f.W(seam!.missed) + (seam!.suspects ? " (suspects ×" + seam!.suspects + ")" : ""));
        if (seam!.providerSide && Number(seam!.providerSide.missed) > 0) L.push("- provider-side: " + f.W(seam!.providerSide.missed));
        if (seam!.rewinds && Number(seam!.rewinds.missed) > 0) L.push("- rewinds: " + f.W(seam!.rewinds.missed));
        if (seam!.abortCorrelated) L.push("- abort-correlated: " + seam!.abortCorrelated);
    } else L.push(t("common.empty"));
    L.push("");
    L.push("## " + t("det.stab_title"));
    L.push("");
    if (st && (Number(st.paired) || 0) > 0) {
        L.push("- paired: " + st.paired + ", identical: " + (Number(st.equal) || 0) + ", diverged: " + (Number(st.diverged) || 0));
        const kinds: string[] = [];
        if (st.head) kinds.push("head " + st.head);
        if (st.append) kinds.push("append " + st.append);
        if (st.mid) kinds.push("mid " + st.mid);
        if (st.unknownOffset) kinds.push("unknown " + st.unknownOffset);
        if (kinds.length) L.push("- divergence kinds: " + kinds.join(", "));
    } else L.push(t("common.empty"));
    L.push("");
    L.push("## " + t("det.cache_econ"));
    L.push("");
    if (tot) {
        L.push("| component | tokens |");
        L.push("|---|---|");
        L.push("| " + t("det.ce_new") + " | " + f.W(tot.newContent || 0) + " |");
        L.push("| " + t("det.ce_comp") + " | " + f.W(tot.compRepay || 0) + " |");
        L.push("| " + t("det.ce_ttl") + " | " + f.W(tot.ttlRepay || 0) + " |");
        L.push("| " + t("det.ce_residual") + " | " + f.W(tot.residual || 0) + " |");
        L.push("");
        L.push("- balanced: " + (tot.balanced ? "yes" : "no"));
    } else L.push(t("common.empty"));
    if (folds.length) {
        L.push("");
        L.push("### folds (" + folds.length + ")");
        L.push("");
        L.push("| # | time | S | σ | hit % | T |");
        L.push("|---|---|---|---|---|---|");
        folds.forEach((fd, i) => { L.push("| " + (fd.seq != null ? fd.seq : i + 1) + " | " + (fd.at ? f.DT(fd.at) : "-") + " | " + f.W(fd.S) + " | " + f.W(fd.sigma) + " | " + (fd.hPct == null ? "-" : fd.hPct.toFixed(1) + "%") + " | " + f.W(fd.T) + " |"); });
    }
    return L.join(NL);
}

export function buildSessionReportSvg(d: ReportData, opts: ReportOpts = {}): SvgReport {
    const mask = opts.mask !== false;
    const lang = opts.lang === "en" ? "en" : "zh-CN";
    const t = (k: string, a?: Record<string, string | number>) => tr(lang, k, a);
    const f = makeFmt(lang);
    const { tot, seam, st, folds, lines, seamEvents, ctxBest, win } = readLedger(d);
    const W = 920, PAD = 28;
    const INK = "#1f2328", MUT = "#6e7681", LINEC = "#d0d7de", ACC = "#0969da", RED = "#cf222e", AMB = "#bf8700", SOFT = "#f6f8fa";
    const SANS = "ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
    const body: string[] = [];
    let y = 0;
    function txt(x: number, yy: number, s: string, opt?: { size?: number; weight?: string; color?: string; anchor?: string; mono?: boolean }): void {
        opt = opt ?? {};
        body.push('<text x="' + x + '" y="' + yy.toFixed(1) + '" font-size="' + (opt.size ?? 12) + '" font-weight="' + (opt.weight ?? "normal") + '" fill="' + (opt.color ?? INK) + '" text-anchor="' + (opt.anchor ?? "start") + '" font-family="' + (opt.mono ? MONO : SANS) + '">' + escXml(s) + "</text>");
    }
    function section(title: string): void {
        y += 30;
        body.push('<rect x="' + PAD + '" y="' + (y - 19) + '" width="4" height="17" rx="2" fill="' + ACC + '"/>');
        txt(PAD + 14, y, title, { size: 14, weight: "bold" });
        y += 8;
    }
    function kv(label: string, value: string, mono?: boolean): void {
        y += 19;
        txt(PAD, y, label, { size: 12, color: MUT });
        txt(PAD + 150, y, value == null || value === "" ? f.none : String(value), { size: 12, mono: !!mono, weight: "500" });
    }
    function statRow(items: Array<[string, string, string?]>): void {
        const gap = 12, n = items.length, cw = (W - PAD * 2 - gap * (n - 1)) / n;
        items.forEach((it, i) => {
            const bx = PAD + i * (cw + gap);
            body.push('<rect x="' + bx.toFixed(1) + '" y="' + y + '" width="' + cw.toFixed(1) + '" height="48" rx="8" fill="' + SOFT + '" stroke="' + LINEC + '"/>');
            txt(bx + 12, y + 19, it[0], { size: 11, color: MUT });
            txt(bx + 12, y + 39, String(it[1]), { size: 16, weight: "bold", color: it[2] ?? INK, mono: true });
        });
        y += 56;
    }
    function tableHead(cols: Array<{ t: string; w: number }>): void {
        y += 18;
        let x = PAD;
        body.push('<line x1="' + PAD + '" y1="' + y + '" x2="' + (W - PAD) + '" y2="' + y + '" stroke="' + LINEC + '"/>');
        cols.forEach((c) => { txt(x + 4, y + 14, c.t, { size: 10.5, weight: "bold", color: MUT }); x += c.w; });
        y += 4;
        body.push('<line x1="' + PAD + '" y1="' + y + '" x2="' + (W - PAD) + '" y2="' + y + '" stroke="' + LINEC + '"/>');
    }
    function tableRow(cells: string[], widths: number[]): void {
        y += 17;
        let x = PAD;
        cells.forEach((c, i) => { txt(x + 4, y, c, { size: 11, mono: true }); x += widths[i]; });
    }
    function noteLine(s: string, color?: string): void { y += 16; txt(PAD, y, s, { size: 11, color: color ?? MUT }); }
    body.push('<rect x="0" y="0" width="' + W + '" height="96" fill="' + SOFT + '"/>');
    txt(PAD, 36, String(d.id ?? ""), { size: 15, weight: "bold", mono: true });
    const subBits = [d.protocol ?? "", f.host(d.upstreamOrigin)].filter(Boolean).join("   ·   ");
    txt(PAD, 57, subBits || f.none, { size: 12, color: MUT });
    txt(PAD, 78, t("det.identity") + ":  " + truncStr(reportTitle(d, mask, lang), 60), { size: 12 });
    txt(W - PAD, 36, "generated " + new Date().toISOString().slice(0, 16).replace("T", " "), { size: 11, color: MUT, anchor: "end" });
    if (mask) txt(W - PAD, 57, t("det.report_note"), { size: 11, color: AMB, anchor: "end" });
    y = 96;
    section(t("det.identity"));
    kv(t("common.title"), truncStr(reportTitle(d, mask, lang), 48));
    if (d.label && d.label !== d.id) kv("label", truncStr(mask ? t("det.report_masked") : String(d.label), 48));
    kv(t("common.protocol"), d.protocol || f.none);
    kv(t("common.upstream"), f.host(d.upstreamOrigin) || f.none);
    kv(t("common.requests"), d.requests != null ? String(d.requests) : f.none, true);
    kv(t("common.context"), f.W(ctxBest) + (win ? " / " + f.W(win) + " (" + (ctxBest / win * 100).toFixed(1) + "%)" : "") + (d.contextTokensSource === "estimate" ? " (est.)" : ""), true);
    if (Number(d.systemPromptTokens)) kv("system prompt", f.W(d.systemPromptTokens), true);
    if (Array.isArray(d.blockDetails)) kv("blocks", d.blockDetails.filter((b) => b.active).length + " active / " + d.blockDetails.length + " total", true);
    kv("compressions", String(folds.length), true);
    section(t("det.usage"));
    statRow([
        [t("ov.input_tokens"), f.W(Number(d.inputTokens) || 0)],
        [t("ov.cached_tokens"), f.W(Number(d.cachedTokens) || 0)],
        [t("ov.output_tokens"), f.W(Number(d.outputTokens) || 0)],
        [t("det.rpt_hit"), (Number(d.inputTokens) > 0) ? ((Number(d.cachedTokens) || 0) / Number(d.inputTokens) * 100).toFixed(1) + "%" : f.none, ACC]
    ]);
    if ((Number(d.retrieveCalls) || 0) > 0) noteLine("retrieve " + d.retrieveCalls + " (hits " + (Number(d.retrieveHits) || 0) + " / misses " + (Number(d.retrieveMisses) || 0) + ")");
    if ((Number(d.wholeBlockRestores) || 0) > 0 || (Number(d.rangeRestores) || 0) > 0) noteLine("decompress " + (Number(d.wholeBlockRestores) || 0) + " whole-block (" + (Number(d.wholeBlockRestoresPreciseAvailable) || 0) + " precise) · " + (Number(d.rangeRestores) || 0) + " range");
    section(t("det.trajectory"));
    if (!lines.length) noteLine(t("det.trajectory_empty"));
    else {
        const CH = 150, PL = 52, PR = 14, PT = 8, PB = 20;
        const top = y + PT, bot = y + CH - PB, left = PAD + PL, right = W - PAD - PR;
        const vals = lines.map((l) => Number(l.input) || 0);
        let maxV = Math.max.apply(null, vals.concat(win ? [win] : []).concat(Number(d.systemPromptTokens) ? [Number(d.systemPromptTokens)] : []));
        if (!(maxV > 0)) maxV = 1;
        const Xp = (i: number) => left + (lines.length <= 1 ? (right - left) / 2 : (i / (lines.length - 1)) * (right - left));
        const Yp = (v: number) => bot - (v / maxV) * (bot - top);
        body.push('<line x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + bot + '" stroke="' + LINEC + '"/>');
        body.push('<line x1="' + left + '" y1="' + bot + '" x2="' + right + '" y2="' + bot + '" stroke="' + LINEC + '"/>');
        [maxV, maxV / 2, 0].forEach((v) => {
            const yy = Yp(v);
            body.push('<line x1="' + (left - 4) + '" y1="' + yy.toFixed(1) + '" x2="' + left + '" y2="' + yy.toFixed(1) + '" stroke="' + LINEC + '"/>');
            txt(left - 8, yy + 3, f.W(v), { size: 9.5, color: MUT, anchor: "end", mono: true });
        });
        let areaPts = left + "," + bot + " ";
        lines.forEach((l, i) => { areaPts += Xp(i).toFixed(1) + "," + Yp(Number(l.cached) || 0).toFixed(1) + " "; });
        areaPts += right + "," + bot;
        body.push('<polygon points="' + areaPts.trim() + '" fill="' + ACC + '" opacity="0.16"/>');
        let linePts = "";
        lines.forEach((l, i) => { linePts += Xp(i).toFixed(1) + "," + Yp(Number(l.input) || 0).toFixed(1) + " "; });
        body.push('<polyline points="' + linePts.trim() + '" fill="none" stroke="' + ACC + '" stroke-width="1.6"/>');
        if (win && win <= maxV) {
            const wy = Yp(win);
            body.push('<line x1="' + left + '" y1="' + wy.toFixed(1) + '" x2="' + right + '" y2="' + wy.toFixed(1) + '" stroke="' + RED + '" stroke-dasharray="5 4" stroke-width="1.2"/>');
            txt(right, wy - 4, t("det.legend_window") + " " + f.W(win), { size: 9.5, color: RED, anchor: "end" });
        }
        y += CH + 8;
        const cols = [{ t: "#", w: 56 }, { t: t("det.rpt_input"), w: 180 }, { t: t("det.rpt_cached"), w: 180 }, { t: t("det.rpt_missed"), w: 180 }, { t: t("det.rpt_hit"), w: W - PAD * 2 - 596 }];
        tableHead(cols);
        const show = lines.slice(-12);
        const off = lines.length - show.length;
        show.forEach((ln, i) => {
            const inp = Number(ln.input) || 0, cac = Number(ln.cached) || 0;
            tableRow([String(off + i + 1), f.W(inp), f.W(cac), f.W(inp - cac), inp > 0 ? (cac / inp * 100).toFixed(1) + "%" : "-"], [cols[0].w, cols[1].w, cols[2].w, cols[3].w, cols[4].w]);
        });
        if (lines.length > 12) noteLine("… +" + (lines.length - 12) + " earlier calls (see .md)");
    }
    section(t("det.seam_events", { n: seamEvents.length }));
    if (!seamEvents.length) noteLine(t("common.empty"));
    else {
        const scols = [{ t: "#", w: 48 }, { t: t("det.fold_time"), w: 120 }, { t: t("det.rpt_hit"), w: 90 }, { t: t("det.rpt_input"), w: 110 }, { t: "divergence", w: W - PAD * 2 - 368 }];
        tableHead(scols);
        seamEvents.slice(0, 10).forEach((ev) => {
            tableRow([String(ev.seq), ev.at ? f.DT(ev.at) : "-", typeof ev.hitPct === "number" ? ev.hitPct.toFixed(1) + "%" : "-", f.W(ev.input || 0), f.B(ev.lcpBytes || 0) + " @m" + (ev.msgIndex != null ? ev.msgIndex : "?")], [scols[0].w, scols[1].w, scols[2].w, scols[3].w, scols[4].w]);
        });
        if (seamEvents.length > 10) noteLine("… +" + (seamEvents.length - 10) + " more (see .md)");
        if (Number(seam!.missed) > 0) noteLine("attributed missed " + f.W(seam!.missed) + (seam!.suspects ? " (×" + seam!.suspects + ")" : ""), RED);
        if (seam!.providerSide && Number(seam!.providerSide.missed) > 0) noteLine("provider-side " + f.W(seam!.providerSide.missed), AMB);
        if (seam!.rewinds && Number(seam!.rewinds.missed) > 0) noteLine("rewinds " + f.W(seam!.rewinds.missed), MUT);
    }
    section(t("det.stab_title"));
    if (st && (Number(st.paired) || 0) > 0) {
        statRow([
            ["paired", String(st.paired)],
            ["identical", String(Number(st.equal) || 0)],
            ["diverged", String(Number(st.diverged) || 0), (Number(st.mid) > 0) ? RED : INK]
        ]);
        const kk: string[] = [];
        if (st.head) kk.push("head " + st.head);
        if (st.append) kk.push("append " + st.append);
        if (st.mid) kk.push("mid " + st.mid);
        if (st.unknownOffset) kk.push("unknown " + st.unknownOffset);
        if (kk.length) noteLine(kk.join("  ·  "));
    } else noteLine(t("common.empty"));
    section(t("det.cache_econ"));
    if (tot) {
        statRow([
            [t("det.ce_new"), f.W(tot.newContent || 0)],
            [t("det.ce_comp"), f.W(tot.compRepay || 0)],
            [t("det.ce_ttl"), f.W(tot.ttlRepay || 0)],
            [t("det.ce_residual"), f.W(tot.residual || 0), tot.balanced ? INK : AMB]
        ]);
        if (folds.length) {
            const fcols = [{ t: "#", w: 48 }, { t: t("det.fold_time"), w: 120 }, { t: "S", w: 120 }, { t: "σ", w: 120 }, { t: t("det.rpt_hit"), w: 110 }, { t: "T", w: W - PAD * 2 - 518 }];
            tableHead(fcols);
            folds.slice(-15).forEach((fd, i) => {
                tableRow([String(fd.seq != null ? fd.seq : i + 1), fd.at ? f.DT(fd.at) : "-", f.W(fd.S), f.W(fd.sigma), fd.hPct == null ? "-" : fd.hPct.toFixed(1) + "%", f.W(fd.T)], [fcols[0].w, fcols[1].w, fcols[2].w, fcols[3].w, fcols[4].w, fcols[5].w]);
            });
            if (folds.length > 15) noteLine("… +" + (folds.length - 15) + " earlier folds (see .md)");
        }
    } else noteLine(t("common.empty"));
    y += 24;
    const H = Math.ceil(y);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">'
        + '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>'
        + body.join("") + "</svg>";
    return { svg, w: W, h: H };
}
