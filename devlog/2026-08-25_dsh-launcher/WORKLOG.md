# WORKLOG — 2026-08-25 dsh launcher

## 实现前实测探针(/tmp 临时环境,已清理)

1. mock SSE 上游 + `DSH_HOME` 隔离 + `DEEPSEEK_BASE_URL` → dsh headless 完整回合 PROBE-OK(证明 env 重定向)。
2. settings.yaml 节名试错: 顶层 `providers:` 无效;`llm-pi-ai.providers.deepseek` 不生效(默认路由不是 pi-ai);`--dump-config` 揭示 agent-default-model 钉 `deepseek-official`;garbage settings 硬崩(证明 settings 从 DSH_HOME 读)。
3. `dsh-llm-deepseek` 源码: `config.baseURL ?? env.DEEPSEEK_BASE_URL ?? PUBLIC_BASE_URL`。
4. 全链路: dsh → bili(/bili/ 前缀) → mock, 压缩工具注入(tools=[...,compress,decompress,search_context,acp_status]), 双会话独立跟踪。

## 代码改动

- src/client-config.ts: `DshConfig`、`resolveDshHome`、`parseDshSettingsYaml`、`readDshConfig`;loadClientConfig 挂 `config.dsh`。
- src/launcher.ts: LAUNCH_CLIENTS/BaseClientName +dsh;discoverRoutes dsh 分支(baseUrls → httpRewrites);`prepareDshHome`(overlay 重写,hermes 姊妹版);runLaunch dsh 分支(BILLION_CONTEXT_PROXY + DEEPSEEK_BASE_URL + DSH_HOME overlay + 三态警告);launcherInjectMcp 排除 dsh;re-export 三个新符号。
- src/loop/adapter-openai.ts: emitCompletion usage 数字字段 `?? 0` 兜底(修 dsh non-JSON-serializable)。
- src/cli.ts: help 三处加 dsh。
- tests/launcher.test.ts +6 测试(parse/read/resolve、discoverRoutes、prepare 重写/CRLF/unreadable、runLaunch spawn 级 env 断言)。
- tests/loop-adapters.test.ts +1 回归测试(usage 字段完整性)。
- README(.zh-CN).md + CONFIGURATION(.zh-CN).md: launcher 命令、重定向/CA 表、发现表、隔离配置、wire-only 说明。

## 验证

- typecheck ✅;npm test 604/604 ✅(三遍);build ✅。
- 真实 e2e: `node dist/index.js dsh --profile headless "..."`(DSH_HOME 隔离 + settings.yaml 带 llm-deepseek.baseURL → mock): overlay 生成、DEEPSEEK_BASE_URL 设置、双请求过代理、SSE 回流 `DSH-E2E-OK`、exit 0。usage 修复前后对比确认(修复前 dsh 报 "session event assistant/chunk carries non-JSON-serializable data")。

## 教训

- 测试 dist 服务必须 --no-auto-update(repo package.json 又被就地更新到 0.1.54,git checkout 还原)。
- mock 端口被旧进程占用时新 mock 静默 EADDRINUSE 死亡,旧 mock 继续答 → 现象诡异;先 ps 后 kill。

## Follow-up 6: native `/acp` command via `--patch` injection (issue: wire-mode /acp not native)

User feedback: typing `/acp` in the dsh web UI sent it to the model as a plain
prompt (model then called the wire-injected `acp_status` tool and pasted raw
JSON). Requested parity with pi/omp/codex/claude — a real native command.

**dsh plugin mechanics discovered** (dsh 0.1.1-rc.2):
- cordis plugins: `{name, inject:["commands"], apply(ctx)}`;
  `ctx.commands.register({name, description, handler})`; handler returns
  `{kind:"success"|"error", text}` — verified against `dsh-command-compact`.
- `--patch <path>` CLI flag: repeatable overlay applied after the profile's
  user layer; entries `[{insert: [{name: <specifier>}]}]` append to the root
  loader tree. Entry names resolve through Node's module loader — a `file://`
  absolute URL works (cordis-plugin-loader `EntryTree.import`).
- Subcommand rules: `dsh web` accepts its own `--patch` (parent flags
  rejected before it); `dsh plugin` (pnpm forwarding) and
  `--dump-default-config` take no `--patch` at all.
- `dsh-headless` is a one-shot direct Agent driver — it never parses slash
  commands (native `/compact` is equally unavailable there); `/acp` targets
  the web/tui interactive surfaces.

**Implementation**:
- `src/agent/dsh-acp.ts` (tsup entry → `dist/agent/dsh-acp.js`): registers
  `/acp`; outcome chain = proxyBaseFromEnv → fetchStatusLatest (panel text)
  → fetchProxyVersion (armed-but-idle info, PR#235 wording) → unreachable
  error. No-env case hints `bili dsh`.
- `src/agent/shared.ts`: +`fetchStatusLatest` — status endpoint rejects an
  EMPTY conversationId, so the URL carries `conversationId=dsh&fallback=latest`.
- `src/launcher.ts`: +`writeDshAcpPatch` (writes `~/.dsh-bili/.bili-acp.patch.yml`
  with `- insert:\n    - name: file://…/dsh-acp.js\n`; independent of the
  settings rewrite so it exists with zero custom providers) and
  `dshArgsWithPatch` (three-shape splice: prepend / after-`web` / skip).
  runLaunch dsh branch wires both.

**Tests**: launcher 85 (argv splice assertions in the existing runLaunch dsh
e2e + writeDshAcpPatch content + dshArgsWithPatch four shapes);
tests/dsh-acp.test.ts 4 (panel / armed / unreachable / no-env). 610/610.
Gotcha: the handler test's fetch mock must be restored AFTER `await
handler()` — restoring synchronously raced ahead of the first actual fetch
call and a live proxy on 127.0.0.1:8787 answered instead.

**e2e (real vllm)**: `--dump-config` shows our insert row; headless one-shot
through `bili dsh` returns ACP-E2E-OK with no loader errors (plugin loads and
registers); `dsh web` boots clean; `status?conversationId=dsh&fallback=latest`
on a live proxy returns the rendered panel.

**Docs**: README(.zh-CN).md dsh line + CONFIGURATION(.zh-CN).md launcher
"native tools" section, install-matrix wording (dsh no longer "wire-only").
