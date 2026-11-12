# Codex 云端压缩 ↔ ACP 历史代

> 一段会话上有两种压缩：Codex 后端用加密 checkpoint 替换历史，bili 用 ACP
> 压缩同一段历史。本文记录两者如何保持一致，以及越过边界后什么还活着。

## 三条线上通道，一个序号

边界可以在三个位置被确认，三者携带同一身份，因此任何一条通道都不会重复 reset，
也不存在“必须依赖某一条”的情况：

| 通道 | 何时可见 | 服务对象 |
|---|---|---|
| `x-bili-codex-checkpoint*` header | 回放 checkpoint 的那次请求 | dsh-codex-subscription |
| 回放的 `compaction` 输入项 | 服务端压缩之后的任意请求 | 真实 Codex CLI、无 header 的客户端 |
| 响应里的 `compaction` 输出项 | 造成压缩的那一轮响应 | 所有客户端，最早的时间点 |

响应侧通道在“造成压缩的那一轮”就关闭历史代，而不是晚一轮；后续通道会按已记录的
序号（`metadata.codexCloudCheckpoint.seq`）去重，所以回放、重试或进程重启都不会
为同一个 checkpoint 关闭第二代。

`dsh-codex-subscription` 校验回放的 OpenAI `compaction` 项后，可以给下一次模型请求
打上 checkpoint 身份（这是三条通道中的显式一条；插件未打时另外两条仍然工作）：

| Header | 含义 |
|---|---|
| `x-bili-codex-checkpoint` | checkpoint id（加密载荷的摘要） |
| `x-bili-codex-checkpoint-seq` | 该 checkpoint 在会话中的序号 |
| `x-bili-codex-checkpoint-state` | `fresh`（首次通知）或 `reuse` |
| `x-bili-codex-checkpoint-covered` | 被替换掉的历史条数 |
| `x-bili-codex-checkpoint-digest` | 所携带 items 的摘要 |

bili（`src/codex-checkpoint.ts`）把**新身份**——新 id 或更大的 `seq`——当作权威
远端边界；`fresh`/`reuse` 只是信息。时序是固有的：checkpoint 在响应里产生，只能
在下一次请求通知，因此若 `fresh` 通知丢失（请求失败、插件重启），必须允许 `reuse`
通知补开边界。`x-bili-plugin: codex` 或 `dsh` 信封都算该通道；checkpoint header
是强信号，原有的文本/结构探测仍作为无法通知的客户端的兜底。

这些 header 属于代理内部：已列入 `UPSTREAM_HOP_HEADERS`，HTTP 与 WebSocket
出站都会被剥掉。

## 跨代聚合

连续压缩会让模型看到多个互不相干的代。导航注记因此把所有已关闭代的块摘要合并成
**一条**统一摘要（同一 topic 以最新一条为准，整体约 1.2k 字符封顶），模型保留对
“已关闭的过去”的单一连贯印象，细节仍然要调用 `search_context` / `decompress`。

## 不重复压缩同一段 token

代理在线上折叠了历史，但模型客户端仍按自己（未折叠）的历史计算体积。折叠成功后
不做协调，客户端会继续请求服务端压缩一个已经变小的 body。因此 bili 在**每个响应**
上通告它此刻从线上折叠掉的 token 数（`x-bili-plugin-compressed`，等于活跃块的
covered tokens 之和——prepare 时已知、重试稳定、没有折叠时不出现在响应里）。配合的
客户端把该额度抵扣进下一次请求的压缩阈值，而不是永久下调。

## 边界上发生什么

1. `closeHistoryGeneration()` 把活跃压缩状态——blocks、blockContents、ref 映射、
   原始消息和一份冻结的 CCR 切片——快照成只读**历史代**
   （`<session-base>.history-generations.json`，与 content store 同编码/加密，
   fsync，0600）。
2. 只有旁车写成功后才写元数据索引（`metadata.historyGenerations`）；两者之间崩溃
   可恢复：`historyGenerationsOf()` 会重读旁车并自愈索引。
3. 活跃状态被重置，但 ref floor 与 `state.nextBlockId` 钉在所有已归档值之上：
   旧的 `mNNNNN`、`bN` 永远不会被发给不同内容。
4. 以**尾部临时注记**（`[billion-context] Closed history generations — …`）追加一段精简导航
   （代数、ref 区间、关闭原因），绝不写进 developer/system 层——该前缀必须逐轮字节
   一致，否则 provider 缓存失效（`#2596`）；不会把任何
   归档载荷重新发给模型。

若历史代无法持久化（且持久化开启），边界**不会**回卷：活跃状态保持原样，下一次
请求重试。持久化关闭时，历史代存进有界进程内映射，生命周期与会话一致。

## 读取过去

- `decompress` 只读恢复归档块（整块或 `startId`/`endId` 区间），不会重新激活块，
  也不会 markDirty。
- `search_context` 同时搜索活跃块和所有已关闭历史代（摘要、归档原始消息、归档
  原文），命中标签为 `bN (T1, generation G)`。
- retrieve 工具能取回原文只剩在历史代里的 ref。
- 早于历史代机制的旧归档会如实报告不可恢复。

## 启用与验证

bili 无需新增配置。DSH 里把 Codex 订阅 provider 的 `compactionMode` 设为
`cloud`；`dsh` 模式不会产生远端 checkpoint。

```bash
# bili
npm run build
# codex 插件
cd ~/dsh-codex-subscription && pnpm run build
# 真实凭据验证（读 ~/.codex/auth.json，不打印 token）
node --import ./tests/preload-test-env.mjs --import tsx \
  tests/manual/real-cloud-compaction.e2e.mjs
```

定向自动化：`tests/history-generations.test.ts`（历史代、ref、重启、工具调用）、
`tests/codex-checkpoint-boundary.test.ts`（走真实请求管线的 header 真相）、
`tests/compaction-archive.test.ts`。
