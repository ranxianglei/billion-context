# billion-context —— Codex 桌面版插件

把 [billion-context](https://github.com/ranxianglei/billion-context) 的上下文压缩
能力装进 Codex 桌面版：小上下文窗口（100K 就够）也能连跑数天、累计数十亿 token。

## 安装

从仓库根目录执行：

```powershell
.\plugins\codex\scripts\install.ps1
```

或者手动执行等价的三步：

```powershell
codex plugin marketplace add ranxianglei/billion-context
codex plugin add billion-context@billion-context
```

装完**重启 Codex**。

> marketplace 必须是 **Git 源**。这是更新检测的前提：只有 Git marketplace 才有
> 版本推进语义，Codex 会把它识别成 `sourceType=git` 并在后台自动拉取上游更新。
> `local` 和 `npm` 源的版本号恒为 `null`，插件页面永远看不到「有更新」。

## 它做了什么

插件注入一个 MCP server（`bili`），提供四个上下文管理工具：

| 工具 | 作用 |
| --- | --- |
| `compress` | 把一段对话折叠成详细摘要 |
| `decompress` | 需要精确细节时把压缩掉的区段还原回来 |
| `search_context` | 在压缩摘要和可见消息里按关键词搜索 |
| `acp_status` | 上下文占用概览，以及还有哪些区段可以压缩 |

压缩由模型自己决定何时触发、压缩什么；被折叠的区段保持摘要、随时可解压还原，
前缀缓存不失效。

## 关于压缩代理

插件负责**工具面**（让 Codex 的模型能调用压缩），压缩的**执行面**在 bili 代理里。
两者分工：

- 只装插件、不跑代理 → 四个工具会出现在 Codex 里，但 `tools/list` 会报
  `bili proxy unreachable …`，因为没有会话被代理。
- 想让压缩真正生效，需要代理在跑：

  ```powershell
  bili start        # 后台代理，监听 8787
  ```

  或者用 `bili codex` 启动 Codex —— 它会同时拉起代理并把 Codex 的流量
  指向代理，压缩与工具一起生效（零配置路线）。

## 更新

Codex 桌面版会自己拉取上游 Git marketplace 的新提交（内置的
`plugins-marketplace-auto-upgrade` 任务）。上游发新版本后：

1. 插件页面的版本号会前进；
2. 点更新（或执行 `codex plugin remove` + `codex plugin add`）即可装上新版本。

版本号以仓库的 `package.json` 为唯一真相源，
`scripts/sync-codex-plugin-version.mjs` 负责把它同步到所有插件清单，
发布流程里已经接了这个校验。

## 排障

**工具列表是空的 / 报 proxy unreachable**

说明 MCP server 起来了但代理没跑。先 `bili start`，再重启 Codex。

**MCP server 起不来**

插件里的 `mcp-server.mjs` 会依次找 `dist/mcp.js`：`BILI_MCP_ENTRY` 环境变量 →
仓库源码布局（`<插件目录>/../../dist/mcp.js`）→ 插件目录自身（`<插件目录>/dist/mcp.js`）
→ 全局 npm 安装目录。全都找不到时它会把已尝试的路径打到 stderr。
这时装一下 CLI 即可：`npm install -g billion-context`。

**插件页面不显示图标**

Codex 从插件目录读 `interface` 字段（显示名、简介、品牌色）。本插件的
`interface` 写在 `.codex-plugin/plugin.json` 里。
