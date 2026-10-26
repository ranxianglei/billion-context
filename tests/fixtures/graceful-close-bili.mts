// Child-process fixture for tests/graceful-close.test.ts (#1982): a full bili
// server with MITM enabled for "localhost". It runs in its OWN process because
// NODE_EXTRA_CA_CERTS — which makes the proxy's upstream fetch trust the
// mock-upstream cert signed by bili's test CA — is only read at process
// startup, so an in-process test can never make it take effect. Prints
// "READY <port>" on stdout once listening; all bili logs go to stderr
// (logFile: "off"), which the parent test asserts against.
import { defaultConfig } from "acp-kernel";
import { startServer } from "../../src/server.js";
import type { ProxyOptions } from "../../src/config.js";

const tlsUp = Number(process.env.GC_TLS_UPSTREAM_PORT);
const plainUp = Number(process.env.GC_PLAIN_UPSTREAM_PORT);
if (!Number.isInteger(tlsUp) || !Number.isInteger(plainUp)) {
    console.error("fixture requires GC_TLS_UPSTREAM_PORT and GC_PLAIN_UPSTREAM_PORT");
    process.exit(2);
}
const opts: ProxyOptions = {
    port: 0,
    host: "127.0.0.1",
    upstream: "http://127.0.0.1",
    routes: {
        [`https://localhost:${tlsUp}`]: { models: { "gpt-test": { context: 400_000 } } },
        [`http://127.0.0.1:${plainUp}`]: { models: { "gpt-test": { context: 400_000 } } },
    },
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
    compat: { roles: {} },
    passthroughSource: null,
    autoRestartOnUpdate: false,
    updateTag: "latest",
    mitm: { enabled: true, domains: ["localhost"] },
};
startServer(opts).then((server) => {
    server.on("listening", () => {
        const port = (server.address() as { port: number }).port;
        console.log(`READY ${port}`);
    });
});
