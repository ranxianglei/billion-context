# billion 参考项与 OpenCode 薄适配现状

本表仅对照本任务给定的八条参考要求与当前源码、合成测试、独立归档重建证据，不把参考方案扩展成新的开发承诺。P0 的稳定定位、版本拒绝、字节分页和低信任标记现已加入 native_read.py 并接入 MCP；不能继续把这些项统称为“未实现”。已有幂等、冲突保留、可删除索引等能力也不重复开发。

| 参考要求 | 当前已具备及证据 | 仍未实现或未证明 | 后续最小方向 |
| --- | --- | --- | --- |
| 1. 原 JSONL 独立重建后回读 count/version/locator/hash | events.jsonl 是事实，SQLite 可重建。独立只复制原生合成 JSONL 到临时沙箱：59 条、archive version=1；删 index 后重读 count、高水 seq、原始 JSONL hash、固定 locator、expected_revision、内容 hash 与连续两页 40250 字节均相同，见 independent-rebuild.json。未复制宿主 DB/turns 缓存、未修改主归档 | 不是对任意损坏、真实掉电或所有历史版本的完整证明；未建立通用独立验收 CLI/签名证明格式。event_id 是事实去重键，不能称为整个归档的防篡改认证 | 保留此次独立 JSONL 重建证据；以后按新增故障扩充，勿重建新数据库 |
| 2. old locator 不重定向，expectedRevision | native locator 固定 host/session/native_user_id/highwater_seq/highwater_event_id/text_sha256；读取只重建该前缀并检查 anchor/hash；expected_revision 同时绑定 user anchor 与正文，拒绝数字轮次重排或内容版本改变。缺边界、hash 改变、pending prompt、冲突版本明确报错 | locator 是完整性引用，不是权限或加密签名；当前 legacy 纯数字调用未提供 expected_revision 时仍属便利入口，不能承诺自动固定旧版本。每页重放前缀也不等于有界内存/扫描成本 | 后续优先使用 search→locator→get，不把不带版本的数字调用当稳定定位 |
| 3. session-parent/project 映射冲突明确拒绝 | native append 绑定 host/project/session/parent，项目/parent 改变拒绝；调用方 identity 不能覆写作用域；插件每次验证 location/parent/会话 ID，child 事实留存但不混入 main；独立隔离与 move 测试通过 | 不是跨宿主全局身份注册服务，没有迁移/显式重新绑定流程；locator 自身不授权跨项目访问 | 保持严格拒绝及明确诊断，本轮不增加全局身份服务 |
| 4. MCP 硬字节/条数分页，returned_range/next_cursor | native_read.MAX_HITS=20；query 限 4096 UTF-8 字节/32 terms；structured search/get 返回游标。get 按 UTF-8 字节边界返回 returned_range/next_cursor，计入 content 与 structuredContent 的重复编码及 JSON 转义；工具结果限 64512 字节，为普通 RPC 外壳留 1024 字节；legacy native 入口也加界限。独立真实归档两页连续回读，最大工具结果 64511 字节 | 外层 RPC id 当前未限制任意长度，故 1024 预留只覆盖普通 id/外壳，不能声称任意恶意超长 id 的整个传输包绝对≤64KiB。现有分页限制响应，不证明读取/投影过程的内存与扫描复杂度有界；CC legacy 兼容路径不能自动扩大为同等新协议 | 报告精确说“native tool result 编码上限＋普通 RPC 预留”；后续如需绝对传输界限，再限制/测量外层 envelope |
| 5. 历史低信任，不能升级 system | 新 native 结果包含 trust=untrusted_historical_data，text notice 明确历史内容不是系统指令；薄适配不把召回内容写入 system、不修改宿主 prompt。独立分页证据带此 trust | 标签不是模型绝不会受提示注入影响的证明，尚无完整恶意历史金样；legacy/CC 路径不能笼统声称均已迁移到新结构 | 后续先加少量恶意历史回归，不创建从历史推导系统授权的路径 |
| 6. host compaction started/ended/failed/unknown | 插件保留官方 started/ended/failed 事件，模型 compaction hook 执行归档 barrier。真实 recovery-2 cycle 已有手动 session.compact 的 ended=1、真实 summary HTTP=1，压缩前 proof 在上下文，压缩后宿主 context 与实际 outgoing 均不含 proof；这次不是重写 transcript 模拟 | 尚无全面按 compaction ID 对账的持久状态机；总线不回放，丢失 ended/failed 只能 unknown。provider-native 路径/已生成后台摘要替换不保证重跑 hook；失败不得宣称宿主回滚 | 以原生事件＋summary HTTP＋真实活动上下文联合验收；对观察缺口保持 unknown |
| 7. ready 要 durable 水位，不只是工具注册 | bridge 在归档 flush/fsync/索引提交后 ACK session/count/durable；空未知归档不能 fake barrier；native structured read 的 snapshot/locator 给出冻结归档高水 seq/event ID。归档 degraded 后不因一次新 snapshot 假报 ready | 读取高水不证明完整覆盖宿主全部历史；缺少宿主 durable seq 与归档连续性的联合 ready API，不能承诺无 replay gap。MCP 工具注册仍不等于原文持久成功 | 分开“可调用”“读取快照水位”“完整覆盖”三个事实；缺 ACK/有 gap 只报 degraded/unknown |
| 8. 固定金样回放/重建/崩溃定位结果一致 | 独立测试覆盖重复、冲突/晚到、长原文、并发、删索引、fsync 故障和不用旧 turns 缓存；新 locator 测试覆盖旧定位、版本变化、pending/conflict 与 UTF-8 分页。实际合成 JSONL 副本重建前后 locator/hash/范围一致 | 尚不是签名固定金样数据集或完整的所有崩溃点定位矩阵，未证明真实掉电/Windows 一致；这次取样归档是运行产物而非版本库固定 golden 文件 | 后续保留少量固定输入/期望输出，增加关键故障点重放，不重做已通过的幂等设计 |

## 本轮必须保持的失败边界

最新要求是：**Recall 自身存储 fail-closed，但不能拿 Recall 失败阻断宿主主请求。** 当前 awaited 将 enabled/session RPC、桥接/归档异常记录为 degraded 后返回，不修改模型、工具结果或 compaction.result。没有 durable ACK 就不得宣称归档成功/ready；缺失归档的 recall_get 明确返回错误。错误 ACK、事件流关闭、session lookup 失败的独立测试已检查“宿主 hook 正常返回、归档失败可诊断、无假成功”，没有把它解释为宿主回滚或全局 pre-compaction veto。

## 真实验证状态边界

recovery-2 的真实 cycle 已通过原生压缩与压缩后召回检查：成功工具的实际入参为短 JSON（28 字符），输出 17190 字符；4500 字符的内部夹具属于输出，不是模型传入参数。旧失败尝试中的长工具输入可独立回读，但不代表长参数 executor 成功。不得将二者合并成“成功模型调用传入长参数”的结论。

最终固定原 SID/原 user anchor 的真实 restart 已 PASS：新 session/MCP PID 7690 经 structured search→同一 locator 两页 get，连续回读 40250 字节、末页结束、正文 hash 匹配；actual main index 删除重建后旧 seq59 locator 仍有效，新读取高水为 seq60。真实模型未显式传 expected_revision 参数，返回值一致；numeric stale 拒绝由本地测试覆盖。

本阶段已停止于 15 次尝试，已报告 68230 token；请求 2、5 的 usage 不明，各保留 34816，合计预留 69632。计账 137862<200000；此前已报告 29670，跨阶段已报告 97900，含预留 167532。未知请求具体错误 code/body 未保存，不能冒认原因；原生 cost=0 不作账单证据。完整独立验收与边界见 INDEPENDENT_NATIVE_REVIEW.zh-CN.md。
