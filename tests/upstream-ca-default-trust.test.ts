import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, test } from "node:test";
import { ensureRootCA, mintHostCert, pemFingerprint, rootCaPath, _resetForTest as resetCa } from "../src/ca.ts";
import { upstreamExtraCa, _resetUpstreamCaForTest } from "../src/upstream-ca.ts";

const supported = typeof tls.getCACertificates === "function" && typeof tls.setDefaultCACertificates === "function";
const originalDefaults = supported ? tls.getCACertificates("default") : [];
const previousCa = process.env.BILI_CA_FILE;
const previousExtra = process.env.NODE_EXTRA_CA_CERTS;
const directory = mkdtempSync(join(tmpdir(), "bili-default-ca-"));
const additionalFile = join(directory, "additional.pem");
let trustedRoot: string;
let trustedRootFile: string;
let leaf: { keyPem: string; certPem: string };

before(() => {
    if (!supported) return;
    const previousData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = directory;
    try {
        resetCa();
        ensureRootCA();
        trustedRootFile = rootCaPath();
        trustedRoot = readFileSync(trustedRootFile, "utf8");
        leaf = mintHostCert("localhost");
        writeFileSync(additionalFile, tls.rootCertificates[0]!);
    } finally {
        if (previousData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previousData;
        resetCa();
    }
});

afterEach(() => {
    if (supported) tls.setDefaultCACertificates(originalDefaults);
    if (previousCa === undefined) delete process.env.BILI_CA_FILE;
    else process.env.BILI_CA_FILE = previousCa;
    if (previousExtra === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previousExtra;
    _resetUpstreamCaForTest();
});

after(() => rmSync(directory, { recursive: true, force: true }));

function setDefaultTrust(): void {
    tls.setDefaultCACertificates([trustedRoot]);
    delete process.env.NODE_EXTRA_CA_CERTS;
    process.env.BILI_CA_FILE = additionalFile;
    _resetUpstreamCaForTest();
}

async function requestWithConfiguredTrust(): Promise<string> {
    const server = https.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (_request, response) => response.end("trusted default CA"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
        return await new Promise<string>((resolve, reject) => {
            const request = https.get({ hostname: "localhost", port: address.port, ca: upstreamExtraCa(), agent: false, signal: AbortSignal.timeout(3000) }, (response) => {
                let body = "";
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => { body += chunk; });
                response.on("end", () => resolve(body));
                response.on("error", reject);
            });
            request.on("error", reject);
        });
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

test("adding network.caFile preserves CA certificates already in Node's effective default store", { skip: !supported }, () => {
    setDefaultTrust();
    const fingerprints = new Set(upstreamExtraCa()!.map(pemFingerprint));
    assert.ok(fingerprints.has(pemFingerprint(trustedRoot)));
    assert.ok(fingerprints.has(pemFingerprint(tls.rootCertificates[0]!)));
});

test("the merged trust accepts a real HTTPS server signed by a default-only CA", { skip: !supported }, async () => {
    setDefaultTrust();
    assert.equal(await requestWithConfiguredTrust(), "trusted default CA");
});

test("merging an extra CA does not reintroduce bundled roots excluded from default trust", { skip: !supported }, () => {
    setDefaultTrust();
    const fingerprints = new Set(upstreamExtraCa()!.map(pemFingerprint));
    assert.ok(!fingerprints.has(pemFingerprint(tls.rootCertificates[1]!)));
});

test("without network.caFile, native default trust remains untouched", { skip: !supported }, async () => {
    setDefaultTrust();
    delete process.env.BILI_CA_FILE;
    assert.equal(upstreamExtraCa(), undefined);
    assert.equal(await requestWithConfiguredTrust(), "trusted default CA");
});

test("a Linux process started with --use-system-ca retains its SSL_CERT_FILE trust", { skip: !supported || process.platform !== "linux" }, () => {
    const certificateDirectory = join(directory, "empty-certs");
    mkdirSync(certificateDirectory);
    const result = execFileSync(process.execPath, ["--use-system-ca", "--import", "tsx", "--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        import tls from "node:tls";
        import { pemFingerprint } from "./src/ca.ts";
        import { upstreamExtraCa } from "./src/upstream-ca.ts";
        const expected = pemFingerprint(readFileSync(process.env.SSL_CERT_FILE, "utf8"));
        assert.ok(tls.getCACertificates("default").some(pem => pemFingerprint(pem) === expected));
        assert.ok(upstreamExtraCa().some(pem => pemFingerprint(pem) === expected));
        console.log("system CA retained");
    `], {
        cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 10_000,
        env: { ...process.env, SSL_CERT_FILE: trustedRootFile, SSL_CERT_DIR: certificateDirectory, BILI_CA_FILE: additionalFile, NODE_EXTRA_CA_CERTS: "" },
    });
    assert.match(result, /system CA retained/);
});
