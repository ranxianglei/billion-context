#!/usr/bin/env node
// #5930 (architecture docs initiative): CI guard for the docs/architecture hub.
// Mechanical checks only:
//   1. reference/architecture.md lists every tracked src/ file (no missing, no ghosts)
//   2. hub module ledger: every "active" row has en + zh-CN page pairs; no orphan pages
//   3. every page references assets/<module>.{en,zh-CN}.svg and a .png fallback, all present
//   4. every SVG is basic-well-formed (balanced <g>/<rect>/<text> tags, no unescaped &)
// Visual freshness is NOT machine-checked (same-PR rule + review, see AGENTS.md).

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`ok: ${msg}`);

// ---------- 1. reference/architecture.md covers every tracked src/ file ----------
const tracked = execSync('git -c core.quotepath=off ls-files src/', { encoding: 'utf8' })
  .trim().split('\n')
  .filter((f) => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.json'))
  .filter((f) => !f.includes('.test.') && !f.includes('/e2e/'));

const mapText = readFileSync(join(ROOT, 'reference/architecture.md'), 'utf8');
// The map is a bare box-drawing tree in the markdown body (no code fence):
// "billion-context/" root line, then "├── " / "└── " entries at 4-space indent per level.
const listed = new Set();
const stack = [];
for (const rawLine of mapText.split('\n')) {
  const line = rawLine.replace(/│/g, ' '); // box-drawing gutter counts as indent
  const t = line.trimStart();
  if (!/^[ ]*[├└]── /.test(t)) continue;
  const label = t.replace(/^[ ]*[├└]── /, '').split(' ')[0].trim();
  if (!label) continue;
  const isDir = label.endsWith('/');
  // indent = box-drawing gutter width ("│   "/"    " per level), not whitespace
  const gutter = (rawLine.match(/^(?:[│ ]   )*/)[0].length / 4) | 0;
  const depth = gutter + 1;
  while (stack.length >= depth) stack.pop();
  if (isDir) { stack.push(label.replace(/\/$/, '')); continue; }
  if (label.startsWith('#')) continue;
  listed.add([...stack, label].join('/'));
}
const missing = tracked.filter((f) => !listed.has(f));
const ghosts = [...listed].filter((f) => f.startsWith('src/') && !tracked.includes(f) && !f.endsWith('.md'));
if (missing.length === 0 && ghosts.length === 0) ok(`map covers all ${tracked.length} src files, no ghosts`);
else {
  for (const f of missing) fail(`reference/architecture.md missing: ${f}`);
  for (const f of ghosts) fail(`reference/architecture.md ghost entry: ${f}`);
}

// ---------- 2. hub ledger <-> page set ----------
const hubDir = join(ROOT, 'docs');
const hubEn = readFileSync(join(hubDir, 'architecture.md'), 'utf8');
const hubZh = readFileSync(join(hubDir, 'architecture.zh-CN.md'), 'utf8');
// hub diagrams: the hub lives in docs/, its images in docs/architecture/assets/ —
// the link MUST be ./architecture/assets/... (a bare ./assets/ 404s: that bug
// shipped once with the first hub revision, the rendered image pointed at docs/assets/)
for (const [hub, lang] of [[hubEn, 'en'], [hubZh, 'zh-CN']]) {
  for (const ext of ['svg', 'png']) {
    const link = `./architecture/assets/architecture-current.${lang}.${ext}`;
    if (!hub.includes(`](${link})`)) fail(`docs/architecture.${lang === 'en' ? '' : 'zh-CN.'}md does not link ${link}`);
    if (!existsSync(join(hubDir, 'architecture/assets/architecture-current.' + lang + '.' + ext))) fail(`missing hub diagram: docs/architecture/assets/architecture-current.${lang}.${ext}`);
  }
}
const ledgerSlugs = [...hubEn.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1]);
if (ledgerSlugs.length === 0) fail('hub ledger: no module rows parsed from docs/architecture.md');
const activeSlugs = [];
for (const slug of ledgerSlugs) {
  const rowEn = hubEn.split('\n').find((l) => l.startsWith(`| \`${slug}\``));
  if (rowEn && rowEn.includes('✅')) activeSlugs.push(slug);
}
// zh hub must carry the same ledger
const zhSlugs = [...hubZh.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1]);
if (JSON.stringify(ledgerSlugs) !== JSON.stringify(zhSlugs)) fail('hub ledger mismatch between architecture.md and architecture.zh-CN.md');

const pageDir = join(hubDir, 'architecture');
const pageFiles = existsSync(pageDir) ? readdirSync(pageDir).filter((f) => f.endsWith('.md')) : [];
const pageSlugs = new Set(pageFiles.map((f) => f.replace(/\.zh-CN\.md$/, '').replace(/\.md$/, '')));
for (const slug of activeSlugs) {
  for (const f of [`architecture/${slug}.md`, `architecture/${slug}.zh-CN.md`]) {
    if (!existsSync(join(hubDir, f))) fail(`ledger says ${slug} is active but docs/${f} is missing`);
  }
}
for (const slug of pageSlugs) {
  if (!ledgerSlugs.includes(slug)) fail(`orphan module page (not in hub ledger): docs/architecture/${slug}.md`);
}
if (!process.exitCode) ok(`ledger: ${ledgerSlugs.length} modules, ${activeSlugs.length} active, page set matches`);

// ---------- 3+4. each active page: diagram references present, SVGs well-formed ----------
const BAD_ENT = /&(?!amp;|lt;|gt;|quot;|apos;|#)/;
for (const slug of activeSlugs) {
  for (const lang of ['en', 'zh-CN']) {
    const pageName = lang === 'en' ? `${slug}.md` : `${slug}.zh-CN.md`;
    const page = readFileSync(join(pageDir, pageName), 'utf8');
    const svg = `./assets/${slug === 'storage' ? 'storage' : slug}.${lang}.svg`;
    const png = svg.replace(/\.svg$/, '.png');
    if (!page.includes(`](${svg})`)) fail(`docs/architecture/${slug}.${lang}.md does not link ${svg} (svg-first rule)`);
    if (!page.includes(`](${png})`)) fail(`docs/architecture/${slug}.${lang}.md does not link the ${png} fallback`);
    const svgPath = join(pageDir, svg.slice(2));
    if (!existsSync(svgPath)) { fail(`missing diagram file: docs/${svg}`); continue; }
    const svgText = readFileSync(svgPath, 'utf8');
    if (BAD_ENT.test(svgText)) fail(`unescaped '&' in docs/${svg} (XML would not parse — the en diagram once shipped broken this way)`);
    for (const tag of ['g', 'rect', 'text', 'svg']) {
      const open = (svgText.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length;
      const close = (svgText.match(new RegExp(`</${tag}>`, 'g')) || []).length;
      const self = (svgText.match(new RegExp(`<${tag} [^>]*/>`, 'g')) || []).length;
      if (open !== close + self) fail(`unbalanced <${tag}> in docs/${svg} (open=${open} close=${close} selfclose=${self})`);
    }
    if (!existsSync(join(pageDir, png.slice(2)))) fail(`missing bitmap fallback: docs/${png}`);
  }
}
if (!process.exitCode) ok('diagram references + SVG well-formedness pass');
console.log(process.exitCode ? 'architecture-docs guard: FAILED' : 'architecture-docs guard: all green');
