#!/usr/bin/env node
// align-check.mjs — billion-context fork 继承判定器（只读 index.db）
// node align-check.mjs <parentSessionId> <childSessionId> [--db PATH] [--json]

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const has = (n) => argv.includes(`--${n}`);
const val = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
if (pos.length < 2) { console.error('usage: node align-check.mjs <parent> <child> [--db PATH] [--json]'); process.exit(2); }
const [parentId, childId] = pos;
const dbPath = val('db') ?? path.join(os.homedir(), '.local/share/billion-context/sessions/index.db');

// 注意：不要传 { readOnly: true }，node:sqlite 在 Windows 上会 errcode 14
const db = new DatabaseSync(dbPath);

const loadRows = (sid) => db.prepare(`
  select m.seq, m.msg_id, m.role, m.ref, m.content_hash, m.retired_at, c.bytes as cbytes
    from messages m left join content c on c.hash = m.content_hash
   where m.session_id = ? order by m.seq`).all(sid).map((r) => {
  let body = null;
  if (r.cbytes) { try { body = JSON.parse(Buffer.from(r.cbytes).toString('utf8')); } catch { body = null; } }
  return { ...r, body };
});

const P = loadRows(parentId);
const C = loadRows(childId);
if (!P.length) throw new Error(`parent empty/not found: ${parentId}`);
if (!C.length) throw new Error(`child empty/not found: ${childId}`);

// tool-call 参数在不同序列化之间只差空白，比较前统一重排
const normText = (t, ct) => {
  if (typeof t !== 'string') return t ?? null;
  if (ct === 'tool-call') { try { return JSON.stringify(JSON.parse(t)); } catch { return t; } }
  return t;
};

const MODES = {
  // 与客户端 forkIdentityHashOf 同构（现状）
  current: (r) => { const b = r.body ?? {}; return [r.role, b.contentType ?? null, b.text ?? null, b.toolName ?? null, b.toolCallId ?? null, b.thinkingTokens ?? null, b.summaryOfBlockId ?? null, b.toolIsError === true]; },
  // 只把 contentType 移出
  noContentType: (r) => { const b = r.body ?? {}; return [r.role, b.text ?? null, b.toolName ?? null, b.toolCallId ?? null, b.thinkingTokens ?? null, b.summaryOfBlockId ?? null, b.toolIsError === true]; },
  // contentType 移出 + tool-call JSON 归一
  normalized: (r) => { const b = r.body ?? {}; const ct = b.contentType ?? null; return [r.role, normText(b.text, ct), b.toolName ?? null, b.toolCallId ?? null, b.thinkingTokens ?? null, b.summaryOfBlockId ?? null, b.toolIsError === true]; },
};

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const K = (t) => JSON.stringify(t);

// 严格前缀（复刻 matchForkPrefix）
const strictPrefix = (mode) => {
  const n = Math.min(P.length, C.length);
  for (let i = 0; i < n; i++) if (!eq(mode(P[i]), mode(C[i]))) return i;
  return n;
};

// 顺序贪心对齐：允许子表插入，不允许顺序回退
const orderedAlign = (mode) => {
  const buckets = new Map();
  C.forEach((r, idx) => { const k = K(mode(r)); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(idx); });
  let cursor = -1, matched = 0, firstMiss = -1, missing = [];
  for (let i = 0; i < P.length; i++) {
    const list = buckets.get(K(mode(P[i])));
    let hit = -1;
    if (list) { let lo = 0, hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] <= cursor) lo = m + 1; else hi = m; } if (lo < list.length) hit = list[lo]; }
    if (hit >= 0) { matched++; cursor = hit; }
    else if (firstMiss < 0) { firstMiss = i; if (missing.length < 5) missing.push(P[i].msg_id?.slice(0, 22)); }
  }
  return { matched, total: P.length, rate: matched / P.length, firstMiss, missing };
};

const blocksOf = (sid) => db.prepare('select block_id, ord, tier, active, payload_json from blocks where session_id = ? order by ord').all(sid);
const childIds = new Set(C.map((r) => r.msg_id));
const pblocks = blocksOf(parentId).map((b) => {
  let eff = [];
  try { eff = JSON.parse(b.payload_json).effectiveMessageIds ?? []; } catch { eff = []; }
  const present = eff.filter((id) => childIds.has(id)).length;
  return { blockId: b.block_id, ord: b.ord, tier: b.tier, active: b.active === 1, effCount: eff.length, present, fully: eff.length > 0 && present === eff.length };
});

const modes = {};
for (const [name, mode] of Object.entries(MODES)) {
  const sp = strictPrefix(mode);
  const oa = orderedAlign(mode);
  modes[name] = { strictPrefix: sp, orderedAligned: oa.matched, orderedTotal: oa.total, rate: +oa.rate.toFixed(4), firstMiss: oa.firstMiss, firstMissSample: oa.missing };
}

const report = {
  parent: { id: parentId, rows: P.length, blocks: pblocks.length },
  child: { id: childId, rows: C.length, live: C.filter((r) => r.retired_at == null).length, retired: C.filter((r) => r.retired_at != null).length, blocks: blocksOf(childId).length },
  modes,
  parentBlockInheritance: { fullyInheritable: pblocks.filter((b) => b.fully).length, anyPresent: pblocks.filter((b) => b.present > 0).length, total: pblocks.length, detail: pblocks },
  verdict: {
    serializationNoiseNotContentLoss: modes.normalized.rate > 0.9 && modes.current.strictPrefix <= 8,
    verbatimCloneWouldRecover: modes.normalized.rate,
    zeroInheritanceByConstruction: pblocks.filter((b) => b.fully).length === 0,
  },
};

if (has('json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
const pad = (s, n) => String(s).padEnd(n);
console.log(`parent : ${parentId} rows=${report.parent.rows} blocks=${report.parent.blocks}`);
console.log(`child  : ${childId} rows=${report.child.rows} (live ${report.child.live}/retired ${report.child.retired}) blocks=${report.child.blocks}`);
console.log('');
console.log(`${pad('identity', 16)}${pad('strictPrefix', 14)}${pad('orderedAlign', 14)}rate`);
for (const [n, m] of Object.entries(modes)) console.log(`${pad(n, 16)}${pad(m.strictPrefix, 14)}${pad(`${m.orderedAligned}/${m.orderedTotal}`, 14)}${(m.rate * 100).toFixed(1)}%`);
console.log('');
console.log(`parent blocks fully inheritable : ${report.parentBlockInheritance.fullyInheritable} / ${report.parentBlockInheritance.total}`);
console.log(`parent blocks partially present : ${report.parentBlockInheritance.anyPresent} / ${report.parentBlockInheritance.total}`);
console.log('');
console.log(`zeroInheritanceByConstruction   : ${report.verdict.zeroInheritanceByConstruction}`);
console.log(`serializationNoiseNotContentLoss: ${report.verdict.serializationNoiseNotContentLoss}`);
console.log(`verbatimCloneWouldRecover       : ${(report.verdict.verbatimCloneWouldRecover * 100).toFixed(1)}%`);
