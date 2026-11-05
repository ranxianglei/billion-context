# OpenCode 原生适配的官方 API 契约与边界

核实日期：2026-11-01 UTC。隔离 HOME/XDG 中实测既有官方 CLI 为 `opencode v2.2.5`。以下实现依据同时核对当前 V2 文档和固定 `v2.2.5` 源码；不是 V1 API，也不保证未来版本不变。本文件仅记录 API 研究，不将 mock、握手或源码推断计为真实宿主验收。

## 支持的原生接入点

插件是目录包，默认导出 `{ id, setup(ctx) }`；`Plugin.define` 是类型辅助形式。`setup` 可异步并返回清理函数。配置使用复数 `plugins`，可以传 `{package, options}`；不需要更改宿主或供应商请求路径、OAuth、模型配置。[官方 V2 插件说明](https://opencode.ai/v2/docs/plugins/)、[server 插件文档](https://opencode.ai/v2/docs/build/plugins/server/)。

| 接入点 | V2.2.5 的真实参数/效果 | 归档用途与限制 |
|---|---|---|
| `ctx.session.hook('prompt', callback)` | `{sessionID, messageID, prompt, metadata?, delivery}`；`prompt={text,files?,agents?,skills?}` | 等待持久化后才返回，可保留此时宿主交给插件的输入结构。不是 V1 的 `parts`。其他先运行的插件可能已修改 prompt。 |
| `ctx.tool.hook('execute.before', callback)` | `{tool,sessionID,agent,messageID,id,input}`，`input` 是已解析对象 | 调用身份和结构化参数；不是 provider 原始 JSON 字节。回调 rejection 使该工具调用失败。 |
| `ctx.tool.hook('execute.after', callback)` | 上述身份字段；`status:'completed'` 时有 `result={content,output?,metadata?}`；`status:'error'` 时有 `error` | 原生本地工具执行之后、core 的图片/内容归一化之前被等待。工具自身可能已经截断输出；失败不能回滚工具副作用。 |
| `ctx.event.subscribe({types?,signal?,onActivity?})` | 返回 `AsyncIterable<event>` | 捕获真实 durable ended 事件与版本。不是 `event.listen`，没有 `after` 参数；异步订阅不是宿主提交的 fsync 屏障。 |
| `ctx.session.hook('compaction', callback)` | `{sessionID,model,agent,system,messages,tools,options,result?}` | 摘要/原生压缩请求组装时被等待；可先对已启用 session 做 snapshot/flush。`messages` 是已转换的 AI 消息，不能当原始宿主事件。不要设置 `result` 来伪造一次真实摘要模型验收。 |
| `ctx.session.hook('context', callback)` | 同类请求形状、用于正常 agent loop | 可在压缩后的下一次真实请求前放入检索提示；不等于压缩前归档 hook。 |

固定签名：[session hook 接口](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/session.ts#L14-L59)、[tool hook 接口](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/tool.ts#L38-L64)、[event 订阅接口](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/event.ts#L6-L11)。原始 prompt schema 是 [PromptInput](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/prompt-input.ts#L25-L30)。

`execute.after` 的真实调用顺序见 [core/tool.ts](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/tool.ts#L132-L175)。Promise hook 的区别在 [adapter.ts](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/adapter.ts#L686-L695)：before 用可失败的 `Effect.tryPromise`，after 用 `Effect.promise`。因此 after 写档失败会传播执行故障，不能说成已成功保存，也不能承诺宿主已提交原结果。

## 真实事件与事实身份

V2 durable 事件的外形为：

```text
{ id, type, created, durable:{aggregateID,seq,version}, location?, metadata?, data }
```

**修订号在 `event.durable` 内，不在顶层。** `seq` 是非负整数，`version` 是正整数；保存收到的整个 native 对象，独立保存本地观察/归档序号，不以晚到事件覆盖旧事实。来源：[事件 envelope](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/event.ts#L17-L35)、[durable schema](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/event.ts#L94-L125)。

主要可重放边界如下，不能套用 V1 的 `message.part.updated`：

| 事件 | `event.data` 的关键字段 |
|---|---|
| `session.created` | `sessionID, projectID, location, parentID?, version, ...` |
| `session.inbox.enqueued` | `sessionID, inboxID, item`；用户 item 为 `{type:'user',payload:{text,files?,agents?,skills?,metadata?},delivery}` |
| `session.inbox.delivered` | `sessionID, inboxID`；本身没有用户正文 |
| `session.step.started` | `sessionID, assistantMessageID, agent, model, started` |
| `session.text.ended` | `sessionID, assistantMessageID, ordinal, text, native?`，完整解码文本边界 |
| `session.tool.input.started` | `sessionID, assistantMessageID, id, name` |
| `session.tool.input.ended` | `sessionID, assistantMessageID, id, text`，原始工具参数 JSON 字符串的可重放边界 |
| `session.tool.called` | 上述工具身份、`input` 对象、`executed, native?` |
| `session.tool.success` | 上述工具身份、`content` 非空数组、`metadata?, executed, native?`；此事件自身不带工具 name |
| `session.tool.failed` | 工具身份、`error, content?, metadata?, executed, native?` |
| `session.step.ended` | `assistantMessageID, finish, tokens, cost, ...` |
| `session.compaction.started/ended/failed` | session、reason；ended 带 `model,text,native?,tokens,cost`，failed 带 error |

schema 来源：[user/inbox](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/session-event.ts#L208-L228)、[text](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/session-event.ts#L396-L432)、[tool](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/session-event.ts#L473-L571)、[compaction](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/session-event.ts#L586-L639)。`text.delta` 和 `tool.input.delta` 是 ephemeral，不能仅靠这些 fragment 承诺重启后补全；ended 才是完整可重放值。

## Session 查询、范围和恢复

`ctx.session.get({sessionID})` 返回 Session.Info，含 `parentID?`、`projectID`、`location` 和 metadata。父子会话不应混为主链；显式允许项目/会话之外必须不采集。`parentID` 缺失可判根会话，fork 信息也应作为身份保留。[Session.Info schema](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/session.ts#L30-L67)。

`ctx.session.context({sessionID})` 返回解包的消息数组，只覆盖当前压缩边界之后的 active context。用户消息是 `{id,type:'user',text,...}`；助手消息 `content` 中有 text/reasoning/tool 项，工具 completed state 中有 `input` 对象和 `content`。它不是完整历史事件日志，也无法还原错过的原始工具 JSON 字符串。来源：[公开 context endpoint](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/protocol/src/groups/session.ts#L506-L517)、[消息 schema](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/session-message.ts)。

不要虚构 `ctx.session.messages()`、`ctx.session.message()` 或 `ctx.session.log()`：V2.2.5 插件 SessionDomain 只暴露 [显式方法集合](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/session.ts#L201-L220)，这些名字不在集合中。普通 client/HTTP 另有分页历史 message endpoint，以及实验 durable log endpoint，但不能据此假定插件 ctx 自动暴露相同接口。实验日志真实路径是 `GET /api/experimental/session/:sessionID/log?after=<exclusive seq>&follow=<bool>`，[固定定义](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/protocol/src/groups/session.ts#L656-L675)。若未通过受支持 client 明确接入并验收，不应宣称已利用其完整重放。

插件事件订阅没有历史 cursor，直接来自进程内 bus；[host.ts](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin/host.ts#L266-L282) 接 `bus.subscribe`，[typed bus](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/bus.ts#L751-L784) 使用 unbounded PubSub。不要将 HTTP client 的 4096 条 shared-events 队列或 SSE `server.connected` 帧等同为插件 ctx 的实现；插件 EventDomain 明确排除了该 framing 类型。进程死亡/插件重载仍会丢失尚未消费的内存队列，也没有归档 fsync 提交确认。重启时可以对已显式启用 session 做当前 context snapshot，并将缺口/不完整状态记录下来；不能把 snapshot 冒充从创建开始完整事件日志。不能打开宿主私有数据库来掩盖缺失的公开 API。

## 压缩前等待与失败的准确含义

固定代码中 `compaction` hook 被 await：`compaction.ts` 的 `summarize` 在 [L471](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/compaction.ts#L455-L488) 先 `prepare`，prepare 在 [L835-L852](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/compaction.ts#L835-L852) 调 `requests.compaction`；`model-request.ts` [L261-L280](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/model-request.ts#L261-L280) 等待 shape，[L423-L430](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/model-request.ts#L423-L430) 将其连接到真实 hook。通用 dispatcher 顺序等待回调：[hooks.ts L85-L95](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin/hooks.ts#L85-L95)。

因此，本版本可以在该 hook 内 await 独立归档 fsync/队列排空，失败则拒绝返回成功；manual runner 捕获失败并发布 `session.compaction.failed`，不会按成功摘要落完成 checkpoint。处理在 [runner/llm.ts L127-L170](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/runner/llm.ts#L127-L170)。这是“本次压缩请求组装前的可等待归档屏障”，**不是官方 `pre-compaction veto` API**，没有 `allow:false` 或取消字段，也不是对未来所有压缩、删除、崩溃或其他插件行为的全局保证。

`event.result` 的官方语义是直接提供压缩摘要/窗口以跳过模型；它不是拒绝压缩。生产适配器只归档时应不设置它。后台预计算也会触发 compaction 请求 hook，但已算好的摘要以后 swap 时未必重新触发；不能声称每个应用 checkpoint 都重新通过插件 veto。默认不应擅改用户 background compaction 设置；实际测试要说明是否关闭了实验后台路径。[compaction.ts 后台逻辑](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/compaction.ts#L334-L420)。

## 同一 standalone 内真实压缩与召回的可行验收路径

官方手动入口：`await ctx.session.compact({sessionID,id?,delivery?})`。它仅将请求持久入 inbox 并唤醒 session，不等待摘要；HTTP 为 `POST /api/session/:sessionID/compact`，payload `{id?,delivery?}`。[endpoint](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/protocol/src/groups/session.ts#L441-L460)、[实现](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/session.ts#L259-L279)。即使 `compaction.auto=false`，手动操作仍执行。通常完成依据是 compaction ended/failed，再核对新 context。`ctx.session.wait({sessionID})` 等待本进程 idle；不要在该 session 当前 hook 中等待它自己。

可在**独立合成测试插件**的 `experimental.idle` hook 中只触发一次：先 `await ctx.session.synthetic({sessionID,text:'合成压缩后召回指令',resume:false})`，再 `await ctx.session.compact({sessionID})`，然后直接返回，不 await wait。runner 在 hook 后发现 inbox 项，会在同一次 execution 中继续执行 manual compaction，然后处理 pending synthetic。此方法不需持久 server 密码，不改 provider URL。

这不是推测出的调度：固定官方测试 [session-runner.test.ts L1327-L1351](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/test/session-runner.test.ts#L1327-L1351) 就验证 first answer → summary → second answer 在一次 runPrompt 内完成。调度实现见 [runner/llm.ts L173-L182](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/runner/llm.ts#L173-L182)。接口为实验性，测试插件必须一次性、仅合成 session；不能把它默认装成产品自动压缩策略。正式适配层只观察/归档官方生命周期。

也可注册原生命令 `ctx.command.transform(editor=>editor.add({name,description?,execute:async({sessionID,prompt,delivery})=>{...}}))`；但只排队 compact 的 CLI API 命令可能在 accepted 后就退出，所以不能把 accepted 当摘要完成。[命令契约](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/command.ts#L7-L21)。

真实验收至少保存 compaction.started、被实际调用的 compaction hook、provider usage、compaction.ended，核对 active context 已替换且没有旧 proof，再在同 session/重启 session 用真实 Recall 工具取回长原文。设置测试 `keep.tokens=0` 能避免 recent tail 保留旧工具结果；摘要若仍含 proof，必须如实判定“答案可能来自摘要”，不能据此判独立档案召回通过。

## 无损声明的明确边界

- `tool.execute.after` 不保证任意工具的未截断进程 stdout。官方 `ToolOutput.truncate` 在超限时把全文写到本地 `metadata.outputPath`，再返回 bounded content；别的工具或上游服务也可能已截断。[tool-output.ts L69-L119](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/tool-output.ts#L69-L119)。至少保留 `truncated/outputPath` 原字段并标记不完整。若要读取那个官方文件，必须额外实现受控本地路径/大小/链接检查和权限范围，不能追任意工具返回的路径。
- 图片/附件保留宿主提供的对象或引用不等于保留以后可用的文件字节；不应自动抓取 URL、远端附件、用户私有文件或 provider auth 数据。`native` 中可能有 opaque/encrypted provider 重放对象，只能保留 host 提供的数据，不宣称已解密原推理。
- JSON 对象重新编码可保证结构语义与完整字符串，不是 provider 网络原始字节。原始工具 JSON 文本只有在真实 input.ended 事件被捕获时才能另行保证；启动恢复 snapshot 不能补造它。
- awaitable hook 能提升正常运行时持久边界；异步事件订阅仍可能晚到、在进程死亡/重载时遗失内存中未消费事件，或插件启动晚于旧压缩。应保留所有修订并报告缺口，不能让迟到或摘要版本覆盖先存原文，也不能声称无宿主 API 支持的原子删除前 veto。
- OpenCode 压缩通常改变 active context 的读取边界，并非一定物理删除旧数据库消息。真实压缩测试只能按实际宿主轨迹描述，不把“模型看不到旧窗口”写成“宿主磁盘旧字节已删除”。

## 初始化校验失败与宿主继续运行

V2.2.5 官方 loader 隔离普通插件 setup 异常：Promise adapter 的 [L667](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/promise/adapter.ts#L661-L675) 将 setup 接入 effect；[core/plugin.ts L63-L104](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin.ts#L63-L104) 用 `Effect.exit` 捕获失败，并在 L92-L94 关闭该 activation scope，清理其已注册 hook/transform，再将错误作为 slot 状态保留。激活循环在 [L153-L174](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin.ts#L153-L174) 记录失败后继续；[slotInfo](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin.ts#L300-L308) 将其显示为 `failed`。因此本插件在初始化时拒绝非法配置/不支持宿主版本，可以保持明确失败，而无需吞错并伪装 active；这类 setup 校验 throw 本身不应变成主会话请求失败。

这与运行中的 awaited hook 异常不同：运行时异常若不被本适配器处理，仍会按前文真实调用链传播。若产品选择“归档不确认/不 ready，但宿主继续”，必须在本适配器的运行时 hook 中标记 degraded 并安全返回，不能借 loader 的 setup 隔离来推断任意 hook throw 都不会阻断宿主。failed reload 还可能由官方 loader 恢复上一个健康 activation，这是宿主既有回退语义；不能把失败的新配置当已生效。
