// #3776 sub-defect 2: CA trust material for bili's OWN outbound upstream fetch.
// Node's default TLS trust is the built-in Mozilla bundle + NODE_EXTRA_CA_CERTS;
// it does NOT read the OS certificate store, so a security-software MITM root
// (Kaspersky / corporate DLP) installed in the Windows/Mac store is untrusted and
// every request dies with SELF_SIGNED_CERT_IN_CHAIN (#3773). network.caFile /
// BILI_CA_FILE points at that vendor's PEM; we MERGE it with the built-ins (never
// replace) so all other upstreams keep working. When unset we return undefined and
// the dispatcher uses Node's default trust byte-for-byte (no connect override).

import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as tls from "node:tls";
import { log as loggerLog } from "./logger.js";
import { upstreamCaFile } from "./knobs.js";

const IDENTITY_TTL_MS = 30_000;
let lastStatAt = 0;
let lastIdentity = "none";
let cacheKey: string | null = null;
let cacheValue: string[] | undefined;

function readPem(path: string): string[] {
    try {
        return [readFileSync(path, "utf8")];
    } catch (err) {
        loggerLog("warn", `[upstream-ca] CA file ${path} unreadable (${(err as Error).message}); ignoring — upstream TLS falls back to whatever else is trusted`);
        return [];
    }
}

/** #4403: true when ANY extra CA material is configured (network.caFile knob or
 *  NODE_EXTRA_CA_CERTS) — one input to the TLS-trust enterprise signal: a user
 *  who already trusts an extra vendor root is on the "scanner re-signs traffic"
 *  path, not the "hijacked DNS" path. Cheap knob/env read, no IO. */
export function extraCaConfigured(): boolean {
    return upstreamCaFile() !== undefined || process.env["NODE_EXTRA_CA_CERTS"] !== undefined;
}

// #4403 P2-1: loading network.caFile SILENTLY extends what bili will trust —
// a typo'd or attacker-placed PEM becomes invisible trust expansion. Log each
// certificate's identity at load so the operator can see EXACTLY which CAs the
// merge now accepts (and cross-check them against the vendor's published ones).
function logPemIdentities(pem: string, source: string): void {
    const blocks = [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
    if (blocks.length === 0) {
        loggerLog("warn", `[upstream-ca] ${source}: no PEM certificate blocks found — nothing added to the trust merge`);
        return;
    }
    blocks.forEach((m, i) => {
        try {
            const x509 = new X509Certificate(m[0]);
            const subject = x509.subject.replace(/\n/g, ", ");
            const issuer = x509.issuer.replace(/\n/g, ", ");
            loggerLog("info", `[upstream-ca] trusted extra CA from ${source} (block ${i + 1}/${blocks.length}): subject=${subject} issuer=${issuer} fp256=${x509.fingerprint256.toLowerCase().replace(/:/g, "")}`);
        } catch (err) {
            loggerLog("warn", `[upstream-ca] ${source}: certificate block ${i + 1}/${blocks.length} is not parseable (${(err as Error).message}) — passed through to Node unparsed`);
        }
    });
}

/** Stable identity of the configured extra-CA material ("none" when unset),
 *  TTL-cached so a statSync happens at most once per IDENTITY_TTL_MS even on the
 *  hot fetch path. Used both as the dispatcher cache-key discriminator and as the
 *  PEM rebuild trigger, so a rotated CA file is picked up without a restart. */
export function upstreamCaIdentity(now = Date.now()): string {
    const caFile = upstreamCaFile();
    if (!caFile) {
        lastIdentity = "none";
        return "none";
    }
    if (now - lastStatAt < IDENTITY_TTL_MS && lastIdentity !== "none") return lastIdentity;
    let mtimeMs = 0;
    try { mtimeMs = statSync(caFile).mtimeMs; } catch { /* missing file => mtime 0 */ }
    lastIdentity = `${caFile}\u0000${mtimeMs}`;
    lastStatAt = now;
    return lastIdentity;
}

/** Merged CA list (built-ins + NODE_EXTRA_CA_CERTS + network.caFile) for bili's
 *  own fetch, or undefined when no caFile is configured — in which case the
 *  dispatcher must NOT set connect.ca and Node's default trust applies unchanged.
 *  The merge (not replace) matters: an explicit undici connect.ca REPLACES the
 *  default store, so we fold in everything Node would already have trusted. */
export function upstreamExtraCa(): string[] | undefined {
    const identity = upstreamCaIdentity();
    if (identity === "none") return undefined;
    if (cacheKey === identity) return cacheValue;
    const merged: string[] = [...tls.rootCertificates];
    const nodeExtra = process.env["NODE_EXTRA_CA_CERTS"];
    // Node treats NODE_EXTRA_CA_CERTS as ONE file path — no list separator on any
    // platform (verified against Node 22: the whole value is loaded as a single
    // file, multi-cert files carry several PEM blocks). Mirror that exactly so
    // the merge trusts precisely what Node would already have trusted.
    if (nodeExtra) {
        const pems = readPem(nodeExtra);
        merged.push(...pems);
        if (pems.length > 0) logPemIdentities(pems.join(""), `NODE_EXTRA_CA_CERTS=${nodeExtra}`);
    }
    const caFile = upstreamCaFile();
    if (caFile) {
        const pems = readPem(caFile);
        merged.push(...pems);
        if (pems.length > 0) logPemIdentities(pems.join(""), `network.caFile=${caFile}`);
    }
    cacheKey = identity;
    cacheValue = merged;
    loggerLog("info", `[upstream-ca] upstream TLS trust extended with ${caFile} (${merged.length} certs total)`);
    return merged;
}

export function _resetUpstreamCaForTest(): void {
    lastStatAt = 0;
    lastIdentity = "none";
    cacheKey = null;
    cacheValue = undefined;
}
