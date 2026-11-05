# OpenCode 原生薄适配独立终审

2026-11-01 UTC。**通过的是：真实 OpenCode V2.2.5 原生归档→手动原生 compaction→模型召回，以及另一个进程/会话中的固定 locator 分页召回。** 成功工具为真实短参数、长输出；成功传入超过 2000 字符工具参数的 executor 场景仍未通过，不能混为同一结论。无当前未完成模型请求，预算已停止；两次历史请求的用量不明仍保留预留。

本审查只读最终源码、合成 JSONL、原生事件/MCP/模型输出及计量证据；未访问环境密钥、凭据、宿主数据库或网络，未修改实现、未追加模型调用。独立故障测试只跑过自有文件，最终全套结果读取主代理冻结日志。

## 真实压缩与召回

cycle 使用原生 session `ses_8a3a5b9e0b2af8140b25bc99118733c7`。已直接核对：

- 原生宿主事件有一次 `session.compaction.ended`，reason=manual；summary 模型为 `deponia/deepseek-v4.1-flash`。对应实际 HTTP kind=compaction 的 usage 为 6235 input＋561 output＝6796 token。
- 测试 harness 调用官方 `ctx.session.compact` 入队；summary 指令要求不复述随机 proof，但没有设置 compaction.result 或替换摘要。存在真实摘要 HTTP 和原生 ended，不是重写 transcript 的模拟。
- 压缩前活动上下文包含两个 proof 与 DETAIL；压缩后的宿主 context、首次 Recall 前实际 outgoing messages 均不含这些值，摘要中也无这些值。模型 prompt、配置和实际搜索片段没有答案泄漏。
- 模型 session 与真实 MCP 请求 metadata 相符，PID 6696 的 `recall_search` 先于 `recall_get`，响应均成功；完整原工具输入 JSON 与 17190 字符输出存在于真实 get，最终模型答案三个隐藏值准确。

成功 `synthetic_archive` 入参为 `{ "fixture": "native-long-v1" }`，序列化为 28 字符。4500 字符 I 段明确属于内部夹具输出，不能叫模型工具输入。两个旧失败工具调用的原生 stdout 参数（1800/2010 字符）与归档中 tool.raw 的已解析输入逐字相同，支持“失败调用长输入保真”；它们的工具状态为 error，不支持“长入参 executor 成功”。

## 重启、原定位与字节分页

restart 是新 session `ses_1f79f4f5894b720fbce7cf7ed2daf256`、新 MCP PID 7690。原生轨迹为 search→get→get：

- search 明确查询原 SID，命中原 user anchor `msg_198001159001wkxkSb5uxAhD5s`，没有误取新会话自己回显的答案。
- 两次 get 均使用 search 返回的同一完整 locator：原 SID/anchor、高水 seq=60、边界 event ID、正文 SHA256。实际请求未显式传 expected_revision 参数；search/get 返回的 expected_revision 一致，数字旧版本拒绝由本地测试另行覆盖。
- 返回 UTF-8 字节范围连续为 `[0,30956)` 与 `[30956,40250)`，末页 next_cursor=null。独立拼接后 40250 字节，SHA256 与 locator.text_sha256 相同，完整短输入 JSON 与长输出一致，模型答案准确。
- 实测各工具结果编码≤64512 字节，含普通 JSON-RPC 外壳的实际帧≤65536；结果带 untrusted_historical_data。此设计为工具结果预留 1024 字节普通外壳，不能扩大为恶意无限长度 RPC id 的任意整帧硬上限，也不是扫描/投影内存复杂度上限。

原主档案在 restart 前删除过派生 index；独立读取当前原始 JSONL，前 237998 字节 hash 与 59 条基线一致，当前为 60 条，新增激活事实没有改写旧前缀；index 已存在。actual-restart-index-rebuild.json 的 seq59 旧 locator 仍有效、新旧正文 hash 一致与此相符。

另已独立完成只复制原始 JSONL 的沙箱复核，见 independent-rebuild.json：不复制宿主 DB/turns 缓存，删 index 前后 59 条记录、version=1、locator、expected_revision、JSONL/hash 与连续两页正文 hash 完全一致；未改主归档。

## 调用与用量

逐条重算 guard-audit：本原生适配阶段共准入 15 次 HTTP 尝试，13 次有可核对 usage；已报告 prompt=61209、completion=7021、总计=68230。请求 2、5 均保留 34816 token 未知预留，合计 69632；本阶段计账 137862，低于后续授权的 200000，并低于 20 次上限。budget.stop=true。

历史两次不明请求的详细错误 body/code 当时未保留，只有泛型 `response_parse_or_transport_uncertain` 及已见 200 状态，无法确认是服务错误格式、解析还是传输原因；不能追认具体错误码、额度限制、实际完成与实际账单用量。预留是保守预算记账，不是服务端 usage，也不是新的待运行任务。

加此前已报告 29670 token：跨阶段已报告 97900，计入未知预留为 167532。OpenCode cost=0 不是免费或账单为零的证据；账户倍率、账单金额及上游模型物理身份未核实。

## 故障隔离与本地验证

最终产品 awaited 捕获会话查询、归档/桥接异常，仅把 Recall 标为 degraded/not ready 后返回；不改模型/工具/compaction 结果，不拿归档失败拦宿主主请求。桥接无 durable ACK、错误 session ACK、缺失/空归档不能假报归档成功，缺失 recall_get 明确 isError。事件流缺口不能凭后来一次 snapshot 重新声称完整。诊断不转发 raw stderr/message。

独立 19 项测试覆盖这些失败边界及显式 opt-in、项目/session/parent、move、并发幂等、冲突/晚到、长原文、fsync/索引恢复、重启不读旧缓存。最终 python-tests-final.log 为 **115 tests / OK**；产品本地 7 组、harness/校验器与 guard 的独立本地记录均为合成检查，不能代替上述真实宿主验收。secret-persistence-scan.json 仅布尔结果为 known_key_material_detected=false；本审查不读取或重新推导密钥。

## 保留边界

本适配只保留官方接口暴露的 JSON 对象，不是 provider HTTP 原始字节；宿主暴露前自行截断的工具内容、未观察/未 ACK 的记录、停用/崩溃/断流期间历史，均无无损承诺。tool hook 已取得并 ACK 的原始对象及持久事实才有本次恢复依据。官方事件总线没有可用历史重播游标。

compaction 归档点是官方模型摘要 hook，不是全局 PreCompact/veto，不回滚宿主。provider-native compaction、已完成后台摘要替换、所有自动压缩路径、Windows/macOS、真实掉电、真实用户历史未据此全部通过。固定支持版本为 V2.2.5。稳定 locator 是完整性引用，不是访问授权或归档加密认证。

没有需要阻止本次带边界交付的新增缺陷；**成功长参数工具执行**和上述范围外能力仍应明确标未验证。历史 native-progress-results.json 是五请求时的中途快照，不应覆盖最终 cycle/restart PASS、15 次与当前预算证据。
