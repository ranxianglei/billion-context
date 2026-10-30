# REQ: Web 面板博客定时从 GitHub master 拉取新文章

**Issue:** #4906 · **Branch:** `2026-10-27_web-blog-github-refresh` · **Date:** 2026-10-27

## 问题

Web 面板博客（`/__bili/blog`，#4587）只渲染随 npm 包冻结的 markdown（`website/blog/posts/*.md`）。master 上新写的文章必须等发版 + self-update 才能在面板出现。Owner 要求：面板能自动从 GitHub 拉新文章。

## 验收标准

1. `GET /__bili/blog` 立即按既有逻辑响应（捆绑底/上次远端快照），随后在后台触发一次节流刷新（默认 1h 窗口）：拉 GitHub `ranxianglei/billion-context` master 的 `website/blog/posts/*.md`（+ 文中引用的图片）。
2. 成功 → 远端条目并入 feed；同 id 时远端覆盖本地捆绑副本；本地独有 id 保留（旧版捆绑内容不丢）。排序沿用现有 newest-first。
3. 图片经现有 `/__bili/blog-assets/<rel>` 路由服务（内存字节），扩展名白名单不变。
4. Fail-soft（与 #3719 changelog 同等纪律）：离线 / HTTP 错误 / 畸形 JSON / 超限大小 → 保留已缓存或本地捆绑内容，feed JSON 带 `error: "offline"`，绝不向调用方抛异常，绝不阻塞请求路径（fire-and-forget）。
5. 无配置键、无 env var、无磁盘缓存文件——访问驱动 + 每进程冷启动一次 warm-up；**另加每小时自驱刷新链**（首次触碰后启动，句柄 unref，事件循环无常驻负担）——owner 2026-10-27 评审后追加：无论有没有人访问，内容不得老于 ~1h。
6. 越界防护：API 返回的路径段不允许 `..`/绝对路径/NUL；下载有 per-file 与总量字节预算、文件数上限；非 `.md` 行跳过。
7. 测试覆盖：合并优先级、节流、fail-soft、路径安全、资产 404 降级、size cap、每小时自驱链（mock 时钟）。typecheck + check:unused-exports + web 测试绿。
8. dsh 内嵌设置面（`src/agent/dsh-native-client.ts`）：tab 栏新增「博客」按钮，位置紧跟「版本」之后（#4906 owner 跟进，2026-10-27）；复用内嵌 frame 的既有 `#/blog` hash 路由，不新增数据通道；旧构建的内嵌页面不认识该路由时自行回落默认页，不会白屏。

## 约束 / 范围外

- 无鉴权 API：GitHub contents API 匿名限速 60/h/IP — 1h 节流在限额内；超限时 fail-soft 回退本地，不重试风暴；每小时自驱链的失败轮成本 ≈ 1 次匿名请求。
- v1 不支持远端 `website/articles.json`（该文件当前在 master 上不存在）；posts-only。
- 不改面板前端渲染逻辑（新文章以既有 JSON 形状自然出现）；不改 `website/` 静态站。
- 不发版、不动 `version`（release 分支专属）。
