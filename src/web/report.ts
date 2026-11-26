import { MESSAGES } from "./i18n.js";

// Dependency-free, DOM-free builders so they run in both the proxy (/__bili/session-report)
// and unit tests; title/label (user PII) masked by default, upstream host + metrics kept.
type Locale = "zh-CN" | "en" | "ko";

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
        /** #6729: nudge-recommended vs actually-folded recovery events + summary. */
        recovery?: {
            events?: Array<{ at?: number; kind?: "n" | "f"; tier?: number | null; pending?: number; folded?: number | null; foldSeq?: number | null; mode?: "n" | "a" | null; pct?: number | null; paired?: boolean }>;
            summary?: { nudges?: number; folds?: number; nudgeFolds?: number; activeFolds?: number; totalPending?: number; totalFolded?: number; pct?: number | null };
            /** #6729 follow-up: one point per nudge round for the recovery line chart. */
            episodes?: Array<{ at?: number; tier?: number | null; pending?: number; folded?: number; pct?: number | null; activeFolds?: number; open?: boolean; credited?: number; extra?: number }>;
        };
        lines?: Array<{ at?: number; input?: number; cached?: number; seq?: number }>;
    }) | null;
}

interface SvgReport {
    svg: string;
    w: number;
    h: number;
}

function tr(lang: string, key: string, args?: Record<string, string | number>): string {
    const loc: Locale = lang === "en" || lang === "ko" ? lang : "zh-CN";
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
    // #6729: sparse on pre-upgrade ledgers.
    const rec = led.recovery && Array.isArray(led.recovery.events) && led.recovery.events.length ? led.recovery : null;
    const lines = Array.isArray(led.lines) ? led.lines : [];
    const seamEvents = seam && Array.isArray(seam.events) ? seam.events.filter((e) => e && (e.at ?? 0) > 0) : [];
    const ctxBest = (d.contextBest && d.contextBest.tokens) ? d.contextBest.tokens : (Number(d.contextTokens) || 0);
    const win = Number(d.contextWindow) || 0;
    return { led, tot, seam, st, folds, lines, seamEvents, ctxBest, win, rec };
}

export function buildSessionReportMd(d: ReportData, opts: ReportOpts = {}): string {
    const mask = opts.mask !== false;
    const lang = opts.lang === "en" || opts.lang === "ko" ? opts.lang : "zh-CN";
    const t = (k: string, a?: Record<string, string | number>) => tr(lang, k, a);
    const f = makeFmt(lang);
    const { tot, seam, st, folds, lines, seamEvents, ctxBest, win, rec } = readLedger(d);
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
    if (rec) {
        const s = rec.summary || {};
        const evs = rec.events || [];
        L.push("");
        L.push("### " + t("det.rec_title"));
        L.push("");
        L.push("- " + t("det.rec_head2", { n: s.nudges || 0, f: s.folds || 0, nf: s.nudgeFolds || 0, a: s.activeFolds || 0, p: f.W(s.totalPending || 0), s: f.W(s.totalFolded || 0) }) + (((s.totalFolded || 0) > (s.totalPending || 0)) ? " · " + t("det.rec_over_stock") : "") + " · " + t("det.rec_rate") + ": " + (s.pct != null ? s.pct.toFixed(1) + "%" : f.none));
        L.push("- " + t("det.rec_note_t1"));
        L.push("- " + t("det.rec_note_burst"));
        const eps = rec.episodes || [];
        if (eps.length) {
            L.push("");
            L.push("- " + t("det.rec_line_title") + ":");
            eps.forEach((ep, i) => {
                L.push("  " + (i + 1) + ". T" + (ep.tier != null ? ep.tier : "?") + " · " + (ep.at ? f.DT(ep.at) : "-") + " · " + f.W(ep.pending || 0) + "→" + f.W(ep.folded || 0) + " · " + (ep.pct != null ? ep.pct.toFixed(1) + "%" : f.none) + ((ep.activeFolds || 0) > 0 ? " · +" + (ep.activeFolds || 0) + " " + t("det.rec_kind_active") : ""));
            });
        }
        L.push("");
        L.push("| # | " + t("det.fold_time") + " | " + t("det.rec_kind") + " | " + t("det.rec_rec") + " | " + t("det.rec_folded") + " | " + t("det.rec_pct") + " |");
        L.push("|---|---|---|---|---|---|");
        evs.slice(-30).forEach((ev, i) => {
            const kind = ev.kind === "n" ? t("det.rec_kind_nudge") + (ev.tier != null ? " T" + ev.tier : "") : ev.mode === "a" ? t("det.rec_kind_active") : t("det.rec_kind_nf");
            const pct = ev.pct != null ? ev.pct.toFixed(1) + "%" : ev.kind === "n" && ev.paired === false ? t("det.rec_unfolded_short") : "-";
            L.push("| " + (i + 1) + " | " + (ev.at ? f.DT(ev.at) : "-") + " | " + kind + " | " + f.W(ev.pending || 0) + " | " + (ev.folded != null ? f.W(ev.folded) : "-") + " | " + pct + " |");
        });
        if (evs.length > 30) { L.push("- " + t("det.rec_note_window", { n: 30 })); L.push("… +" + (evs.length - 30) + " earlier events"); }
    }
    return L.join(NL);
}

export function buildSessionReportSvg(d: ReportData, opts: ReportOpts = {}): SvgReport {
    const mask = opts.mask !== false;
    const lang = opts.lang === "en" || opts.lang === "ko" ? opts.lang : "zh-CN";
    const t = (k: string, a?: Record<string, string | number>) => tr(lang, k, a);
    const f = makeFmt(lang);
    const { tot, seam, st, folds, lines, seamEvents, ctxBest, win, rec } = readLedger(d);
    const W = 920, PAD = 28;
    const INK = "#1f2328", MUT = "#6e7681", LINEC = "#d0d7de", ACC = "#0969da", RED = "#cf222e", AMB = "#bf8700", SOFT = "#f6f8fa", GROW = "#1b7c83"; // GROW: growth-recovery series — teal + hollow, kept apart from ACC (#0969da = active ticks / over-100 fold dots)
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
    if ((Number(d.wholeBlockRestores) || 0) > 0 || (Number(d.rangeRestores) || 0) > 0) noteLine("decompress " + (Number(d.wholeBlockRestores) || 0) + " whole-block (" + (Number(d.wholeBlockRestoresPreciseAvailable) || 0) + " precise) · " + (Number(d.rangeRestores) || 0) + " range");
    section(t("det.trajectory"));
    if (!lines.length) noteLine(t("det.trajectory_empty"));
    else {
        const CH = 150, PL = 52, PR = 14, PT = 8, PB = 20;
        const top = y + PT, bot = y + CH - PB, left = PAD + PL, right = W - PAD - PR;
        let maxV = lines.reduce((max, l) => Math.max(max, Number(l.input) || 0), -Infinity);
        maxV = Math.max(maxV, win || -Infinity, Number(d.systemPromptTokens) || -Infinity);
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
    if (rec) {
        section(t("det.rec_title"));
        const s = rec.summary || {};
        noteLine(t("det.rec_head2", { n: s.nudges || 0, f: s.folds || 0, nf: s.nudgeFolds || 0, a: s.activeFolds || 0, p: f.W(s.totalPending || 0), s: f.W(s.totalFolded || 0) }) + (((s.totalFolded || 0) > (s.totalPending || 0)) ? " · " + t("det.rec_over_stock") : ""));
        statRow([
            [t("det.rec_nudge"), String(s.nudges || 0)],
            [t("det.rec_active"), String(s.activeFolds || 0)],
            [t("det.rec_rec_total"), f.W(s.totalPending || 0)],
            [t("det.rec_fold_total"), f.W(s.totalFolded || 0)]
        ]);
        noteLine(t("det.rec_note_t1"));
        noteLine(t("det.rec_note_burst"));
        const revs = (rec.events || []).slice(-10);
        const rcols = [{ t: "#", w: 48 }, { t: t("det.fold_time"), w: 120 }, { t: t("det.rec_kind"), w: 150 }, { t: t("det.rec_rec"), w: 120 }, { t: t("det.rec_folded"), w: 120 }, { t: t("det.rec_pct"), w: W - PAD * 2 - 558 }];
        // #6729 follow-up v7: the recovery LINE is the compressions — one point per
        // compress() call (folded ÷ the nudge recommendation outstanding for it),
        // connected in time order; none skipped. >100% = also folded older stock (true
        // value, axis extends past the 100% baseline). Nudges are ▼ markers; rounds keep
        // their brackets (a round's points sum to its recovery). Compressions without a
        // measurable recommendation (active / non-T1) stay as blue/grey axis ticks.
        const eps = rec.episodes || [];
        type RevEv = { at: number; kind: "n" | "f"; tier?: number | null; pending?: number | null; folded?: number | null; mode?: "n" | "a"; pct?: number | null; paired?: boolean };
        const revEvs: RevEv[] = [];
        (rec.events || []).forEach((ev) => {
            if (!ev || ev.at == null || !(ev.at > 0) || (ev.kind !== "n" && ev.kind !== "f")) return;
            revEvs.push({ at: ev.at, kind: ev.kind, tier: ev.tier ?? null, pending: ev.pending ?? null, folded: ev.folded ?? null, mode: ev.mode ?? undefined, pct: ev.pct ?? null, paired: ev.paired });
        });
        if (revEvs.length > 0) {
            const CH = 240, CPL = 40, CPR = 14, CPT = 30, CPB = 44;
            const left = PAD + CPL, right = W - PAD - CPR, top = y + CPT, bot = y + CH - CPB;
            const times = revEvs.map((ev) => ev.at);
            const t0 = Math.min(...times), t1 = Math.max(...times);
            const TX = (at: number): number => left + (t1 > t0 ? ((at - t0) / (t1 - t0)) * (right - left) : (right - left) / 2);
            // per-fold points: denominator = the latest nudge's recommendation before the fold
            let lastP = 0;
            const fPts = revEvs.flatMap((ev) => {
                if (ev.kind === "n") { lastP = ev.pending || 0; return []; }
                const p = ev.pending || 0;
                // The server payload may carry the per-fold pct directly (the ledger's p field
                // is only set on newer ledgers); prefer it and fall back to pending-derived.
                const pct = ev.pct != null ? ev.pct : (p > 0 ? Math.round(((ev.folded || 0) / p) * 1000) / 10 : null);
                return [{ at: ev.at, S: ev.folded || 0, p, pct, mode: ev.mode ?? "a" }];
            });
            // Growth recovery (one point per round): folded ÷ context growth since the
            // previous round's first sample. Answers "did the context actually come back
            // down" — the ratchet meter (#6720). Needs the per-request usage samples.
            const uLines = (lines || []).filter((l) => Boolean(l) && (l.at || 0) > 0).sort((a, b) => (a.at || 0) - (b.at || 0));
            const gPts: Array<{ at: number; s: number; g: number; pct: number | null }> = [];
            let gPrevEnd: number | null = null; // previous round's last fold — the floor is measured after it
            eps.forEach((ep) => {
                const folded = ep.folded || 0;
                if (!folded) return;
                const gs = ep.at ?? 0;
                const nextNud = eps.find((e2, i2) => i2 > eps.indexOf(ep) && (e2.at ?? 0) > gs);
                let ge: number | null = null;
                revEvs.forEach((ev) => {
                    if (ev.kind === "f" && ev.mode === "n" && ev.at >= gs && (nextNud == null || ev.at < (nextNud.at ?? Infinity)) && (ge === null || ev.at > ge)) ge = ev.at;
                });
                if (ge === null || !uLines.length) return;
                const geT = ge;
                // growth = pre-round floor → round peak. The FLOOR is the lowest input
                // AFTER the previous round's last fold and BEFORE this round's nudge
                // (fallback: the whole pre-round history for round one): a fold is itself
                // a drop, so the min inside the peak window can sit right after an earlier
                // fold and make "growth" look 10× larger. Peak window = [round start, last
                // fold + 2 min]. Two conversations can share one session UUID (dsh-client
                // #5792): sub-25%-of-peak samples are a different stream and are dropped
                // before taking the min/max.
                let preMin: number | null = null;
                for (const pln of uLines) {
                    if ((pln.at || 0) >= gs) break;
                    if (gPrevEnd !== null && (pln.at || 0) <= gPrevEnd) continue;
                    const pin = pln.input || 0;
                    if (preMin === null || pin < preMin) preMin = pin;
                }
                const wAll = uLines.filter((ln) => (ln.at || 0) >= gs && (ln.at || 0) <= geT + 120000).map((ln) => ln.input || 0);
                if (!wAll.length) return;
                const gPeakAll = wAll.reduce((max, v) => Math.max(max, v), -Infinity);
                const gPeak = wAll.filter((v) => v >= 0.25 * gPeakAll).reduce((max, v) => Math.max(max, v), -Infinity);
                const gBase = preMin !== null && preMin >= 0.25 * gPeak ? preMin : wAll.filter((v) => v >= 0.25 * gPeak).reduce((min, v) => Math.min(min, v), Infinity);
                const gGrow = Math.max(0, gPeak - gBase);
                gPts.push({ at: geT, s: folded, g: gGrow, pct: gGrow > 0 ? Math.round(folded / gGrow * 1000) / 10 : null });
                gPrevEnd = geT;
            });
            // dynamic axis: 100% is the central reference; over-folds push the axis up (capped 400%)
            const maxPct = Math.max(
                fPts.reduce((mx, fp) => (fp.pct !== null && fp.pct > mx ? fp.pct : mx), 100),
                gPts.reduce((mx, gp) => (gp.pct !== null && gp.pct > mx ? gp.pct : mx), 0)
            );
            const axisMax = maxPct <= 100 ? 150 : Math.min(400, Math.ceil((maxPct * 1.1) / 50) * 50);
            const RY = (pct: number): number => bot - (Math.max(0, Math.min(axisMax, pct)) / axisMax) * (bot - top);
            const colFor = (pct: number): string => pct >= 80 ? "#2da44e" : pct >= 40 ? AMB : RED;
            const gStep = axisMax > 200 ? 50 : 25;
            for (let g = 0; g <= axisMax; g += gStep) {
                body.push('<line x1="' + left + '" y1="' + RY(g).toFixed(1) + '" x2="' + right + '" y2="' + RY(g).toFixed(1) + '" stroke="' + LINEC + '" stroke-width="1"/>');
                txt(left - 6, RY(g) + 3, g + "%", { size: 9.5, color: MUT, anchor: "end", mono: true });
            }
            const yB = RY(100);
            body.push('<line x1="' + left + '" y1="' + yB.toFixed(1) + '" x2="' + right + '" y2="' + yB.toFixed(1) + '" stroke="#57606a" stroke-width="1.3"/>');
            txt(right, yB - 4, t("det.rec_line_base"), { size: 8.5, color: "#57606a", anchor: "end", mono: true });
            revEvs.filter((ev) => ev.kind === "n").forEach((nv) => {
                const x = TX(nv.at);
                body.push('<path d="M' + x.toFixed(1) + ',' + (top - 6) + ' L' + (x - 5).toFixed(1) + ',' + (top - 15) + ' L' + (x + 5).toFixed(1) + ',' + (top - 15) + ' Z" fill="#d29922"/>');
                txt(x, top - 19, "T" + (nv.tier != null ? nv.tier : "?") + " · " + f.W(nv.pending || 0), { size: 8.5, color: "#d29922", anchor: "middle", mono: true });
            });
            // axis ticks for compressions without a measurable recommendation
            let tickLines = "";
            fPts.forEach((fp) => {
                if (fp.pct !== null) return;
                const x = TX(fp.at);
                tickLines += '<line x1="' + x.toFixed(1) + '" y1="' + (bot - 13).toFixed(1) + '" x2="' + x.toFixed(1) + '" y2="' + bot.toFixed(1) + '" stroke="' + (fp.mode === "a" ? ACC : MUT) + '" stroke-width="2"/>';
            });
            body.push(tickLines);
            // main line + points + cumulative (mass-weighted running Σfolded ÷ Σrecommended)
            let cpSum = 0, cfSum = 0;
            const cumPts: string[] = [];
            const mainPts: string[] = [];
            const measCount = fPts.filter((fp) => fp.pct !== null).length;
            const showEvery = measCount > 8 ? 2 : 1;
            let shown = 0;
            fPts.forEach((fp) => {
                if (fp.pct === null) return;
                const x = TX(fp.at);
                const over = fp.pct > 100;
                const dcol = over ? ACC : colFor(fp.pct);
                if (over) body.push('<circle cx="' + x.toFixed(1) + '" cy="' + RY(fp.pct).toFixed(1) + '" r="6" fill="none" stroke="' + ACC + '" stroke-width="1.5"/>');
                body.push('<circle cx="' + x.toFixed(1) + '" cy="' + RY(fp.pct).toFixed(1) + '" r="3.5" fill="' + dcol + '" stroke="#ffffff" stroke-width="1"/>');
                if (shown++ % showEvery === 0) txt(x, RY(fp.pct) - 7, fp.pct.toFixed(fp.pct >= 100 ? 0 : 1) + "%", { size: 9, weight: "600", color: dcol, anchor: "middle", mono: true });
                cpSum += fp.p; cfSum += fp.S;
                mainPts.push(x.toFixed(1) + "," + RY(fp.pct).toFixed(1));
                if (cpSum > 0) cumPts.push(x.toFixed(1) + "," + RY((cfSum / cpSum) * 100).toFixed(1));
            });
            // per-round brackets (round sums; a round's point values add up to its pct)
            // old-stock pool: each round adds its pending, folds consume to a floor of 0
            let recPool = 0;
            const epExtra = eps.map((ep) => {
                recPool += ep.pending || 0;
                const folded = ep.folded || 0;
                const credited = Math.min(folded, recPool);
                recPool -= credited;
                return Math.max(0, folded - credited);
            });
            eps.forEach((ep, i) => {
                const epAt = ep.at ?? 0;
                let end = epAt, k = 0;
                revEvs.filter((ev) => ev.kind === "f" && ev.mode === "n").forEach((fd) => {
                    if (fd.at >= epAt && (i + 1 >= eps.length || fd.at < (eps[i + 1].at ?? Infinity))) { k++; if (fd.at > end) end = fd.at; }
                });
                const x = TX(t1 > t0 ? (epAt + end) / 2 : epAt);
                if (ep.pct != null) {
                    const over = ep.pct > 100;
                    const dcol = over ? ACC : colFor(ep.pct);
                    body.push('<circle cx="' + x.toFixed(1) + '" cy="' + RY(Math.min(axisMax, ep.pct)).toFixed(1) + '" r="2.5" fill="' + dcol + '"/>');
                }
                const extra = epExtra[i] || 0;
                const x0 = TX(epAt), yb = bot + 14 + (i % 2) * 15;
                body.push('<path d="M' + x0.toFixed(1) + ',' + (yb - 4) + ' L' + x0.toFixed(1) + ',' + yb + ' L' + x.toFixed(1) + ',' + yb + ' L' + x.toFixed(1) + ',' + (yb - 4) + '" fill="none" stroke="' + MUT + '" stroke-width="1"/>');
                txt((x0 + x) / 2, yb + 10, t(ep.open ? "det.rec_bracket_open" : "det.rec_bracket", ep.open ? { k, s: f.W(ep.folded || 0), p: f.W(ep.pending || 0), pct: ep.pct != null ? ep.pct.toFixed(ep.pct >= 100 ? 0 : 1) + "%" : "-" } : { i: i + 1, k, s: f.W(ep.folded || 0), p: f.W(ep.pending || 0), pct: ep.pct != null ? ep.pct.toFixed(ep.pct >= 100 ? 0 : 1) + "%" : "-" }) + (extra > 0 ? t("det.rec_bracket_over", { s: f.W(extra) }) : ""), { size: 8.5, color: MUT, anchor: "middle", mono: true });
            });
            if (mainPts.length > 1) body.push('<polyline points="' + mainPts.join(" ") + '" fill="none" stroke="#57606a" stroke-width="1.5"/>');
            if (cumPts.length > 1) body.push('<polyline points="' + cumPts.join(" ") + '" fill="none" stroke="#8250df" stroke-width="1.2" stroke-dasharray="4 3"/>');
            // growth line: thick teal, one point per round (hollow dots — blue is reserved for active folds / over-100 fold dots)
            const gLinePts: string[] = [];
            gPts.forEach((gp) => { if (gp.pct !== null) gLinePts.push(TX(gp.at).toFixed(1) + "," + RY(gp.pct).toFixed(1)); });
            if (gLinePts.length > 1) body.push('<polyline points="' + gLinePts.join(" ") + '" fill="none" stroke="' + GROW + '" stroke-width="2"/>');
            gPts.forEach((gp) => {
                const x = TX(gp.at);
                if (gp.pct === null) {
                    // no new growth → mark on the 0% axis (pure older-stock cleanup)
                    body.push('<circle cx="' + x.toFixed(1) + '" cy="' + bot.toFixed(1) + '" r="4" fill="none" stroke="' + GROW + '"><title>' + t("det.rec_growth_flat", { s: f.W(gp.s) }) + "</title></circle>");
                    return;
                }
                const over = gp.pct > 100;
                if (over) body.push('<circle cx="' + x.toFixed(1) + '" cy="' + RY(gp.pct).toFixed(1) + '" r="7" fill="none" stroke="' + GROW + '"/>');
                body.push('<circle cx="' + x.toFixed(1) + '" cy="' + RY(gp.pct).toFixed(1) + '" r="4.5" fill="#ffffff" stroke="' + GROW + '" stroke-width="1.8"><title>' + t("det.rec_growth_tip", { at: f.DT(gp.at), g: f.W(gp.g), s: f.W(gp.s), pct: gp.pct }) + "</title></circle>");
                const lx = x + 9 > right - 44 ? x - 9 : x + 9;
                txt(lx, RY(gp.pct) + 3, gp.pct.toFixed(gp.pct >= 100 ? 0 : 1) + "%", { size: 9, weight: "700", color: GROW, anchor: lx < x ? "end" : "start", mono: true });
            });
            y += CH + 16;
        }
        tableHead(rcols);
        revs.forEach((ev, i) => {
            const kind = ev.kind === "n" ? t("det.rec_kind_nudge") + (ev.tier != null ? " T" + ev.tier : "") : ev.mode === "a" ? t("det.rec_kind_active") : t("det.rec_kind_nf");
            tableRow([String(i + 1), ev.at ? f.DT(ev.at) : "-", kind, f.W(ev.pending || 0), ev.folded != null ? f.W(ev.folded) : "-", ev.pct != null ? ev.pct.toFixed(1) + "%" : ev.kind === "n" && ev.paired === false ? t("det.rec_unfolded_short") : "-"], [rcols[0].w, rcols[1].w, rcols[2].w, rcols[3].w, rcols[4].w, rcols[5].w]);
        });
        if ((rec.events || []).length > 10) { noteLine(t("det.rec_note_window", { n: 10 })); noteLine("… +" + ((rec.events || []).length - 10) + " earlier events (see .md)"); }
    }
    y += 24;
    const H = Math.ceil(y);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">'
        + '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff"/>'
        + body.join("") + "</svg>";
    return { svg, w: W, h: H };
}
