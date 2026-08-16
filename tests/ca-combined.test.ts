import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import test from "node:test";
import { combinedCaPath, collectSystemCaPems, ensureRootCA, rootCaPath } from "../src/ca.js";
import { resolveCombinedCaPath } from "../src/launcher.js";

let _tmpHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

test.before(() => {
    _tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ca-combined-"));
    for (const k of ["HOME", "XDG_DATA_HOME", "SSL_CERT_FILE"]) {
        savedEnv[k] = process.env[k];
    }
    process.env.HOME = _tmpHome;
    delete process.env.SSL_CERT_FILE;
});

test.after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    if (_tmpHome) {
        try { fs.rmSync(_tmpHome, { recursive: true, force: true }); } catch { }
    }
});

test("#152: ensureRootCA writes combined-ca.pem with MITM root + public roots", () => {
    ensureRootCA();
    const combined = fs.readFileSync(combinedCaPath(), "utf8");
    const mitmRoot = fs.readFileSync(rootCaPath(), "utf8").trim();
    assert.ok(combined.includes(mitmRoot), "combined bundle must contain the MITM root CA");
    const certCount = combined.split("BEGIN CERTIFICATE").length - 1;
    assert.ok(certCount > 10, `combined bundle must contain public roots (found ${certCount} certs)`);
    assert.ok(combined.includes(tls.rootCertificates[0].trim()), "Node Mozilla roots are merged in (Windows baseline)");
});

test("#152: combined bundle re-merges when the root already exists", () => {
    fs.rmSync(combinedCaPath(), { force: true });
    ensureRootCA();
    assert.ok(fs.existsSync(combinedCaPath()), "existing-CA branch also refreshes the combined bundle");
    const combined = fs.readFileSync(combinedCaPath(), "utf8");
    const mitmRoot = fs.readFileSync(rootCaPath(), "utf8").trim();
    assert.ok(combined.includes(mitmRoot));
});

test("#152: collectSystemCaPems honors SSL_CERT_FILE user bundle first", () => {
    const userBundle = fs.mkdtempSync(path.join(os.tmpdir(), "bili-user-ca-"));
    try {
        const bundlePath = path.join(userBundle, "custom-bundle.pem");
        fs.writeFileSync(bundlePath, tls.rootCertificates[0] + tls.rootCertificates[1]);
        const pems = collectSystemCaPems({ SSL_CERT_FILE: bundlePath } as NodeJS.ProcessEnv);
        assert.equal(pems.length, 1, "user bundle is picked as the system source");
        assert.ok(pems[0].includes("BEGIN CERTIFICATE"));
    } finally {
        try { fs.rmSync(userBundle, { recursive: true, force: true }); } catch { }
    }
});

test("#152: collectSystemCaPems dedupes identical bundles", () => {
    const once = collectSystemCaPems({});
    const twice = collectSystemCaPems({ SSL_CERT_FILE: "/nonexistent/bundle.pem" } as NodeJS.ProcessEnv);
    assert.equal(once.length, twice.length);
});

test("#152: resolveCombinedCaPath mirrors the caDir layout", () => {
    const p = resolveCombinedCaPath({} as NodeJS.ProcessEnv);
    assert.ok(p.endsWith(path.join("billion-context", "ca", "combined-ca.pem")));
    assert.equal(resolveCombinedCaPath({ XDG_DATA_HOME: "/custom/data" } as NodeJS.ProcessEnv),
        path.join("/custom/data", "billion-context", "ca", "combined-ca.pem"));
});
