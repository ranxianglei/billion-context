# 迁移到 billion_context_native

本次将原 `billion-claude-recall` / `claude-code-native-recall` 产品与源码入口统一为 `billion_context_native`。这是安装身份迁移，不是数据格式迁移，也不是版本发布；本功能分支不修改版本号。仓库根部 billion-context / `bili`、`src/`、kernel 和已有 provider 配置不在改名范围内。

## 不变的内容

- 功能操作名仍为 `recall_search`、`recall_get`、`recall_status`、`recall_rule`、`compact_ready`。宿主能力边界不变，OpenCode/DSH 不因此获得 Claude Code 的 readiness veto。
- `events.jsonl` 事实记录、schema、host/project/session 身份、immutable locator、来源版本、水位、哈希和游标不因改名而改写。旧工具调用仍是归档中的历史事实，不应批量替换。
- Claude Code 默认存储仍为 `~/.claude/recall`；OpenCode 默认仍为 `.recall-opencode`；所有显式 `archiveHome` 保持原值。原有项目与 session 选择范围也必须保留。
- 迁移不移动、不删除、不重写历史归档，不需要重建档案身份。不要为了“清理旧名”删除存档目录或扩大检索范围。
- 七项共享核心配置 `SOFT`、`STEP`、`HARD`、`HARD_HAIKU`、`HOME`、`PROJECTS`、`CC_VERSION` 优先读取 `BILLION_CONTEXT_NATIVE_` 前缀，未设置时使用对应旧 `RECALL_` 前缀 fallback。迁移时保持值不变；同时设置时新名优先，显式空值也不回退。
- 解释器启动变量是兼容例外：CC hook/MCP 都保留 `RECALL_PYTHON`，没有 `BILLION_CONTEXT_NATIVE_PYTHON` 别名。这样不依赖宿主未保证的嵌套 fallback，也不新增 shell 或破坏 Windows MCP 启动。OpenCode/DSH 的 `python` 配置字段保持不变。

## Claude Code

1. 查看已安装插件及实际 scope（project、local 或 user），记录旧 marketplace 来源、存储路径和设置。先停止加载旧插件的会话，防止旧进程继续运行 hooks。
2. 在原安装 scope 禁用或卸载旧身份。以下示例只适用于原来在 project scope 的安装；其他 scope 必须替换参数，不要无差别修改所有范围：

   ```sh
   claude plugin disable billion-claude-recall@billion-claude-recall-marketplace --scope project
   claude plugin uninstall billion-claude-recall@billion-claude-recall-marketplace --scope project
   ```

   若旧身份被手动改名，以安装列表中的确切 ID 为准。旧 marketplace 只有在没有任何其他安装使用它时才移除：`claude plugin marketplace remove billion-claude-recall-marketplace`。
3. 将完整的新源码放到新路径；入口是含 `.claude-plugin/marketplace.json` 的 `contrib/billion_context_native` 目录。保持原存储位置，从目标项目目录安装到原来选定的 scope：

   ```sh
   claude plugin marketplace add /absolute/path/to/contrib/billion_context_native --scope project
   claude plugin install billion_context_native@billion_context_native --scope project
   ```

4. 确认启用列表只包含新身份，检查实际加载源码与 MCP 工具，再开新会话。旧缓存副本或旧进程不会因为目录改名自动更新，不要让新旧 hooks 并行启用。

插件名与 marketplace 名都为 `billion_context_native`。CC 内部 MCP key 刻意用短名 `native`，避免宿主拼出的工具名超过 64 字符；MCP `serverInfo.name` 仍为 `billion_context_native`。若自行配置过工具权限，应按实际新生成的工具名更新，仅保留原先允许的操作范围。

当前官方 CLI 可加载含下划线的此本地名称，但 `plugin validate` 会对非 kebab-case 给出 warning，`--strict` 可能失败；claude.ai marketplace 同步要求 kebab-case。因此这里提供的是本地 CLI 安装方式，不宣称该名称满足所有 marketplace 发布/同步要求。见 [官方故障排查](https://code.claude.com/docs/en/plugins/troubleshooting) 与 [manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference)。

同名源码迭代应停止会话后按原 scope 卸载并重新安装，再核对加载副本，不以普通 update 命令或未变的版本号推断缓存已刷新。不要为本次功能分支修改版本号；正式版本由独立 release 流程管理。

## OpenCode

停止旧适配器后，把 plugin 路径改为新树下的 `opencode/`，MCP 脚本改为 `plugin/billion_context_native/mcp_server.py`。MCP server key 改成 `billion_context_native`，相应权限命名空间由旧 `recall_*` 改为 `billion_context_native_*`；只允许 `billion_context_native_recall_search` 和 `billion_context_native_recall_get`。使用 [示例配置](opencode/opencode.example.jsonc) 合并这些条目，不覆盖完整宿主配置。

保留 `enabled`、精确 `projects`、原生 `sessions` 和 `archiveHome`；MCP 的 `BILLION_CONTEXT_NATIVE_HOME` 必须指向同一个归档目录，`BILLION_CONTEXT_NATIVE_PROJECTS` 仍应指向空的专用目录。不要把旧档案移动到按新品牌命名的新目录，也不要重新扫描无关 CC transcript。重启后确认只有一个 adapter 与一个相应 MCP server。

## DSH

停止旧 profile 会话，将 patch 中插件源码路径改为新树下的 `dsh/index.mjs`，patch id 改为 `billion_context_native`，移除旧 `recall-native` 条目，而不是追加一个同时加载的新条目。包名与 Cordis 运行时名均为 `billion_context_native`。使用 [DSH 示例](dsh/README.zh-CN.md)，保留原 profile、provider、显式项目/session 和 `archiveHome`；依赖解析要求不变。

## 验证与回退

先核对新安装身份、加载路径、工具列表和原存储目录，再用原有范围中的会话检查搜索与分页读取，确认旧 locator 仍指向同一历史事实。改名前 DeepSeek / 原生压缩测试报告保留原日期与结论，仅证明当时版本。改名后的新真实 DeepSeek 验证尚待完成，结果应单独记录，不能将历史通过当作新验收。详见 [验证边界](VALIDATION.md)。

如需回退，先停止并禁用新安装，再在相同 scope/profile 恢复旧源码和旧配置入口；仍使用原归档路径与权限范围，不删除或还原事实文件，不同时运行两个版本。回退不会补回未被任何适配器观察到的数据。
