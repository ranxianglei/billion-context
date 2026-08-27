# 需求: omp TUI 切换模型后原生模式消失

用户报告: bili omp TUI 会话中切换模型(GLM chat → qwen responses)后, 模型退回 wire 模式
(模型在对话里贴原始 acp_status 输出, "原生模式消失了")。

## 复现(全保真 launcher TUI + 双协议 mock)
- 新会话 chat 协议发消息: identity register 被消费, plugin mode ✓
- 切 responses 模型(同 conversation, 新 session): injectTool=true —— wire ✗

## 根因
consumePluginRegisterFor 对 identity 注册 delete-on-read: 第一个请求消费后注册即删。
模型切换 → session key(protocol|upstream|apiKey|conversation) 变化 → 新 session →
队列已空 → wire。#162 语义本应是"该 conversation 的任何请求随到随绑"。

## 修复
identity 注册对 conversation 粘性: consume 保留条目并刷新 LRU 顺序, 沿用
MAX_PENDING_REGISTERS=64 容量上限。
