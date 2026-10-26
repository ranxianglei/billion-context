# 外部摘要功能开发合同

设计讨论：[#2163](https://github.com/ranxianglei/billion-context/issues/2163)，关联 [#1640](https://github.com/ranxianglei/billion-context/issues/1640)。

## 当前阶段

PR #2167 已通过 `src/external-summary-runtime.ts` 和 `src/external-summary-compress.ts`，将 `src/external-summary.ts` 独立执行器接入宿主压缩路径。`compress.externalSummary` 默认关闭，须显式启用；该链与其余 `compress` 字段一样存在全部三个层级（provider/model 层整链替换，无子字段合并），且沿请求 Config 轨道（`ctx.config` / `effectiveConfig`，#833）流动，不再有旁路配置文件。当前是评审分支中的实现，不是已发布版本，也未部署生产；配置面仍待仓库 owner 明确确认。

链以**引用**形式表达（`"glm/glm-4.9-flash"`），指向 `providers` 表中的具名拨号配方（带 `baseUrl`/`api`/凭据/`models` 的非 URL 条目，详见 `CONFIGURATION.zh-CN.md`）。解析分两层：`src/external-summary-settings.ts` 在配置加载时做语法层链解析（`parseExternalSummaryChain`），在请求应用时做引用展开（`expandExternalSummaryChain` / `src/compress-settings.ts` 的 tolerant 变体），产出执行器轨道消费的展开型 `ExternalSummarySettings`。启用链中的不可解析引用会记录一次警告并禁用整条链 —— 绝不回退主模型。Web API 保存时对不可解析的启用链返回 HTTP 400；配方从即将保存的 `providers` 段收集（`src/config.ts` 的 `collectNamedProviders`）。#2336 新增内存中的 **agent 注册表兜底层**（`src/agent-providers.ts`）：ACP 原生 agent POST 自己已配置的 providers（`POST /__bili/agent-providers`，`parseAgentProviderReport` 消毒+校验），这些 recipes 在请求应用时合并在文件 recipes 之下（`{ ...agentProviderRecipes(), ...opts.namedProviders }`）——同名时文件胜出。agent recipes 携带已解析的 inline key（轨道 target 上的 `apiKey`，与 `credentialRef` 互斥；文件世界仍拒绝明文 key——`parseExternalSummarySettings(value, { inlineKeys: true })` 是轨道专用开关）。

执行器接收不可变的任务文本、指令、可选只读参考，有序的异步候选调用及明确的内部预算。协议、鉴权和范围选择由调用方负责；没有调用方就不会请求供应商或折叠历史。

`src/external-summary-http.ts` 提供 Anthropic、OpenAI Chat、Responses 和 Google 的单次 HTTP 候选调用，复用现有摘要编解码；关闭态不改变既有 preflight 行为。它使用明确的摘要端点、模型及认证头快照，不继承主请求凭据；只读参考与被选内容分别传递。重定向、非法 UTF-8、响应字节超限、缺少完成标记、截断及工具调用都会被拒绝；中转改变返回格式时仍检查 SSE 帧及完成状态。HTTP 或流式失败交给既有候选链切换，不另加重试循环。隔离测试使用本机模拟上游；另有可选真实 Responses 烟测，验证事实保留和原文精确恢复。烟测不等于多供应商质量或费用基准。

## 执行合同

- 每个选定范围中，每个候选最多调用一次，按顺序执行，首个有效结果胜出。调用错误、空正文或 UTF-8 字节超限时尝试下一项。字节校验不等于语义质量或模型窗口校验。
- 排队计入总时限；拿到并发许可后才开始计算单目标时限。定时器与单调时钟检查共同拒绝迟到结果；同步阻塞代码不能被抢占中断。
- 调用方取消或总超时立即终止候选链，部分或迟到正文不得作为成功返回。全失败不悄悄退回主模型。
- 同一共享执行器限制各操作的实际并发调用数。忽略取消的超时调用直到真正结束前仍占用许可，防止不断启动后台调用。生产协议适配器必须真正取消网络并释放资源。
- 回报只含候选序号及分类结果，不带供应商错误原文、Key、URL 或历史正文。只有调用方能够校验会话版本，并通过既有压缩权威提交成功范围。

## 最终验收范围

内部 `executeBatch` 操作让排队、所有范围及备选尝试共用一个单调时钟截止时间。结果与输入顺序一致；`finished` 表示所有范围已处理，不表示全部成功。取消或超时后不再处理后续范围，已生成的结果保留，供未来接入方校验并提交；该操作本身不折叠历史，也不会逐范围重置总时限。

- 配置页提供默认关闭的自定义摘要目标及有序备选。需求方已授权在 fork 中实现并提交评审；这不能替代合并前仓库 owner 对公开字段与秘密存储的明确批准。
- 开启后，主动 `compress`、preflight、MCP/官方 thin-plugin 执行、受支持的 native-compaction 摘要生成路径统一调用外部服务。仅支持 preflight 不能作为最终交付。
- 折叠成功后原主模型继续正常任务；非摘要请求及关闭态保持原行为。
- 多客户端、多主机验证覆盖会话隔离、取消、过期版本拒绝、失败安全、凭据隔离，以及 proxy/plugin 两种模式的工具参数原字节保真。
- 真实 API 的质量和费用比较需要专用凭据及明确费用上限，模拟测试不能代替真实测量。

此功能不会自行获得未经过代理的客户端历史。模型流量与会话身份须先接入 Billion，单独连接 MCP 不够；共享摘要服务的凭据不必按每个主供应商重复配置。

每阶段结束须查看 issue/PR 新反馈。同目标优化可自主推进；永久删去核心目标须重新取得需求方批准。本阶段不代理合并、不发布 npm、不部署生产。
