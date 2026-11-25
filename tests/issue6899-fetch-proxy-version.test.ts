// #6899: fetchProxyVersion appends ` (commit)` to its display string, which
// parseSemVer rejects — so isVersionNewer always returned false and the
// #3544 stale-proxy rotation never fired on the dsh-native attach path.
// The fix keeps the display string for status surfaces and exposes the clean
// semver separately via fetchProxyManifestVersion; the rotation decision
// compares the clean version. The decision-gate regression itself lives in
// tests/issue3544-stale-proxy-rotation.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchProxyManifestVersion, fetchProxyVersion } from "../src/agent/shared.ts";
import { isVersionNewer } from "../src/update.ts";

async function startManifestServer(manifest: unknown): Promise<{ origin: string; close: () => Promise<void> }> {
    const server = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(typeof manifest === "string" ? manifest : JSON.stringify(manifest));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    return {
        origin: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    };
}

test("#6899 fetchProxyManifestVersion exposes the clean semver and the commit separately", async () => {
    const srv = await startManifestServer({ version: "0.1.214", commit: "abc123" });
    try {
        assert.deepEqual(await fetchProxyManifestVersion(srv.origin), { version: "0.1.214", commit: "abc123" });
    } finally {
        await srv.close();
    }
});

test("#6899 fetchProxyVersion keeps the `version (commit)` display string", async () => {
    const srv = await startManifestServer({ version: "0.1.214", commit: "abc123" });
    try {
        assert.equal(await fetchProxyVersion(srv.origin), "0.1.214 (abc123)");
    } finally {
        await srv.close();
    }
});

test("#6899 fetchProxyVersion returns the bare version when the manifest carries no commit", async () => {
    const srv = await startManifestServer({ version: "0.1.214" });
    try {
        assert.equal(await fetchProxyVersion(srv.origin), "0.1.214");
        assert.deepEqual(await fetchProxyManifestVersion(srv.origin), { version: "0.1.214" });
    } finally {
        await srv.close();
    }
});

test("#6899 the rotation comparison runs on the clean version, not the display string", () => {
    // The exact field case from the issue: the resident reports 0.1.214 with
    // a commit suffix while the host runs 0.1.215. The display string can
    // never compare newer (parseSemVer rejects the suffix by design); the
    // clean value compares correctly.
    assert.equal(isVersionNewer("0.1.215", "0.1.214 (abc123)"), false, "display string is unparseable — never compare it");
    assert.equal(isVersionNewer("0.1.215", "0.1.214"), true, "clean semver compares newer");
});

test("#6899 manifest probes soft-fail to undefined on a manifest with no version", async () => {
    const srv = await startManifestServer({ version: "" });
    try {
        assert.equal(await fetchProxyManifestVersion(srv.origin), undefined);
        assert.equal(await fetchProxyVersion(srv.origin), undefined);
    } finally {
        await srv.close();
    }
});
