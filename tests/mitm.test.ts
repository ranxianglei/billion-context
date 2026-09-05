import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import net from "node:net";
import { once } from "node:events";
import http from "node:http";
import { isMitmHost, readMitmUpstream, MITM_UPSTREAM_KEY, setupMitm, noteMitmTlsError, _resetCertRejectionWarningForTest } from "../src/mitm.js";
import { ensureRootCA, rootCaPath, getSecureContext, mintHostCert, _resetForTest } from "../src/ca.js";
import { _resetDiscoveryCacheForTest } from "../src/discover.js";

// isMitmHost now calls discoverMitmDomains(), which reads real client config
// files. Isolate discovery to an empty temp HOME so the isMitmHost assertions
// are deterministic (only DEFAULT_MITM_DOMAINS apply, no discovered hosts).
const _discoverySavedEnv: Record<string, string | undefined> = {};
let _discoveryTmpHome: string | undefined;

test.before(() => {
    _discoveryTmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mitm-disc-"));
    for (const k of ["HOME", "CODEX_HOME", "ZCODE_DATA_BASE_DIR", "PI_CODING_AGENT_DIR", "PI_HOME"]) {
        _discoverySavedEnv[k] = process.env[k];
    }
    process.env.HOME = _discoveryTmpHome;
    process.env.CODEX_HOME = path.join(_discoveryTmpHome, ".codex");
    process.env.ZCODE_DATA_BASE_DIR = path.join(_discoveryTmpHome, ".zcode");
    process.env.PI_CODING_AGENT_DIR = path.join(_discoveryTmpHome, ".pi");
    _resetDiscoveryCacheForTest();
});

test.after(() => {
    for (const [k, v] of Object.entries(_discoverySavedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    _resetDiscoveryCacheForTest();
    if (_discoveryTmpHome) {
        try { fs.rmSync(_discoveryTmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

// Isolate the CA directory to a per-test tmp dir so we never touch the real
// ~/.local/share/billion-context/ca. caDir() = dataDir()/ca =
// XDG_DATA_HOME/billion-context/ca.
async function withTmpCa<T>(fn: () => Promise<T> | T): Promise<T> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bili-mitm-"));
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = tmp;
    _resetForTest();
    try {
        // MUST await: a bare `return fn()` lets the finally below run as soon
        // as an async fn suspends — restoring XDG_DATA_HOME and wiping the CA
        // state while the test body is still running.
        return await fn();
    } finally {
        if (prev === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prev;
        _resetForTest();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

test("isMitmHost: matches the built-in whitelist exactly", () => {
    assert.equal(isMitmHost("open.bigmodel.cn"), false);
    assert.equal(isMitmHost("api.anthropic.com"), true);
    assert.equal(isMitmHost("api.openai.com"), true);
    assert.equal(isMitmHost("chatgpt.com"), true);
});

test("isMitmHost: matches subdomains via suffix", () => {
    // A subdomain of a whitelisted apex should also be MITM'd (providers shard
    // traffic across subdomains, e.g. edge.chatgpt.com).
    assert.equal(isMitmHost("edge.chatgpt.com"), true);
    assert.equal(isMitmHost("coding.api.anthropic.com"), true);
});

test("isMitmHost: rejects unknown hosts and suffix-spoofing", () => {
    assert.equal(isMitmHost("evil.com"), false);
    assert.equal(isMitmHost("example.com"), false);
    // Critical: "open.bigmodel.cn.evil.com" must NOT match — it ends with the
    // apex but is a distinct host. The suffix check is "." + domain, which
    // prevents this attack.
    assert.equal(isMitmHost("open.bigmodel.cn.evil.com"), false);
    assert.equal(isMitmHost("notchatgpt.com"), false);
});

test("isMitmHost: honors extra domains from config", () => {
    assert.equal(isMitmHost("foo.com", ["foo.com"]), true);
    assert.equal(isMitmHost("sub.foo.com", ["foo.com"]), true);
    assert.equal(isMitmHost("bar.com", ["foo.com"]), false);
    // Case-insensitive
    assert.equal(isMitmHost("FOO.COM", ["foo.com"]), true);
});

test("isMitmHost: is case-insensitive on the host", () => {
    assert.equal(isMitmHost("CHATGPT.COM"), true);
    assert.equal(isMitmHost("Api.Anthropic.Com"), true);
});

await test("ensureRootCA: generates a PEM cert + key on first call", async () => {
    await withTmpCa(async () => {
        ensureRootCA();
        const p = rootCaPath();
        assert.ok(fs.existsSync(p), "root CA cert file should exist");
        const pem = fs.readFileSync(p, "utf8");
        assert.ok(pem.includes("BEGIN CERTIFICATE"), "should be a PEM certificate");
        // Private key file lives next to it (0600 perms for secrecy).
        const keyPath = path.join(path.dirname(p), "root-ca-key.pem");
        assert.ok(fs.existsSync(keyPath), "root CA key file should exist");
        const keyPem = fs.readFileSync(keyPath, "utf8");
        assert.ok(keyPem.includes("BEGIN PRIVATE KEY") || keyPem.includes("BEGIN RSA PRIVATE KEY"));
        // Key must NOT be world-readable.
        if (process.platform !== "win32") {
            const mode = (fs.statSync(keyPath).mode & 0o777);
            assert.equal(mode & 0o077, 0, `key file mode ${mode.toString(8)} leaks group/other bits`);
        }
    });
});

await test("ensureRootCA: is idempotent across calls (reuses existing CA)", async () => {
    await withTmpCa(async () => {
        ensureRootCA();
        const first = fs.readFileSync(rootCaPath(), "utf8");
        // Second call must NOT regenerate — the same cert keeps already-trusted
        // installs valid across restarts.
        ensureRootCA();
        const second = fs.readFileSync(rootCaPath(), "utf8");
        assert.equal(first, second, "root CA cert must be stable across ensureRootCA calls");
    });
});

await test("getSecureContext: returns a usable SecureContext", async () => {
    await withTmpCa(async () => {
        ensureRootCA();
        const ctx = getSecureContext("open.bigmodel.cn");
        assert.ok(ctx, "should return a SecureContext");
    });
});

await test("#535: MITM certs satisfy strict OpenSSL 3 chain verification (Python/hermes)", async () => {
    await withTmpCa(async () => {
        ensureRootCA();
        const forge = (await import("node-forge")).default;
        const root = forge.pki.certificateFromPem(fs.readFileSync(rootCaPath(), "utf8"));
        const rootBc = root.getExtension("basicConstraints");
        assert.ok(rootBc, "root has basicConstraints");
        assert.equal(rootBc.critical, true, "CA basicConstraints must be critical (python OpenSSL 3 rejects otherwise)");
        const rootSkiHex = root.generateSubjectKeyIdentifier().toHex();
        assert.match(rootSkiHex, /^[0-9a-f]{40}$/i, "root SKI is a sha1 key id");
        const leaf = forge.pki.certificateFromPem(mintHostCert("api.openai.com").certPem);
        const aki = leaf.getExtension("authorityKeyIdentifier");
        assert.ok(aki, "leaf has authorityKeyIdentifier (python OpenSSL 3 rejects without)");
        assert.ok(aki.value.includes(forge.util.hexToBytes(rootSkiHex)), "leaf AKI carries the root SKI (forge keeps parsed AKI as raw DER)");
        assert.ok(leaf.getExtension("subjectKeyIdentifier"), "leaf has subjectKeyIdentifier");
        const verified = root.verify(leaf);
        assert.ok(verified, "leaf is really signed by the root");
    });
});

await test("getSecureContext: caches per host (same object on repeat)", async () => {
    await withTmpCa(async () => {
        ensureRootCA();
        const a = getSecureContext("api.openai.com");
        const b = getSecureContext("api.openai.com");
        assert.equal(a, b, "same host must return the cached SecureContext");
        const c = getSecureContext("api.anthropic.com");
        assert.notEqual(a, c, "different host must get a distinct context");
    });
});

test("readMitmUpstream: reads the socket marker when set", () => {
    const fakeSocket = {} as unknown as import("node:net").Socket;
    (fakeSocket as unknown as Record<string, unknown>)[MITM_UPSTREAM_KEY] = "https://open.bigmodel.cn";
    assert.equal(readMitmUpstream(fakeSocket), "https://open.bigmodel.cn");
});

test("readMitmUpstream: returns undefined when no marker (direct /bili/ request)", () => {
    const fakeSocket = {} as unknown as import("node:net").Socket;
    assert.equal(readMitmUpstream(fakeSocket), undefined);
    assert.equal(readMitmUpstream(undefined), undefined);
});

// ---------------------------------------------------------------------------
// e2e CONNECT tests (#77 gate, #118 handshake timeout, happy path)
// ---------------------------------------------------------------------------

/** Send a raw CONNECT and resolve once the status line is received. */
function rawConnect(port: number, host: string, connectTo: string): Promise<{ statusLine: string; socket: net.Socket }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ statusLine: string; socket: net.Socket }>();
    const socket = net.connect(port, host, () => {
        socket.write(`CONNECT ${connectTo} HTTP/1.1\r\nHost: ${connectTo}\r\n\r\n`);
    });
    let buf = "";
    const onData = (chunk: Buffer): void => {
        buf += chunk.toString("utf8");
        if (buf.includes("\r\n\r\n")) {
            socket.off("data", onData);
            resolve({ statusLine: buf.slice(0, buf.indexOf("\r\n")), socket });
        }
    };
    socket.on("data", onData);
    socket.once("error", reject);
    return promise;
}

await test("setupMitm e2e: CONNECT → TLS handshake → decrypted request reaches http server", async () => {
    await withTmpCa(async () => {
        let sawMarker: string | undefined;
        const server = http.createServer((req, res) => {
            sawMarker = readMitmUpstream(req.socket as unknown as tls.TLSSocket);
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("mitm-ok");
        });
        setupMitm(server, [], (msg) => { /* silent */ });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            const { statusLine, socket } = await rawConnect(port, "127.0.0.1", "api.anthropic.com:443");
            assert.match(statusLine, /^HTTP\/1\.1 200/);
            const tlsSock = tls.connect({ socket, rejectUnauthorized: false, servername: "api.anthropic.com" });
            const { promise: bodyPromise, resolve: resolveBody, reject: rejectBody } = Promise.withResolvers<string>();
            let out = "";
            tlsSock.on("secureConnect", () => {
                tlsSock.write("GET /probe HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: close\r\n\r\n");
            });
            tlsSock.on("data", (c: Buffer) => { out += c.toString("utf8"); });
            tlsSock.on("close", () => resolveBody(out));
            tlsSock.once("error", rejectBody);
            const body = await bodyPromise;
            assert.match(body, /mitm-ok/);
            assert.equal(sawMarker, "https://api.anthropic.com", "decrypted request must carry the MITM upstream marker");
        } finally {
            server.close();
            server.closeAllConnections?.();
        }
    });
});

await test("setupMitm e2e: idle tunnel after CONNECT is killed by the handshake timeout (#118)", async () => {
    await withTmpCa(async () => {
        const server = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
        setupMitm(server, [], () => { /* silent */ });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        process.env.BILI_MITM_HANDSHAKE_TIMEOUT_MS = "200";
        try {
            const { statusLine, socket } = await rawConnect(port, "127.0.0.1", "api.anthropic.com:443");
            assert.match(statusLine, /^HTTP\/1\.1 200/);
            // Never send the TLS ClientHello — the slowloris pattern. This test
            // deliberately exercises a REAL timer (the server-side handshake
            // timeout): deterministic clock control cannot cross the process
            // boundary, so we await the close event with a generous bound.
            const closed = Promise.withResolvers<void>();
            socket.once("close", () => closed.resolve());
            const bail = setTimeout(() => closed.resolve(), 3000);
            await closed.promise;
            clearTimeout(bail);
            assert.equal(socket.destroyed, true, "socket must be destroyed by the handshake timeout");
        } finally {
            delete process.env.BILI_MITM_HANDSHAKE_TIMEOUT_MS;
            server.close();
            server.closeAllConnections?.();
        }
    });
});

await test("setupMitm e2e: remote CONNECT policy (#77, #240)", async (t) => {
    // The test client's remoteAddress is only non-loopback if we connect via a
    // real LAN address of this host. Skip when the box has none (some CI).
    const lanAddr = Object.values(os.networkInterfaces())
        .flat()
        .find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lanAddr) return t.skip("no non-loopback IPv4 address available");
    await withTmpCa(async () => {
        // Gate stays closed when allowRemoteClients is not opted in (default:
        // loopback-only proxy) — the #77 regression.
        const strictServer = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
        setupMitm(strictServer, [], () => { /* silent */ });
        strictServer.listen(0, lanAddr.address);
        await once(strictServer, "listening");
        const strictPort = (strictServer.address() as { port: number }).port;
        try {
            const { statusLine } = await rawConnect(strictPort, lanAddr.address, "api.anthropic.com:443");
            assert.match(statusLine, /^HTTP\/1\.1 403/);
        } finally {
            strictServer.close();
            strictServer.closeAllConnections?.();
        }

        // Non-loopback --host opts in (#240): whitelisted model hosts accept
        // remote CONNECT, everything else stays 403 (no open TCP relay).
        const openServer = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
        setupMitm(openServer, [], () => { /* silent */ }, undefined, true);
        openServer.listen(0, lanAddr.address);
        await once(openServer, "listening");
        const openPort = (openServer.address() as { port: number }).port;
        try {
            const whitelisted = await rawConnect(openPort, lanAddr.address, "api.anthropic.com:443");
            assert.match(whitelisted.statusLine, /^HTTP\/1\.1 200/, "remote client + whitelisted host must be MITM'd");
            whitelisted.socket.destroy();
            const other = await rawConnect(openPort, lanAddr.address, "example.com:443");
            assert.match(other.statusLine, /^HTTP\/1\.1 403/, "remote client + non-whitelisted host must be refused");
        } finally {
            openServer.close();
            openServer.closeAllConnections?.();
        }
    });
});

await test("setupMitm e2e: blind TCP tunnel to a non-whitelisted host passes bytes both ways (#346)", async () => {
    await withTmpCa(async () => {
        const upstream = net.createServer((sock) => {
            sock.on("data", (c) => sock.write("UPSTREAM-SAW:" + c.toString("utf8")));
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upPort = (upstream.address() as { port: number }).port;

        const logs: string[] = [];
        const server = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
        setupMitm(server, [], (msg) => { logs.push(msg); });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const port = (server.address() as { port: number }).port;
        try {
            // 127.0.0.1 is an IP, not a domain → isMitmHost is false → blind tunnel.
            const { statusLine, socket } = await rawConnect(port, "127.0.0.1", `127.0.0.1:${upPort}`);
            assert.match(statusLine, /^HTTP\/1\.1 200/, "blind tunnel must answer CONNECT with 200");
            const reply = Promise.withResolvers<string>();
            let out = "";
            let settled = false;
            socket.on("data", (c: Buffer) => {
                out += c.toString("utf8");
                if (!settled && out.includes("UPSTREAM-SAW:")) { settled = true; reply.resolve(out); }
            });
            socket.once("close", () => { if (!settled) reply.reject(new Error("tunnel closed before reply")); });
            socket.write("hello-zcode");
            const body = await reply.promise;
            assert.match(body, /UPSTREAM-SAW:hello-zcode/, "bytes must flow client→tunnel→upstream and back");
            assert.ok(
                logs.some((l) => /tunnel .* established \(blind TCP, not decrypted\)/.test(l)),
                "established blind tunnel must be logged for diagnostics",
            );
            socket.destroy();
        } finally {
            server.close();
            server.closeAllConnections?.();
            upstream.close();
            upstream.closeAllConnections?.();
        }
    });
});

// A real client (e.g. ZCode, #346) that does not trust the root CA sends a
// TLS "certificate unknown" alert; the handler must turn that into exactly ONE
// actionable "install the root CA" warning, deduplicated across the hundreds
// of identical failures a single misconfigured client produces.
test("noteMitmTlsError: cert-rejection alert → one actionable CA warning, deduplicated (#346)", () => {
    _resetCertRejectionWarningForTest();
    const logs: string[] = [];
    const log = (msg: string) => { logs.push(msg); };
    const realAlert = "705F0000:error:0A000416:SSL routines:ssl3_read_bytes:ssl/tls alert certificate unknown:openssl\\ssl\\record\\rec_layer_s3.c:918:SSL alert number 46";
    noteMitmTlsError("api.anthropic.com", 443, realAlert, log);
    noteMitmTlsError("api.anthropic.com", 443, "ssl/tls alert certificate unknown", log);
    noteMitmTlsError("api.anthropic.com", 443, "ssl/tls alert unknown ca", log);
    const warnings = logs.filter((l) => l.includes("REJECTED the MITM certificate"));
    assert.equal(warnings.length, 1, `expected exactly one CA warning, got ${warnings.length}: ${JSON.stringify(logs)}`);
    assert.match(warnings[0], /root-ca\.pem/, "warning must point at the root CA file path");
    assert.equal(logs.filter((l) => l.includes("TLS error")).length, 3, "the raw TLS error line is always logged");
});

test("noteMitmTlsError: non-cert TLS errors (reset/close) do NOT trigger the CA warning", () => {
    _resetCertRejectionWarningForTest();
    const logs: string[] = [];
    const log = (msg: string) => { logs.push(msg); };
    noteMitmTlsError("api.anthropic.com", 443, "socket hang up", log);
    noteMitmTlsError("api.anthropic.com", 443, "read ECONNRESET", log);
    assert.equal(logs.filter((l) => l.includes("REJECTED the MITM certificate")).length, 0);
    assert.equal(logs.length, 2, "raw TLS error lines still logged");
});
