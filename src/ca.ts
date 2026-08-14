import forge from "node-forge";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { caDir } from "./paths.js";

const ROOT_CERT_FILE = "root-ca.pem";
const ROOT_KEY_FILE = "root-ca-key.pem";
const ROOT_CN = "billion-context MITM Root CA";

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
        { name: "basicConstraints", cA: true },
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
    if (rootCertPem && rootKeyPem) return;
    const dir = caDir();
    fs.mkdirSync(dir, { recursive: true });
    const certPath = path.join(dir, ROOT_CERT_FILE);
    const keyPath = path.join(dir, ROOT_KEY_FILE);
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        rootCertPem = fs.readFileSync(certPath, "utf8");
        rootKeyPem = fs.readFileSync(keyPath, "utf8");
        rootCert = forge.pki.certificateFromPem(rootCertPem);
        rootKey = forge.pki.privateKeyFromPem(rootKeyPem);
        return;
    }
    const { cert, key } = generateRootCA();
    fs.writeFileSync(certPath, cert, { mode: 0o644 });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    rootCertPem = cert;
    rootKeyPem = key;
    rootCert = forge.pki.certificateFromPem(cert);
    rootKey = forge.pki.privateKeyFromPem(key);
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

    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = Date.now().toString() + Math.floor(Math.random() * 1e6).toString();
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);
    cert.setSubject([{ name: "commonName", value: host }]);
    cert.setIssuer(rootCert.subject.attributes);
    cert.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: host }] },
    ]);
    cert.sign(rootKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());

    const ctx = tls.createSecureContext({
        cert: forge.pki.certificateToPem(cert),
        key: forge.pki.privateKeyToPem(keys.privateKey),
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
