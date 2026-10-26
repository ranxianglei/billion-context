import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import * as tls from "node:tls";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.js";
import type { ProxyOptions } from "../src/config.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { setLogCapture } from "../src/logger.js";
import { describeUpstreamFailure, formatUpstreamError } from "../src/upstream-proxy.js";
import {
    TLS_TRUST_CODES,
    isTlsTrustCode,
    tlsTrustRemediation,
    withUpstreamFailure,
    upstreamFailureOf,
} from "../src/upstream-fail.js";
import { upstreamCaIdentity, upstreamExtraCa, _resetUpstreamCaForTest } from "../src/upstream-ca.js";
import { recordUpstreamCircuitFailure, recordUpstreamCircuitSuccess, upstreamCircuitLastFailureKind, _resetUpstreamCircuitsForTest } from "../src/upstream-alerts.js";
import { _resetFetchUtilForTest } from "../src/fetch-util.js";
import { ensureRootCA, rootCaPath, mintHostCert, _resetForTest as _resetCaForTest } from "../src/ca.js";

// #3776: security software doing HTTPS scanning (Kaspersky / corporate DLP) MITMs the
// upstream; Node's default trust (built-ins + NODE_EXTRA_CA_CERTS) ignores the OS cert
// store, so bili's own fetch dies with SELF_SIGNED_CERT_IN_CHAIN and the client only ever
// saw a generic 502. These tests pin the three fixes: (1) trust-code TLS failures carry a
// concrete remediation hint on every channel, (2) network.caFile/BILI_CA_FILE merges an
// extra root into bili's own fetch trust, (3) the 502 body carries a machine-readable
// upstreamFailure{kind,code,hint} so users can self-diagnose without reading bili.log.

const tmpRoot = process.env.TMPDIR && fs.existsSync(process.env.TMPDIR) ? process.env.TMPDIR : os.tmpdir();
function mkTmp(prefix: string): string { return fs.mkdtempSync(path.join(tmpRoot, prefix)); }

function netError(code: string, message: string, cause?: Error): Error {
    const err = new Error(message) as NodeJS.ErrnoException & { cause?: unknown };
    err.code = code;
    if (cause) err.cause = cause;
    return err;
}

// --- sub-defect 1: remediation hint appears ONLY for trust-code TLS failures ---

test("#3776 sub-defect 1: trust-code TLS failure carries the security-software remediation", () => {
    const wrapped = new TypeError("fetch failed", { cause: netError("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain") });
    const parts = describeUpstreamFailure(wrapped, "https://api.example.test/v1/messages");
    assert.equal(parts.detail.kind, "tls");
    assert.equal(parts.detail.code, "SELF_SIGNED_CERT_IN_CHAIN");
    assert.match(parts.message, /security software/);
    assert.match(parts.message, /NODE_EXTRA_CA_CERTS/);
    // the thin format wrapper stays byte-compatible and carries the same hint
    assert.match(formatUpstreamError(wrapped, "https://api.example.test/v1/messages"), /security software/);
});

test("#3776 sub-defect 1: non-trust TLS failure (EPROTO) does NOT carry the remediation", () => {
    const wrapped = new TypeError("fetch failed", { cause: netError("EPROTO", "protocol error") });
    const parts = describeUpstreamFailure(wrapped, "https://api.example.test/v1/messages");
    assert.equal(parts.detail.kind, "tls");
    assert.equal(parts.detail.code, "EPROTO");
    assert.doesNotMatch(parts.message, /security software/);
});

test("#3776 sub-defect 1: isTlsTrustCode / TLS_TRUST_CODES are the single source of truth", () => {
    assert.ok(isTlsTrustCode("SELF_SIGNED_CERT_IN_CHAIN"));
    assert.ok(isTlsTrustCode("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"));
    assert.ok(!isTlsTrustCode("EPROTO"));
    assert.ok(!isTlsTrustCode(undefined));
    assert.ok(!isTlsTrustCode(42));
    for (const c of TLS_TRUST_CODES) assert.ok(isTlsTrustCode(c));
    assert.match(tlsTrustRemediation(), /Kaspersky/);
});

// --- sub-defect 3: structured failure attachment is retrievable and non-enumerable ---

test("#3776 sub-defect 3: withUpstreamFailure attaches a non-enumerable, retrievable slice", () => {
    const detail = { kind: "tls" as const, code: "SELF_SIGNED_CERT_IN_CHAIN", hint: "the hint" };
    const err = withUpstreamFailure(new Error("boom"), detail);
    assert.deepEqual(upstreamFailureOf(err), detail);
    assert.deepEqual(Object.keys(err), []); // symbol property is non-enumerable
    assert.equal(String(err), "Error: boom"); // message form untouched
    assert.equal(upstreamFailureOf(new Error("plain")), undefined);
    assert.equal(upstreamFailureOf("not-an-error"), undefined);
    assert.equal(upstreamFailureOf(null), undefined);
});

test("#3776 sub-defect 3: upstreamCircuitLastFailureKind exposes the opener's kind only while open", () => {
    _resetUpstreamCircuitsForTest();
    const url = "https://circuit-kind.invalid/v1/messages";
    assert.equal(upstreamCircuitLastFailureKind(url), undefined, "fresh host: no open circuit");
    const tlsErr = new TypeError("fetch failed", { cause: netError("SELF_SIGNED_CERT_IN_CHAIN", "self-signed certificate in certificate chain") });
    recordUpstreamCircuitFailure(url, tlsErr, false);
    recordUpstreamCircuitFailure(url, tlsErr, false);
    assert.equal(upstreamCircuitLastFailureKind(url), undefined, "2 consecutive failures: not open yet");
    recordUpstreamCircuitFailure(url, tlsErr, false);
    assert.equal(upstreamCircuitLastFailureKind(url), "tls", "open circuit names the failing kind for the egress hint");
    recordUpstreamCircuitSuccess(url);
    assert.equal(upstreamCircuitLastFailureKind(url), undefined, "closed circuit: no kind");
});

// --- sub-defect 2: CA material resolution (merge, never replace; unset = default trust) ---

test("#3776 sub-defect 2: unset caFile => undefined (Node default trust unchanged)", () => {
    const prevEnv = process.env["BILI_CA_FILE"];
    delete process.env["BILI_CA_FILE"];
    try {
        _resetUpstreamCaForTest();
        assert.equal(upstreamCaIdentity(), "none");
        assert.equal(upstreamExtraCa(), undefined);
    } finally {
        if (prevEnv === undefined) delete process.env["BILI_CA_FILE"]; else process.env["BILI_CA_FILE"] = prevEnv;
        _resetUpstreamCaForTest();
    }
});

test("#3776 sub-defect 2: configured caFile merges built-ins + user PEM (never replaces)", () => {
    const dir = mkTmp("bili-cafile-test-");
    const pem = "-----BEGIN CERTIFICATE-----\nMIIBfakeuserca\n-----END CERTIFICATE-----\n";
    const caFile = path.join(dir, "extra-ca.pem");
    fs.writeFileSync(caFile, pem);
    const prevEnv = process.env["BILI_CA_FILE"];
    process.env["BILI_CA_FILE"] = caFile;
    try {
        _resetUpstreamCaForTest();
        assert.notEqual(upstreamCaIdentity(), "none");
        const merged = upstreamExtraCa();
        assert.ok(Array.isArray(merged));
        assert.ok(merged!.length >= tls.rootCertificates.length + 1, "built-ins plus at least the user PEM");
        assert.ok(merged!.includes(pem), "user PEM present verbatim");
        assert.ok(merged!.includes(tls.rootCertificates[0]), "built-in roots preserved (merge, not replace)");
    } finally {
        if (prevEnv === undefined) delete process.env["BILI_CA_FILE"]; else process.env["BILI_CA_FILE"] = prevEnv;
        _resetUpstreamCaForTest();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("#3776 sub-defect 2: NODE_EXTRA_CA_CERTS entries are folded into the merge too", () => {
    const dir = mkTmp("bili-cafile-extra-");
    const caPem = "-----BEGIN CERTIFICATE-----\nMIIBcafile\n-----END CERTIFICATE-----\n";
    const caFile = path.join(dir, "ca-file.pem");
    fs.writeFileSync(caFile, caPem);
    const extraPem = "-----BEGIN CERTIFICATE-----\nMIIBenvextra\n-----END CERTIFICATE-----\n";
    const extraPath = path.join(dir, "env-extra.pem");
    fs.writeFileSync(extraPath, extraPem);
    const prevCa = process.env["BILI_CA_FILE"];
    const prevExtra = process.env["NODE_EXTRA_CA_CERTS"];
    process.env["BILI_CA_FILE"] = caFile;
    process.env["NODE_EXTRA_CA_CERTS"] = extraPath;
    try {
        _resetUpstreamCaForTest();
        const merged = upstreamExtraCa();
        assert.ok(merged!.includes(caPem), "network.caFile PEM present");
        assert.ok(merged!.includes(extraPem), "NODE_EXTRA_CA_CERTS PEM present (merge, not replace)");
        assert.ok(merged!.includes(tls.rootCertificates[0]), "built-ins preserved");
        // Node loads NODE_EXTRA_CA_CERTS as ONE file path (no list separator on any
        // platform) — a colon-joined value is one nonexistent file to Node itself,
        // so the merge must NOT split it and fold in the first half.
        _resetUpstreamCaForTest();
        process.env["NODE_EXTRA_CA_CERTS"] = `${extraPath}:${path.join(dir, "bogus.pem")}`;
        const joined = upstreamExtraCa();
        assert.ok(!joined!.includes(extraPem), "colon-joined env value treated as a single path (mirrors Node)");
    } finally {
        if (prevCa === undefined) delete process.env["BILI_CA_FILE"]; else process.env["BILI_CA_FILE"] = prevCa;
        if (prevExtra === undefined) delete process.env["NODE_EXTRA_CA_CERTS"]; else process.env["NODE_EXTRA_CA_CERTS"] = prevExtra;
        _resetUpstreamCaForTest();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- e2e: a self-signed MITM upstream, through a real in-process bili proxy ---

function close(server: http.Server | https.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function startTlsScenario(withCaFile: boolean): Promise<{ resp: Response; body: string }> {
    // isolated XDG_DATA_HOME so the test root CA is generated fresh, then a leaf cert
    // for "localhost" signed by it — the shape of a security-scanner re-signed upstream.
    const xdg = mkTmp("bili-tls-mitm-xdg-");
    const prevXdg = process.env.XDG_DATA_HOME;
    let leafCert = "", leafKey = "", rootPem = "";
    process.env.XDG_DATA_HOME = xdg;
    try {
        _resetCaForTest();
        ensureRootCA();
        rootPem = fs.readFileSync(rootCaPath(), "utf8");
        const leaf = mintHostCert("localhost");
        leafCert = leaf.certPem;
        leafKey = leaf.keyPem;
    } finally {
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
        _resetCaForTest();
    }

    const upstreamHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "r1", object: "chat.completion", created: 1, model: "gpt-test",
                choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            }));
        });
    };
    const upstream = https.createServer({ key: leafKey, cert: leafCert }, upstreamHandler);
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const origin = `https://localhost:${upstreamPort}`;

    const captured: { level: string; msg: string }[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const prevRetryMax = process.env["BILI_REPLAY_RETRY_MAX"];
    process.env["BILI_REPLAY_RETRY_MAX"] = "1"; // single attempt: keep the scenario fast
    const prevCaFile = process.env["BILI_CA_FILE"];
    if (withCaFile) {
        const caDir = mkTmp("bili-tls-mitm-cafile-");
        const caFile = path.join(caDir, "scanner-root.pem");
        fs.writeFileSync(caFile, rootPem);
        process.env["BILI_CA_FILE"] = caFile;
    } else {
        delete process.env["BILI_CA_FILE"];
    }
    _resetFetchUtilForTest(); // drop any cached dispatcher so the new CA identity takes effect

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "https://localhost",
        routes: { [origin]: { models: { "gpt-test": { context: 400_000 } } } },
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
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/${origin}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": "tls-mitm-1" },
            body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] }),
        });
        const body = await resp.text();
        return { resp, body };
    } finally {
        setLogCapture(null);
        if (prevRetryMax === undefined) delete process.env["BILI_REPLAY_RETRY_MAX"]; else process.env["BILI_REPLAY_RETRY_MAX"] = prevRetryMax;
        if (prevCaFile === undefined) delete process.env["BILI_CA_FILE"]; else process.env["BILI_CA_FILE"] = prevCaFile;
        _resetFetchUtilForTest();
        await close(proxy);
        await close(upstream);
    }
}

test("#3776 e2e (A): untrusted MITM upstream => 502 carrying structured upstreamFailure{kind:tls}", async () => {
    const { resp, body } = await startTlsScenario(false);
    assert.equal(resp.status, 502);
    const parsed = JSON.parse(body) as { error?: string; detail?: string; upstreamFailure?: { kind?: string; code?: string; hint?: string } };
    // #4254: `error` is now informative (the client-rendered field); the legacy
    // prefix is preserved so hosts matching the old constant still match.
    assert.ok((parsed.error ?? "").startsWith("acp-proxy failure"), `legacy prefix kept, got: ${parsed.error}`);
    assert.match(parsed.error ?? "", /tls/, "informative error carries the tls kind");
    assert.ok(parsed.detail?.includes("kind=tls"), `detail should name the kind, got: ${body}`);
    assert.equal(parsed.upstreamFailure?.kind, "tls");
    assert.ok(parsed.upstreamFailure?.code, "structured code present");
    assert.match(parsed.upstreamFailure?.hint ?? "", /security software/);
});

test("#3776 e2e (B): same MITM upstream trusted via network.caFile => 200 completion", async () => {
    const { resp, body } = await startTlsScenario(true);
    assert.equal(resp.status, 200);
    const parsed = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
    assert.equal(parsed.choices?.[0]?.message?.content, "hi");
});
