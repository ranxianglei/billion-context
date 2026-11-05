#!/usr/bin/env node
// Codex 插件的 MCP server 启动器。
//
// Codex 把插件装到 ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/，
// 这个目录里只有插件自身的文件。billion-context 的 MCP 外壳（dist/mcp.js）
// 来自 npm 包或者仓库源码，两者都不在这个目录里，所以这里按优先级探测：
//
//   1) BILI_MCP_ENTRY —— 显式指定 dist/mcp.js 的绝对路径（最高优先级）
//   2) 仓库源码布局：<插件目录>/../../dist/mcp.js（开发检出时优先用本仓库
//      自己的构建，而不是可能过期的全局安装）
//   3) 插件目录自身（dist/mcp.js 就在插件目录里的布局）
//   4) 全局 npm 安装的 billion-context（npm root -g 下的包目录；npm 不在
//      PATH 上时兜底 AppData\npm\node_modules）
//
// 找到之后以 child_process 的 stdio 管道原样转发：Codex 说 JSON-RPC，
// dist/mcp.js 说 JSON-RPC，中间不做任何解析，避免协议漂移。
//
// 必须用 spawn 而不是 import()：dist/mcp.js 里的 stdio 循环只在它
// "作为脚本被直接执行"时启动（见 src/mcp.ts 末尾的 invokedAsScript 守卫），
// 被 import() 加载时它只会导出 runMcpStdio，不会接管 stdin。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 全局 npm root（可能不止一个：nvm / pnpm / yarn 各自一处）。 */
function globalNpmRoots() {
  const roots = [];
  const probe = (cmd, args) => {
    try {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
      const out = (r.stdout || "").trim();
      if (r.status === 0 && out) roots.push(out);
    } catch {
      /* npm 不在 PATH 上是常态，忽略即可 */
    }
  };
  probe("npm", ["root", "-g"]);
  // Windows 上 npm 不在 PATH 时的常见全局安装位置（npm root -g 探针失效的兜底）
  const appData = process.env.APPDATA;
  if (appData) roots.push(path.join(appData, "npm", "node_modules"));
  return roots;
}

function candidates() {
  const out = [];

  const explicit = process.env.BILI_MCP_ENTRY?.trim();
  if (explicit) out.push(explicit);

  // 仓库源码布局：插件目录的上两级是仓库根，dist/mcp.js 在那里
  out.push(path.resolve(HERE, "..", "..", "dist", "mcp.js"));
  // 插件目录自己就是包根（npm 源安装时 dist/mcp.js 在插件目录里）
  out.push(path.join(HERE, "dist", "mcp.js"));

  for (const root of globalNpmRoots()) {
    out.push(path.join(root, "billion-context", "dist", "mcp.js"));
  }

  return out;
}

function resolveEntry() {
  for (const c of candidates()) {
    if (isFile(c)) return c;
  }
  return null;
}

// Codex 启动 MCP server 时给的 cwd 可能是插件目录，也可能不是（不同版本的
// 行为不一样）。mcp-server.mjs 用 import.meta.url 定位自己的位置，所以
// cwd 无关；但 dist/mcp.js 内部会按 cwd 找配置（~/.config/billion-context 等），
// 那里是绝对路径，所以也不受影响。这里只做一件事：把 cwd 钉到插件目录，
// 让相对路径的引用（比如 README、scripts/）在任何宿主下都指向插件自己的文件。
process.chdir(HERE);

const entry = resolveEntry();

if (!entry) {
  // 不能静默退出：Codex 会看到一个"启动了但立刻消失"的 MCP server，
  // 报错信息还指向一个不存在的端口。把缺失说清楚。
  process.stderr.write(
    "[bili-codex] 找不到 billion-context 的 MCP 入口（dist/mcp.js）。\n" +
      "[bili-codex] 已尝试：\n" +
      candidates()
        .map((c) => `  - ${c}`)
        .join("\n") +
      "\n" +
      "[bili-codex] 请安装 CLI：npm install -g billion-context\n" +
      "[bili-codex] 或设置 BILI_MCP_ENTRY 指向 dist/mcp.js 的绝对路径。\n",
  );
  process.exit(1);
}

const child = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

child.on("error", (err) => {
  // spawn 本身失败（极少见）时给一个可定位的报错，而不是裸的未处理事件。
  process.stderr.write(`[bili-codex] 无法启动 MCP 入口 ${entry}: ${err.message}\n`);
  process.exit(1);
});

// stdio 三路直接对接，中间不加任何缓冲或解析。
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      child.kill(sig);
    } catch {
      /* 子进程已经退出 */
    }
  });
}
