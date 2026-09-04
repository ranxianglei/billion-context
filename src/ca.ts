import forge from "node-forge";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { caDir } from "./paths.js";

const ROOT_CERT_FILE = "root-ca.pem";
const ROOT_KEY_FILE = "root-ca-key.pem";
const COMBINED_CA_FILE = "combined-ca.pem";
const ROOT_CN = "billion-context MITM Root CA";

/** First readable candidate wins per platform; Node's Mozilla root set is
 *  always merged in so the combined bundle also works on Windows. */
const PLATFORM_CA_CANDIDATES: readonly string[] =
    process.platform === "darwin"
        ? ["/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem"]
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

function writeCombinedBundle(): void {
    const certs = new Set<string>();
    for (const pem of collectSystemCaPems()) certs.add(pem.trim());
    for (const pem of tls.rootCertificates) certs.add(pem.trim());
    certs.add(rootCertPem!.trim());
    const body = [...certs].map((pem) => (pem.endsWith("\n") ? pem : pem + "\n")).join("");
    fs.writeFileSync(path.join(caDir(), COMBINED_CA_FILE), body, { mode: 0o644 });
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
