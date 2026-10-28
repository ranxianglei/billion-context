# DESIGN: blog GitHub refresh（#4906）

## 模块与依赖方向

- 新文件 `src/web/blog-refresh.ts`：拉取 + 注册。单向依赖 `blogfeed.ts`（复用渲染/排序/资产类型），**不**反向 import，无循环。
- `src/web/blogfeed.ts`（改）：feed 状态从「本地一次性计算」扩展为「本地 + 已注册的远端」：
  - 新增纯函数 `resolveRepoRel(base, target)`（无 fs 的相对路径解析，`..` 不得越过仓库根）+ `collectImageTargets(md, base)`（下载前收集候选图，保证渲染丢图判定与下载集一致）；remote 渲染走 `rewriteImagesFromAssets`（候选 = 已下载集合），disk 路径不变。输出形态一致（`/__bili/blog-assets/<repo-rel>`）。
  - posts 拼装抽成共享的 `postsFromPairs()`（bundled/remote 同一套 slug/date/双语标题逻辑）；新增导出 `buildRemoteBlogPosts(files, assetKeys)` / `registerRemoteBlogFeed(round)` / `getRemoteBlogAsset(rel)`；`getBlogFeed()` = 按 id 去重合并（远端优先）→ newest-first 排序。
  - 资产路由先查内存远端 map（rel → {buf, type}），未命中再走原磁盘路径。
- `src/server/admin.ts`（改）：`/__bili/blog` 路由响应后调 `kickBlogRefresh()`（fire-and-forget，TTL+单飞在模块内部）。
- `src/plugin.ts`（改 1 行）：`/acp` 状态路径紧跟 `warmChangelogOnce()` 旁加 `warmBlogRefreshOnce()` —— 仅冷启动触发（本进程尚无 master 快照时拉一次）；进程已持有 overlay 后，后续状态访问完全不走网络；失败静默。
- `src/agent/dsh-native-client.ts`（改，owner 跟进 2026-10-27）：dsh 内嵌 bili 设置面的 tab 栏在「版本」后加「博客」按钮 —— `PAGE_IDS` 尾部追加 `"blog"` + `PAGE_KEYS`/zh/en 各一条 i18n；点击只改 iframe hash（`#/blog`），零新增数据通道。

## 数据流

```
GET /__bili/blog ──> handleBlogGet(res)          立即响应（bundled 底/上次远端快照）
               └─> kickBlogRefresh()            (fire-and-forget: throttle 1h, inflight 去重, 不 await)
                     │ 1. api.github.com contents: website/blog/posts?ref=master
                     │ 2. raw.githubusercontent.com/<name> 逐个 .md（并发 ≤4，5s/个超时）
                     │ 3. 解析 ![]() 相对引用 → 去重候选（≤50）→ 同样的 raw 下载
                     │ 4. blogfeed 构建 BlogItem[] + assets map
                     └─> registerRemoteBlogFeed(items, error?)   <- 失败时仅记 "offline"
handleBlogGet(res)  <── getBlogFeed(): sort(mergeDedupe(remote ?? [], bundled), remote-wins)
GET /__bili/blog-assets/<rel> -> 远端内存 map 命中 ? buf : 磁盘路径（原逻辑）
```

## 关键取舍

- **每小时自驱链（2026-10-27 owner 要求，覆盖 v1 的纯访问驱动）**：进程第一次碰本模块（博客路由 / status warm / 测试轮）时启动一条每 1h 强拉一轮的链（kick 内部首行自续）。长跑进程即使零访问，服务内容也不会老于 ~1h；句柄 unref，不拖短命 CLI 退出、不进测试事件循环（`_resetBlogRefreshForTest` 会清）；force 保证失败轮也能在下一小时重试（失败轮成本 ≈ 1 次匿名 contents 请求）。
- **不 await 刷新**：changelog 的 handler await 是因为单请求；博客是 1+N 请求，阻塞请求路径最坏可达分钟级。改为非阻塞后台预取——本次加载看到旧内容，下一刷看到新内容，可接受且零回归风险。
- **匿名 API**：与 changelog 一致不申请 token；限额靠 fail-soft 吸收。
- **预算**：md ≤ 512KB/篇、图片 ≤ 2MB/张、总 ≤ 8MB、文件总数 ≤ 200；任一超限 → 放弃本轮远端内容（保留上轮或捆绑），warn 日志（loggerLog，非 console）。
