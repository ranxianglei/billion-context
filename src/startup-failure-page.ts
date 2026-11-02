// #5096: a launcher-spawned proxy that dies on a fatal startup error (e.g.
// EPERM while writing its own CA/database files) leaves the proxy port with
// NO listener at all — the web UI is unreachable and the only evidence is a
// head-truncated %TEMP% log line. When (and only when) this child was spawned
// by a launcher, hold the port with a minimal failure page: the actual error
// text, a human hint for the filesystem-permission signature, and a 503
// /__bili/health that can never be mistaken for a healthy instance. The
// launcher reclaims us via its spawn-budget kill; we also exit when the
// parent pid dies or after a bounded max hold, so a failed kill can never
// leave this placeholder squatting the port into the next port-ladder round.

import http from "node:http";

const PERMISSION_DENIED_SIGNATURE =
    /\b(?:EPERM|EACCES|EROFS|EBUSY)\b|operation not permitted|permission denied|read-only file system|readonly database/i;
const BILI_DATA_PATH_SIGNATURE =
    /billion-context|combined-ca\.pem|index\.db|\.local[\\/](?:share|state)[\\/]/i;

/** #5096: classify sampled child output for known startup-failure signatures.
 *  Returns "" when nothing matches — the launcher/page then stay silent
 *  rather than guessing. Pure and dependency-free so both the launcher error
 *  path and the failure page share one wording. */
export function classifyStartupFailure(sample: string): string {
    if (!PERMISSION_DENIED_SIGNATURE.test(sample) || !BILI_DATA_PATH_SIGNATURE.test(sample)) return "";
    return "possible cause: the proxy could not write its own data files (EPERM/EACCES/read-only on the bili data dir) — most often antivirus (e.g. Windows Defender Controlled Folder Access) blocking the node runtime, a read-only flag or ACL on the directory, or another process holding the files; add the bili data dir and the node runtime to AV exclusions (see #367) or fix the directory permissions, then retry";
}

const HINT_ZH =
    "大概率是 bili 的数据目录(如 .local/share/billion-context)被系统拦住了:杀毒软件(如 Windows Defender「受控文件夹访问」)拦截 node 进程、目录被设为只读 / ACL 拒绝,或文件被其他进程占用。请把 bili 数据目录和 node 运行时加入杀毒排除项(见 issue #367),或修复目录权限,然后重启会话让 bili 重新拉起。";

interface StartupFailureInfo {
    message: string;
    hint: string;
    hintZh: string;
    lane: string | undefined;
    origin: string;
}

/** #5096: flatten a caught startup error into page-safe fields. fs errors
 *  carry the actionable `code`/`path` pair — keep them in the message. */
export function startupFailureInfo(err: unknown, host: string, port: number): StartupFailureInfo {
    const e = err as { message?: unknown; code?: unknown; path?: unknown } | null;
    const parts: string[] = [];
    const message = typeof e?.message === "string" && e.message.length > 0 ? e.message : String(err);
    parts.push(message);
    if (typeof e?.code === "string" && !message.includes(e.code)) parts.push(`code: ${e.code}`);
    if (typeof e?.path === "string" && !message.includes(e.path)) parts.push(`path: ${e.path}`);
    const flat = parts.join(" | ");
    return {
        message: flat,
        hint: classifyStartupFailure(flat),
        hintZh: HINT_ZH,
        lane: process.env.BILI_LAUNCHER_LANE,
        origin: `http://${host}:${port}/__bili/`,
    };
}

function escapeHtml(s: string): string {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

/** #5096: the served page. Standalone on purpose — no panel assets, no
 *  engine, nothing that can itself fail on a locked data dir. Auto-refresh
 *  so a fixed environment (next successful respawn rebinds this port)
 *  replaces this page with the real panel without user action. */
export function renderStartupFailurePage(info: StartupFailureInfo): string {
    const lane = info.lane ? `拉起通道:${escapeHtml(info.lane)}` : "拉起通道:launcher";
    const hint = info.hint ? `<p class="hint">${escapeHtml(info.hintZh)}</p>` : "";
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>bili 启动失败</title>
<style>
body{font-family:system-ui,sans-serif;background:#16181d;color:#e6e6e6;display:flex;justify-content:center;padding:40px 16px;margin:0}
.card{max-width:720px;width:100%}
h1{font-size:20px;color:#ff8484}
code{display:block;white-space:pre-wrap;word-break:break-all;background:#0d0f13;border:1px solid #2a2e37;border-radius:6px;padding:12px;font-size:13px}
.hint{background:#2b2302;border:1px solid #6b5600;border-radius:6px;padding:12px;font-size:14px}
.meta{color:#8a8f98;font-size:13px;margin-top:16px;line-height:1.6}
</style>
</head>
<body>
<div class="card">
<h1>bili 代理启动失败(端口占位提示页)</h1>
${hint}
<h2>错误信息</h2>
<code>${escapeHtml(info.message)}</code>
<p class="meta">${lane}<br>
本页由 bili 在启动失败后绑定代理端口提供,每 10 秒自动刷新;环境修复、bili 成功启动后,本页会被正常面板自动替换。<br>
详细日志见启动器写入的 bili-proxy-&lt;port&gt;.log(Windows %TEMP% 下)。</p>
</div>
</body>
</html>`;
}

export function createStartupFailureHandler(info: StartupFailureInfo): http.RequestListener {
    return (req, res) => {
        const url = new URL(req.url ?? "/", info.origin);
        if (url.pathname === "/__bili/health") {
            // 503 + ok:false — a probe must never adopt this placeholder as a
            // healthy instance (probeHealth/fetchHealthInfo treat !res.ok as
            // not-bili), it only explains why the port answers at all.
            const body = Buffer.from(
                JSON.stringify({ ok: false, bili: true, status: "startup-failed", error: info.message }),
                "utf8",
            );
            res.writeHead(503, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
            res.end(body);
            return;
        }
        const body = Buffer.from(renderStartupFailurePage(info), "utf8");
        res.writeHead(503, { "content-type": "text/html; charset=utf-8", "content-length": body.length });
        res.end(body);
    };
}

const PARENT_WATCH_INTERVAL_MS = 5_000;
const MAX_HOLD_MS = 10 * 60_000;

/** #5096: hold the port with the failure page when this child was spawned by
 *  a launcher. Resolves false immediately (caller rethrows, normal exit-1
 *  path) when not launcher-spawned or the port cannot be bound; once armed
 *  it never resolves — the process leaves via the parent-pid watch, the
 *  launcher's budget kill, or the bounded max hold, always exit(1). */
export function serveStartupFailurePage(opts: { host: string; port: number }, err: unknown): Promise<boolean> {
    if (!process.env.BILI_LAUNCH_TOKEN) return Promise.resolve(false);
    if (!(opts.port > 0)) return Promise.resolve(false);
    const info = startupFailureInfo(err, opts.host, opts.port);
    return new Promise<boolean>((resolve) => {
        const server = http.createServer(createStartupFailureHandler(info));
        server.once("error", () => resolve(false));
        server.listen(opts.port, opts.host, () => {
            console.error("bili: failed to start:", err);
            console.error(`bili: serving the startup-failure page on ${info.origin} until the launcher reclaims this child (#5096)`);
            const exit = (code: number): void => {
                server.close();
                process.exit(code);
            };
            const parentPid = Number(process.env.BILI_PARENT_PID ?? 0);
            const timers: NodeJS.Timeout[] = [];
            if (parentPid > 0) {
                timers.push(
                    setInterval(() => {
                        try {
                            process.kill(parentPid, 0);
                        } catch {
                            exit(1);
                        }
                    }, PARENT_WATCH_INTERVAL_MS),
                );
            }
            timers.push(setTimeout(() => exit(1), MAX_HOLD_MS));
            for (const t of timers) t.unref();
            process.once("SIGTERM", () => exit(1));
            process.once("SIGINT", () => exit(1));
        });
    });
}
