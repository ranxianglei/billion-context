# OpenCode 原生 Recall 适配增量交付

2026-11-01 UTC。**原生薄适配层已实现；真实 OpenCode 2.2.5 工具归档、manual compaction 后模型召回及新进程重启后的结构化分页召回均通过。** 这次没有用重写 transcript 代替宿主压缩，没有 fork 或修改 OpenCode，也没有改用户主请求 URL、OAuth、代理或自动压缩设置。

## 最终实现

- 原生插件必须同时显式启用项目和原生 session ID。默认不创建目录、不订阅事件、不读取会话；不扫描全量历史，排除子会话及跨项目移动的会话。
- prompt、context、工具执行前后及 model-compaction hooks 对接 Python bridge；只在原生接口可等待的位置等待持久化。原始宿主 JSON 对象、消息/工具身份和原生修订追加到同一 `events.jsonl`。索引及阅读视图可删除重建，不以伪 CC transcript 作事实源。
- 相同事件/版本幂等；合法流式版本和同版本矛盾内容保留，迟到数据不按到达顺序覆盖。session/project/parent 冲突拒绝。
- 原生结构化召回新增固定 anchor、水位、边界 event ID 和内容摘要的 locator。旧 locator 按当时事实前缀回读；无匹配或冲突时明确失败，不跳到新内容。numeric turn 可用 `expected_revision` 拒绝已变动视图。
- 原生读取提供 UTF-8 字节页、`returned_range`、`next_cursor`，编码 MCP tool result 最大64,512 bytes，为普通 JSON-RPC 外壳预留1 KiB。搜索最多20条；历史标为低信任数据，插件不升级为system指令。CC legacy get保持原兼容语义。
- Recall 的存储失败不返回假 durable ACK/ready，并记录degraded；**运行时归档失败不拦宿主模型、工具或压缩流程**。不把归档错误作为宿主veto，也不声称能回滚工具副作用。

共享源码仅扩展 `archive.py`、`transcript.py`、`mcp_server.py`，新增 bridge/native reader及独立JS适配目录；没有另建存储系统。原CC测试未改，全部通过。

## 四类验收

|范围|结果|证据与边界|
|---|---|---|
|适配器单元、故障、旧能力回归|PASS，115项|包括原64项；并发、迟到/冲突、索引重建、fsync/提交失败、隔离、locator、分页、3项真实stdio集成|
|真正插件加载与原生事件/工具hooks|PASS|实际宿主session事件及工具前后事实；成功本地工具使用28字符短参数，返回17,190字符完整输出|
|真正宿主manual compaction后模型召回|PASS|真实compaction.ended、真实摘要HTTP、压缩前后active context、模型search→get与正确答案联合成立|
|新进程重启、删索引恢复及结构化分页召回|PASS|新session/PID，原anchor locator连续两页40250字节，全部hash/原文正确，旧locator仍有效|

其他本地检查另列：产品插件7组、测试工具5组、分页检查器10组、预算守卫12组。这些是无网络合成检查，不计为真实模型验收。

实际成功cycle的原生 session 为 `ses_8a3a5b9e0b2af8140b25bc99118733c7`，MCP PID 6696。测试工具真实参数为 `{"fixture":"native-long-v1"}`（本地JSON渲染28字符），输出17190字符，含尾部两个随机proof及DETAIL。4500字符I块明确是内部输出数据，不是模型参数。此前失败调用的2010字符长参数，已通过真实event/message/tool.raw原文一致性检查，但不冒充成功长参数executor。

同一次native run通过官方idle/inbox队列调用 `session.compact()`。摘要由Flash真实生成，usage为6796 tokens；没有设置compaction `result` 替代摘要。测试仅向摘要增加“不抄opaque proof”的约束。宿主压缩完成后实际outgoing/官方session.context均不含proof，随后真实模型search→get完整找回答案。是活动context切换，不声称物理删除宿主DB。

最终restart使用新session `ses_1f79f4f5894b720fbce7cf7ed2daf256`、MCP PID 7690，原始anchor `msg_198001159001wkxkSb5uxAhD5s`。模型真实structured search后以同一locator读取两页：`0–30956`、`30956–40250`，next_cursor终止，拼接hash及原文、proof/DETAIL全部正确。该次get没有显式发送expected_revision条件参数；search/get返回版本一致，numeric stale拒绝另由本地回归证明。

重启前删除了插件自己的派生index.sqlite3，未动宿主DB或原JSONL。重启后index重建，原59条事实对应的237998字节前缀hash不变；新增一条激活快照后水位60。重启前水位59的locator仍可取回同样内容。独立沙箱也仅从这份JSONL重建，核验数量、版本、定位、hash和分页一致。

## 请求和用量

|本阶段用途|请求|服务端已报告tokens|
|---|---:|---:|
|前两次失败cycle的诊断尝试|5|10400；另两次usage未知|
|修正后真实工具→压缩→召回cycle|6|23961|
|最终structured locator/分页restart|4|33869|
|本阶段合计|15|68230|

本阶段已报告输入61209、输出7021，总68230。第2、5次HTTP200错误流的usage未知，仍各保留34816，合计69632；**已知加未知保守预留为137862**，低于父任务后续明确授权的200000口径，15次低于20次上限。目标完成即停止，没有在途请求，也没有用满额度。

第一阶段已有29670纳入总报告：两轮Depo测试共27次请求，已报告97900 tokens；加本阶段未知保守预留为167532。未知预留不是已核实实际消耗；账户倍率、账单金额均未核验，原生`cost:0`不代表免费。

首次夹具迫使模型计数/复制长字符串，导致schema门槛失败及冗长输出，现改为确定性本地工具夹具。两次旧错误流的具体错误体当时未保存，无法追溯准确provider code，不猜测为401/403/429或网络拒绝。守卫已修复脱敏错误分类/有界记录，未知用量未清零；修复后10次目标路径请求全部成功。详见错误诊断文件。

## 安装、停用和兼容

按本目录README和example配置安装。只添加插件及显式归档范围，不替换provider、模型、URL或OAuth；不自动写`compaction.auto:false`。仅允许MCP search/get；旧CC的compact_ready/status/rule不是OC压缩接管接口。

|平台/API|状态|
|---|---|
|OpenCode V2.2.5，Linux x86_64|上述原生路径已实测|
|交付版CC共享能力|原64项回归通过；没有新增CC原生压缩实测|
|OpenCode V1、其他V2版本|不作兼容承诺，不能混用V1配置/hook|
|Windows/macOS、真实掉电|未验证|
|provider-native compaction路径|可能绕过model compaction hook，不宣称全部覆盖|

停用时移除插件配置或enabled=false；MCP可另行停用。归档不会自动删除，需用户自行处理对应会话目录。插件失败不是宿主回滚机制。

## 保留边界

原生JSON对象保真不等于provider wire原始字节。工具自身可能已截断输出；默认只保留宿主暴露对象和outputPath/附件引用，不绕过读取或下载。事件订阅没有历史重播cursor，启动catchup仅能读取已选会话当前context，不能补回启用前或断档期间已消失的旧数据。

locator/字节上限针对新原生协议；旧CC legacy get未强行改成新协议。64KiB边界是tool result加普通RPC外壳，不覆盖恶意无限长RPC id。顺序数字turn未带expected_revision仍属于legacy位置语义，稳定读取应使用locator。更强的全库校验账本、固定金样覆盖矩阵等后续项见参考矩阵，未借本轮扩成新内核。

独立终审已确认实测、usage及边界一致。全程仅合成数据；未读取用户私密历史、桌面或预置StarPet项目，未push、创建远端repo、部署、充值或订阅。新包保留初始失败和未知用量，没有覆盖此前Library交付。
