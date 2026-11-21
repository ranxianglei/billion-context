import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { classifyUpstreamFailure, tlsTrustRemediation, wantsCertProbe } from "../src/upstream-fail.js";
import { describeUpstreamFailure, tlsEnterpriseSignal } from "../src/upstream-proxy.js";
import {
    getOpenUpstreamCircuits,
    getUpstreamAlerts,
    recordUpstreamAlert,
    recordUpstreamCircuitFailure,
    recordUpstreamCircuitSuccess,
    upstreamCircuitBlockReason,
    _resetUpstreamAlertsForTest,
    _resetUpstreamCircuitsForTest,
} from "../src/upstream-alerts.js";
import { presentedCertOf, scheduleCertProbe, _resetCertProbeForTest, _seedCertProbeForTest } from "../src/upstream-cert-probe.js";
import { extraCaConfigured, upstreamExtraCa, _resetUpstreamCaForTest } from "../src/upstream-ca.js";
import { createSummaryHttpCandidate, _setSummaryRetryDelayForTest } from "../src/external-summary-http.js";
import { ensureRootCA, rootCaPath, mintHostCert, _resetForTest as _resetCaForTest } from "../src/ca.js";
import { setLogCapture } from "../src/logger.js";

// #4403: DNS poisoning makes the upstream TLS handshake fail with a trust code
// (DEPTH_ZERO_SELF_SIGNED_CERT & co). #3776 already made those self-diagnosable,
// but its remediation text unconditionally told users to INSTALL the presented CA —
// under active hijacking that means installing the ATTACKER's root. These tests
// pin the follow-up fixes: (P0-1) remediation text branches on evidence and leads
// with "do NOT install this CA / verify DNS" unless an enterprise-interception
// signal exists; (P0-2) a fire-and-forget forensic probe captures what certificate
// the endpoint actually presents (subject/issuer/SAN/fp256 + probe-time address)
// and enriches log lines and the 502 upstreamFailure slice; (P0-3) unclassified
// ("unknown") final failures count toward the circuit-opening gate (gate only —
// never a banner), and every final failure site (relay, re-request, external
// summary, preflight summary) feeds the same alert/circuit ledger; (P2-1) loading
// extra CA material logs each certificate's identity instead of silently extending
// trust.

const tmpRoot = process.env.TMPDIR && fs.existsSync(process.env.TMPDIR) ? process.env.TMPDIR : os.tmpdir();
function mkTmp(prefix: string): string { return fs.mkdtempSync(path.join(tmpRoot, prefix)); }

function netError(code: string, message: string): Error {
    const err = new Error(message) as NodeJS.ErrnoException;
    err.code = code;
    return err;
}

function fetchFailed(code: string, message: string): TypeError {
    return new TypeError("fetch failed", { cause: netError(code, message) });
}

function resetAll(): void {
    _resetCertProbeForTest();
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    _resetUpstreamCaForTest();
}

// --- P0-1: remediation text branches on evidence ---

test("#4403 P0-1: alt-name-invalid cert → do NOT install any CA, verify DNS", () => {
    const hint = tlsTrustRemediation({ code: "ERR_TLS_CERT_ALTNAME_INVALID", hostname: "opencode.ai" });
    assert.match(hint, /Do NOT install any new CA/);
    assert.match(hint, /verify what opencode\.ai resolves to/);
    assert.doesNotMatch(hint, /NODE_EXTRA_CA_CERTS/);
});

test("#4403 P0-1: probe-captured SAN lacking the target host → do NOT install THIS CA", () => {
    const hint = tlsTrustRemediation({ code: "DEPTH_ZERO_SELF_SIGNED_CERT", hostname: "opencode.ai", cert: { san: ["evil.example"] } });
    assert.match(hint, /self-signed\/untrusted AND its subject alt names \(evil\.example\) do not include opencode\.ai/);
    assert.match(hint, /Do NOT install this CA/);
    assert.doesNotMatch(hint, /NODE_EXTRA_CA_CERTS/);
});

test("#4403 P0-1: SAN that DOES cover the host falls back to the verify-first default", () => {
    const hint = tlsTrustRemediation({ code: "SELF_SIGNED_CERT_IN_CHAIN", hostname: "opencode.ai", cert: { san: ["opencode.ai"] } });
    assert.match(hint, /Before installing ANY CA:/);
    assert.match(hint, /security software/);
});

test("#4403 P0-1: wildcard SAN covering the host is NOT mitm-suspect (RFC 6125 single-label)", () => {
    const hint = tlsTrustRemediation({ code: "DEPTH_ZERO_SELF_SIGNED_CERT", hostname: "api.corp.example", cert: { san: ["*.corp.example"] } });
    assert.doesNotMatch(hint, /Do NOT install this CA/);
    assert.match(hint, /Before installing ANY CA:/);
});

test("#4403 P0-1: wildcard SAN does not cover apex or multi-label hosts (still mitm-suspect)", () => {
    assert.match(tlsTrustRemediation({ code: "DEPTH_ZERO_SELF_SIGNED_CERT", hostname: "corp.example", cert: { san: ["*.corp.example"] } }), /Do NOT install this CA/);
    assert.match(tlsTrustRemediation({ code: "DEPTH_ZERO_SELF_SIGNED_CERT", hostname: "a.b.corp.example", cert: { san: ["*.corp.example"] } }), /Do NOT install this CA/);
});

test("#4403 P0-1: enterprise signal present → original scanner/vendor-CA advice", () => {
    const hint = tlsTrustRemediation({ code: "SELF_SIGNED_CERT_IN_CHAIN", hostname: "api.example.test", enterpriseSignal: true });
    assert.match(hint, /Kaspersky, enterprise DLP/);
    assert.match(hint, /NODE_EXTRA_CA_CERTS=\//);
    assert.doesNotMatch(hint, /Before installing ANY CA/);
});

test("#4403 P0-1: expired cert → upstream misconfiguration, nothing to install locally", () => {
    const hint = tlsTrustRemediation({ code: "CERT_HAS_EXPIRED", hostname: "api.example.test" });
    assert.match(hint, /EXPIRED/);
    assert.match(hint, /nothing to install locally/);
    assert.doesNotMatch(hint, /NODE_EXTRA_CA_CERTS/, "no CA-install advice for an expired cert");
});

test("#4403 P0-1: bare call keeps the #3776-compatible verify-first default", () => {
    const hint = tlsTrustRemediation();
    assert.match(hint, /security software/);
    assert.match(hint, /Kaspersky/);
    assert.match(hint, /Before installing ANY CA:/);
    assert.match(hint, /NODE_EXTRA_CA_CERTS/);
    assert.match(hint, /hijacked DNS answer presenting a forged cert/);
});

test("#4403 P0-1: tlsEnterpriseSignal = local/private proxy OR extra CA material configured", () => {
    const prevExtra = process.env["NODE_EXTRA_CA_CERTS"];
    try {
        delete process.env["NODE_EXTRA_CA_CERTS"];
        delete process.env["BILI_CA_FILE"];
        _resetUpstreamCaForTest();
        assert.equal(tlsEnterpriseSignal(undefined), false, "no signal at all");
        assert.equal(tlsEnterpriseSignal("http://proxy.corp.example:8080"), false, "public proxy host is not an interception signal");
        assert.equal(tlsEnterpriseSignal("http://127.0.0.1:8080"), true, "loopback proxy = local interceptor");
        assert.equal(tlsEnterpriseSignal("http://192.168.1.10:3128"), true, "private-range proxy = local interceptor");
        process.env["NODE_EXTRA_CA_CERTS"] = "/some/ca.pem";
        assert.equal(extraCaConfigured(), true);
        assert.equal(tlsEnterpriseSignal(undefined), true, "configured extra CA material IS the scanner path");
    } finally {
        if (prevExtra === undefined) delete process.env["NODE_EXTRA_CA_CERTS"]; else process.env["NODE_EXTRA_CA_CERTS"] = prevExtra;
        delete process.env["BILI_CA_FILE"];
        _resetUpstreamCaForTest();
    }
});

// --- P0-2: forensic probe — seeded cache flow through describeUpstreamFailure ---

const SEED_FP = "ab".repeat(32);
const VICTIM_URL = "https://victim.example:443/v1/messages";

test("#4403 P0-2: trust-code failure + landed probe → forensics in message AND detail slice", () => {
    resetAll();
    _seedCertProbeForTest(VICTIM_URL, {
        remoteAddress: "203.0.113.7",
        subject: "CN=victim.example",
        issuer: "O=Evil Corp CN=Evil Root",
        san: ["victim.example", "other.example"],
        fingerprint256: SEED_FP,
    });
    const parts = describeUpstreamFailure(fetchFailed("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"), VICTIM_URL);
    assert.equal(parts.detail.kind, "tls");
    assert.equal(parts.detail.code, "DEPTH_ZERO_SELF_SIGNED_CERT");
    // free-text channel (log line / 502 error string): private hostnames are
    // masked to <private-host> by design (#255 discipline, same as url=), so
    // assert mask-independent bits here — the RAW values are pinned in detail.
    assert.match(parts.message, /probeRemote=203\.0\.113\.7/);
    assert.match(parts.message, /certSubject="CN=/);
    assert.match(parts.message, /certIssuer="O=Evil Corp CN=Evil Root"/);
    assert.match(parts.message, /certSan=\[.*other\.example\]/);
    assert.match(parts.message, new RegExp(`certFp256=${SEED_FP}`));
    // machine-readable slice (502 upstreamFailure object)
    assert.equal(parts.detail.remoteAddress, "203.0.113.7");
    assert.equal(parts.detail.certSubject, "CN=victim.example");
    assert.equal(parts.detail.certIssuer, "O=Evil Corp CN=Evil Root");
    assert.deepEqual(parts.detail.certSan, ["victim.example", "other.example"]);
    assert.equal(parts.detail.certFingerprint256, SEED_FP);
});

test("#4403 P0-2: no probe result yet (first event) → no forensic parts, no crash", () => {
    resetAll();
    const parts = describeUpstreamFailure(fetchFailed("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"), "https://fresh.example/v1/messages");
    assert.equal(parts.detail.kind, "tls");
    assert.doesNotMatch(parts.message, /probeRemote=/);
    assert.doesNotMatch(parts.message, /certSubject=/);
    assert.equal(parts.detail.remoteAddress, undefined);
    assert.equal(parts.detail.certFingerprint256, undefined);
});

test("#4403 P0-2: non-TLS failure never carries forensic parts", () => {
    resetAll();
    _seedCertProbeForTest(VICTIM_URL, { remoteAddress: "203.0.113.7", fingerprint256: SEED_FP });
    const parts = describeUpstreamFailure(fetchFailed("ECONNREFUSED", "connect ECONNREFUSED"), VICTIM_URL);
    assert.equal(parts.detail.kind, "connect-refused");
    assert.doesNotMatch(parts.message, /probeRemote=/);
    assert.equal(parts.detail.certFingerprint256, undefined);
});

test("#4403 P0-2: wantsCertProbe fires only for direct-mode trust-code deaths", () => {
    assert.equal(wantsCertProbe(fetchFailed("DEPTH_ZERO_SELF_SIGNED_CERT", "x"), false), true);
    assert.equal(wantsCertProbe(new TypeError("fetch failed", { cause: new TypeError("inner", { cause: netError("SELF_SIGNED_CERT_IN_CHAIN", "x") }) }), false), true, "walks the cause chain");
    assert.equal(wantsCertProbe(fetchFailed("DEPTH_ZERO_SELF_SIGNED_CERT", "x"), true), false, "via proxy the direct probe hits the wrong endpoint");
    assert.equal(wantsCertProbe(fetchFailed("EPROTO", "protocol error"), false), false, "non-trust TLS death: nothing to capture");
    assert.equal(wantsCertProbe(fetchFailed("ECONNREFUSED", "refused"), false), false);
    assert.equal(wantsCertProbe(new Error("plain"), false), false);
});

// --- P0-2: REAL hermetic probe against an in-process self-signed HTTPS server ---

async function waitForCert(url: string, timeoutMs = 6_000): Promise<ReturnType<typeof presentedCertOf>> {
    const start = Date.now();
    for (;;) {
        const info = presentedCertOf(url);
        if (info) return info;
        if (Date.now() - start > timeoutMs) return undefined;
        await new Promise((r) => setTimeout(r, 50));
    }
}

test("#4403 P0-2 e2e: probe captures subject/issuer/SAN/fingerprint from a real handshake", async () => {
    resetAll();
    // Isolated XDG_DATA_HOME so the test root CA is minted fresh (never touches
    // the operator's real ~/.local/share/billion-context CA).
    const xdg = mkTmp("bili-4403-xdg-");
    const prevXdg = process.env.XDG_DATA_HOME;
    let leafCert = "", leafKey = "";
    process.env.XDG_DATA_HOME = xdg;
    const captured: string[] = [];
    setLogCapture((_level, msg) => captured.push(msg));
    let upstream: https.Server | null = null;
    try {
        _resetCaForTest();
        ensureRootCA();
        const leaf = mintHostCert("localhost");
        leafCert = leaf.certPem;
        leafKey = leaf.keyPem;

        upstream = https.createServer({ key: leafKey, cert: leafCert }, (_req, res) => res.end("{}"));
        await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
        const port = (upstream.address() as { port: number }).port;
        const url = `https://localhost:${port}/probe`;

        scheduleCertProbe(url);
        const info = await waitForCert(url);
        assert.ok(info, "probe landed within the timeout");
        // localhost may resolve to 127.0.0.1 or ::1 depending on the runner's hosts file
        assert.match(info!.remoteAddress ?? "", /^(127\.0\.0\.1|::1|0:0:0:0:0:0:0:1)$/);
        assert.match(info!.subject ?? "", /CN=localhost/);
        assert.ok((info!.san ?? []).includes("localhost"), `SAN carries the plain hostname (got ${JSON.stringify(info!.san)})`);
        assert.match(info!.fingerprint256 ?? "", /^[0-9a-f]{64}$/);
        assert.ok(captured.some((m) => m.includes("TLS forensics probe") && m.includes("connected") && m.includes("CN=localhost")),
            `forensic log line emitted (captured ${captured.length} lines)`);
        // server close happens in finally — a thrown assert must not leak the listener
    } finally {
        if (upstream !== null) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
        _resetCaForTest();
        setLogCapture(null);
        fs.rmSync(xdg, { recursive: true, force: true });
        _resetCertProbeForTest();
    }
});

// --- P0-3: unknown counts toward the circuit gate, never toward the banner ---

test("#4403 P0-3: three consecutive UNCLASSIFIED failures open the circuit gate — without a banner", () => {
    resetAll();
    const url = "https://ghost.example/v1/chat/completions";
    const mystery = new Error("something undici did not classify");
    for (let i = 0; i < 3; i++) {
        recordUpstreamAlert(url, mystery, false);
        recordUpstreamCircuitFailure(url, mystery, false, "boom");
    }
    const open = getOpenUpstreamCircuits();
    assert.equal(open.length, 1, "circuit open after 3 unknown failures");
    assert.equal(open[0].host, "ghost.example");
    assert.equal(open[0].lastFailure?.kind, "unknown");
    assert.equal(getUpstreamAlerts().length, 0, "unknown never mints a misleading banner");
    assert.ok(upstreamCircuitBlockReason(url), "fail-fast engages");
    recordUpstreamCircuitSuccess(url);
    assert.equal(getOpenUpstreamCircuits().length, 0, "a resolved response closes the gate");
});

test("#4403 P0-3: post-connect timeouts still count nowhere (unchanged discipline)", () => {
    resetAll();
    const url = "https://slow.example/v1/chat/completions";
    const timeout = fetchFailed("ETIMEDOUT", "socket timed out");
    assert.equal(classifyUpstreamFailure(timeout, { viaProxy: false }), "upstream-timeout");
    for (let i = 0; i < 3; i++) recordUpstreamCircuitFailure(url, timeout, false);
    assert.equal(getOpenUpstreamCircuits().length, 0, "post-connect timeout proves nothing about reachability");
    assert.equal(getUpstreamAlerts().length, 0);
});

test("#4403 P0-3: DEPTH_ZERO_* classifies as tls (defect A pin, fixed since v0.1.203)", () => {
    assert.equal(classifyUpstreamFailure(fetchFailed("DEPTH_ZERO_SELF_SIGNED_CERT", "self-signed certificate"), { viaProxy: false }), "tls");
    assert.equal(classifyUpstreamFailure(fetchFailed("DEPTH_ZERO_UNTRUSTED_ROOT", "untrusted root"), { viaProxy: false }), "tls");
    assert.equal(classifyUpstreamFailure(fetchFailed("ERR_TLS_CERT_ALTNAME_INVALID", "altname mismatch"), { viaProxy: false }), "tls");
});

// --- P0-3 wiring: external summary candidate final failures feed the ledger ---

function deadPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const p = (srv.address() as { port: number }).port;
            srv.close(() => resolve(p));
        });
    });
}

test("#4403 P0-3 wiring: exhausted summary candidate dispatches account in alert + circuit ledger", async () => {
    resetAll();
    const port = await deadPort();
    const url = `http://127.0.0.1:${port}/v1/chat/completions`;
    const candidate = createSummaryHttpCandidate({ protocol: "openai", url, model: "sum-model", headers: {} }, 1_000_000);
    const work = { content: "hello", instructions: "summarize" };
    _setSummaryRetryDelayForTest(0);
    try {
        // One summarize call = one FINAL pre-response failure (the in-call retries
        // are transparent replays). Three calls = three consecutive final failures.
        for (let i = 0; i < 3; i++) {
            await assert.rejects(candidate.summarize(work, new AbortController().signal));
        }
        const open = getOpenUpstreamCircuits();
        assert.equal(open.length, 1, "summary-only outage trips the same circuit gate");
        assert.equal(open[0].lastFailure?.kind, "connect-refused");
        assert.equal(getUpstreamAlerts().length, 1, "alert table sees the host too");
        assert.equal(getUpstreamAlerts()[0].host, `127.0.0.1:${port}`);
        assert.equal(getUpstreamAlerts()[0].kind, "connect-refused");
    } finally {
        _setSummaryRetryDelayForTest(null);
        resetAll();
    }
});

// --- P2-1: loading extra CA material logs each certificate's identity ---

test("#4403 P2-1: caFile load logs each merged certificate's subject/issuer/fingerprint", async () => {
    const xdg = mkTmp("bili-4403-ca-xdg-");
    const dir = mkTmp("bili-4403-cafile-");
    const prevXdg = process.env.XDG_DATA_HOME;
    const prevCa = process.env["BILI_CA_FILE"];
    const captured: string[] = [];
    setLogCapture((_level, msg) => captured.push(msg));
    process.env.XDG_DATA_HOME = xdg;
    try {
        _resetCaForTest();
        ensureRootCA();
        const caFile = path.join(dir, "extra-ca.pem");
        fs.writeFileSync(caFile, fs.readFileSync(rootCaPath(), "utf8"));
        process.env["BILI_CA_FILE"] = caFile;
        _resetUpstreamCaForTest();
        const merged = upstreamExtraCa();
        assert.ok(merged && merged.length > 0, "merge built");
        const identityLine = captured.find((m) => m.includes("[upstream-ca] trusted extra CA from network.caFile="));
        assert.ok(identityLine, `identity line logged (captured: ${captured.slice(0, 5).join(" | ")})`);
        assert.match(identityLine!, /billion-context MITM Root CA/, "subject visible");
        assert.match(identityLine!, /fp256=[0-9a-f]{64}/, "fingerprint visible");
    } finally {
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
        if (prevCa === undefined) delete process.env["BILI_CA_FILE"]; else process.env["BILI_CA_FILE"] = prevCa;
        _resetCaForTest();
        _resetUpstreamCaForTest();
        setLogCapture(null);
        fs.rmSync(xdg, { recursive: true, force: true });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("#4403 P2-1: blockless caFile warns loudly instead of silently adding nothing", () => {
    const dir = mkTmp("bili-4403-cafile-empty-");
    const prevCa = process.env["BILI_CA_FILE"];
    const captured: string[] = [];
    setLogCapture((_level, msg) => captured.push(msg));
    const caFile = path.join(dir, "empty.pem");
    fs.writeFileSync(caFile, "not a pem\n");
    process.env["BILI_CA_FILE"] = caFile;
    try {
        _resetUpstreamCaForTest();
        upstreamExtraCa();
        assert.ok(captured.some((m) => m.includes("no PEM certificate blocks found")), "loud warning");
    } finally {
        if (prevCa === undefined) delete process.env["BILI_CA_FILE"]; else process.env["BILI_CA_FILE"] = prevCa;
        _resetUpstreamCaForTest();
        setLogCapture(null);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
