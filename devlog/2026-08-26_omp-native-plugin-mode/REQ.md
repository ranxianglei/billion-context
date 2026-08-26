# REQ — omp 原生插件模式恢复

用户观察链:
1. omp wire 模式会话里, 模型伪造「📦 [ACP] Compressed」收据 + 假 `<acp>` 标签, 最终一轮"输出到一半停了"(只输出空白+假标签)。
2. 用户判断根因: "omp 没有真实的工具, wire 模式压缩内容注入给模型" → 模型把压缩工件学成了行为。
3. 用户决策(m07040): "这都不是根本方法 应该看如何恢复 bili 在 omp 的 native 模式" — 恢复原生模式, 让压缩走真实客户端工具。

## 根因(为何 omp 此前只能 wire)
- omp 17.x 把未声明 loadMode 的扩展工具挂到 xd:// 设备 URL(主回合 tools 数组不可见, 仅 title 请求可见) → 即便装了插件, 模型也调不到 compress。
- omp 分叉不发 before_provider_headers → 无法盖章 x-bili-plugin, 代理无法进入 pluginMode。
- 此前(PR#248 时代)结论"omp 主回合永远看不到扩展工具"由此而来, 当时以为不可修, 选择了 wire + /acp 的折中。

## 修复
- manifestToTool 注册 loadMode:"essential"(声明值优先于默认 discoverable, 主回合可见; pi 忽略该字段)。
- omp 无 headers 事件 → 工具就绪后 POST /__bili/plugin/register {conversationId: 会话uuid, agent:"omp", identity:true}(复用 #162 claude/codex 通道); 代理按 identity 绑定后续请求进 pluginMode。
- before_provider_request 事件作重试驱动(omp 每请求触发)。
