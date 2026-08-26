# omp chat-completions /acp 修复

## Request

omp 会话使用 chat-completions 协议 provider (GLM-5.3 via Zhipu LB) 长时间运行后, `/acp` 面板永远显示 armed 兜底文案 ("No model request in this conversation yet"), 无任何数据; 压缩在 wire 模式下静默工作但原生模式永不绑定。

## Acceptance

- `/acp` 在 omp chat 协议会话中显示完整面板
- omp 插件 identity register 命中 → pluginMode 绑定 → wire 注入抑制
- responses/anthropic 路径行为不变
