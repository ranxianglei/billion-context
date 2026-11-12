# 自动合并护栏（Auto-Merge Guardrails）— 证据附录

> **来源**：[#801](https://github.com/ranxianglei/billion-context/issues/801)「自动合并材料收集」。
> **方法**：拉取三个仓库（billion-context / billion-context-pi / acp-kernel）**全部 issue + PR + 评论**（共 1543 项、1072 个 PR、3645 条评论），叠加本仓 `devlog/` 31 条迭代记录、`AGENTS.md` 完整 git 演进史、commit 类型分布，交叉比对得出。
> **目标**：让 ~90% 的 bugfix 可自动合并，同时守住大方向不偏移。
> **定位（重要）**：规则的**权威文本在 [`AGENTS.md` §7](../AGENTS.md#7-review--auto-merge-discipline) Review & Auto-Merge Discipline**（每次会话自动加载，是唯一操作依据）。本文件只做**证据附录**——保留基线数据、逐条 issue/PR 出处、重灾区数据分析、以及内核 vs 本仓库的归属判断。**凡是规则 / Gate / Checklist 的操作文本，一律以 §7 为准，本文不复述**，避免两处漂移。范围限定：**本次仅改本仓库**，跨仓库改动暂留人工。

---

## 1. 基线事实（数据说话）

| 事实 | 数据 | 含义 |
|------|------|------|
| fix 是主战场 | 非合并 commit：`fix:` 360 / `feat:` 117 / `docs:` 99 / `test:` 41 / `refactor:` 24 | bugfix 约占 54%，正是自动合并要覆盖的对象 |
| 没有"被拒绝"的 PR | 三仓 closed-unmerged **全为 0** | 人工要么合并、要么挂着，从不直接否决。风险不在"AI 的东西被否"，而在**剩下 ~10% 需返工的会卡住整条流水线** |
| 规则是事后补的 | `AGENTS.md` 每条硬规则几乎都对应一次事故（#377 两种压缩模式、#584 问题必建 issue、version 仅 release 分支、auto-update 改动先发 no-op 版） | 现有 `AGENTS.md` ≈ 已踩坑沉淀；隐性规则现在已并入 §7 |
| AI 工作难从作者区分 | 仅 55 个 PR 带 `ework-agent-pr` 标记；多数早期工作以 ranxianglei PAT 直推 | 判断"AI vs 人工"要靠 `[bot] 🏷` 前缀 + 标记，不能靠 authorship |

---

## 2. 人工确立的规则（每条的真实出处）

> 规则文本本身见 `AGENTS.md` §7.1–§7.3；这里只给**为什么有这条**的证据。

### A. 早已成文（继续守住）
git 安全四禁（禁 force-push master / 禁 merge / 禁 npm publish / 禁打印 PAT）、branch 命名 `YYYY-MM-DD_short-title`、version 仅 `*_release-v*` 分支、发布流程 + no-op 校验、acp-kernel 先于本项目发布、issue 先行 + 问题必报、代码质量（no `as any` / hex escape `\x3c\x3e` / loggerLog）、改请求管线前跑 e2e、两种压缩模式都要想。

### B. 隐性规则（现已并入 §7）——逐条出处
1. **先查重再动手** —— *出处*：#268「这个应该已经存在了一个 pr 修复这个问题 检查下重复」；pi #311/#314 同标题重复 PR。
2. **rebase 到最新 master 再验证再提** —— 警惕 **rebase 顺序依赖**。*出处*：#249/#221/#155/#479 反复要求基于最新 master 重验。**#479 最典型**：AI 漏了顺序依赖——测试写死 `savedAt=9000/5000/8000`（1970），因另一 PR(#487)先落 master 而失效，人工独立复审才抓到。
3. **收敛范围，一 issue 一主题** —— *出处*：#247「先收敛 你先只负责本 issue…额外问题我找其他 agents 去做」；#640 兄弟 issue 批一个 PR、关掉被取代的。
4. **交 PR，不是光推分支** —— *出处*：#282「提交 pr 而不是分支」。
5. **绝不静默丢/覆盖用户配置** —— *出处*：#155 白名单漏 prompts 键 → web 保存会静默抹掉自定义压缩提示词，改为 malformed 直接 400；`devlog/context-window-fixes`（读失败还往 `{}` 合并 = 静默丢数据）。
6. **兜底值要合理** —— *出处*：#282「识别失败默认回 20w、最低 10w，别用 64k」；`devlog/context-window-fixes`（静态表压过活注册表 = freshness 层级倒挂）。
7. **优先用客户端原生稳定标识** —— *出处*：#280「session-id 才是唯一不变、绑定当前会话的…不能拿到的客户端你报告一下」。
8. **分清症状与机制** —— *出处*：#282「连续压缩」实为上游 429 限流 + 客户端重试刷出的日志假象，并非压缩机制失控。
9. **输出要诚实** —— *出处*：#155 export 对 0-block 会话打出"下面是原始对话"的文案，要求改成诚实提示。
10. **完成 = 证据** —— *出处*：#784「review 了吗」；#247「本地双 review 然后实际测试切换 观察是否符合预期」。
11. **日志：凭证必脱敏 + 分级** —— *出处*：#247（B.1 hdrLog 脱敏、B.3 分级）。
12. **文档中英同步 + 位置可见** —— *出处*：#698 QQ 群号三项目中英文都加、且别放最后没人看见。
13. **跨仓顺序** —— *出处*：#772「先发一个内核版本,再发这个版本」「内核已经合并」。

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
| #571 | hold client through long preflight | diff-爆炸（#575 同病）、反复 rebase 冲突（#558/#593）、文档放错节 + env 变量只写英文 README、漏 zh/configuration.md |
| #467 | hard backstop plugin-mode overflow | base 落后 43 commits；逐行空格 artifact（1280 off-by-one-space）被挑出 |
| #517 | reject stale snapshots rollback | 与 #587 重写 `src/persist.ts` 同文件冲突，需语义 rebase |
| #425 | uncompressed baseline + clamp negative | base 停在 8/31；上条评论承诺的 openai 拆分口径没做完 |
| #219 | stale context limits + registry-first | 首修漏了"代理网络下 Node fetch 忽略 http(s)_proxy → registry 拉取永久失效"；快照从投影扩成全量 |
| #428 | re-voice acp_summary as user | 要求确认回归；方案被推翻、移到原 issue |
| #360 | /acp panel persistent message | 反复冲突；"为啥新搞一个 acp panel?"（方案质疑）；Windows 临时端口范围致 flaky 测试（改 `listen(0)`） |
| #254 | preflight-compress on model switch | 需真实 A/B 复现验证（非仅单测） |
| #657 | recover stale shim conversation id | review 才发现残留小问题 |

**两个主导成因**（操作版见 `AGENTS.md` §7.5）：
1. **stale-base / 并发文件踩踏**：长命分支偏离快速演进的 master，或与别的 PR 抢同一热文件（`server.ts` / preflight / `persist.ts` / `agent/*` 类型）。信号：分支新鲜度 + 是否与其它 open PR 改同一文件。
2. **首遍不完整**：只治了报出来的症状，漏了相邻路径/边界、或承诺了却没做完、或方案要重来。信号：修复是否覆盖该 bug 的**所有**路径，而不只是 repro。

---

## 附：owner 拍板结论 + 内核 vs 本仓库归属判断

**已定**：
1. ✅ 规则与门槛并入 `AGENTS.md` 新增 **§7 Review & Auto-Merge Discipline**（唯一操作文本）。
2. ✅ 范围限定：**跨仓库改动暂留人工**——自动合并门槛只作用于本仓库；acp-kernel bump / 任何跨仓改动一律人工处理。
3. 「可自动合并」这套先作为 **reviewer 清单 + AGENTS.md 门槛**；是否再升级为 CI 硬门禁(gate)留待后续单独评估（涉及 CI 改动，属另一件事）。届时以 §7.4 为准。

**内核 vs 本仓库归属判断**（owner 指出"还有一条落下了，需判断优先沉淀到内核还是本仓库"）：
- 有真正归属歧义的是 **wire / 内核产物保真** 这一条。判定：**格式契约 + id 永不复用保证归 acp-kernel**（它产出并拥有 ACP 压缩标签、block ref、`acp_summary` 结构、ref 空间）；**本仓库只保留 host 侧义务**（忠实消费：不重生成 tool_call id/顺序、不裁剪 ref map、两种压缩模式都要想）。
- 依据：`AGENTS.md` §2「Kernel Contract」早已把 id-never-reused 记为内核契约的 host 视角；§7.3 的 wire-fidelity 项已明确标注此 split。
- 处置：内核侧的正式 spec **已在 acp-kernel 单独 PR 落地**（[acp-kernel#303](https://github.com/ranxianglei/acp-kernel/pull/303)，把 ref-id 不可复用 + wire-artifact 格式契约提升为一等不变量）；billion-context-pi 对应 PR 为 [pi#457](https://github.com/ranxianglei/billion-context-pi/pull/457)。
