import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import test from "node:test";
import { combinedCaPath, collectOsStorePems, collectSystemCaPems, decodeOsStoreOutput, ensureRootCA, osStoreExecOptions, osStorePowerShellScript, parseOsStoreNdjson, pemFingerprint, rootCaPath, wrapDerPem } from "../src/ca.js";
import { resolveCombinedCaPath } from "../src/launcher.js";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

let _tmpHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

test.before(() => {
    _tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-ca-combined-"));
    for (const k of ["HOME", "XDG_DATA_HOME", "SSL_CERT_FILE"]) {
        savedEnv[k] = process.env[k];
    }
    process.env.HOME = _tmpHome;
    // caDir() resolves through XDG_DATA_HOME (checked before os.homedir()); on
    // Windows HOME does NOT affect homedir(), so without this the CA dir leaks
    // into the real profile dir and races other files' parallel MITM startups.
    process.env.XDG_DATA_HOME = path.join(_tmpHome, "data");
    delete process.env.SSL_CERT_FILE;
});

test.after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    if (_tmpHome) {
        try { rmrf(_tmpHome); } catch { }
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
        try { rmrf(userBundle); } catch { }
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

const b64Of = (pem: string): string => pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");

test("#1807: wrapDerPem round-trips a real root cert at 64 columns", () => {
    const b64 = b64Of(tls.rootCertificates[0]);
    const wrapped = wrapDerPem(b64);
    const lines = wrapped.trim().split("\n");
    assert.equal(lines[0], "-----BEGIN CERTIFICATE-----");
    assert.equal(lines[lines.length - 1], "-----END CERTIFICATE-----");
    const body = lines.slice(1, -1);
    for (const l of body.slice(0, -1)) assert.equal(l.length, 64);
    assert.ok(body[body.length - 1].length > 0 && body[body.length - 1].length <= 64, "final base64 line is a short tail");
    assert.equal(b64Of(wrapped), b64);
});

test("#1807: pemFingerprint dedupes across wrappings, separates distinct certs", () => {
    const b64a = b64Of(tls.rootCertificates[0]);
    const altWrap = (b64: string) => `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,32}/g)!.join("\n")}\n-----END CERTIFICATE-----`;
    assert.equal(pemFingerprint(tls.rootCertificates[0]), pemFingerprint(altWrap(b64a)));
    assert.notEqual(pemFingerprint(tls.rootCertificates[0]), pemFingerprint(altWrap(b64Of(tls.rootCertificates[1]))));
});

test("#1807: parseOsStoreNdjson skips junk/malformed lines and tolerates CRLF", () => {
    const b64 = b64Of(tls.rootCertificates[0]);
    const out = `{"d":"${b64}"}\r\ngarbage line\r\nnot json at all\r\n{"d":""}\r\n{"nope":1}\r\n{"d":"${b64}"}\r\n`;
    const pems = parseOsStoreNdjson(out);
    assert.equal(pems.length, 2);
    assert.equal(pems[0], wrapDerPem(b64));
});

test("#1807: decodeOsStoreOutput handles UTF-16LE PowerShell pipes", () => {
    const text = '{"d":"QUJDRA=="}';
    assert.equal(decodeOsStoreOutput(Buffer.from(text, "utf8")), text);
    assert.equal(decodeOsStoreOutput(Buffer.from(text, "utf16le")), text);
});

test("#1807: osStorePowerShellScript covers both Root stores without interpolation leaks", () => {
    const s = osStorePowerShellScript();
    assert.ok(s.includes("X509Store('Root'"));
    assert.ok(s.includes("'LocalMachine','CurrentUser'"));
    assert.ok(!s.includes("${"));
});

test("#2439: the OS-store export spawns powershell hidden (GUI hosts flash a console otherwise)", () => {
    const opts = osStoreExecOptions();
    assert.equal(opts.windowsHide, true, "an unhidden console child makes Windows allocate a console window");
    assert.equal(opts.timeout, 30_000);
    assert.equal(opts.maxBuffer, 16 * 1024 * 1024);
    // #2834: explicit stdio — stderr stays piped so the warn log keeps the error text.
    assert.deepEqual([...opts.stdio], ["ignore", "pipe", "pipe"]);
});

test("#1807: collectOsStorePems degrades to [] where the platform tooling is absent", () => {
    assert.deepEqual(collectOsStorePems("linux"), [], "linux has no OS-store source");
    if (process.platform !== "win32") assert.deepEqual(collectOsStorePems("win32"), [], "no powershell off-Windows");
    if (process.platform !== "darwin") assert.deepEqual(collectOsStorePems("darwin"), [], "no security(1) off-macOS");
    // On a native host the real store IS reachable — exercise the production
    // export path end-to-end (PS script + decode + parse on win32, security(1) on darwin).
    if (process.platform === "win32" || process.platform === "darwin") {
        const pems = collectOsStorePems();
        assert.ok(pems.length > 0, `native ${process.platform} OS-store export returned no certs`);
        for (const pem of pems) assert.ok(pem.startsWith("-----BEGIN CERTIFICATE-----"));
    }
});

test("#1807: combined bundle reused while fresh, rebuilt when stale or CA-missing", () => {
    ensureRootCA();
    const file = combinedCaPath();
    const mitmRoot = fs.readFileSync(rootCaPath(), "utf8").trim();
    const future = new Date(Date.now() + 3600e3);
    fs.utimesSync(file, future, future);
    const before = fs.statSync(file).mtimeMs;
    ensureRootCA();
    assert.equal(fs.statSync(file).mtimeMs, before, "fresh bundle carrying the MITM CA is NOT rewritten");

    const stale = new Date(Date.now() - 25 * 3600e3);
    fs.utimesSync(file, stale, stale);
    ensureRootCA();
    assert.notEqual(fs.statSync(file).mtimeMs, stale.getTime(), "stale (>24h) bundle is rebuilt");
    assert.ok(fs.readFileSync(file, "utf8").includes(mitmRoot), "rebuilt bundle carries the MITM CA");

    fs.writeFileSync(file, "-----BEGIN CERTIFICATE-----\n" + Buffer.from("junk").toString("base64") + "\n-----END CERTIFICATE-----\n");
    const freshButWrong = new Date(Date.now() + 3600e3);
    fs.utimesSync(file, freshButWrong, freshButWrong);
    ensureRootCA();
    assert.ok(fs.readFileSync(file, "utf8").includes(mitmRoot), "fresh file missing the MITM CA is rebuilt");
});

// #5103: a forced power loss left the DSH child dying on EPERM at the combined
// bundle rewrite (the file was >24h old, so every startup re-merged it). The
// rebuild must degrade to REUSING an existing valid bundle instead of bricking
// the whole proxy — but only when that bundle still carries our root CA.

test("#5103: write-refused rebuild reuses an existing bundle that carries the MITM root", (t) => {
    if (process.getuid?.() === 0) {
        t.skip("root bypasses permission bits — cannot simulate the OS write refusal");
        return;
    }
    ensureRootCA();
    const file = combinedCaPath();
    const before = fs.readFileSync(file, "utf8");
    const stale = new Date(Date.now() - 25 * 3600e3);
    fs.utimesSync(file, stale, stale); // force the rebuild branch
    fs.chmodSync(file, 0o444); // EACCES on POSIX / EPERM on win32 at open-for-write
    const captured: Array<{ level: string; msg: string }> = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    let threw: unknown;
    try {
        try { ensureRootCA(); } catch (err) { threw = err; }
        assert.equal(threw, undefined, "a usable existing bundle must absorb the write refusal");
        assert.equal(fs.readFileSync(file, "utf8"), before, "the existing bundle is left untouched");
        const warn = captured.find((c) => c.level === "warn" && c.msg.includes("cannot rebuild"));
        assert.ok(warn, "the reuse must be announced loudly (not silent degradation)");
        assert.ok(warn!.msg.includes("continuing with the EXISTING bundle"), warn.msg);
        assert.ok(warn!.msg.includes("antivirus"), "must point at the AV-exclusion remedy");
    } finally {
        setLogCapture(null);
        fs.chmodSync(file, 0o644);
    }
});

test("#5103: write-refused rebuild with NO usable bundle still fails fast", (t) => {
    if (process.getuid?.() === 0) {
        t.skip("root bypasses permission bits — cannot simulate the OS write refusal");
        return;
    }
    ensureRootCA();
    const file = combinedCaPath();
    fs.writeFileSync(file, "-----BEGIN CERTIFICATE-----\n" + Buffer.from("junk").toString("base64") + "\n-----END CERTIFICATE-----\n");
    const stale = new Date(Date.now() - 25 * 3600e3);
    fs.utimesSync(file, stale, stale);
    fs.chmodSync(file, 0o444);
    let threw: unknown;
    try {
        try { ensureRootCA(); } catch (err) { threw = err; }
    } finally {
        fs.chmodSync(file, 0o644);
    }
    assert.ok(threw instanceof Error, "no reusable bundle — the refusal must stay fatal");
    const code = (threw as NodeJS.ErrnoException).code;
    assert.match(String(code ?? ""), /EACCES|EPERM/, `expected a permission errno, got ${String(code)}`);
    // leave the shared tmp home in a healthy state for any later test
    ensureRootCA();
});
