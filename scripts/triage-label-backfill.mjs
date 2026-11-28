#!/usr/bin/env node
/**
 * Triage label backfill — idempotent, add-only (issue #7059).
 *
 * After the 2026-11-12 "never relabel source issues" hard rule, workers
 * stopped labeling issues on pickup; the rule was refined on 2026-11-17
 * (labeling on pickup is REQUIRED — only title/state/body mutation is
 * banned), but the unlabeled backlog remained. This script closes it.
 *
 * Scope (2026-11-18 owner expansion, supersedes the original zero-label
 * scope): every OPEN issue MISSING a priority label (p1/p2/p3) — both the
 * "has other labels but no p" and the "zero labels" cases. For each target:
 *   1. priority: exactly one of p1/p2/p3 (targets have none by definition).
 *      p1 ONLY on strong signals (crash / data loss / availability /
 *      cache-leak class per triage.md §1); anything uncertain gets p2 and
 *      is listed for owner review.
 *   2. host lane: added only when the issue has NO lane label yet — the
 *      single clearly-involved host (never for cross-lane).
 *   3. scope/*: added only when the issue has NO scope label yet — one
 *      domain label, first matching rule wins.
 *
 * Red lines (issue §5, enforced):
 *   - add-only: POST /issues/{n}/labels appends; existing labels are never
 *     removed, reordered or renamed (an existing lane/scope is kept, not
 *     replaced with a second one);
 *   - never renames, closes, or edits the issue body;
 *   - skips [根因] aggregation issues (the classification pipeline's match
 *     targets) — they stay untouched.
 *
 * Idempotent: a second run finds no issue missing a p label → zero writes.
 *
 * Usage:
 *   GITHUB_TOKEN=... node scripts/triage-label-backfill.mjs [--dry-run]
 *
 * Output (stdout, markdown): summary, the full issue→labels table, the p1
 * list (with the matched signal), the p3 list, and the p2 review list —
 * paste-ready for the pinned discussion ledger (#3913).
 */
import process from "node:process";

const REPO = process.env.GITHUB_REPOSITORY || "ranxianglei/billion-context";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const BASE = "https://api.github.com";
const DRY_RUN = process.argv.includes("--dry-run");
const DELAY_MS = 120;

if (!TOKEN) {
    console.error("triage-label-backfill: GITHUB_TOKEN is required");
    process.exit(1);
}

/* ------------------------------ HTTP layer ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Core rate limit on the shared fleet token is small (observed 60/h) and
 *  resets hourly — a full backfill legitimately spans multiple windows. On a
 *  rate-limit 403/429, sleep until X-RateLimit-Reset and retry, up to 24
 *  windows (~24 h) before giving up. */
async function ghJson(url, init = {}) {
    for (let attempt = 0; ; attempt++) {
        const res = await fetch(url, {
            ...init,
            headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${TOKEN}`,
                "user-agent": "bili-triage-label-backfill",
                "x-github-api-version": "2022-11-28",
                ...(init.headers ?? {}),
            },
            signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) return res.json();
        const text = await res.text().catch(() => "");
        const limited =
            (res.status === 403 || res.status === 429) &&
            (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(text));
        if (!limited || attempt >= 24) {
            throw new Error(`${init.method ?? "GET"} ${url} → ${res.status} ${text.slice(0, 300)}`);
        }
        const resetSec = Number(res.headers.get("x-ratelimit-reset") || 0);
        const waitMs = Math.max(0, resetSec * 1000 - Date.now()) + 2_000;
        console.log(`rate limited — sleeping ${Math.round(waitMs / 60000)} min until window reset (attempt ${attempt + 1}/24)`);
        await sleep(waitMs);
    }
}

/* --------------------------- classification rules ----------------------- */
/*
 * Keyword rules per reference/triage.md. Deliberately conservative:
 * - p1 only on strong, explicit signals (never guessed);
 * - host lane only when EXACTLY ONE host matches (跨车道不打);
 * - scope: first matching rule wins, order = specificity;
 * - anything unmatched falls to p2 + scope/other and lands in the review list.
 */

/** Host-lane rules. claude-code / opencodev2 are checked first and SUPPRESS
 *  their bare forms (same product line — not a cross-lane). */
const HOST_RULES = [
    { label: "claude-code", re: /claude[\s-]*code/i, suppress: "claude" },
    { label: "opencodev2", re: /opencode[\s-]*v2/i, suppress: "opencode" },
    { label: "dsh", re: /\bdsh\b/i },
    { label: "pi", re: /\bpi\b/i },
    { label: "codex", re: /\bcodex\b/i },
    { label: "claude", re: /\bclaude\b/i },
    { label: "opencode", re: /\bopencode\b/i },
    { label: "hermes", re: /\bhermes\b/i },
    { label: "kimi", re: /\bkimi\b/i },
    { label: "trae", re: /\btrae\b/i },
    { label: "zcode", re: /\bzcode\b/i },
    { label: "omp", re: /\bomp\b/i },
    { label: "gemini", re: /\bgemini\b/i },
];

/** Scope rules — first match wins. Order: docs, ci, storage, kernel, ui,
 *  wiring, other (per reference/triage.md §3; kernel before ui so banner
 *  REPORTS of compression conflicts land in the compression domain, matching
 *  the #3913 ledger's category-C placement).
 *  The TITLE is tested first with these (broad) rules; only when the title
 *  matches nothing is the BODY tried — with the stricter BODY_SCOPE_RULES
 *  below, because bodies quote subsystems incidentally (URLs, "see the
 *  docs", "an image was sent"). "kernel" in a title must not be a file
 *  path (kernel/SECURITY.md) — hence the (?![\/.]) lookahead. */
const SCOPE_RULES = [
    { label: "scope/docs", re: /\[docs?\](?!\w)|\bdocs\b|documentation|readme|configuration\.md/i },
    { label: "scope/ci", re: /\bci\b|流水线|release pipeline|github actions|workflow|测试基建|test infra|\bdependency|依赖|self.?update|auto.?upgrade|更新通道|\brollback\b|回滚/i },
    { label: "scope/storage", re: /\bstorage\b|sqlite|持久化|存储|\bgc\b|ingest|session file|digest|originals|hydration|checkpoint|\bfork(s|ed)?\b|quick_?check/i },
    { label: "scope/kernel", re: /kernel(?![\/.])|压缩|compaction|compression|折叠|\bfold(s|ed|ing)?\b|摘要|ledger|账本|summary|snapshot|thinking|image|图像|calibrat|usage|effectiveToken|token count|render.?tag|system.?prompt|系统提示|carrier|output.?budget|\bcache\b|reforge/i },
    { label: "scope/ui", re: /\bweb ui\b|web panel|面板|\bui\b|banner|页面|\bpage\b|展示|display|\bmetrics\b|\btab(s|bed)?\b/i },
    { label: "scope/wiring", re: /wire|tunnel|\begress\b|\bingress\b|request|protocol|协议|接线|inject|注入|plugin lane|\bplugin install\b|\bproxy\b|adapter|\bsse\b|websocket|\bws\b|\bhttp\b(?!:\/\/)|stream|endpoint|\broute\b|nudge|provider|\bfetch\b|degrad|\btools?\b|tool_call|tool result/i },
    { label: "scope/other", re: null },
];

/** Stricter body-fallback scope rules: only high-precision domain terms.
 *  Dropped vs the title rules: bare "docs"/"readme"/"documentation"/
 *  "configuration.md" (bodies cite READMEs and docs as EVIDENCE — not docs
 *  issues; only the [docs] tag marks a docs issue), "kernel"/"compression"
 *  (the bug-report template carries a "Compression-related config" section
 *  and an "Operating system … kernel 6.x" field — both fire on boilerplate,
 *  and "kernel/" paths are file references, not the compression engine),
 *  "依赖"/"dependency" (incidental mentions), "image/图像/usage/summary/
 *  token count/system-prompt/output-budget" (common prose),
 *  "request/provider/fetch/degrad/tools/adapter" (every body talks about
 *  requests), "render-tag" (bodies quote `renderTags=…` log lines as
 *  evidence), "web panel/面板" (bodies list the panel as one of several
 *  affected surfaces). "http" must be a bare word, never a URL. */
const BODY_SCOPE_RULES = [
    { label: "scope/docs", re: /\[docs?\](?!\w)/i },
    { label: "scope/ci", re: /\bci\b|流水线|release pipeline|github actions|workflow|测试基建|test infra|self.?update|auto.?upgrade|更新通道|\brollback\b|回滚/i },
    { label: "scope/storage", re: /\bstorage\b|sqlite|持久化|存储|\bgc\b|ingest|session file|digest|originals|hydration|checkpoint|\bfork(s|ed)?\b|quick_?check/i },
    { label: "scope/kernel", re: /压缩|compaction|折叠|\bfold(s|ed|ing)?\b|摘要|ledger|账本|snapshot|thinking|calibrat|effectiveToken|系统提示|carrier|reforge|\bcache\b/i },
    { label: "scope/ui", re: /\bweb ui\b|\bui\b|banner|页面|\bpage\b|展示|display|\bmetrics\b|\btab(s|bed)?\b/i },
    { label: "scope/wiring", re: /wire|tunnel|\begress\b|\bingress\b|protocol|协议|接线|inject|注入|plugin lane|\bproxy\b|\bsse\b|websocket|\bws\b|\bhttp\b(?!:\/\/)|stream|endpoint|\broute\b|nudge|出站|tool_call|tool result/i },
    { label: "scope/other", re: null },
];

/** p1 strong signals (triage.md §1: 可用性缺陷 + 缓存泄露类, owner 2026-10-19).
 *  Matched on the TITLE only — the title is the curated one-line summary of
 *  the defect, whereas the body routinely QUOTES the triage rules themselves
 *  (e.g. a backfill issue whose body says "缓存泄露类一律 p1") or mentions a
 *  word incidentally. A body-only p1 word is a guess, and the issue forbids
 *  guessing p1: those fall to p2 + the owner-review list instead. */
const P1_SIGNALS = [
    ["crash", /\bcrash(es|ed|ing)?\b|崩溃/i],
    ["data-corruption", /\bcorrupt(s|ed|ion)?\b|数据损坏|数据丢失|data loss|丢失/i],
    ["stack-overflow", /\boverflow(s|ed)?\b[\s\S]{0,30}\bstack\b|\bstack\b[\s\S]{0,30}\boverflow/i],
    ["unusable", /unusable|不可用|无法使用|无法调用|no longer call tools|cannot call tools|停摆/i],
    ["history-emptied", /\bempty(ies|ied)?\b[\s\S]{0,24}\bhistories?\b|\bhistories?\b[\s\S]{0,24}\bempty/i],
    ["sessions-stop", /sessions?\s+stop(s|ping|ped)?\s+(by themselves|on its own|spontaneously)|会话.*自行停止/i],
    ["cache-leak", /stale cache|cache\s*ref|只增不减|unbounded (context|growth|memory)|缓存泄露|cache leak|无限增长/i],
    ["cache-collapse", /cache hit (rate )?(fall|drop|collapse)|prefix cache (break|broken|崩坏)|缓存命中(崩坏|暴跌)/i],
    ["bricked", /\bbrick(s|ed|ing)?\b/i],
    ["every-request-refused", /\brefus(es|ed|ing)?\b[\s\S]{0,25}\bevery request|\bevery request[\s\S]{0,25}\brefus/i],
    ["never-terminated", /never terminated|永不终止|永不结束/i],
];

/** p3 signals (triage.md §1: 轻微缺陷、文档、测试补齐、UX 打磨、低频场景).
 *  Also title-anchored for the same reason as p1. */
const P3_SIGNALS = [
    ["docs", /\[docs?\]\b|\bdocs\b|documentation|文档|typo|拼写|勘误/i],
    ["test-fill", /测试补齐|补测试|test completion|补全测试/i],
    ["ux-polish", /\bux\b|体验|外观/i],
    ["low-frequency", /\blabel(s|ing)?\b|标签|\bplaceholder\b|站位|占位/i],
];

/** Feature requests are p2 scheduling items — never p1 (even if the title
 *  incidentally contains a p1 word) and never p3. Checked FIRST. */
const FEATURE_RE = /^\s*\[?(enhancement|feature)\b|^feat:|\bfeature request\b|\bauto-upgrade\b|提案/i;

/* ------------------------------ classification -------------------------- */

function detectHosts(text) {
    const hits = new Set();
    for (const rule of HOST_RULES) {
        if (rule.re.test(text)) hits.add(rule.label);
    }
    for (const rule of HOST_RULES) {
        if (rule.suppress && hits.has(rule.label)) hits.delete(rule.suppress);
    }
    return hits;
}

function detectScope(text, rules) {
    for (const rule of rules) {
        if (rule.re && rule.re.test(text)) return rule.label;
    }
    return null;
}

/** Lane: the TITLE names exactly one host → that host. Otherwise the BODY
 *  names exactly one → that host. Two+ hosts anywhere, or none → no lane
 *  (跨车道不打). */
function detectLane(title, body) {
    const titleHosts = detectHosts(title);
    if (titleHosts.size === 1) return [...titleHosts][0];
    if (titleHosts.size === 0) {
        const bodyHosts = detectHosts(body ?? "");
        if (bodyHosts.size === 1) return [...bodyHosts][0];
    }
    return null;
}

function classify(issue) {
    const title = issue.title;
    const rawBody = issue.body ?? "";
    // Fenced code blocks are quoted evidence (debug logs, config dumps) that
    // mention subsystem names incidentally — body scope matching runs on the
    // prose with the fences stripped. Lane detection keeps the full body.
    const body = rawBody.replace(/```[\s\S]*?```/g, " ");
    const lane = detectLane(title, rawBody);
    const scope = detectScope(title, SCOPE_RULES) ?? detectScope(body, BODY_SCOPE_RULES) ?? "scope/other";
    // Priority is title-anchored (see P1/P3_SIGNALS comments): a feature is
    // p2, a title-level p1/p3 signal wins, everything else defaults to p2
    // and is listed for owner review — never a guessed p1.
    let priority = "p2";
    let signal = null;
    if (FEATURE_RE.test(title)) {
        priority = "p2";
    } else if ((signal = P1_SIGNALS.find(([, re]) => re.test(title)))) {
        priority = "p1";
    } else if ((signal = P3_SIGNALS.find(([, re]) => re.test(title)))) {
        priority = "p3";
    }
    return {
        priority,
        lane,
        scope,
        signal: signal ? signal[0] : null,
        needsReview: priority === "p2", // default p2 — no strong title signal
    };
}

/* --------------------------------- main ---------------------------------- */

async function listOpenIssues() {
    const issues = [];
    for (let page = 1; ; page++) {
        const batch = await ghJson(`${BASE}/repos/${REPO}/issues?state=open&per_page=100&page=${page}`);
        if (!Array.isArray(batch) || batch.length === 0) break;
        issues.push(...batch);
        if (batch.length < 100) break;
    }
    return issues;
}

async function addLabels(number, labels) {
    const applied = await ghJson(`${BASE}/repos/${REPO}/issues/${number}/labels`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labels }),
    });
    const appliedNames = (applied ?? []).map((l) => l.name);
    const missing = labels.filter((l) => !appliedNames.includes(l));
    if (missing.length > 0) {
        throw new Error(`#${number}: expected labels ${missing.join(", ")} not in response (${appliedNames.join(", ") || "empty"})`);
    }
    await sleep(DELAY_MS);
}

const P_LABELS = new Set(["p1", "p2", "p3"]);
/** Every lane label that can exist on an issue (HOST_RULES labels + the
 *  antigravity lane, which has no classifier rule but counts as "a lane is
 *  already present"). */
const LANE_LABELS = new Set([...HOST_RULES.map((r) => r.label), "antigravity"]);
const existingLane = (issue) => issue.labels.find((l) => LANE_LABELS.has(l.name))?.name ?? null;
const existingScope = (issue) => issue.labels.find((l) => /^scope[/:]/.test(l.name))?.name ?? null;

async function main() {
    const all = await listOpenIssues();
    const openIssues = all.filter((i) => !i.pull_request);
    const isRootCause = (i) => /^\s*\[根因\]/.test(i.title) || i.labels.some((l) => l.name === "root-cause-batch");
    const missingP = openIssues.filter((i) => !i.labels.some((l) => P_LABELS.has(l.name)));
    const targets = missingP.filter((i) => !isRootCause(i));
    const skippedRootCause = missingP.filter(isRootCause);

    console.log(`# triage-label-backfill ${DRY_RUN ? "(dry-run)" : ""}`);
    console.log("");
    console.log(`open issues: ${openIssues.length} · missing p: ${missingP.length} · targets: ${targets.length} · [根因] skipped: ${skippedRootCause.length}`);
    console.log("");

    if (targets.length === 0) {
        console.log("nothing to do — every open issue carries a p label (idempotent no-op).");
        return;
    }

    const rows = [];
    for (const issue of targets) {
        const c = classify(issue);
        const lane = existingLane(issue);
        const scope = existingScope(issue);
        const labels = [c.priority];
        if (c.lane && !lane) labels.push(c.lane);
        if (!scope) labels.push(c.scope);
        rows.push({ issue, c, labels, lane, scope });
        if (!DRY_RUN) {
            await addLabels(issue.number, labels);
            console.log(`labeled #${issue.number} → +${labels.join(", ")}`);
        }
    }

    const p1 = rows.filter((r) => r.c.priority === "p1");
    const p3 = rows.filter((r) => r.c.priority === "p3");
    const p2Review = rows.filter((r) => r.c.needsReview);
    const crossLane = rows.filter((r) => !r.lane && r.c.lane === null);

    console.log("");
    console.log("## 补打清单 (issue → 标签)");
    console.log("");
    console.log("| # | 优先级 | 车道(终态) | scope(终态) | 本次新增 | 标题 |");
    console.log("|---|--------|-----------|------------|---------|------|");
    for (const { issue, c, labels, lane, scope } of rows) {
        const title = issue.title.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
        console.log(`| #${issue.number} | ${c.priority} | ${lane ?? c.lane ?? "—"} | ${scope ?? c.scope} | ${labels.join(", ")} | ${title.slice(0, 100)} |`);
    }

    console.log("");
    console.log(`## p1 (${p1.length}) — 强信号命中,请抽查`);
    for (const { issue, c } of p1) {
        console.log(`- #${issue.number} [${c.signal}] ${issue.title.slice(0, 90)}`);
    }

    console.log("");
    console.log(`## p3 (${p3.length}) — 文档/低频/UX 信号`);
    for (const { issue, c } of p3) {
        console.log(`- #${issue.number} [${c.signal}] ${issue.title.slice(0, 90)}`);
    }

    console.log("");
    console.log(`## p2 待 owner 复核 (${p2Review.length}) — 无强 p1/p3 信号,默认 p2`);
    for (const { issue } of p2Review) {
        console.log(`- #${issue.number} ${issue.title.slice(0, 90)}`);
    }

    if (crossLane.length > 0) {
        console.log("");
        console.log(`## 未打车道标签 (跨车道或无单一宿主信号, ${crossLane.length})`);
        for (const { issue } of crossLane) {
            console.log(`- #${issue.number} ${issue.title.slice(0, 90)}`);
        }
    }

    console.log("");
    console.log(DRY_RUN ? "dry-run complete — no writes were made." : `done — ${rows.length} issues labeled.`);
}

{
    const failed = await main().catch((e) => {
        console.error(`triage-label-backfill failed: ${e?.message ?? e}`);
        return e;
    });
    if (failed) process.exit(1);
}
