# REQ: bili omp 零配置原生插件

用户报告(承接 omp 92% 不压缩事故的调查): "这个不是不需要 install 吗? 都是 bili omp
直接零配置启动 说明还是不符合我们的预期" —— omp 发行版并不自带 bili 插件, /acp 体验
一直依赖历史 `bili plugin install omp`(该条目 08-25 23:02 被移除后静默降级为纯 wire)。
预期: `bili omp` 零配置 = 原生 /acp 命令开箱即用。

## 交付(分支 2026-08-25_omp-pck-identity, commit 7749429)
- launcher omp 分支镜像 pi(PR#227): 无可加载 bili 条目时前置 `-e dist/agent/omp.js`
- ompPluginLoadedFrom(): 条目目标文件存在才算已装(陈旧路径不抑制注入)
- server.ts 日志修复: injectTool 打印有效值而非原始 flag
- 设计定论: omp 不把 extension 工具放进模型工具面(17.3.8 实测), 因此 omp 保持
  wire 工具 + prompt_cache_key 身份; -e 注入的增益 = 原生 /acp 命令
