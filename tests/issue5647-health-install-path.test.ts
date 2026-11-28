import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { INSTALL_PATH, VERSION } from "../src/version.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

process.env.NODE_ENV = "test";

// #5647 item 5: `bili --version` said 0.1.211 while /__bili/health said
// 0.1.212 — a report citing one build about another. version+commit already
// identify the RUNNING copy; installPath now identifies WHICH install serves
// it, so a skew can be located instead of guessed.

function opts(): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {},
        modelContextLimit: 100_000,
        kernelConfig: defaultConfig(100_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        streamErrorShape: "protocol",
        passthroughSource: null,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        mitm: { enabled: false, domains: [] },
    };
}

test("INSTALL_PATH resolves to the running copy's package root (#5647)", () => {
    assert.ok(typeof INSTALL_PATH === "string" && INSTALL_PATH.length > 0, "package root resolved");
    const pkgFile = join(INSTALL_PATH, "package.json");
    assert.ok(existsSync(pkgFile), "root holds its package.json");
    const name = (JSON.parse(readFileSync(pkgFile, "utf8")) as { name?: string }).name;
    assert.equal(name, "billion-context", "it is THIS package's root, not an ancestor's");
});

test("/__bili/health reports installPath alongside version and commit (#5647)", async () => {
    setRegistryForTest({});
    _setStoreForTest(new SessionStore({ enabled: false }));
    const proxy = await startServer(opts());
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    try {
        // #2941: health answers 503 {reason:"starting"} until boot registration
        // completes — poll like every other health consumer does.
        let r: Response | undefined;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            r = await fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: AbortSignal.timeout(2000) });
            if (r.status === 200) break;
            r.body?.cancel();
            await new Promise((res) => setTimeout(res, 250));
        }
        assert.ok(r && r.status === 200, `health never reached 200 (last status ${r?.status})`);
        const body = (await r.json()) as Record<string, unknown>;
        assert.equal(body.ok, true);
        // Shape regression guard: the pre-existing identity fields stay.
        assert.equal(body.version, VERSION);
        assert.equal(typeof body.commit, "string");
        assert.equal(body.installPath, INSTALL_PATH, "install path identifies the serving copy");
        assert.ok(existsSync(join(String(body.installPath), "package.json")), "reported path really holds the running package");
    } finally {
        await new Promise<void>((r2) => proxy.close(() => r2()));
    }
});
