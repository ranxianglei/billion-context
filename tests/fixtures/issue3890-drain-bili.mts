// Child-process fixture for tests/issue3890-parent-gone-confirm-drain.test.ts:
// a minimal bili server in its OWN process because finishShutdown ends with
// process.exit(0) — an in-process test would kill the runner. Prints
// "READY <port>" on stdout once listening; all bili logs go to stderr
// (logFile: "off"), which the parent test asserts against.
import { defaultConfig } from "acp-kernel";
import { startServer } from "../../src/server.js";
import type { ProxyOptions } from "../../src/config.js";

const opts: ProxyOptions = {
    port: 0,
    host: "127.0.0.1",
    upstream: "http://127.0.0.1:1",
    routes: {},
    modelContextLimit: 400_000,
    kernelConfig: defaultConfig(400_000),
    compress: { injectTool: true, injectNudge: true },
    promptCache: { routing: "auto" },
    sessionHeader: "x-acp-session",
    log: true,
    logFile: "off",
    debug: false,
    passthrough: false,
    autoUpdate: false,
    autoRestartOnUpdate: false,
    advisoryCheck: false,
    releaseNotesCheck: false,
    compat: { roles: {} },
    passthroughSource: null,
    updateTag: "latest",
    mitm: { enabled: false, domains: [] },
};
startServer(opts).then((server) => {
    server.on("listening", () => {
        const port = (server.address() as { port: number }).port;
        console.log(`READY ${port}`);
    });
});
