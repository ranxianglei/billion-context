// #2984: shared private-upstream host detection — the single home for the
// predicate that decides which hosts count as "private" (loopback, RFC1918,
// link-local, ULA, mDNS/LAN names, IPv4-mapped IPv6). Consumers:
//   - the codex launcher auto-fallback (src/launcher.ts): private upstreams
//     cannot parse codex's `namespace` tool type, so MCP injection falls back
//     to wire mode;
//   - the four plain-HTTP trust gates (#2585): when network.allowPrivateHttpProviders
//     is on, a private host joins the loopback set for plaintext admission.
//
// The loopback list stays its own constant: with the switch OFF the gates
// trust EXACTLY {localhost, 127.0.0.1, [::1]} (byte-stable with pre-#2984
// behavior); the wider private set applies only when the knob is on.

/** Hostnames trusted over plain HTTP even with network.allowPrivateHttpProviders off. */
export const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;

function isPrivateIPv4(host: string): boolean {
    const a = Number.parseInt(host.split(".")[0] ?? "", 10);
    const b = Number.parseInt(host.split(".")[1] ?? "", 10);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

/** True for a parsed hostname (WHATWG URL .hostname — IPv6 keeps brackets):
 *  loopback, RFC1918, 0/8, link-local, IPv6 ULA, an mDNS/LAN name, or an
 *  IPv4-mapped IPv6 form over a private IPv4. CGNAT (100.64/10, e.g. Tailscale)
 *  is deliberately NOT private — #2984 keeps it refused. */
export function isPrivateHostname(hostname: string): boolean {
    let host = hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".internal")) return true;
    if (host.startsWith("[")) host = host.slice(1, -1);
    if (host.includes(":")) {
        if (host === "::1" || host === "::") return true;
        const first = host.split(":")[0] ?? "";
        if (/^f[cd]/.test(first)) return true;
        if (/^fe[89ab]/.test(first)) return true;
        const dotted = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
        if (dotted && isPrivateIPv4(dotted[1]!)) return true;
        const hex = /::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
        if (hex) {
            const w1 = Number.parseInt(hex[1]!, 16);
            const w2 = Number.parseInt(hex[2]!, 16);
            if (isPrivateIPv4(`${w1 >> 8}.${w1 & 0xff}.${w2 >> 8}.${w2 & 0xff}`)) return true;
        }
        return false;
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIPv4(host);
    return false;
}

/** True when the URL's host points at self-hosted inference: loopback, RFC1918,
 *  link-local, IPv6 ULA, or an mDNS/LAN name. Those servers (sglang/vllm/ollama/
 *  llama.cpp) do not understand codex's `namespace` tool type, so MCP-injected
 *  tools would be silently invisible to the model. Moved verbatim from
 *  src/launcher.ts (#2984). */
export function isPrivateUpstreamHost(raw: string): boolean {
    let host: string;
    try {
        host = new URL(raw).hostname.toLowerCase();
    } catch {
        return false;
    }
    return isPrivateHostname(host);
}

/** #2984: the plain-HTTP trust decision shared by all four #2585 gates.
 *  Loopback is always trusted; private networks join only when allowPrivate
 *  is on. Public hosts stay untrusted either way — HTTPS is their only path. */
export function plainHttpTrusted(url: URL, allowPrivate: boolean): boolean {
    if ((LOOPBACK_HOSTNAMES as readonly string[]).includes(url.hostname)) return true;
    return allowPrivate && isPrivateHostname(url.hostname);
}
