import fs from 'node:fs';
const W = 1560, H = 1050;
const rows = [
  { l:['宿主车道 msgid 采集','#5842 四载体已就位（shim/pi/opencode/codex…）'], f:'保留·复用', c:'g', r:['第 0 段 身份入册输入（采集零改）','双信道身份原样进链；新下游 l1_world 落盘 (sess_raw↔ledger_id)，跨进程/跨重启恒可答（P8/P9）'] },
  { l:['入站适配器 prepare-*','{openai,anthropic,responses,google}ToCore 矩阵'], f:'保留·复用', c:'g', r:['第 1 段 协议转换复用','wire 矩阵不动；span 解析只做身份差集 NEW 元素（任意体位，含 pos 0）；散布编码字节等价钉 = P2 准入'] },
  { l:['lane-decisions 分轨','请求头 session id + 会话粘滞绑定'], f:'保留·扩展', c:'g', r:['路由矩阵 · cohort 判定成行','每组合一条正负成对行（#3617 gate 双向断言）；cohort 边界（故障硬拒绝 vs 顺序>hash 降级）全进判定函数'] },
  { l:['legacy 全量重发路径','今天的默认主路径（JSON.parse 全包 + 钉存 AST）'], f:'角色变更', c:'a', r:['兜底安全网 · 整轮回落通道','非 cohort 仍是主路径；cohort 会话命中 R1–R4 任一红门 ⇒ 该轮整体走它并重新盖戳，客户端一轮收敛'] },
  { l:['增量 plugin-turn 车道','anthropic-wire divert · x-bili-plugin-turn 回合'], f:'保留·原职', c:'g', r:['原职维持 · 按请求形状分轨','anthropic-wire divert 回合照旧；dsh shim 逐回合与快照底座二选一，服务端不打混合标'] },
  { l:['v5 watermark 快路径','5% 灰度 · fastpath-scan 结构扫描'], f:'保留·域收窄', c:'a', r:['域收窄 · 只服务非 cohort','管解析成本、不管状态真源；与快照底座同表不同车道、旗位独立，互不双处理'] },
  { l:['D-lane 快照渲染 #3756','≈0% 灰度 · 正史渲染出站前缀'], f:'让位·退役', c:'gr', tag:'待裁定 K', r:['让位 · 旗位互斥（待裁定 K）','在新底座车道上与 snap 三件套旗位互斥运行；退役与否由 P3 依影子期数据裁定'] },
  { l:['acp-kernel 压缩内核','projectUnit / prompts / nudge flat-50K / ref 账本'], f:'零改动', c:'k', r:['零改动 · I/O 契约扩展为五事件流','cast / append / update / delete / compact；折叠判定、四条 prompts、flat-50K nudge、id 永不复用合同一行不动'] },
  { l:['出站映射 coreTo*','双 carrier 分支 · pf-/信封头永不出代理'], f:'替换', c:'i', r:['mapEgress + tripwire 抽样','存活行按 pos 排序 ++ 本轮尾窗 [K..T) 新解析；carrier 分支逻辑照搬（#377 教训）；抽样不一致 ⇒ 立即摘回 legacy + 告警'] },
  { l:['状态存储：kstate JSON + 表族','v11 · hydration 水合拼装（mergeState 单一事实源）'], f:'收敛', c:'i', r:['单一存储真源 · 三件套 + L1','snap_rows/snap_log/snap_ckpt 单事务提交（不变量 i–v）；kstate 降为红道回退源，绿道读三件套'] },
];
const pains = [
  ['痛点① 状态三处住','进程内存 + 表 + kstate 双写分叉；#5403 OOM 钉存来源','解决：ckpt.meta_json 单一真源（F 裁定）','内存降为缓存；绿道读三件套 / 红道随时承接 kstate 旧路，切换按会话单向、失步整轮回退'],
  ['痛点② 宿主身份不落盘','(sess_raw,msgid) ingest 即剥，只在 in-flight 信封活一轮','解决：L1 身份薄表持久化（G 裁定）','复用 #5842 载体采集器；首见即记、永不截断删除（P8/P9）；裁决三分支 echo 抽验 / 复合探测 / 发放新身份'],
  ['痛点③ 快路径各自打补丁','v5/增量/D-lane 各管一段流量，缓存稳定性靠补丁叠加','解决：单事务提交原语 + 四件套保护','三步原子：upsert rows → append log(seq 严格单调) → compact 可选；tripwire / S4 校验和 / 见证要求 / 审计抽验'],
];
const col = { g:['#dcfce7','#16a34a'], i:['#e0e7ff','#4f46e5'], a:['#fef3c7','#b45309'], gr:['#f1f5f9','#64748b'], k:['#ffffff','#16a34a'], rd:['#fee2e2','#b91c1c'] };
const mark = { g:'arrG', i:'arrI', a:'arrA', gr:'arrGr', k:'arrG' };
const fcol = { g:'#15803d', i:'#4338ca', a:'#b45309', gr:'#475569', k:'#15803d' };
let s = '';
const rowH = 52, pitch = 64, y0 = 158;
rows.forEach((row, i) => {
  const y = y0 + pitch * i;
  const [fill, stroke] = col[row.c];
  const sw = row.c === 'k' ? ' stroke-width="2.5"' : '';
  s += `<rect x="30" y="${y}" width="420" height="${rowH}" rx="8" fill="${fill}" stroke="${stroke}"${sw}/>`;
  s += `<text x="44" y="${y+21}" class="n">${row.l[0]}</text>`;
  s += `<text x="44" y="${y+39}" class="s">${row.l[1]}</text>`;
  s += `<line x1="452" y1="${y+26}" x2="612" y2="${y+26}" stroke="${fcol[row.c]}" stroke-width="1.6" marker-end="url(#${mark[row.c]})"/>`;
  s += `<text x="532" y="${y+13}" class="fn" fill="${fcol[row.c]}" text-anchor="middle">${row.f}</text>`;
  s += `<rect x="636" y="${y}" width="894" height="${rowH}" rx="8" fill="${fill}" stroke="${stroke}"${sw}/>`;
  s += `<text x="650" y="${y+21}" class="n">${row.r[0]}</text>`;
  s += `<text x="650" y="${y+39}" class="s">${row.r[1]}</text>`;
  if (row.tag) s += `<text x="1516" y="${y+21}" class="warnb" text-anchor="end">⚠ ${row.tag}</text>`;
});
let p = '';
pains.forEach((pn, j) => {
  const y = 846 + j * 56;
  p += `<rect x="30" y="${y}" width="530" height="44" rx="8" fill="#fee2e2" stroke="#b91c1c"/>`;
  p += `<text x="44" y="${y+18}" class="warn">${pn[0]}</text>`;
  p += `<text x="44" y="${y+36}" class="warnb">${pn[1]}</text>`;
  p += `<line x1="562" y1="${y+22}" x2="622" y2="${y+22}" stroke="#b91c1c" stroke-width="1.6" marker-end="url(#arrR)"/>`;
  p += `<rect x="636" y="${y}" width="894" height="44" rx="8" fill="#dcfce7" stroke="#16a34a"/>`;
  p += `<text x="650" y="${y+18}" class="ok">${pn[2]}</text>`;
  p += `<text x="650" y="${y+36}" class="okb">${pn[3]}</text>`;
});
const legend = [[30,'g','保留 / 复用 / 扩展 · 零改动'],[250,'i','替换 / 收敛'],[380,'a','角色变更 / 域收窄'],[530,'gr','让位 · 退役（待裁）'],[710,'rd','红 = 痛点　绿 = 解决锚点']]
  .map(([x,k,txt])=>`<rect x="${x}" y="88" width="14" height="14" rx="3" fill="${col[k][1]}"/><text x="${x+22}" y="99" class="leg">${txt}</text>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <style>
    html,body { margin:0; padding:0; background:#fff; }
    text { font-family: 'Noto Sans CJK SC','Droid Sans Fallback',sans-serif; }
    .tt { font-size: 22px; font-weight: 700; fill: #0f172a; }
    .sub { font-size: 13px; fill: #475569; }
    .stage { font-size: 15px; font-weight: 700; fill: #0f172a; }
    .n { font-size: 12px; font-weight: 700; fill: #0f172a; }
    .s { font-size: 10.5px; fill: #475569; }
    .fn { font-size: 11px; font-weight: 700; }
    .warn { font-size: 12.5px; font-weight: 700; fill: #7f1d1d; }
    .warnb { font-size: 11px; fill: #991b1b; }
    .ok { font-size: 12px; font-weight: 700; fill: #14532d; }
    .okb { font-size: 10.5px; fill: #166534; }
    .leg { font-size: 11px; fill: #334155; }
  </style>
  <defs>
    <marker id="arrG" markerWidth="10" markerHeight="8" refX="9" refY="3" orient="auto"><path d="M0,0 L9,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="arrI" markerWidth="10" markerHeight="8" refX="9" refY="3" orient="auto"><path d="M0,0 L9,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="arrA" markerWidth="10" markerHeight="8" refX="9" refY="3" orient="auto"><path d="M0,0 L9,3 L0,6 Z" fill="#b45309"/></marker>
    <marker id="arrGr" markerWidth="10" markerHeight="8" refX="9" refY="3" orient="auto"><path d="M0,0 L9,3 L0,6 Z" fill="#64748b"/></marker>
    <marker id="arrR" markerWidth="10" markerHeight="8" refX="9" refY="3" orient="auto"><path d="M0,0 L9,3 L0,6 Z" fill="#b91c1c"/></marker>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
  <text x="30" y="42" class="tt">组件迁移总览 · 「现状」的十块组件在新架构下去向何处</text>
  <text x="30" y="68" class="sub">同一条链路、同一个内核 —— 多数组件原样保留或收窄职责；变化集中在「状态住哪、身份记在哪」两处收敛到单一存储真源</text>
  ${legend}
  <line x1="30" y1="126" x2="1530" y2="126" stroke="#e2e8f0"/>
  <text x="30" y="146" class="stage">今天 · origin/master（storage schema v11，四车道各自为政）</text>
  <text x="636" y="146" class="stage">底座落地后（本提案 · 六段固定链）</text>
  ${s}
  <line x1="30" y1="822" x2="1530" y2="822" stroke="#e2e8f0"/>
  <text x="30" y="840" class="stage">三个结构性痛点 → 一一对应的解决锚点</text>
  ${p}
</svg>`;
fs.writeFileSync('arch-migration.svg', svg);
console.log('written', svg.length, 'bytes; canvas', W + 'x' + H, '; last content y ≈ 1002');
