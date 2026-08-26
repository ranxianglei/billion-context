# REQ — `bili dsh` launcher (deepseek-harness)

用户需求: 适配 https://github.com/deepseek-ai/deepseek-harness,新增 `bili dsh` 启动器,与 `bili pi` / `bili hermes` 等并列。

## 调研结论(实测验证)

- npm 包 `@deepseek-ai/dsh` (bin: `dsh`),cordis 组合式插件架构,home = `$DSH_HOME` 或 `~/.dsh`。
- settings 文档: `$DSH_HOME/settings.yaml`,按插件命名空间分节(`llm-pi-ai:` / `llm-deepseek:` 等),文档级 parse 失败会硬崩 boot,坏 section 静默惰性。
- **默认路由 `deepseek-official` 不走 pi-ai catalog**: 专用适配器 `dsh-llm-deepseek`,baseUrl 解析链 `config.baseURL ?? $DEEPSEEK_BASE_URL ?? https://api.deepseek.com`(config 优先)。env 重定向实测有效。
- 自定义 provider: `llm-pi-ai.providers.<route>` profile(`baseURL` 字段),pi-ai 纯 fetch,**无 proxy/CA 接口** → cert-MITM 不可行,全部 `/bili/` URL 重写。
- agent-default-model 钉死 provider=deepseek-official + model=deepseek-v4-flash(headless profile)。
- CLI: `dsh [--profile <name>] [args...]` 透传给 booted profile;`--profile headless "task"` one-shot e2e 可用。

## 设计(定案)

1. 内置 deepseek-official 路由: launcher 设 `DEEPSEEK_BASE_URL=<origin>/bili/https://api.deepseek.com`(零配置可用;用户 settings 有 llm-deepseek.baseURL 时重写后的 config 优先,env 自动让位)。
2. 用户 settings.yaml 自定义 providers: 持久 overlay `~/.dsh-bili`(同 hermes 模式),行级重写所有 `baseURL|baseUrl|base_url` 值,CRLF 保持,profiles/credentials/sessions symlink 共享,真实 `~/.dsh` 永不修改。
3. 不做 catalog 注入(无法验证生效 + 污染配置面,砍掉)。
4. 无插件 API,永远 wire 模式。

## 顺带修复

e2e 发现 openai 适配器 emitCompletion 的 usage 缺数字段问题: 上游不发 usage 时 `prompt_tokens: undefined` 被 JSON.stringify 丢弃,合成 chunk 只剩 `{"total_tokens":0}`;dsh 的 mapUsage 对缺失字段算出 NaN/undefined → "non-JSON-serializable" 硬崩。修: `?? 0` 兜底(anthropic/responses 适配器已有守卫,openai 漏了)。
