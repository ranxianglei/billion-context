# REQ — dsh 进 PLUGIN_AGENTS：native 插件部署 + fetch 拦截层（#521）

来源: issue #521（#513 native 模式任务 D，owner 已确认方案）。

## 目标

1. `bili plugin install dsh`：把 cordis 插件（dist/agent/dsh-acp.js）部署进真实
   DSH_HOME 的每个 profile（`<dshHome>/profiles/*/cordis.patch.yml`），替代目前
   仅 launcher `--patch` overlay 注入的路径。remove/status 同步支持，幂等、先备份。
2. fetch 拦截层集成进 dsh-acp 插件：dsh 的 LLM 流量走 pi-ai 的裸 `fetch` 调用
   （已对安装的 dsh 0.1.1-rc.2 验证无捕获引用），包装 globalThis.fetch，仅把
   origin == 活动上游 origin 的请求改写到 `http://127.0.0.1:<port>/bili/<origURL>`；
   其余请求原样透传。代理不可达时该请求降级直连，绝不打断会话。
   上游 origin 解析顺序（issue 指定）：settings baseURL ?? env DEEPSEEK_BASE_URL
   （official deepseek 路由默认 https://api.deepseek.com）。
3. 代理自举：插件在 apply() 时确保代理运行——有 BILLION_CONTEXT_PROXY env 直接用
   （launcher 路径不变），否则 execFile 子命令 `bili daemon --fresh --json
   --parent-pid <dsh pid>`：动态端口（listen(0)，经 instance-file 握手回传真实
   origin/pid/logPath）、独立 session instance file（不污染全局发现文件，避免
   #394 双写告警风暴）、BILI_PARENT_PID=dsh pid（复用 #414 父进程监视器实现
   dsh 退出后代理自动回收）。
4. wire mode 保持不变：dsh 无客户端 conversation id，压缩由代理端执行；/acp
   命令继续走 fetchStatusLatest，输出新增一行拦截状态信息。

## 非目标

- 不实现 ACP 工具透传 / x-bili-plugin 头（那是 B/C 任务）。
- 不改压缩管线、不改两种压缩模式的既有行为。
- 不向 spawn 的代理传 modelWindows（registry fallback 生效，后续跟进项）。

## 验收

- typecheck / 全量单测 / build 通过。
- 真实 dsh e2e：裸 `dsh --profile headless "task"`（不经 bili dsh）→ 插件拉起
  动态端口代理 → LLM 流量经 /bili/ 改写（代理日志可见）→ 长 prompt 触发压缩 →
  /acp 渲染面板 → dsh 退出后代理被回收（≤2s）。
- `bili plugin install dsh && bili plugin status && bili plugin remove dsh` 全流程
  幂等且可回退（.bili-bak）。
- launcher 兼容：native 安装后 `bili dsh` 不再写 overlay patch（防双注册），
  未安装时行为与现状完全一致。
