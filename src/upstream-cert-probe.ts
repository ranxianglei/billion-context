// #4403 P0-2: capture what certificate an upstream ACTUALLY presents when TLS
// verification fails. Node/undici error objects carry no certificate bytes on a
// trust failure (code + message only), so subject/issuer/SAN/fingerprint — the
// fields that separate "enterprise scanner re-signed it" from "link injection
// presented a forged cert" — are only learnable from one short-lived handshake
// with verification disabled. The probe is fired fire-and-forget at FINAL
// trust-code failures (direct mode only, see wantsCertProbe); results cache per
// host so a client retry storm probes once per TTL; describeUpstreamFailure
// reads the cache synchronously to enrich log lines and the 502 upstreamFailure
// slice. Honest boundary: the probe resolves the hostname AT PROBE TIME — under
// intermittent DNS poisoning that address may differ from the one the failed
// request reached, which is why outputs are labeled "probe". Never throws,
// never blocks the request path.

import * as net from "node:net";
import * as tls from "node:tls";
import { log as loggerLog } from "./logger.js";

export interface PresentedCertInfo {
    /** Address THIS probe connected to (probe-time resolution, not necessarily
     *  the failed request's). */
    remoteAddress?: string;
    subject?: string;
    issuer?: string;
    san?: string[];
    /** Lowercase hex sha256 of the DER encoding. */
    fingerprint256?: string;
}

const PROBE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 10 * 60_000;
const MAX_CONCURRENT_PROBES = 4;
const MAX_CACHE_ENTRIES = 64;

interface CacheEntry { at: number; info: PresentedCertInfo; }
let cache = new Map<string, CacheEntry>();
let inFlight = 0;

// Node 20 types the peer address as a method, Node >=22.18 as a property —
// engines allow both, so read whichever shape the runtime provides.
function socketRemoteAddress(socket: tls.TLSSocket): string | undefined {
    const value = (socket as unknown as { remoteAddress?: unknown }).remoteAddress;
    if (typeof value === "string") return value;
    if (typeof value === "function") {
        try { return value(); } catch { return undefined; }
    }
    return undefined;
}

function formatName(name: Record<string, unknown> | undefined): string | undefined {
    if (!name || typeof name !== "object") return undefined;
    const parts: string[] = [];
    for (const [key, value] of Object.entries(name)) {
        if (Array.isArray(value)) parts.push(`${key}=${value.join(",")}`);
        else if (value !== undefined && value !== null && String(value) !== "") parts.push(`${key}=${String(value)}`);
    }
    return parts.length > 0 ? parts.join(" ") : undefined;
}

function runProbe(hostname: string, port: number): Promise<PresentedCertInfo> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (info: PresentedCertInfo) => {
            if (settled) return;
            settled = true;
            resolve(info);
        };
        const socket = tls.connect({ host: hostname, port, servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: false }, () => {
            try {
                const info: PresentedCertInfo = {};
                const remote = socketRemoteAddress(socket);
                if (remote !== undefined && remote !== "") info.remoteAddress = remote;
                const cert = socket.getPeerCertificate();
                if (cert && Object.keys(cert).length > 0) {
                    info.subject = formatName(cert.subject);
                    info.issuer = formatName(cert.issuer);
                    // Node reports SANs as a comma-separated string ("DNS:a,DNS:b")
                    // on current runtimes while older releases exposed an array —
                    // normalize both shapes and strip the "DNS:" tag so consumers
                    // compare against plain target hostnames (the mitm-suspect SAN
                    // cross-check would otherwise never match).
                    const rawAlt: unknown = cert.subjectaltname;
                    const altEntries: string[] = Array.isArray(rawAlt)
                        ? rawAlt.filter((e): e is string => typeof e === "string")
                        : typeof rawAlt === "string" && rawAlt.length > 0 ? rawAlt.split(",") : [];
                    const san = altEntries.map((e) => e.trim().replace(/^DNS:/, "")).filter((e) => e !== "");
                    if (san.length > 0) info.san = san;
                    // Node renders it upper-case colon-separated ("AB:CD:…"); the
                    // contract here is canonical lowercase hex so the two forensic
                    // surfaces (probe + caFile identity log) cross-check 1:1.
                    if (typeof cert.fingerprint256 === "string" && cert.fingerprint256.length > 0) info.fingerprint256 = cert.fingerprint256.toLowerCase().replace(/:/g, "");
                }
                finish(info);
            } catch {
                finish({});
            } finally {
                socket.destroy();
            }
        });
        const timer = setTimeout(() => { socket.destroy(); finish({}); }, PROBE_TIMEOUT_MS);
        socket.once("error", () => { clearTimeout(timer); socket.destroy(); finish({}); });
        socket.once("close", () => { clearTimeout(timer); finish({}); });
    });
}

function freshEntry(key: string): CacheEntry | undefined {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= CACHE_TTL_MS) {
        cache.delete(key);
        return undefined;
    }
    return entry;
}

/** Synchronous read for the render paths (log line, 502 body, circuit banner):
 *  the last probe result for this host while fresh, else undefined. */
export function presentedCertOf(url: string): PresentedCertInfo | undefined {
    try {
        const u = new URL(url);
        if (u.protocol !== "https:") return undefined;
        return freshEntry(u.host)?.info;
    } catch {
        return undefined;
    }
}

/** Fire-and-forget forensic probe. No-op for non-https URLs, hosts with a
 *  fresh cached result, or when the concurrency cap is reached. */
export function scheduleCertProbe(url: string): void {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return;
    }
    if (u.protocol !== "https:") return;
    const key = u.host;
    if (freshEntry(key)) return;
    if (inFlight >= MAX_CONCURRENT_PROBES) return;
    inFlight += 1;
    void runProbe(u.hostname, u.port !== "" ? Number(u.port) : 443).then((info) => {
        inFlight -= 1;
        if (Object.keys(info).length === 0) {
            loggerLog("warn", `[acp-proxy] TLS forensics probe ${key}: no certificate captured (handshake did not complete within ${PROBE_TIMEOUT_MS}ms) (#4403)`);
            return;
        }
        if (cache.size >= MAX_CACHE_ENTRIES) {
            let oldestKey: string | undefined;
            let oldestAt = Infinity;
            for (const [k, e] of cache) {
                if (e.at < oldestAt) {
                    oldestAt = e.at;
                    oldestKey = k;
                }
            }
            if (oldestKey !== undefined) cache.delete(oldestKey);
        }
        cache.set(key, { at: Date.now(), info });
        const bits = [
            `connected ${info.remoteAddress ?? "?"}`,
            ...(info.subject ? [`subject=${info.subject}`] : []),
            ...(info.issuer ? [`issuer=${info.issuer}`] : []),
            ...(info.san ? [`san=[${info.san.join(", ")}]`] : []),
            ...(info.fingerprint256 ? [`fp256=${info.fingerprint256}`] : []),
        ];
        loggerLog("warn", `[acp-proxy] TLS forensics probe ${key}: ${bits.join(" ")} (#4403)`);
    }).catch(() => {
        inFlight -= 1;
    });
}

export function _resetCertProbeForTest(): void {
    cache = new Map();
    inFlight = 0;
}

/** Test seam: seed the cache as if a probe had already landed for this host. */
export function _seedCertProbeForTest(url: string, info: PresentedCertInfo): void {
    try {
        cache.set(new URL(url).host, { at: Date.now(), info });
    } catch { /* invalid url — nothing to seed */ }
}
