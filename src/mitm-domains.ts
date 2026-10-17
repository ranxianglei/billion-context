// MITM domain matching shared by the CONNECT lane (mitm.ts) and the
// config-load diagnostics (config.ts). Kept as a LEAF module with zero bili
// imports: config.ts must not import mitm.ts, because mitm.ts pulls in
// knobs.ts, which imports loadConfigFile from config.ts — an import cycle.

/** Domains we transparently MITM by default. These are ONLY the model-inference endpoints
 *  hardcoded in client BINARIES with no config file to discover from
 *  (Claude=api.anthropic.com, codex-login=api.openai.com/chatgpt.com).
 *  Everything else is auto-discovered at runtime from each client's config
 *  (see discoverMitmDomains). Expanding this list expands the set of hosts
 *  whose TLS we terminate — the security boundary. */
export const DEFAULT_MITM_DOMAINS = [
    "api.anthropic.com",
    "api.openai.com",
    "chatgpt.com",
];

/** True when `host` equals one of `domains` or is a subdomain of one
 *  (case-insensitive both sides). */
export function matchesAnyMitmDomain(host: string, domains: string[]): boolean {
    const h = host.toLowerCase();
    return domains.some((d) => {
        const dl = d.toLowerCase();
        return h === dl || h.endsWith("." + dl);
    });
}
