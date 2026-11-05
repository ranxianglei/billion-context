import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionReportMd, buildSessionReportSvg } from "../src/web/report.ts";

const D = {
    id: "01a11bc7-2e24-763f-a52d-e2a87b07145d",
    title: "SECRET-TITLE-XYZ",
    protocol: "anthropic",
    upstreamOrigin: "https://api.example.com/v1",
    requests: 42,
    inputTokens: 900000,
    cachedTokens: 720000,
    outputTokens: 30000,
    systemPromptTokens: 8000,
    contextTokens: 120000,
    contextWindow: 200000,
    contextTokensSource: "estimate",
    blockDetails: [{ active: true }, { active: true }, { active: false }],
    ledger: {
        totals: { newContent: 100000, compRepay: 20000, ttlRepay: 5000, residual: 1234, balanced: true },
        seam: {
            suspects: 2,
            missed: 3000,
            abortCorrelated: 1,
            providerSide: { count: 1, missed: 100 },
            rewinds: { count: 1, missed: 50 },
            events: [{ seq: 3, at: 1700000000000, hitPct: 42.5, input: 80000, lcpBytes: 2048, msgIndex: 7 }]
        },
        stability: { paired: 40, equal: 30, diverged: 10, head: 2, append: 5, mid: 3, unknownOffset: 0 },
        folds: [{ seq: 1, at: 1700000100000, S: 50000, sigma: 1200, hPct: 80.2, T: 120 }],
        lines: [
            { input: 10000, cached: 5000 },
            { input: 20000, cached: 18000 },
            { input: 30000, cached: 28000 }
        ]
    }
};

// The only non-deterministic byte is the generation timestamp; neutralize it before comparing.
const stripTs = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+Z)?/g, "TS");

test("markdown: masks title/label by default but keeps upstream host for diagnosis", () => {
    const md = buildSessionReportMd(D);
    assert.ok(!md.includes("SECRET-TITLE-XYZ"), "title must be masked by default");
    assert.ok(md.includes("api.example.com"), "upstream host is diagnostic and must stay visible");
});

test("markdown: mask=false reveals the raw title", () => {
    const md = buildSessionReportMd(D, { mask: false });
    assert.ok(md.includes("SECRET-TITLE-XYZ"));
});

test("markdown: renders every section heading + key metrics (zh default)", () => {
    const md = buildSessionReportMd(D);
    for (const h of ["# billion-context session report", "基本信息", "用量统计", "上下文轨迹", "缓存经济学"]) {
        assert.ok(md.includes(h), "missing section: " + h);
    }
    assert.ok(md.includes("900K"), "input tokens formatted");
    assert.ok(md.includes("720K"), "cached tokens formatted");
    assert.ok(md.includes("42.5%"), "seam event hit % present");
    assert.ok(md.includes("diverged: 10"), "stability divergence present");
    assert.ok(md.includes("## ⚠ 缓存接缝事件 · 1"), "seam heading present");
    assert.ok(!md.includes("⚠ ⚠"), "no doubled warning glyph (i18n string already carries it)");
});

test("markdown: locale switching changes headings (zh vs en)", () => {
    const zh = buildSessionReportMd(D, { lang: "zh-CN" });
    const en = buildSessionReportMd(D, { lang: "en" });
    assert.notEqual(zh, en);
    assert.ok(zh.includes("基本信息"));
    assert.ok(!en.includes("基本信息"), "en output must not contain the zh identity heading");
    assert.ok(en.includes("api.example.com"), "host kept in en too");
});

test("markdown: deterministic modulo timestamp", () => {
    assert.equal(stripTs(buildSessionReportMd(D)), stripTs(buildSessionReportMd(D)));
});

test("svg: well-formed closed vector, correct dims, masks title, keeps host", () => {
    const r = buildSessionReportSvg(D);
    assert.ok(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
    assert.ok(r.svg.endsWith("</svg>"));
    assert.equal(r.w, 920);
    assert.ok(r.h > 0);
    assert.ok(r.svg.includes('width="920"') && r.svg.includes(`height="${r.h}"`));
    assert.ok(!r.svg.includes("SECRET-TITLE-XYZ"), "title masked in svg");
    assert.ok(r.svg.includes("api.example.com"));
    assert.ok(!r.svg.includes("<foreignObject>"), "must stay a closed vector doc");
});

test("svg: mask=false reveals title; deterministic modulo timestamp", () => {
    assert.ok(buildSessionReportSvg(D, { mask: false }).svg.includes("SECRET-TITLE-XYZ"));
    assert.equal(stripTs(buildSessionReportSvg(D).svg), stripTs(buildSessionReportSvg(D).svg));
});

test("empty payload: no crash, still emits a titled report", () => {
    const md = buildSessionReportMd({});
    assert.ok(typeof md === "string" && md.length > 0);
    assert.ok(md.includes("# billion-context session report"));
    const sv = buildSessionReportSvg({});
    assert.ok(sv.svg.startsWith("<svg") && sv.svg.endsWith("</svg>") && sv.w === 920 && sv.h > 0);
});
