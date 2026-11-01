// Child process for tests/multi-instance-live.test.ts — one bili proxy
// instance. The parent spawns TWO of these over the same BILI_SESSIONS_DIR to
// reproduce the #394 two-live-instances shape hermetically (each child has its
// own module-level session pool and its own SessionStore over the shared dir —
// the part one-process tests cannot simulate, because the pool is a
// module singleton).
//
// argv: <upstreamPort>
// env: BILI_SESSIONS_DIR (shared sessions dir), XDG_STATE_HOME (shared state
//      dir — registry lane + tee log), BILI_PERSIST_DEBOUNCE_MS=30 (fast
//      settles).
// stdout: "MI_READY <port>" once listening. Exits on SIGTERM (graceful close).

import { startServer } from "../../src/server.ts";
import type { ProxyOptions } from "../../src/config.ts";
import { defaultConfig } from "acp-kernel";

const upstreamPort = process.argv[2] ?? "";
if (upstreamPort.length === 0) throw new Error("usage: multi-instance-child.ts <upstreamPort>");
const upstream = `http://127.0.0.1:${upstreamPort}`;

const proxy = await startServer({
    port: 0,
    proxy: "",
    proxyFallback: { explicitDirect: true, globalSource: "direct" },
    auxProxyFallback: { explicitDirect: true, globalSource: "direct" },
    host: "127.0.0.1",
    upstream: "http://127.0.0.1",
    routes: { [upstream]: {} },
    modelContextLimit: 200_000,
    kernelConfig: defaultConfig(200_000),
    compress: { injectTool: true, injectNudge: true },
    compat: { roles: {} },
    streamErrorShape: "protocol",
    passthroughSource: null,
    autoRestartOnUpdate: false,
    updateTag: "latest",
    advisoryCheck: false,
    releaseNotesCheck: false,
    promptCache: { routing: "auto" },
    sessionHeader: "x-acp-session",
    log: true,
    // #5012: honor the suite's ACP_LOG_FILE pin ("off" = no file leg) instead
    // of always defaulting to the state-dir log
    logFile: process.env.ACP_LOG_FILE === "off" ? "off" : undefined,
    debug: false,
    passthrough: false,
    autoUpdate: false,
    mitm: { enabled: false, domains: [] },
} as ProxyOptions);

const deadline = Date.now() + 10_000;
for (;;) {
    const a = proxy.address();
    if (a && typeof (a as { port?: number }).port === "number") break;
    if (Date.now() > deadline) throw new Error("child server never bound a port");
    await new Promise((r) => setTimeout(r, 5));
}
const addr = proxy.address() as { port: number };
process.stdout.write(`MI_READY ${addr.port}\n`);

const die = (): void => {
    proxy.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGTERM", die);
process.stdin.on("close", die);
