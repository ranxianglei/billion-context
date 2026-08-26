# WORKLOG

1. 证实 omp 17.3.8 发行包无 billion-context 痕迹; `bili omp` 分支原本无 -e 注入(pi 有)。
2. 实现 ompPluginLoadedFrom + launcher -e 注入 + 3 态测试(runLaunch omp 矩阵/单元四态)。
3. e2e 追凶: argv 注入成功但 x-bili-plugin 头为 0 → 探针证明 omp 只发 session_start,
   无 before_provider_headers 事件。
4. 尝试 identity register(POST /__bili/plugin/register identity:true): 服务端绑定
   全链路验证成功(curl 复现 + omp 真机 consume 匹配), 但发现 omp 主回合请求从不包含
   extension 注册工具(仅内部 title 请求可见) → 绑定 pluginMode 反而让模型失去 ACP 工具
   → 否决该方案, 撤销 postIdentityRegister。
5. 中途发现 server.ts:1187 日志 bug: 打印 injectTool=${shouldInject}(原始 flag)而非
   injectTools(有效值) → 修复为有效值 + plugin mode 标记。
6. 最终验证: headless 两轮任务 wire 工具 4/4 注入 + FINAL-E2E-OK; tmux 交互 /acp
   面板渲染(billion-context@0.1.54, Context 0%/200k)。603/603 + typecheck + build。

教训:
- 排查注入与否别信 injectTool= 日志 flag(修复前打的是原始值), 看 fwdTools 列表内容。
- omp(17.x) extension 工具只进 title 请求, 不进主回合工具面 —— 任何依赖"原生工具"
  的 omp 方案都不可行, omp 的正确定位 = wire 工具 + /acp 命令 + pck 身份。
- 真实 ~/.omp/agent 的 config.yml 末行无换行, 手工 append extensions 会拼坏 YAML
  (omp 会把坏文件挪走); ompInstall 代码里已处理此坑。
