// Kiro CLI (AWS, kiro.dev) support.
//
// Kiro CLI's agent talks to its model gateway over the OpenAI Responses wire:
// `POST https://runtime.<region>.kiro.dev/v1/responses` with `{ model, input,
// tools, stream, origin, profileArn, metadata }`, streamed back as
// text/event-stream. It replays the FULL history every turn (input[] grows),
// authenticates with a bearer token (no body signature), honors HTTPS_PROXY,
// and trusts extra roots via NODE_EXTRA_CA_CERTS (its Node agent server) and
// SSL_CERT_FILE (its Rust shell) — so the existing `responses` pipeline
// compresses it once two gateway quirks are handled here:
//
//   1. Roles: the gateway accepts only `user` / `assistant` message items.
//      bili's injected compress prompt rides a `developer` item at input[0]
//      (and `system` is rejected the same way): 400 "This request contains
//      parameters or input that are not supported", param input[0]. Kiro
//      itself sends its own system prompt as a `user` item, so the built-in
//      compat map re-voices developer/system → user for Kiro traffic.
//   2. Identity: every request carries `metadata["kiro:conversation_id"]`
//      (stable across turns and `kiro-cli chat --resume`), while Kiro's own
//      first item (its system prompt) is not byte-stable across processes, so
//      content-prefix affinity mints a fresh session per resumed process. The
//      conversation id is promoted to the session identity instead.
//
// Kiro's other runtime calls (KiroRuntimeService.* AWS-JSON at "/") are not a
// model wire and keep relaying byte-for-byte.

/** Kiro model gateways, cert-MITM'd so `bili kiro` compresses the model
 *  traffic. Commercial regions plus GovCloud, from the endpoint table compiled
 *  into kiro-cli 2.37. Everything else Kiro talks to (management, telemetry,
 *  auth) stays blind-tunneled. */
export const KIRO_DEFAULT_MODEL_HOSTS = [
    "runtime.us-east-1.kiro.dev",
    "runtime.eu-central-1.kiro.dev",
    "runtime.us-gov-east-1.kiro.dev",
    "runtime.us-gov-west-1.kiro.dev",
];

/** Roles the Kiro gateway rejects, re-voiced to the one it accepts. */
export const KIRO_COMPAT_ROLES: Readonly<Record<string, string>> = Object.freeze({ developer: "user", system: "user" });

const KIRO_HOST = /^runtime\.[a-z0-9-]+\.kiro\.dev$/i;

type Headers = Record<string, string | string[] | undefined>;
const header = (headers: Headers, name: string): string => {
    const v = headers[name] ?? headers[name.toLowerCase()];
    return (Array.isArray(v) ? v[0] : v) ?? "";
};

/** Is this request Kiro CLI model traffic? User-Agent `KiroCLI/…` or Kiro's
 *  own origin header, on a Kiro runtime host (when the upstream is known). */
export function isKiroRequest(headers: Headers, upstreamUrl?: string): boolean {
    const ua = header(headers, "user-agent");
    const kiroClient = /^KiroCLI\//.test(ua) || header(headers, "x-amzn-kiro-origin") !== "";
    if (!kiroClient) return false;
    if (upstreamUrl === undefined) return true;
    try {
        return KIRO_HOST.test(new URL(upstreamUrl).hostname);
    } catch {
        return false;
    }
}

/** Built-in compat roles for this request: Kiro's map for Kiro traffic, else
 *  none. Lowest precedence — configured `compat.roles` and learned roles
 *  overlay it per key (relay.ts). */
export function builtinCompatRoles(headers: Headers, upstreamUrl: string | undefined): Record<string, string> {
    return isKiroRequest(headers, upstreamUrl) ? { ...KIRO_COMPAT_ROLES } : {};
}

/** `metadata["kiro:conversation_id"]` of a Kiro Responses body, if any. */
export function kiroConversationId(body: unknown): string | undefined {
    if (!body || typeof body !== "object") return undefined;
    const metadata = (body as { metadata?: unknown }).metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
    const id = (metadata as Record<string, unknown>)["kiro:conversation_id"];
    return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

type Identity = { value: string; source: string; clientProvided: boolean };

/** Promote Kiro's conversation id over a content fingerprint (never over a
 *  real conversation header, session_id, or prompt_cache_key). Only for Kiro
 *  traffic: the `kiro:` metadata key is Kiro's own namespace. */
export function preferKiroConversationIdentity<T extends Identity>(identity: T | undefined, body: unknown, headers: Headers): T | undefined {
    if (!identity || identity.source !== "content-fingerprint" || !isKiroRequest(headers)) return identity;
    const id = kiroConversationId(body);
    if (id === undefined) return identity;
    return { ...identity, value: `kiro-${id}`, source: "metadata-session", clientProvided: true };
}

/** Input positions whose role the BUILT-IN map re-voiced (and that no configured
 *  or learned role overrode), with their original role. Only used to let the
 *  advisory invariant judge see bili's injected developer prompt as itself;
 *  the forwarded body keeps the re-voiced roles. */
export function builtinRoleRestorePoints(
    body: string,
    protocol: "openai" | "responses",
    builtin: Record<string, string>,
    effective: Record<string, string>,
): Array<[number, string]> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        return [];
    }
    const items = protocol === "openai" ? (parsed as { messages?: unknown }).messages : (parsed as { input?: unknown }).input;
    if (!Array.isArray(items)) return [];
    const out: Array<[number, string]> = [];
    items.forEach((item, i) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return;
        const role = (item as { role?: unknown }).role;
        if (typeof role !== "string" || builtin[role] === undefined) return;
        if (effective[role] !== builtin[role]) return; // a configured/learned mapping won
        out.push([i, role]);
    });
    return out;
}

/** Shallow copy of a parsed Responses/chat body with the given roles restored. */
export function withRestoredRoles<T extends Record<string, unknown> | null>(parsed: T, points: Array<[number, string]>): T {
    if (parsed === null || points.length === 0) return parsed;
    const key = Array.isArray(parsed.input) ? "input" : Array.isArray(parsed.messages) ? "messages" : null;
    if (key === null) return parsed;
    const items = [...(parsed[key] as unknown[])];
    for (const [i, role] of points) {
        const item = items[i];
        if (item && typeof item === "object" && !Array.isArray(item)) items[i] = { ...(item as Record<string, unknown>), role };
    }
    return { ...parsed, [key]: items };
}
