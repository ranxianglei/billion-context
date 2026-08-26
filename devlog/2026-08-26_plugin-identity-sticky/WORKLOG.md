# 工作日志

## 排查路径
1. 42947 代理日志: pluginAgent null, 22:41 responses 请求 injectTool=true(wire)。
2. 插桩插件(probe-plugin.js, 注入 __log 到 /tmp/ompreg/plugin.log)从 omp 进程内部取证:
   session_start→manifest GET→identity register POST 全链路正常(单发/TUI/-r 均验证)。
3. plugin-conversations.json: conversation 01a03e4e→responses session 9b62 有映射,
   但 pluginAgent 永远 null → register 从未被 responses 请求消费。
4. 决定性复现: launcher TUI + chat mock(19989)+responses mock(19981), chat 消费 register
   后切 responses 模型 → injectTool=true。bug 实锤。

## 修复
- src/plugin.ts consumePluginRegisterFor: 命中时 delete+set(LRU 刷新), 不再删除。
- tests/launcher-plugin-mode.test.ts +1 测试(双 upstream, 同 conversation, 切换后仍 plugin mode)。
- 红绿验证: 旧代码新测试 FAIL("upstream B"), 新代码 8/8 PASS。

## 验证
- launcher-plugin-mode 8/8; 全量 647/647; typecheck; build。

## 事故与恢复
- 一次 launcher 测试漏带 PI_CODING_AGENT_DIR, 改写用户 overlay agent-bili/models.yml
  为死端口 19998 —— 已 sed 恢复到用户活代理 42947(6 处), 备份
  /tmp/ompreg/models.yml.clobbered.bak。
- chatmock 初版 req.on("close") 在 Node 25 过早触发清掉 interval → SSE 零字节;
  去掉 close 处理后正常。
