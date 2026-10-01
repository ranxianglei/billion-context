import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";

/**
 * Tunnel admission for the `/bili/<absolute-url>` zero-config branch (#409).
 *
 * The CONNECT/MITM side has destination admission (mitm.ts — whitelisted
 * hosts, loopback-only blind tunnels). The /bili/ absolute-URL side had none:
 * it would happily forward to the proxy's OWN /__bili/ management plane (the
 * inner connection originates from the proxy, so the loopback admin gate
 * passes), to link-local metadata addresses, or — on a `--host 0.0.0.0`
 * deployment — to anything reachable from this machine, turning bili into a
 * LAN-reachable SSRF pivot despite the "management stays loopback-only"
 * promise.
 *
 * Policy (destination × client):
 *   - the proxy itself (same port, own addresses incl. 127/8) → always deny
 *   - link-local / metadata ranges → always deny (no legitimate use through
 *     a model-traffic tunnel)
 *   - loopback/private destinations → allowed for loopback clients (the
 *     self-hosted-upstream case: sglang on 127.0.0.1:8199, ollama on
 *     11434, a LAN relay — the httpRewrites launcher flow DEPENDS on this),
 *     denied for remote clients unless the destination is on the explicit
 *     allowlist (BILI_TUNNEL_ALLOWED_HOSTS, "host" or "host:port" entries)
 *   - public destinations → allowed
 *
 * Hostnames are resolved before the verdict (an attacker must not bypass the
 * range checks with "metadata.google.internal" or a rebind-friendly name);
 * unresolvable names are denied outright. A DNS-rebinding race between the
 * check and the connect remains theoretically possible and accepted — the
 * `x-bili-tunnel` marker + management-plane rejection below is the second
 * layer that still holds when it happens.
 *
 * #1686: the admission lookup is bounded-retried (3 attempts, short backoff,
 * per-attempt timeout) because a transiently unreachable DNS server must not
 * be indistinguishable from a genuinely dead name — and the caller answers a
 * resolution failure with 5xx (transport-class), never 403 (permission-class),
 * so clients keep their retry logic alive while the resolver recovers.
 */

// #1686: admission-resolution budget. Per-attempt timeout because a dead OS
// resolver can otherwise hang getaddrinfo for tens of seconds (Windows);
// worst-case total admission delay ≈ 3 × RESOLVE_TIMEOUT_MS + 2 × backoff.
const RESOLVE_MAX_ATTEMPTS = 3;
const RESOLVE_BACKOFF_MS = 250;
const RESOLVE_TIMEOUT_MS = 2000;

export const BILI_TUNNEL_HEADER = "x-bili-tunnel";

export type IpClass = "loopback" | "linkLocal" | "private" | "public";

/** Parse a v4 quad or v6 literal (incl. ::ffff: mapped); null for names. */
export function parseIpLiteral(s: string): string | null {
    const t = s.trim().toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t;
    if (t.includes(":")) return t; // v6 literal (possibly mapped); names never contain ':'
    return null;
}

/** IPv4-mapped v6 in ANY form → the plain dotted quad: both the dotted
 *  `::ffff:1.2.3.4` and the HEX form `::ffff:102:304` the WHATWG URL parser
 *  canonicalizes hostnames to (`new URL("http://[::ffff:127.0.0.1]/")` yields
 *  `[::ffff:7f00:1]`), which otherwise sails past every dotted-only matcher.
 *  Range classification and self-membership then see one shape. */
export function normalizeIpLiteral(ip: string): string {
    const t = ip.trim().toLowerCase();
    if (!t.startsWith("::ffff:")) return t;
    const dotted = t.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted) return dotted[1];
    const hex = t.match(/^::ffff:0*([0-9a-f]{1,4}):0*([0-9a-f]{1,4})$/);
    if (hex) {
        const hi = parseInt(hex[1], 16);
        const lo = parseInt(hex[2], 16);
        return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
    return t;
}

export function classifyIp(ip: string): IpClass {
    const lit = normalizeIpLiteral(parseIpLiteral(ip) ?? "");
    if (!lit) return "public";
    if (lit.includes(":")) {
        if (lit === "::1" || lit === "::") return "loopback";
        if (lit.startsWith("fe8") || lit.startsWith("fe9") || lit.startsWith("fea") || lit.startsWith("feb")) return "linkLocal";
        if (lit.startsWith("fc") || lit.startsWith("fd")) return "private"; // fc00::/7 ULA
        return "public";
    }
    const parts = lit.split(".").map(Number);
    const [a, b] = parts;
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "linkLocal";
    if (a === 10 || a === 0) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT shared space
    return "public";
}

export type ResolveHost = (host: string) => Promise<string[]>;

// The native lookup({timeout}) option exists at runtime (Node ≥ 15.3) but is
// missing from @types/node's LookupOptions — race instead of casting. The
// losing lookup stays handled (Promise.race subscribes to both sides), so a
// late OS-resolver failure cannot surface as an unhandled rejection.
export const dnsResolveHost: ResolveHost = async (host) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const res = await Promise.race([
            lookup(host, { all: true, family: 0 }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })), RESOLVE_TIMEOUT_MS);
                timer.unref?.();
            }),
        ]);
        return res.map((r) => r.address);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

let localAddrCache: { at: number; ips: Set<string> } | undefined;
/** All addresses considered "this machine": 127/8 + ::1 + every interface unicast addr. */
export function localMachineIps(): Set<string> {
    const now = Date.now();
    if (!localAddrCache || now - localAddrCache.at > 30_000) {
        const ips = new Set<string>(["127.0.0.1", "::1"]);
        for (const list of Object.values(networkInterfaces())) {
            for (const ni of list ?? []) {
                if (ni.address) ips.add(ni.address.toLowerCase());
            }
        }
        // The whole 127/8 loopback range routes to this machine.
        for (let i = 0; i <= 255; i++) ips.add(`127.0.0.${i}`);
        localAddrCache = { at: now, ips };
    }
    return localAddrCache.ips;
}

export interface TunnelCheckContext {
    /** Port this proxy is actually serving on (server.address()). */
    selfPort: number | undefined;
    clientLoopback: boolean;
    allowlist: string[];
    resolveHost?: ResolveHost;
    localIps?: () => Set<string>;
    /** Backoff between admission-resolution retries (default RESOLVE_BACKOFF_MS). */
    resolveBackoffMs?: number;
}

export type TunnelVerdict = { ok: true } | { ok: false; code: "self" | "linkLocal" | "privateRemote" | "unresolvable" | "invalid"; message: string };

function allowlistHit(host: string, port: number, allowlist: string[]): boolean {
    const h = host.toLowerCase();
    const hp = `${h}:${port}`;
    return allowlist.some((e) => e === h || e === hp);
}

export async function checkTunnelDestination(origin: string, ctx: TunnelCheckContext): Promise<TunnelVerdict> {
    let u: URL;
    try {
        u = new URL(origin);
    } catch {
        return { ok: false, code: "invalid", message: `invalid tunnel destination ${origin}` };
    }
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    let ips: string[];
    const literal = parseIpLiteral(host);
    if (literal) {
        ips = [normalizeIpLiteral(literal)];
    } else {
        // #1686: bounded retry — a transiently unreachable DNS server must not
        // masquerade as a dead name. Only throws are retried; an empty answer
        // is definitive (the resolver said so).
        const resolve = ctx.resolveHost ?? dnsResolveHost;
        const backoff = ctx.resolveBackoffMs ?? RESOLVE_BACKOFF_MS;
        let resolved: string[] | undefined;
        for (let attempt = 1; attempt <= RESOLVE_MAX_ATTEMPTS; attempt++) {
            try {
                resolved = await resolve(host);
                break;
            } catch {
                if (attempt === RESOLVE_MAX_ATTEMPTS) break;
                await new Promise<void>((r) => setTimeout(r, backoff));
            }
        }
        if (resolved === undefined) return { ok: false, code: "unresolvable", message: `cannot resolve tunnel destination ${host}` };
        ips = resolved;
        if (ips.length === 0) return { ok: false, code: "unresolvable", message: `no addresses for tunnel destination ${host}` };
    }
    // Layer 1: the proxy itself — the /__bili/ management plane must never be
    // reachable through the tunnel, from any client. 0.0.0.0/:: as a
    // destination routes to the local host, so our own port through them is
    // a self-loop even though neither literal sits in the interface set.
    if (ctx.selfPort !== undefined && port === ctx.selfPort) {
        const mine = (ctx.localIps ?? localMachineIps)();
        if (ips.some((ip) => ip === "0.0.0.0" || ip === "::" || mine.has(ip.toLowerCase()) || mine.has(`::ffff:${ip.toLowerCase()}`))) {
            return { ok: false, code: "self", message: "the bili tunnel may not target the proxy itself" };
        }
    }
    // Layer 2: link-local / metadata — no legitimate model upstream lives there.
    const classes = ips.map((ip) => classifyIp(ip));
    if (classes.includes("linkLocal")) {
        return { ok: false, code: "linkLocal", message: "link-local / metadata destinations are blocked from the bili tunnel" };
    }
    // Layer 3: loopback / private — fine for local clients (self-hosted
    // upstreams), denied for remote clients unless explicitly allowlisted.
    if (!classes.every((c) => c === "public")) {
        if (ctx.clientLoopback) return { ok: true };
        if (allowlistHit(host, port, ctx.allowlist)) return { ok: true };
        return {
            ok: false,
            code: "privateRemote",
            message: `tunnel destination ${host} resolves to a loopback/private address; remote clients may only reach it via BILI_TUNNEL_ALLOWED_HOSTS`,
        };
    }
    return { ok: true };
}

/** Parse BILI_TUNNEL_ALLOWED_HOSTS ("host" / "host:port", comma-separated). */
export function tunnelAllowlistFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
    const raw = env.BILI_TUNNEL_ALLOWED_HOSTS ?? "";
    return raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
}
