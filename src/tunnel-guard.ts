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
 */

export const BILI_TUNNEL_HEADER = "x-bili-tunnel";

export type IpClass = "loopback" | "linkLocal" | "private" | "public";

/** Parse a v4 quad or v6 literal (incl. ::ffff: mapped); null for names. */
export function parseIpLiteral(s: string): string | null {
    const t = s.trim().toLowerCase();
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return t;
    if (t.includes(":")) return t; // v6 literal (possibly mapped); names never contain ':'
    return null;
}

export function classifyIp(ip: string): IpClass {
    const lit = parseIpLiteral(ip);
    if (!lit) return "public";
    // v6 (incl. ::ffff:a.b.c.d mapped — normalize BEFORE the v4 branch, which
    // would otherwise split on the dots of a mapped literal and NaN out).
    if (lit.includes(":")) {
        if (lit === "::1" || lit === "::") return "loopback";
        const mapped = lit.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return classifyIp(mapped[1]);
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

export const dnsResolveHost: ResolveHost = async (host) => {
    const res = await lookup(host, { all: true, family: 0 });
    return res.map((r) => r.address);
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
}

export type TunnelVerdict = { ok: true } | { ok: false; code: "self" | "linkLocal" | "privateRemote" | "unresolvable"; message: string };

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
        return { ok: false, code: "unresolvable", message: `invalid tunnel destination ${origin}` };
    }
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    let ips: string[];
    const literal = parseIpLiteral(host);
    if (literal) {
        ips = [literal];
    } else {
        try {
            ips = await (ctx.resolveHost ?? dnsResolveHost)(host);
        } catch {
            return { ok: false, code: "unresolvable", message: `cannot resolve tunnel destination ${host}` };
        }
        if (ips.length === 0) return { ok: false, code: "unresolvable", message: `no addresses for tunnel destination ${host}` };
    }
    // Layer 1: the proxy itself — the /__bili/ management plane must never be
    // reachable through the tunnel, from any client.
    if (ctx.selfPort !== undefined && port === ctx.selfPort) {
        const mine = (ctx.localIps ?? localMachineIps)();
        if (ips.some((ip) => mine.has(ip.toLowerCase()) || mine.has(`::ffff:${ip.toLowerCase()}`))) {
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
