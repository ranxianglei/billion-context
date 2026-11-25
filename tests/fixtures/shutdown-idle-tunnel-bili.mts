// Child-process fixture for tests/shutdown-idle-tunnel-drain.test.ts: a bili
// server with the CONNECT handler on (mitm enabled, no whitelisted domains, so
// every CONNECT becomes a blind tunnel), in its own process because shutdown
// ends with process.exit(0). argv[2] is the upstream base URL. Prints
// "READY <port>" on stdout once listening; logs go to stderr.
import { defaultConfig } from "acp-kernel";
import { startServer } from "../../src/server.js";
import type { ProxyOptions } from "../../src/config.js";

const opts: ProxyOptions = {
    port: 0,
    host: "127.0.0.1",
    upstream: process.argv[2] ?? "http://127.0.0.1:1",
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
    mitm: { enabled: true, domains: [] },
};
startServer(opts).then((server) => {
    server.on("listening", () => {
        const port = (server.address() as { port: number }).port;
        console.log(`READY ${port}`);
    });
});
