# billion_context_native：DSH 原生适配

将显式选中的 DSH 会话归档到现有 Recall 的追加 JSONL 和可重建 SQLite 索引，并以原生工具检索压缩前的完整历史。模型 URL、认证、LLM adapter、全局 fetch 和宿主压缩器保持原配置。

本地包名和 Cordis 运行时插件名均为 `billion_context_native`，patch 示例也使用该 id。迁移应替换源码路径和旧 patch id，保持显式项目、会话与 `archiveHome` 原值，避免同时加载旧新插件。功能工具名及不可变归档身份不变，详见 [迁移说明](../MIGRATION.md)。

## 固定版本

- 参考 billion-context 正式版 `v0.1.212`，commit `daa082ead8a8ead60311e29ad4627bff0f569fc1`，该 tag 内 kernel `0.0.178`。
- 宿主固定 `@deepseek-ai/dsh@0.2.0-rc.2`，官方 tag `dsh-v0.2.0-rc.2`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`。billion 的 `src/agent/client-build-note.ts` 和 `.github/workflows/ci-e2e-dsh-native.yml` 都以此版本为测试基线。
- DSH 本身没有正式稳定 release；此处是与 billion 最新正式版对应的 RC，不将 npm latest `0.2.1-rc.5` 当作已验证替代品。

## 安装与启用

需要 Node 24 或 DSH 官方支持的 Node 版本、Python 3。保持交付源码的 `dsh/` 与 `plugin/billion_context_native/` 相邻关系。将此目录的 `index.mjs` 作为本地 Cordis 插件挂到已有 profile 的 patch；运行时必须能从该模块位置解析 `package.json` 声明的 DSH peer dependencies。可以把交付目录放在该测试 profile 能解析依赖的位置，或按自己的项目方式安装本地包；本插件不替用户修改全局配置或 provider。

```yaml
- insert:
    - id: billion_context_native
      name: /absolute/path/to/billion_context_native/dsh/index.mjs
      config:
        enabled: true
        projects: [/absolute/path/to/project]
        sessions: [exact-native-session-id]
        archiveHome: /absolute/path/to/recall-archive
        declaredHostVersion: 0.2.0-rc.2
```

使用官方 `dsh --profile <已有profile> --patch /absolute/path/to/recall.patch.yml` 启动。首次建立自定义 profile 时才使用 `--from-default-profile`；已有 profile 再传该参数会在启动前失败。原生 session ID 可从宿主界面、既有会话元数据或明确的 SDK 创建结果获得；适配器不扫描用户的历史目录，也不猜测最近会话。

`enabled` 默认 false；关闭时不创建归档目录、不注册工具或监听器。启用要求非空的绝对项目目录列表、明确会话 ID 列表及绝对 `archiveHome`。子 agent、fork seed、其他项目和其他 session 均不归档。`declaredHostVersion` 是操作者声明，不是运行时版本探测；本次只验证固定 RC，不能用更改这一字段冒充兼容性验证。

其他配置：`python` 默认 `python3`；`bridgeTimeoutMs` 默认 20000、范围 100–60000；`maxEnvelopeBytes` 默认且最大 33554432、最小 1024，作用于每次 bridge 请求。恢复快照按事件分批提交；单个事件超过请求上限时明确降级。Python bridge 只继承 PATH、语言及临时目录等白名单环境，不继承 key/token 或 provider 认证。

## 原生接入与失败语义

- `session/event` 捕获宿主提交后的完整事件，标记 `host_live_event`；事件 feed 是 fire-and-forget，不具有压缩 veto 能力。
- `agent/created` 和 `session/flush` 通过必需的 `sessionQuery.observeSession(id, {projectionMode: 'none'})` 补齐已观察前缀，只接受与当前 Session 身份相符的 `live` lease；`prepared` 结果明确降级并释放，不用作原始日志事实。所有 lease 都在分批归档前释放。恢复后的 live Session 本身仍可能含宿主已提交的修复事件，来源明确标为 snapshot，不冒充物理日志原始行。本插件不新增对已弃用的同步 Session 读取方法的调用。
- `agent/created` 的 resume/compact 来源，以及成功 `compaction/end` 后的下一个 `agent/pre-step`，只注入会话索引元数据；历史内容由检索工具按需返回。上下文注入由宿主写入带 `recall-archive` producer source 的消息，符合 DSH v4 持久化要求。
- 归档失败会写 `archive_failed/degraded`，不阻断宿主创建、flush 或压缩。失败时不注入成功索引；搜索和取回会明确失败。只有后续完整 snapshot 获得 durable ACK 后，才清除降级。快照 ACK 仅确认观察前缀，不声称宿主所有内存尾部已保存。
- 退出时先撤销监听器与工具，再等待已接纳的整个工具/监听器操作和进程全部结束。快照读取或提交返回后会重新检查退出状态，停止新的查询或索引注入。查询取消/超时会终止并等待子进程，不把不确定 ACK 冒充成功。

压缩采用 DSH 原生机制。本插件不改基本压缩的阈值、重试、retention 或配置，不安装 billion 的 compaction gate，也不重写全局 fetch。billion `v0.1.212` 的 DSH 插件通过全局 fetch 将请求转发到自己的压缩代理；这里只参考其版本基线、会话隔离和按需召回设计，不执行或依赖该代理实现。

## 原生工具

`recall_search(query, limit?, cursor?)` 搜索当前显式启用的会话；返回 `untrusted_historical_data`、原生 turn 定位和 immutable locator。`recall_get(locator, byte_offset?, byte_limit?)` 从该 locator 取回 UTF-8 字节页，按返回的 `next_cursor` 继续，直到 null。完整响应沿用共享 Recall 的 64 KiB 编码上限。locator 属于其他会话或其他 host 时拒绝，不提供隐式全局跨会话搜索。

`recall_status()` 返回当前 session 的耐久事实数及降级状态。历史页是 `dsh-turn-v1` JSON 文本，保留事件结构、工具参数字符串、原始结果块和来源标签；原文不会因宿主 active surface 的 replace 而消失。同一原生 seq 的冲突版本不会猜测取最新；已有 locator 仍固定其原始高水位。

归档沿用现有 `archive.py` 的 fsync、锁、事件去重、项目/host 绑定和 SQLite 重建能力；结构化读取复用 `native_read.py` 的 locator、分页、hash 和冲突拒绝。没有另建事实数据库。`dsh_read.py` 只负责 DSH turn 阅读投影。原 JSON 对象及字符串可精确保留，但 JSON 序列化会规范化键顺序与空白，不承诺原物理 JSONL 的词法字节。

## 验证

在父目录运行 `python3 -m unittest discover -s tests -q`，以及 `node --test dsh/adapter.test.mjs`。具体版本、真实模型证据的分阶段范围及限制见 [验证记录](VALIDATION.zh-CN.md)。模型脚本模拟的 DSH 原生压缩/恢复测试与 DeepSeek 官方模型测试分开记录，不相互替代。

归档是本地明文历史。历史工具内容被标记为低信任数据，不是新的系统指令或执行授权；该标记不能保证模型永远遵守。附件 URL 和路径保留引用，不下载或保证附件长期存在。自动压缩 veto、Windows/macOS、长会话压力和其他 DSH RC 尚未验证。

既有验证报告属于改名前历史结果；不能据此声称新产品身份通过真实模型验收。改名后的真实 DeepSeek 测试状态见 [验证说明](../VALIDATION.md)。
