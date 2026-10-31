import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import forge from "node-forge";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { caDir } from "./paths.js";
import { log as loggerLog } from "./logger.js";

const ROOT_CERT_FILE = "root-ca.pem";
const ROOT_KEY_FILE = "root-ca-key.pem";
const COMBINED_CA_FILE = "combined-ca.pem";
const ROOT_CN = "billion-context MITM Root CA";
// #1807: the combined bundle merges the OS trust store, which costs a
// PowerShell spawn on Windows — bound the rebuild to once per day per machine.
const COMBINED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** First readable candidate wins per platform; Node's Mozilla root set is
 *  always merged in. On Windows there is no filesystem bundle to probe (no
 *  XDG on win32) — the OS store comes from collectOsStorePems() instead. */
const PLATFORM_CA_CANDIDATES: readonly string[] =
    process.platform === "darwin"
        ? ["/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem"]
        : process.platform === "win32"
          ? []
          : [
                "/etc/ssl/certs/ca-certificates.crt",
                "/etc/pki/tls/certs/ca-bundle.crt",
                "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
                "/etc/ssl/ca-bundle.pem",
                "/etc/ssl/cert.pem",
            ];

let rootCertPem: string | undefined;
let rootKeyPem: string | undefined;
let rootCert: forge.pki.Certificate | undefined;
let rootKey: forge.pki.PrivateKey | undefined;

const secureContextCache = new Map<string, tls.SecureContext>();
// Cap guards memory if the discovered-domain set swells; keygen is also gated
// to MITM-whitelisted hosts, so this stays small in practice. LRU via Map order.
const SECURE_CONTEXT_CACHE_MAX = 64;

/** Path to the PEM-encoded root CA certificate. Clients that support a proxy
 *  CA override (ZCode httpProxyCaCertPath → NODE_EXTRA_CA_CERTS) point at this
 *  file so they trust the dynamically-signed host certs. */
export function rootCaPath(): string {
    return path.join(caDir(), ROOT_CERT_FILE);
}

/** Path to the combined CA bundle: system/public roots + the MITM root CA.
 *  Integrations that REPLACE the default CA bundle via env vars
 *  (SSL_CERT_FILE / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE / GIT_SSL_CAINFO —
 *  replace semantics, unlike the appending NODE_EXTRA_CA_CERTS) must point at
 *  THIS file, not root-ca.pem: non-MITM hosts are blind-tunnelled and present
 *  their real certificate chains, which only validate against public roots. */
export function combinedCaPath(): string {
    return path.join(caDir(), COMBINED_CA_FILE);
}

export function collectSystemCaPems(env: NodeJS.ProcessEnv = process.env): string[] {
    const pems: string[] = [];
    const seen = new Set<string>();
    const pushFile = (file: string): boolean => {
        try {
            const text = fs.readFileSync(file, "utf8");
            if (!text.includes("BEGIN CERTIFICATE") || seen.has(text)) return false;
            seen.add(text);
            pems.push(text);
            return true;
        } catch { }
        return false;
    };
    const userBundle = env.SSL_CERT_FILE?.trim();
    if (userBundle && pushFile(userBundle)) return pems;
    for (const candidate of PLATFORM_CA_CANDIDATES) {
        if (pushFile(candidate)) break;
    }
    return pems;
}

/** #1807: sha256 over the whitespace-stripped base64 payload — dedupes the
 *  same certificate across differently-wrapped PEM encodings (Node's Mozilla
 *  snapshot vs OS-store exports wrap at different columns). */
export function pemFingerprint(pem: string): string {
    const b64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
    return crypto.createHash("sha256").update(b64).digest("hex");
}

/** #1807: wrap a base64 DER certificate as a 64-column PEM block. */
export function wrapDerPem(b64: string): string {
    const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
    const lines: string[] = [];
    for (let i = 0; i < clean.length; i += 64) lines.push(clean.slice(i, i + 64));
    return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** #1807: decode captured PowerShell output — PS 5.1 pipes are frequently
 *  UTF-16LE even though our payload is pure ASCII, so a NUL stride at odd
 *  offsets is the tell; re-decode accordingly instead of dropping everything. */
export function decodeOsStoreOutput(buf: Buffer): string {
    if (buf.length > 2 && buf[1] === 0) return buf.toString("utf16le");
    return buf.toString("utf8");
}

/** #1807: parse the NDJSON lines emitted by osStorePowerShellScript() into PEM
 *  blocks. Malformed/junk lines are skipped, never fatal. */
export function parseOsStoreNdjson(out: string): string[] {
    const pems: string[] = [];
    for (const line of out.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
            const d = (JSON.parse(t) as { d?: unknown }).d;
            if (typeof d === "string" && d.length > 0) pems.push(wrapDerPem(d));
        } catch { }
    }
    return pems;
}

/** #1807: PowerShell 5.1 script exporting every certificate of the machine +
 *  user Root stores as one NDJSON {"d":"<base64 DER>"} line per certificate
 *  (NDJSON keeps the pipe output parseable regardless of locale/console code
 *  page — no human-readable table text to mangle). */
export function osStorePowerShellScript(): string {
    return `$ErrorActionPreference='Stop'
$out = New-Object System.Collections.Generic.List[string]
foreach ($loc in 'LocalMachine','CurrentUser') {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root',$loc)
    try { $store.Open('ReadOnly'); foreach ($c in $store.Certificates) { $out.Add([Convert]::ToBase64String($c.Export('Cert'))) } } catch { } finally { $store.Close() }
}
$out | ForEach-Object { '{"d":"' + $_ + '"}' }`;
}

/** #2439: exec options for the win32 store export. A host that owns no console
 *  (dsh desktop / Electron) makes Windows allocate a NEW console window for any
 *  unhidden console child — that is the black box users saw flash once per
 *  bundle rebuild. #997/#999 swept the other call sites; this one arrived with
 *  #1807. windowsHide is a documented no-op off Windows. #2834: explicit stdio —
 *  a failed export must not forward the child's stderr onto the host terminal;
 *  stderr stays piped because the warn log below consumes the captured error
 *  text. Exported pure so tests can pin it without opening a window. */
export function osStoreExecOptions(): { timeout: number; maxBuffer: number; windowsHide: boolean; stdio: ["ignore", "pipe", "pipe"] } {
    return { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
}

function splitPemBlocks(text: string): string[] {
    const out: string[] = [];
    const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m[0]);
    return out;
}

/** #1807: certificates from the OS-native trust store. Launched clients treat
 *  combined-ca.pem as their ENTIRE trust pool when SSL_CERT_FILE points at it
 *  (codex/rustls replace, not append — see codex-rs/http-client custom_ca.rs),
 *  so the bundle must be a superset of what the OS itself trusts: any direct
 *  (non-MITM) leg of the client validates against this file alone. On Linux
 *  the OS store IS the filesystem bundle collectSystemCaPems already reads.
 *  Best-effort: any failure degrades to the previous bundle shape rather than
 *  breaking startup. */
export function collectOsStorePems(platform: NodeJS.Platform = process.platform): string[] {
    try {
        if (platform === "win32") {
            const buf = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", osStorePowerShellScript()],
                osStoreExecOptions());
            return parseOsStoreNdjson(decodeOsStoreOutput(buf));
        }
        if (platform === "darwin") {
            const pems: string[] = [];
            const keychains = ["/Library/Keychains/System.keychain"];
            const login = path.join(os.homedir(), "Library/Keychains/login.keychain-db");
            if (fs.existsSync(login)) keychains.push(login);
            let failures = 0;
            for (const k of keychains) {
                // One keychain failing (e.g. a locked login keychain) must not
                // drop the certificates already collected from the others.
                try {
                    const out = execFileSync("/usr/bin/security", ["find-certificate", "-a", "-p", k],
                        { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
                    pems.push(...splitPemBlocks(out));
                } catch { failures++; }
            }
            if (failures === keychains.length) throw new Error(`all ${keychains.length} keychain exports failed`);
            return pems;
        }
        return [];
    } catch (err) {
        loggerLog("warn", `os-store merge skipped (${platform}): ${String(err).slice(0, 200)}`);
        return [];
    }
}

/** Rebuild combined-ca.pem unless a fresh copy (< 24h) already carries the
 *  current MITM root CA — the OS-store merge makes each rebuild expensive on
 *  Windows, so steady-state startups reuse the existing file. */
function writeCombinedBundle(): void {
    const file = path.join(caDir(), COMBINED_CA_FILE);
    try {
        const st = fs.statSync(file);
        if (Date.now() - st.mtimeMs < COMBINED_MAX_AGE_MS && fs.readFileSync(file, "utf8").includes(rootCertPem!.trim())) return;
    } catch { }
    const byFingerprint = new Map<string, string>();
    const add = (pem: string): void => {
        const t = pem.trim();
        if (!t.includes("BEGIN CERTIFICATE")) return;
        // Sources like collectSystemCaPems hand over a WHOLE FILE as one
        // string — split into single-certificate blocks first or the
        // fingerprint lands on the concatenated payload and cross-source
        // duplicates survive.
        for (const block of splitPemBlocks(t)) byFingerprint.set(pemFingerprint(block), block);
    };
    for (const pem of collectSystemCaPems()) add(pem);
    for (const pem of collectOsStorePems()) add(pem);
    for (const pem of tls.rootCertificates) add(pem);
    add(rootCertPem!);
    const body = [...byFingerprint.values()].map((pem) => (pem.endsWith("\n") ? pem : pem + "\n")).join("");
    try {
        fs.writeFileSync(file, body, { mode: 0o644 });
    } catch (err) {
        // #5103: an OS-level write refusal (AV/Defender holding the dir,
        // Windows integrity control on a low-integrity launcher, boot-time
        // components still initializing — the #3823 class) must not brick the
        // whole proxy when a functionally valid bundle already sits on disk:
        // it carries the current root CA, which is what MITM needs; the merged
        // public roots are freshness, not correctness. Reuse it and warn loud;
        // the next startup retries the rebuild. No usable bundle (fresh
        // install, or one missing our root) still fails fast as before.
        let reusable = false;
        try {
            reusable = fs.readFileSync(file, "utf8").includes(rootCertPem!.trim());
        } catch { /* absent or unreadable file — nothing to reuse */ }
        if (!reusable) throw err;
        loggerLog(
            "warn",
            `[ca] cannot rebuild ${file} (${String(err).slice(0, 200)}) — continuing with the EXISTING bundle (it still carries the current root CA). This is an OS-level write refusal, not a code fault — on Windows check the Node runtime's integrity label FIRST (icacls \"<path-to-node.exe>\"; a Low label is refused for Medium-labeled files even with correct ACLs, #5154), then antivirus/Defender exclusions for %USERPROFILE%\\.local\\share\\billion-context\\ (#3823); the rebuild retries on the next startup.`,
        );
    }
}

function generateRootCA(): { cert: string; key: string } {
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = "01";
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    const attrs = [
        { name: "commonName", value: ROOT_CN },
        { name: "organizationName", value: "billion-context" },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
        { name: "basicConstraints", cA: true, critical: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true },
        { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return {
        cert: forge.pki.certificateToPem(cert),
        key: forge.pki.privateKeyToPem(keys.privateKey),
    };
}

/** Load the root CA from disk, generating + persisting it on first call.
 *  Idempotent: once written, subsequent processes reuse the same CA so already
 *  installed trust keeps working across restarts. */
export function ensureRootCA(): void {
    if (rootCertPem && rootKeyPem) {
        writeCombinedBundle();
        return;
    }
    const dir = caDir();
    fs.mkdirSync(dir, { recursive: true });
    const certPath = path.join(dir, ROOT_CERT_FILE);
    const keyPath = path.join(dir, ROOT_KEY_FILE);
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        rootCertPem = fs.readFileSync(certPath, "utf8");
        rootKeyPem = fs.readFileSync(keyPath, "utf8");
        rootCert = forge.pki.certificateFromPem(rootCertPem);
        rootKey = forge.pki.privateKeyFromPem(rootKeyPem);
        writeCombinedBundle();
        return;
    }
    const { cert, key } = generateRootCA();
    fs.writeFileSync(certPath, cert, { mode: 0o644 });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    rootCertPem = cert;
    rootKeyPem = key;
    rootCert = forge.pki.certificateFromPem(cert);
    rootKey = forge.pki.privateKeyFromPem(key);
    writeCombinedBundle();
}

/** Mint a leaf certificate for `host` signed by the root CA (with the
 *  strict-OpenSSL-3 extension set Python/httpx requires: SKI + AKI matching
 *  the root's SKI — see getSecureContext). */
export function mintHostCert(host: string): { certPem: string; keyPem: string } {
    if (!rootCertPem || !rootKeyPem || !rootCert || !rootKey) {
        throw new Error("CA not initialized — call ensureRootCA() first");
    }
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString() + Math.floor(Math.random() * 1e6).toString();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);
    cert.setSubject([{ name: "commonName", value: host }]);
    cert.setIssuer(rootCert.subject.attributes);
    // AKI must point at the ROOT's key (explicit bytes — forge's `true` form
    // would stamp the leaf's own SKI here since options.cert is the leaf).
    // Python's OpenSSL 3 chain verification rejects leaves without AKI
    // ("certificate verify failed: Missing Authority Key Identifier") even
    // though curl tolerates them — hermes/httpx is the client that hit it.
    const rootSki = rootCert.generateSubjectKeyIdentifier().getBytes();
    cert.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: host }] },
        { name: "subjectKeyIdentifier" },
        { name: "authorityKeyIdentifier", keyIdentifier: rootSki },
    ]);
    cert.sign(rootKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());
    return {
        certPem: forge.pki.certificateToPem(cert),
        keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
}

/** Return a tls.SecureContext that presents a certificate for `host`, signed
 *  by our root CA. Cached per host — RSA keygen (~100ms) only happens once
 *  per unique hostname, then the cached context is reused for the lifetime of
 *  the process. */
export function getSecureContext(host: string): tls.SecureContext {
    if (!rootCertPem || !rootKeyPem || !rootCert || !rootKey) {
        throw new Error("CA not initialized — call ensureRootCA() first");
    }
    const cached = secureContextCache.get(host);
    if (cached) {
        secureContextCache.delete(host);
        secureContextCache.set(host, cached);
        return cached;
    }

    const { certPem, keyPem } = mintHostCert(host);

    const ctx = tls.createSecureContext({
        cert: certPem,
        key: keyPem,
        ca: rootCertPem,
    });
    secureContextCache.set(host, ctx);
    if (secureContextCache.size > SECURE_CONTEXT_CACHE_MAX) {
        const oldest = secureContextCache.keys().next().value;
        if (oldest !== undefined) secureContextCache.delete(oldest);
    }
    return ctx;
}

/** Drop the per-host cert cache. Tests use this to isolate SecureContext
 *  state across cases. */
export function _resetForTest(): void {
    rootCertPem = undefined;
    rootKeyPem = undefined;
    rootCert = undefined;
    rootKey = undefined;
    secureContextCache.clear();
}
