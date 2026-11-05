#!/usr/bin/env node
// Usage:
//   node tools/gen-config-docs.mjs generate         (default) — rewrite all marked blocks
//   node tools/gen-config-docs.mjs check-coverage   — fail on src params missing from the YAML seed
// Pure Node, zero dependencies: runs locally and in CI without npm install.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_DIR = join(ROOT, "website", "config-reference");
const MD_EN = join(ROOT, "CONFIGURATION.md");
const MD_ZH = join(ROOT, "CONFIGURATION.zh-CN.md");
const MAIN_JS = join(ROOT, "website", "main.js");
const DOCS_HTML = join(ROOT, "website", "docs", "index.html");
const HOME_HTML = join(ROOT, "website", "index.html");
const CONFIG_TS = join(ROOT, "src", "config.ts");

const OPEN = (id) => "\x3c!-- bili:gen " + id + " --\x3e";
const CLOSE = "\x3c!-- /bili:gen --\x3e";
const JOPEN = (id) => "/* bili:gen " + id + " */";
const JCLOSE = "/* /bili:gen */";

const GROUPS = [
  ["core", "Server & core", "服务与核心"],
  ["upstream", "Upstream & billing", "上游与计费"],
  ["behavior", "Behavior toggles", "行为开关"],
  ["mitm", "MITM lane", "MITM 通道"],
  ["process", "Process & persistence", "进程级配置块"],
  ["updates", "Updates & advisories", "更新与公告"],
  ["diagnostics", "Diagnostics & tuning", "诊断与调优"],
  ["compress", "Compression (global level)", "压缩（全局层级）"],
  ["providers", "Provider route fields", "路由表字段"],
  ["envonly", "Environment-only variables", "仅环境变量（无配置文件键）"],
];

const SITE_GROUPS = [
  ["core", "Server & core", "服务与核心"],
  ["up", "Upstream & billing", "上游与计费"],
  ["beh", "Behavior toggles", "行为开关"],
  ["mitm", "MITM lane", "MITM 通道"],
  ["proc", "Process blocks", "进程级块"],
  ["diag", "Diagnostics & updates", "诊断与更新"],
  ["adv", "Advanced scalars", "高级标量"],
];

function fail(msg) {
  console.error("[gen-config-docs] " + msg);
  process.exit(1);
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function mdCell(s) {
  return String(s).replace(/\|/g, "\\|");
}

function parseScalar(raw, ctx) {
  const v = raw.trim();
  if (v === "") return "";
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      fail(ctx + ": quoted value is not valid JSON: " + v.slice(0, 60));
    }
  }
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((p) => parseScalar(p, ctx));
  }
  return v;
}

function parseSeed(text, file) {
  const entries = [];
  let cur = null;
  let inEntries = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    let m;
    if (/^domain:\s*\S+$/.test(line)) continue;
    if (/^entries:\s*$/.test(line)) {
      inEntries = true;
      continue;
    }
    if (!inEntries) fail(file + ":" + (i + 1) + ": unexpected line: " + line);
    if ((m = line.match(/^  - ([A-Za-z_][\w.]*):\s*(.*)$/))) {
      cur = { key: parseScalar(m[2], file + ":" + (i + 1)) };
      entries.push(cur);
      continue;
    }
    if ((m = line.match(/^    ([A-Za-z_][\w]*):\s*(.*)$/))) {
      if (!cur) fail(file + ":" + (i + 1) + ": field before first entry");
      if (m[1] === "key") fail(file + ":" + (i + 1) + ": duplicate key field");
      cur[m[1]] = parseScalar(m[2], file + ":" + (i + 1));
      continue;
    }
    fail(file + ":" + (i + 1) + ": unparsed line: " + line);
  }
  return entries;
}

function validate(entries, file, idMap) {
  for (const e of entries) {
    const ctx = file + ":" + e.key;
    for (const f of ["type", "default", "group", "desc_en", "desc_zh"]) {
      if (typeof e[f] !== "string" || e[f] === "") fail(ctx + ": missing or empty field " + f);
    }
    if (!GROUPS.some((g) => g[0] === e.group)) fail(ctx + ': unknown group "' + e.group + '"');
    // desc_* flow ONLY into the markdown tables below, where backticks are valid inline code.
    if (typeof e.default_zh === "string" && e.default_zh === "") fail(ctx + ": empty default_zh");
    if (typeof e.default_zh !== "undefined" && typeof e.default_zh !== "string") fail(ctx + ": default_zh must be a string");
    const hasId = typeof e.id === "string" && e.id !== "";
    const hasRender = typeof e.render === "string";
    const hasSiteGroup = typeof e.site_group === "string";
    if (hasId !== (hasRender || hasSiteGroup)) fail(ctx + ": id requires exactly one of render|site_group");
    if (hasId && !/^[a-z][a-zA-Z0-9]*\.[A-Za-z0-9_]+$/.test(e.id)) fail(ctx + ": bad id format " + e.id);
    if (hasId && (typeof e.site_en !== "string" || typeof e.site_zh !== "string")) fail(ctx + ": id requires site_en and site_zh");
    if (hasRender && !["compress-row", "obj-item", "route-row", "top-item"].includes(e.render)) fail(ctx + ": bad render " + e.render);
    if (hasSiteGroup && !SITE_GROUPS.some((g) => g[0] === e.site_group)) fail(ctx + ": bad site_group " + e.site_group);
    if (e.kind === "env-only" && !["user", "internal", "test"].includes(e.audience)) fail(ctx + ": env-only entry needs audience user|internal|test");
    if (e.deprecated === "true") e.deprecated = true;
    if (e.deprecated !== undefined && e.deprecated !== true) fail(ctx + ": deprecated must be true");
    if (typeof e.env === "string") e.env = [e.env];
    if (e.env !== undefined && !Array.isArray(e.env)) fail(ctx + ": env must be a name or [names]");
    if (hasId) {
      if (idMap.has(e.id)) fail("duplicate id " + e.id + " (" + idMap.get(e.id) + " vs " + ctx + ")");
      idMap.set(e.id, ctx);
    }
  }
}

function loadSeeds() {
  const files = readdirSync(SEED_DIR).filter((f) => f.endsWith(".yaml")).sort();
  if (!files.length) fail("no .yaml seeds in " + relative(ROOT, SEED_DIR));
  const all = [];
  const idMap = new Map();
  for (const f of files) {
    const es = parseSeed(readFileSync(join(SEED_DIR, f), "utf8"), f);
    if (!es.length) fail(f + ": no entries");
    validate(es, f, idMap);
    for (const e of es) all.push(e);
  }
  return all;
}

function replaceBlock(text, id, body, open, close) {
  const oi = text.indexOf(open);
  if (oi < 0) fail("open marker not found: " + open + " — wire it into the target file first");
  const ci = text.indexOf(close, oi + open.length);
  if (ci < 0) fail("close marker not found for " + id);
  return text.slice(0, oi) + open + "\n" + body + "\n" + close + text.slice(ci + close.length);
}

function genParamRef(entries, lang) {
  const out = [];
  out.push(
    lang === "zh"
      ? "以下索引由 `website/config-reference/*.yaml` 生成——改种子后运行 `node tools/gen-config-docs.mjs generate`，不要手改本区块。"
      : "This index is generated from `website/config-reference/*.yaml` — edit the seed, then run `node tools/gen-config-docs.mjs generate`; do not hand-edit this block."
  );
  out.push("");
  for (const [gid, enL, zhL] of GROUPS) {
    const rows = entries.filter((e) => e.group === gid);
    if (!rows.length) continue;
    out.push("**" + (lang === "zh" ? zhL : enL) + "**");
    out.push("");
    out.push("| Key | Type | Default | Env | Description |");
    out.push("|-----|------|---------|-----|-------------|");
    for (const e of rows) {
      const dep = e.deprecated === true ? (lang === "zh" ? " _(已弃用)_" : " _(deprecated)_") : "";
      const envCol = e.kind === "env-only" ? "—" : e.env && e.env.length ? e.env.join(", ") : "—";
      const desc = lang === "zh" ? e.desc_zh : e.desc_en;
      const def = lang === "zh" && typeof e.default_zh === "string" ? e.default_zh : e.default;
      out.push("| `" + e.key + "` | " + mdCell(e.type) + " | " + mdCell(def) + " | " + mdCell(envCol) + " | " + mdCell(desc) + dep + " |");
    }
    out.push("");
  }
  return out.join("\n");
}

function genEnvMap(entries, lang) {
  const rows = [];
  for (const e of entries) {
    if (e.kind === "env-only" || !e.env) continue;
    for (const name of e.env) rows.push([name, e.key, e.default]);
  }
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const out = [];
  out.push(lang === "zh" ? "| 环境变量 | 配置文件键 | 默认值 |" : "| Env var | Config key | Default |");
  out.push("|---------|------------|--------|");
  for (const [n, k, d] of rows) out.push("| `" + n + "` | `" + k + "` | " + mdCell(d) + " |");
  return out.join("\n");
}

function siteVal(e, lang) {
  return lang === "zh" ? e.site_zh : e.site_en;
}

function genSiteDict(entries, lang) {
  const kv = [];
  for (const r of ["compress-row", "obj-item", "route-row"]) {
    for (const e of entries.filter((x) => x.render === r)) kv.push([e.id, siteVal(e, lang)]);
  }
  for (const [gid, enL, zhL] of SITE_GROUPS) kv.push(["tg." + gid, "<strong>" + escHtml(lang === "zh" ? zhL : enL) + "</strong>"]);
  for (const e of entries.filter((x) => x.site_group)) kv.push([e.id, siteVal(e, lang)]);
  // The block sits mid-object, so every line — including the last — needs its comma.
  return kv.map(([k, v]) => "    " + JSON.stringify(k) + ": " + JSON.stringify(v) + ",").join("\n");
}

function attrFor(v) {
  return v.includes("<") ? "data-i18n-html" : "data-i18n";
}

function leaf(key) {
  return key.split(".").pop();
}

function genParamTable(entries, render, lang) {
  return entries
    .filter((e) => e.render === render)
    .map((e) => {
      const v = siteVal(e, lang);
      return '            <tr><td class="mono">' + leaf(e.key) + '</td><td class="mech">' + e.type + '</td><td ' + attrFor(v) + '="' + e.id + '">' + v + "</td></tr>";
    })
    .join("\n");
}

function genObjList(entries, lang) {
  return entries
    .filter((e) => e.render === "obj-item")
    .map((e) => '          <li data-i18n-html="' + e.id + '">' + siteVal(e, lang) + "</li>")
    .join("\n");
}

function genTopList(entries, lang) {
  const out = [];
  for (const [gid, enL, zhL] of SITE_GROUPS) {
    out.push('          <li class="tg" data-i18n-html="tg.' + gid + '"><strong>' + escHtml(lang === "zh" ? zhL : enL) + "</strong></li>");
    for (const e of entries.filter((x) => x.site_group === gid)) {
      out.push('          <li data-i18n-html="' + e.id + '">' + siteVal(e, lang) + "</li>");
    }
  }
  return out.join("\n");
}

function writeBlocks(entries) {
  let md = readFileSync(MD_EN, "utf8");
  md = replaceBlock(md, "param-ref", genParamRef(entries, "en"), OPEN("param-ref"), CLOSE);
  md = replaceBlock(md, "env-map", genEnvMap(entries, "en"), OPEN("env-map"), CLOSE);
  writeFileSync(MD_EN, md);

  let mdZh = readFileSync(MD_ZH, "utf8");
  mdZh = replaceBlock(mdZh, "param-ref", genParamRef(entries, "zh"), OPEN("param-ref"), CLOSE);
  mdZh = replaceBlock(mdZh, "env-map", genEnvMap(entries, "zh"), OPEN("env-map"), CLOSE);
  writeFileSync(MD_ZH, mdZh);

  let js = readFileSync(MAIN_JS, "utf8");
  js = replaceBlock(js, "site-dict-en", genSiteDict(entries, "en"), JOPEN("site-dict-en"), JCLOSE);
  js = replaceBlock(js, "site-dict-zh", genSiteDict(entries, "zh"), JOPEN("site-dict-zh"), JCLOSE);
  writeFileSync(MAIN_JS, js);

  let h = readFileSync(DOCS_HTML, "utf8");
  h = replaceBlock(h, "compress-table", genParamTable(entries, "compress-row", "en"), OPEN("compress-table"), CLOSE);
  h = replaceBlock(h, "compress-objlist", genObjList(entries, "en"), OPEN("compress-objlist"), CLOSE);
  h = replaceBlock(h, "routes-table", genParamTable(entries, "route-row", "en"), OPEN("routes-table"), CLOSE);
  h = replaceBlock(h, "top-list", genTopList(entries, "en"), OPEN("top-list"), CLOSE);
  writeFileSync(DOCS_HTML, h);

  console.log("[gen-config-docs] wrote 10 blocks from " + entries.length + " seed entries");
}

function dictKeys(slice) {
  const ks = new Set();
  const re = /"([A-Za-z0-9_.]+)"\s*:/g;
  let m;
  while ((m = re.exec(slice))) ks.add(m[1]);
  return ks;
}

function checkI18n() {
  const js = readFileSync(MAIN_JS, "utf8");
  const enStart = js.indexOf("en: {");
  const zhStart = js.indexOf("zh: {");
  const endAt = js.indexOf("};", zhStart);
  if (enStart < 0 || zhStart < 0 || endAt < 0) fail("I18N object structure not recognized in website/main.js");
  const en = dictKeys(js.slice(enStart, zhStart));
  const zh = dictKeys(js.slice(zhStart, endAt));
  const problems = [];
  for (const k of en) if (!zh.has(k)) problems.push("en-only key: " + k);
  for (const k of zh) if (!en.has(k)) problems.push("zh-only key: " + k);
  for (const f of [DOCS_HTML, HOME_HTML]) {
    const html = readFileSync(f, "utf8");
    const re = /data-i18n(?:-html)?="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      if (!en.has(m[1]) || !zh.has(m[1])) problems.push(relative(ROOT, f) + ": unresolved i18n ref " + m[1]);
    }
  }
  if (problems.length) {
    for (const p of problems) console.error("[gen-config-docs] " + p);
    process.exit(1);
  }
  console.log("[gen-config-docs] i18n ok: " + en.size + " keys, EN/ZH sets equal, all refs resolve");
}

function walkTs(dir, acc) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTs(p, acc);
    else if (name.endsWith(".ts")) acc.push(p);
  }
  return acc;
}

function extractEnvNames() {
  const names = new Set();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
    /\benv\.([A-Z][A-Z0-9_]*)/g,
    /\w+\(\s*["']((?:BILI|ACP)_[A-Z0-9_]+)["']/g,
  ];
  const quotedName = /["']((?:BILI|ACP)_[A-Z0-9_]+)["']/g;
  for (const f of walkTs(join(ROOT, "src"), [])) {
    const t = readFileSync(f, "utf8");
    for (const rx of patterns) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(t))) names.add(m[1]);
    }
    // helper calls that pass the name as a LATER argument (envMillis(env, "NAME", d)):
    // quoted BILI_/ACP_ literals on lines that reference the env object.
    for (const ln of t.split("\n")) {
      if (/^\s*(\/|\*|#)/.test(ln)) continue;
      if (!/process\.env|\benv\b/.test(ln)) continue;
      quotedName.lastIndex = 0;
      let m;
      while ((m = quotedName.exec(ln))) names.add(m[1]);
    }
  }
  return [...names].filter((n) => /^(?:BILI|ACP)_/.test(n)).sort();
}

function knownTopLevelKeys() {
  const t = readFileSync(CONFIG_TS, "utf8");
  const m = t.match(/const KNOWN_TOP_LEVEL_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) fail("KNOWN_TOP_LEVEL_KEYS literal not found in src/config.ts");
  const keys = [...m[1].matchAll(/["']([A-Za-z_$][\w$]*)["']/g)].map((x) => x[1]);
  if (!keys.length) fail("parsed empty KNOWN_TOP_LEVEL_KEYS");
  return keys.sort();
}

function checkCoverage(entries) {
  const found = extractEnvNames();
  const docEnv = new Set();
  for (const e of entries) {
    if (e.kind === "env-only") docEnv.add(e.key);
    if (e.env) for (const n of e.env) docEnv.add(n);
  }
  const missingEnv = found.filter((n) => !docEnv.has(n));
  const staleEnv = [...docEnv].filter((n) => /^(?:BILI|ACP)_/.test(n) && !found.includes(n)).sort();
  const tops = knownTopLevelKeys();
  const knobKeys = entries.filter((e) => e.kind !== "env-only").map((e) => e.key);
  const missingTop = tops.filter((K) => !knobKeys.some((k) => k === K || k.startsWith(K + ".")));
  let bad = false;
  if (missingEnv.length) {
    bad = true;
    console.error("[gen-config-docs] UNDOCUMENTED env vars read in src/:");
    for (const n of missingEnv) console.error("  " + n);
  }
  if (missingTop.length) {
    bad = true;
    console.error("[gen-config-docs] UNDOCUMENTED FileConfig top-level keys:");
    for (const n of missingTop) console.error("  " + n);
  }
  if (staleEnv.length) {
    console.log("[gen-config-docs] notice: documented but not detected in src reads (expected for dynamic names):");
    for (const n of staleEnv) console.log("  " + n);
  }
  if (bad) process.exit(1);
  console.log("[gen-config-docs] coverage ok: " + found.length + " env names + " + tops.length + " top-level keys all documented");
}

const cmd = process.argv[2] || "generate";
if (cmd === "generate") {
  const entries = loadSeeds();
  writeBlocks(entries);
  checkI18n();
} else if (cmd === "check-coverage") {
  checkCoverage(loadSeeds());
} else {
  fail("unknown command: " + cmd + " (use generate | check-coverage)");
}
