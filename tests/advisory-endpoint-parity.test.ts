// #2152: the web UI's critical-advisory banner reads d.advisory off /__bili/overview
// (its only data source — client.ts never calls /__bili/status), but sendOverview
// never emitted that field while sendStatus did. The banner was therefore dead code.
// The fix shares one currentAdvisoryPayload() between the two endpoints, so the
// invariant pinned here is PARITY: whatever advisory /__bili/status reports,
// /__bili/overview must report byte-for-byte the same — null when none active,
// the active entry (+targetFailed) otherwise. A future drift re-breaks the banner.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetAdvisoryWatcherForTest, _setAdvisoryStateForTest } from "../src/advisory.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST_ZSTD = "0";

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

interface AdvisoryWire {
    id: string;
    affected: string;
    target: string;
    reason: string;
    currentVersion: string;
    pendingRestart?: boolean;
    installedVersion?: string;
    targetFailed: boolean;
}

type Wire = { advisory: AdvisoryWire | null };

async function fetchWire(port: number, path: string): Promise<Wire> {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(res.status, 200, `${path} answers 200`);
    return (await res.json()) as Wire;
}

test("#2152: /__bili/overview carries the same advisory field as /__bili/status (banner data source)", async () => {
    // Hermetic sessions dir: /__bili/overview walks the disk store, and a missing
    // dir rejects loudly by design (#1937) — on a fresh CI runner the ambient
    // default has never existed, so pin an existing temp dir (#2152 went red).
    const prevSessionsDir = process.env.BILI_SESSIONS_DIR;
    const sessionsDir = mkdtempSync(path.join(tmpdir(), "bili-advisory-parity-"));
    process.env.BILI_SESSIONS_DIR = sessionsDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstreamPort = await freePort(); // never contacted — management endpoints only
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        autoRestartOnUpdate: false,
        updateTag: "latest",
        advisoryCheck: false,
        releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    try {
        _resetAdvisoryWatcherForTest();

        // 1) no advisory active → both surfaces report null (parity), so the
        //    banner stays hidden rather than crashing on a missing key.
        _setAdvisoryStateForTest({});
        let s = await fetchWire(port, "/__bili/status");
        let o = await fetchWire(port, "/__bili/overview");
        assert.equal(o.advisory, null, "overview reports null advisory when none is active");
        assert.deepEqual(o.advisory, s.advisory, "overview/status advisory parity (clean state)");

        // 2) active advisory with a resolvable target → both report the SAME entry,
        //    including the fields the banner renders (id/target/reason) and the
        //    gating flag (targetFailed=false → non-restart branch).
        _setAdvisoryStateForTest({
            active: { id: "bc-2026-001", affected: ">=0.1.155 <0.1.158", target: "0.1.157", reason: "corrupts tool-call arguments", currentVersion: "0.1.156" },
        });
        s = await fetchWire(port, "/__bili/status");
        o = await fetchWire(port, "/__bili/overview");
        assert.ok(o.advisory && o.advisory.id, "overview carries a non-null advisory when one is active");
        assert.deepEqual(o.advisory, s.advisory, "overview/status advisory parity (active)");
        assert.equal(o.advisory!.id, "bc-2026-001");
        assert.equal(o.advisory!.target, "0.1.157");
        assert.equal(o.advisory!.reason, "corrupts tool-call arguments");
        assert.equal(o.advisory!.targetFailed, false);
        assert.ok(!o.advisory!.pendingRestart, "resolvable target takes the non-restart banner branch");

        // 3) active advisory whose pinned target cannot be resolved on the registry
        //    → targetFailed=true on BOTH surfaces (banner falls back to @latest).
        _setAdvisoryStateForTest({
            active: { id: "bc-2026-002", affected: ">=1.0.0", target: "1.0.9", reason: "bad wire rewrite", currentVersion: "1.0.1" },
            lastError: "npm ERR! code E404\nnpm ERR! cannot resolve billion-context@1.0.9",
        });
        s = await fetchWire(port, "/__bili/status");
        o = await fetchWire(port, "/__bili/overview");
        assert.deepEqual(o.advisory, s.advisory, "overview/status advisory parity (unresolvable target)");
        assert.equal(o.advisory!.id, "bc-2026-002");
        assert.equal(o.advisory!.targetFailed, true);
    } finally {
        if (prevSessionsDir === undefined) delete process.env.BILI_SESSIONS_DIR; else process.env.BILI_SESSIONS_DIR = prevSessionsDir;
        rmrf(sessionsDir);
        _setAdvisoryStateForTest({});
        _resetAdvisoryWatcherForTest();
        await close(proxy);
    }
});
