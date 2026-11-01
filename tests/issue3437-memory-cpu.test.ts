/**
 * #3437: GET /__bili/memory must expose cumulative process CPU time
 * (cpuUserNs/cpuSystemNs) plus the core count (cpus) so external samplers can
 * record per-interval CPU deltas alongside the memory fields and normalize
 * against wall time — without OS-specific tooling per platform.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

async function waitReady(port: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: AbortSignal.timeout(500) })).status === 200) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`proxy on port ${port} did not become ready`);
}

interface MemoryProcessFields {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    peakRssBytes: number | null;
    cpuUserNs: number;
    cpuSystemNs: number;
    cpus: number;
}

test("/__bili/memory exposes cumulative CPU time and core count (#3437)", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bili-3437-cpu-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    const prevData = process.env.XDG_DATA_HOME;
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.XDG_DATA_HOME = path.join(tmpRoot, "data");
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1:1",
        routes: {},
        proxy: "",
        proxyMode: "direct",
        proxySource: "direct",
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    };
    let proxy: http.Server | undefined;
    try {
        proxy = await startServer(opts);
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        await waitReady(port);

        const first = (await (await fetch(`http://127.0.0.1:${port}/__bili/memory`)).json()) as { ok: boolean; process: MemoryProcessFields };
        assert.equal(first.ok, true);
        const p = first.process;
        assert.ok(Number.isInteger(p.cpuUserNs) && p.cpuUserNs >= 0, `cpuUserNs is a non-negative integer (got ${p.cpuUserNs})`);
        assert.ok(Number.isInteger(p.cpuSystemNs) && p.cpuSystemNs >= 0, `cpuSystemNs is a non-negative integer (got ${p.cpuSystemNs})`);
        assert.ok(Number.isInteger(p.cpus) && p.cpus >= 1, `cpus names the normalization denominator (got ${p.cpus})`);
        // The sampler contract: counters are cumulative since process start, so
        // a second poll must never read lower (CPU time only accrues).
        const second = (await (await fetch(`http://127.0.0.1:${port}/__bili/memory`)).json()) as { process: MemoryProcessFields };
        assert.ok(second.process.cpuUserNs >= p.cpuUserNs, "cpuUserNs monotone across polls");
        assert.ok(second.process.cpuSystemNs >= p.cpuSystemNs, "cpuSystemNs monotone across polls");
        assert.ok(p.rssBytes > 0 && p.heapUsedBytes > 0 && p.externalBytes >= 0, "pre-existing memory fields intact (additive change only)");

        // #3133 fast-path observability: the sidecar's delta/full ingest split
        // rides the storage payload flat (same convention as verifyDrift) so a
        // retest can confirm steady-state saves ride the O(new-tail) path.
        const status = (await (await fetch(`http://127.0.0.1:${port}/__bili/status`)).json()) as { storage: { sidecarDisabled: boolean; verifyDrift: number; ingests: number; deltaIngests: number } };
        assert.equal(typeof status.storage.sidecarDisabled, "boolean", "pre-existing storage fields intact");
        const s = status.storage;
        assert.ok(Number.isInteger(s.verifyDrift) && s.verifyDrift >= 0, `verifyDrift sane (${s.verifyDrift})`);
        assert.ok(Number.isInteger(s.ingests) && s.ingests >= 0 && Number.isInteger(s.deltaIngests) && s.deltaIngests <= s.ingests, `ingest split sane (delta ${s.deltaIngests} / total ${s.ingests})`);
    } finally {
        if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
        process.env.XDG_STATE_HOME = prevXdg;
        process.env.XDG_DATA_HOME = prevData;
        rmrf(tmpRoot);
    }
});
