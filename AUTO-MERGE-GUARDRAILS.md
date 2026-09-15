# 自动合并护栏（Auto-Merge Guardrails）

> **来源**：[#801](https://github.com/ranxianglei/billion-context/issues/801)「自动合并材料收集」。
> **方法**：拉取三个仓库（billion-context / billion-context-pi / acp-kernel）**全部 issue + PR + 评论**（共 1543 项、1072 个 PR、3645 条评论），叠加本仓 `devlog/` 31 条迭代记录、`AGENTS.md` 完整 git 演进史、commit 类型分布，交叉比对得出。
> **目标**：让 ~90% 的 bugfix 可自动合并，同时守住大方向不偏移。
> **状态（更新）**：owner 已拍板——第 2/4/5 节的规则与门槛已并入 `AGENTS.md` 新增的 **§7 Review & Auto-Merge Discipline**。本文现为**证据附录**：保留逐条 issue/PR 引用、重灾区数据分析、以及内核 vs 本仓库的归属判断。范围限定：**本次仅改本仓库**，跨仓库改动暂留人工。

---

## 1. 基线事实（数据说话）

| 事实 | 数据 | 含义 |
|------|------|------|
| fix 是主战场 | 非合并 commit：`fix:` 360 / `feat:` 117 / `docs:` 99 / `test:` 41 / `refactor:` 24 | bugfix 约占 54%，正是自动合并要覆盖的对象 |
| 没有"被拒绝"的 PR | 三仓 closed-unmerged **全为 0** | 人工要么合并、要么挂着，从不直接否决。风险不在"AI 的东西被否"，而在**剩下 ~10% 需返工的会卡住整条流水线** |
| 规则是事后补的 | `AGENTS.md` 每条硬规则几乎都对应一次事故（#377 两种压缩模式、#584 问题必建 issue、version 仅 release 分支、auto-update 改动先发 no-op 版） | 现有 `AGENTS.md` ≈ 已踩坑沉淀；隐性规则还没沉淀进来 |
| AI 工作难从作者区分 | 仅 55 个 PR 带 `ework-agent-pr` 标记；多数早期工作以 ranxianglei PAT 直推 | 判断"AI vs 人工"要靠 `[bot] 🏷` 前缀 + 标记，不能靠 authorship |

---

## 2. 人工确立的规则

### A. 已成文（在 `AGENTS.md`，继续守住）

git 安全四禁（禁 force-push master / 禁 merge / 禁 npm publish / 禁打印 PAT）、branch 命名 `YYYY-MM-DD_short-title`、version 仅 `*_release-v*` 分支、发布流程 + no-op 校验、acp-kernel 先于本项目发布、issue 先行 + 问题必报、代码质量（no `as any` / hex escape `\x3c\x3e` / loggerLog）、改请求管线前跑 e2e、两种压缩模式都要想。

### B. 反复出现但**尚未成文**（隐性规则，建议补进 `AGENTS.md`）——每条都有真实出处

1. **先查重再动手** —— 开工前搜已有 open/closed issue+PR 是否已修同一件事。
   *出处*：#268「这个应该已经存在了一个 pr 修复这个问题 检查下重复」；pi #311/#314 同标题重复 PR。
2. **rebase 到最新 master 再验证再提** —— 基于**当前** master 重跑 typecheck + 全量测试 + build，而不是 PR 原始基线。要警惕 **rebase 顺序依赖**。
   *出处*：#249/#221/#155/#479 反复要求基于最新 master 重验。**#479 最典型**：AI 漏了顺序依赖——测试写死 `savedAt=9000/5000/8000`（1970），因另一 PR(#487)先落 master 而失效，人工独立复审才抓到。
3. **收敛范围，一 issue 一主题** —— 额外发现拆给别的 issue/agent，不夹带。
   *出处*：#247「先收敛 你先只负责本 issue…额外问题我找其他 agents 去做」；#640 兄弟 issue 批一个 PR、关掉被取代的。
4. **交 PR，不是光推分支** —— *出处*：#282「提交 pr 而不是分支」。
5. **绝不静默丢/覆盖用户配置** —— read-modify-write 必须有 parse 状态保护；malformed 直接 400/409 拒写，而非并进默认值或静默丢字段；白名单必须完整。
   *出处*：#155 白名单漏 prompts 键 → web 保存会静默抹掉自定义压缩提示词，改为 malformed 直接 400；`devlog/context-window-fixes`（读失败还往 `{}` 合并 = 静默丢数据）。
6. **兜底值要合理** —— fallback 值不能过小引发抖动；静态/兜底源必须输给更新鲜的权威源。
   *出处*：#282「识别失败默认回 20w、最低 10w，别用 64k」；`devlog/context-window-fixes`（静态表压过活注册表 = freshness 层级倒挂）。
7. **优先用客户端原生稳定标识** —— 能拿到原生 session id 就用它（它跨凭证/模型/provider 切换不变）；拿不到的客户端要报告。别用会随切换漂移的派生 hash。
   *出处*：#280「session-id 才是唯一不变、绑定当前会话的…不能拿到的客户端你报告一下」。
8. **分清症状与机制** —— 归因到 bili 机制之前先看上游日志。
   *出处*：#282「连续压缩」实为上游 429 限流 + 客户端重试刷出的日志假象，并非压缩机制失控。
9. **输出要诚实** —— 别对退化状态撒谎。
   *出处*：#155 export 对 0-block 会话打出"下面是原始对话"的文案，要求改成诚实提示。
10. **完成 = 证据** —— 双 review + 实际跑一遍观察行为是否符合预期，不是"应该可以"。
    *出处*：#784「review 了吗」；#247「本地双 review 然后实际测试切换 观察是否符合预期」。
11. **日志：凭证必脱敏 + 分级** —— trace/debug/info 分级；bug 收敛期默认开 debug；secret 值一律脱敏。
    *出处*：#247（B.1 hdrLog 脱敏、B.3 分级）。
12. **文档中英同步 + 位置可见** —— zh/en 同步更新，且放用户看得到的位置。
    *出处*：#698 QQ 群号三项目中英文都加、且别放最后没人看见。
13. **跨仓顺序** —— acp-kernel 未合并发不了下游。
    *出处*：#772「先发一个内核版本,再发这个版本」「内核已经合并」。

---

## 3. AI 把握不到的点（审核员重点把关，按出现频率排）

| # | 类别 | 典型表现 | 为什么 AI 容易漏 |
|---|------|----------|------------------|
| 1 | **交叉/交互效应**（最高危） | rebase 顺序依赖、并发 PR 相互影响、切模型/切 provider 后状态漂移 | AI 偏局部推理，看不到全局时序与并发 |
| 2 | **静默数据丢失路径** | read-modify-write、配置覆盖、持久化版本迁移 | 正常路径测得通，异常/边界路径才丢数据 |
| 3 | **协议/线上保真** | tool_call 的 id/顺序、SSE 结构、compaction_trigger 必须是最后一个 input item（#283） | 改了线格式但本地 mock 上游不严格，CI 也测不出 |
| 4 | **标识与会话稳定性** | 派生 id vs 原生 id、sticky 会话、中途切换 | 单一场景下派生 id 够用，切换场景才暴露 |
| 5 | **默认值/兜底判断** | 不合理 fallback、真值来源优先级 | 属产品判断，AI 易拍脑袋选个"看起来对"的值 |
| 6 | **症状 ≠ 根因** | 日志假象、错误归因 | 表象像 A，其实是 B（见 #282） |
| 7 | **流程卫生** | 范围蔓延、重复劳动、只推分支不开 PR、跨仓顺序 | 单看每个动作都对，组合起来违反流程 |
| 8 | **面向用户的判断** | 文档措辞/语言/位置、诚实性、UX 默认值 | 工程正确 ≠ 用户视角正确 |

### 3.1 重灾区：二次评论才过的 PR（数据）

对 455 个已合并 PR 统计"人工评论次数"：**229 个 0 次、71 个 1 次、26 个 ≥2 次**——即约 **7%（26/326 有评论者）需要第二轮及以上人工 review 才过**。这些就是"重灾区"；其中属 **bugfix**（非 feat）的，才是自动合并真正要防的对象：

| PR | 主题 | 二次返工原因 |
|----|------|--------------|
| #571 | hold client through long preflight | diff-爆炸（#575 同病）、反复 rebase 冲突（#558/#593）、文档放错节 + env 变量只写英文 README、漏 zh/CONFIGURATION.md |
| #467 | hard backstop plugin-mode overflow | base 落后 43 commits；逐行空格 artifact（1280 off-by-one-space）被挑出 |
| #517 | reject stale snapshots rollback | 与 #587 重写 `src/persist.ts` 同文件冲突，需语义 rebase |
| #425 | uncompressed baseline + clamp negative | base 停在 8/31；上条评论承诺的 openai 拆分口径没做完 |
| #219 | stale context limits + registry-first | 首修漏了"代理网络下 Node fetch 忽略 http(s)_proxy → registry 拉取永久失效"；快照从投影扩成全量 |
| #428 | re-voice acp_summary as user | 要求确认回归；方案被推翻、移到原 issue |
| #360 | /acp panel persistent message | 反复冲突；"为啥新搞一个 acp panel?"（方案质疑）；Windows 临时端口范围致 flaky 测试（改 `listen(0)`） |
| #254 | preflight-compress on model switch | 需真实 A/B 复现验证（非仅单测） |
| #657 | recover stale shim conversation id | review 才发现残留小问题 |

**两个主导成因**（正是自动合并最危险处，已写入 `AGENTS.md` §7.5）：
1. **stale-base / 并发文件踩踏**：长命分支偏离快速演进的 master，或与别的 PR 抢同一热文件（`server.ts` / preflight / `persist.ts` / `agent/*` 类型）。信号：分支新鲜度 + 是否与其它 open PR 改同一文件。
2. **首遍不完整**：只治了报出来的症状，漏了相邻路径/边界、或承诺了却没做完、或方案要重来。信号：修复是否覆盖该 bug 的**所有**路径，而不只是 repro。

---

## 4. 自动合并门槛（Gate）— 目标 90% bugfix

### ✅ 可自动合并（须**同时**满足）

1. 单模块小修，改动面收敛（无跨文件架构调整）。
2. 有**回归测试**复现原 bug，且该测试由红转绿。
3. **rebase 到最新 master 后** typecheck + 全量测试 + build 全绿。
4. **不改**：配置 schema、持久化格式/版本、线上协议/消息形状、跨仓依赖(acp-kernel)。
5. 纯 `fix:`，无新增能力面（非 feat/refactor）。
6. diff 干净：无无关改动、无大段空格/缩进重排、无生成物/锁文件连带变更。
7. 带 `Fixes #N` 引用其 issue。
8. **不触碰承重基础设施**：`src/update.ts`(auto-updater)、release workflow、CI publish、kernel pin、message-ref/id 逻辑、安全相关(MITM/CA/凭证)。

### ⛔ 必须人工介入（任一命中即停）

- 任何线上协议/消息形状改动（**两种压缩模式都受影响**，见 #377）。
- 配置 schema / 持久化版本 / 版本号变更。
- 跨仓依赖（acp-kernel bump）——须先确认内核已在 npm 上线。
- auto-update(`src/update.ts`)改动——须先发 no-op release 验证升级链路。
- 身份/会话绑定逻辑。
- feat / refactor / 架构决策。
- 安全相关（cert-MITM、CA、credential 处理）。
- 兜底/默认值变更（产品判断）。

---

## 5. 审核员 Checklist（逐条可勾选）

**diff 整洁度（第一道关）**
- [ ] 每一行都和本 PR 目的相关？（无跑题文件/生成物/锁文件连带变更）
- [ ] 无大段纯空格/缩进/重排淹没真实逻辑？
- [ ] 一 issue 一主题，无夹带的额外改动？

**正确性与验证**
- [ ] 是否 rebase 到**当前** master？rebase 后 typecheck + 全量测试 + build 是否重新全绿？
- [ ] 有无 rebase 顺序依赖（写死的 fixture/时间戳会被先落地的其它 PR 破坏）？
- [ ] 回归测试是否真的复现了原 bug（红→绿）？
- [ ] 是否实际跑过一遍、观察行为符合预期（而非"应该可以"）？
- [ ] 是否同时考虑了**两种压缩模式**（plugin / proxy）？

**边界与数据**
- [ ] 有无静默丢/覆盖用户配置的路径（read-modify-write、白名单完整性、malformed 处理）？
- [ ] 兜底/默认值是否合理？freshness 层级是否正确（兜底输给权威源）？
- [ ] 身份/会话标识是否用了原生稳定 id？切换场景是否验证过？

**协议与归因**
- [ ] 是否改变了上游线格式（tool_call id/顺序、SSE、item 顺序）？
- [ ] 症状是否已对照上游日志确认根因（排除日志假象/限流重试）？

**流程与交付**
- [ ] 是否先查过重复（已有同修 PR/issue）？
- [ ] 是否开了 PR（而非只推分支）？是否带 `Fixes #N`？
- [ ] 涉及跨仓时，依赖方是否已合并发版？
- [ ] 承重设施（auto-update/release/kernel-pin/id 逻辑/安全）是否被触碰？触碰则转人工。
- [ ] 文档是否中英同步 + 位置可见？输出信息是否诚实（无退化状态下的误导文案）？

---

## 6. 已并入 `AGENTS.md` §7 的规则文本（参考副本）

> 以下即已并入 `AGENTS.md` **§7 Review & Auto-Merge Discipline** 的紧凑规则文本（此处留作参考副本；以 `AGENTS.md` 为准）。第 4 节 Gate 作为自动合并判定依据；若后续升级为 CI 硬门禁，以此为准。

```markdown
### Review & Auto-Merge Discipline

**Duplicate screening** — Before implementing, search existing open AND closed
issues/PRs for the same fix. If one exists, link it; do not start parallel work.

**Rebase-to-latest-master before mergeable** — Verify against CURRENT master,
not the PR's original base. After rebase, re-run typecheck + full test suite +
build. Watch for rebase-order dependencies (hardcoded fixtures/timestamps that
break when another PR lands first).

**One concern per PR; converge scope** — One issue = one scope. Split extra
findings into separate issues/PRs. Never bundle unrelated changes or mass
whitespace/reformatting. Open a PR, never just push a branch.

**Never silently clobber/drop user config** — Any read-modify-write on user
config needs a parse-state guard; reject malformed input loudly (400/409)
instead of merging into defaults or dropping fields. Whitelists must be complete.

**Sane defaults & fallbacks** — Fallback values must be reasonable (never a
too-small value that causes thrashing). A static/fallback source must always
lose to a fresher authoritative source when both are cheaply available.

**Prefer native stable identifiers** — Use the client's native stable session id
when available (survives credential/model/provider switches); report clients that
expose none. Do not build identity from derived hashes that drift on switch.

**Wire fidelity** — Never alter upstream protocol shape beyond intended
injection: preserve tool_call ids/ordering, SSE structure, and upstream
invariants (e.g. compaction_trigger must remain the last input item). Reason in
BOTH compression modes.

**Symptom ≠ mechanism** — Before attributing a bug to bili's mechanism, verify
against upstream logs (repeated-compression logs may be an upstream rate-limit
retry illusion, not over-compression).

**Honest output** — Never emit misleading status messages for degenerate states
(e.g. claiming "original conversation" when there are no blocks).

**Logs** — Mask secret values in all logs; separate trace/debug/info; keep
debug-on by default during bug-convergence phases.

**Docs** — Keep zh/en docs in sync; place content where users will see it.

**Cross-repo ordering** — acp-kernel must be released (verified on npm) before
billion-context bumps it.

**Auto-merge gate** — A bugfix may auto-merge only if ALL hold: single-module
scoped fix; regression test reproduces the bug and now passes; green on the
REBASED head (typecheck + full tests + build); no change to config schema /
persistence format / wire protocol / cross-repo deps; pure `fix:` (no new
capability surface); clean diff; references its issue via `Fixes #N`; and does
NOT touch load-bearing infra (`src/update.ts`, release workflow, CI publish,
kernel pin, message-ref/id logic, security/MITM/CA/credentials). Anything else
requires human review.
```

---

## 附：owner 拍板结论 + 内核 vs 本仓库归属判断

**已定**：
1. ✅ 规则与门槛并入 `AGENTS.md` 新增 **§7 Review & Auto-Merge Discipline**（本次仅改本仓库）。
2. ✅ 范围限定：**跨仓库改动暂留人工**——自动合并门槛只作用于本仓库；acp-kernel bump / 任何跨仓改动一律人工处理。
3. 「可自动合并」这套先作为 **reviewer 清单 + AGENTS.md 门槛**；是否再升级为 CI 硬门禁(gate)留待后续单独评估（涉及 CI 改动，属另一件事）。

**内核 vs 本仓库归属判断**（owner 指出"还有一条落下了，需判断优先沉淀到内核还是本仓库"）：
- 有真正归属歧义的是 **wire / 内核产物保真** 这一条。判定：**格式契约 + id 永不复用保证归 acp-kernel**（它产出并拥有 ACP 压缩标签、block ref、`acp_summary` 结构、ref 空间）；**本仓库只保留 host 侧义务**（忠实消费：不重生成 tool_call id/顺序、不裁剪 ref map、两种压缩模式都要想）。
- 依据：`AGENTS.md` §2「Kernel Contract」早已把 id-never-reused 记为内核契约的 host 视角；§7.3 的 wire-fidelity 项已明确标注此 split。
- 处置：因本次限定仅改本仓库、跨仓留人工，**内核侧的正式 spec 沉淀放到 acp-kernel 单独的后续 PR**（此处仅记录判断，本轮不动 acp-kernel）。
