// Phase 1 of the Vertex port. Claude Code with CLAUDE_CODE_USE_VERTEX=1 talks to
// a Google endpoint the launcher has to route through the /bili/ URL form, and
// the two halves of that decision live here: is Vertex on, and which host is the
// client about to hit? Everything in this module is pure — no imports from src/
// — so launcher.ts, plugin-install.ts and later the proxy can share one
// derivation without forming a cycle.
//
// The derived hosts follow headroom's vertex_target_for_location
// (headroom/providers/vertex/runtime.py:68-91), which is the only prior art we
// have for this mapping.

/** Location labels are interpolated into a hostname, so they are validated first.
 *  The guard's payload is a percent-encoded `#`: `169.254.169.254#` survives
 *  decoding as a fragment, which an HTTP client reads as host 169.254.169.254 —
 *  SSRF to the GCP metadata endpoint (CWE-918). headroom learned this the hard
 *  way and carries the same regex. */
const VERTEX_LOCATION_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Multi-region locations are served from their own host shape (`us`=US, `eu`=EU). */
const VERTEX_MULTI_REGIONS = new Set(["us", "eu"]);

/** The global endpoint. A project with only global access (ours) 404s everywhere
 *  else, and global is ~10% cheaper than a regional endpoint. */
const VERTEX_GLOBAL_HOST = "https://aiplatform.googleapis.com";

type VertexHostSource = "explicit" | "derived";

interface VertexHost {
    /** What to wrap in the /bili/ URL: an explicit base URL as configured, or the
     *  derived host. NOT necessarily an origin — an explicit value may carry a
     *  path, and the client appends its own project/location path to it. */
    host: string;
    /** The location the host was derived from; null when the value was explicit. */
    location: string | null;
    source: VertexHostSource;
}

/** Which host the client is about to talk to, or null when nothing is derivable.
 *
 *  An explicit ANTHROPIC_VERTEX_BASE_URL wins outright: it may point at a private
 *  endpoint, a gateway or a relay, and the client appends its own
 *  /projects/{p}/locations/{l}/… path to whatever it is given. Deriving from the
 *  location instead is correct only because the client builds that path from
 *  CLOUD_ML_REGION — host and path location must agree or Vertex 404s, so the
 *  launcher reads the same variable the client does.
 *
 *  Unset or malformed location with no explicit value returns null rather than
 *  inventing a region: this project is global-only, and a guessed region answers
 *  404 for every request. The caller warns. */
export function vertexHostForLocation(location: string | undefined, explicitBaseUrl?: string): VertexHost | null {
    const explicit = explicitBaseUrl?.trim();
    if (explicit) return { host: explicit, location: null, source: "explicit" };
    const loc = location?.trim().toLowerCase();
    if (!loc || !VERTEX_LOCATION_RE.test(loc)) return null;
    if (loc === "global") return { host: VERTEX_GLOBAL_HOST, location: loc, source: "derived" };
    if (VERTEX_MULTI_REGIONS.has(loc)) return { host: `https://aiplatform.${loc}.rep.googleapis.com`, location: loc, source: "derived" };
    return { host: `https://${loc}-aiplatform.googleapis.com`, location: loc, source: "derived" };
}

/** The value to hand the client as ANTHROPIC_VERTEX_BASE_URL, or null.
 *
 *  A derived host gains the /v1 segment: the client appends `/projects/…` to this
 *  value verbatim, and Vertex serves `/v1/projects/…` while 404ing the
 *  version-less path (live, 2026-10-15). An explicit value is returned untouched
 *  — a user-configured endpoint is theirs to shape, and doubling a version
 *  segment would break it; see vertexBaseUrlLacksV1 for the warning. */
export function vertexBaseUrlForLocation(location: string | undefined, explicitBaseUrl?: string): string | null {
    const target = vertexHostForLocation(location, explicitBaseUrl);
    if (!target) return null;
    if (target.source === "explicit") return target.host;
    return `${target.host.replace(/\/+$/, "")}/v1`;
}

/** True when a configured base URL carries no /v1 segment. Not a hard error — the
 *  user may have a gateway that adds one — but the launcher warns, because the
 *  common case (pointing at an origin) answers 404 on every request. */
export function vertexBaseUrlLacksV1(value: string): boolean {
    return !/\/v1\/?$/.test(value.trim());
}

/** Is Vertex the lane's provider? Claude Code's own switch:
 *  `CLAUDE_CODE_USE_VERTEX=1` on, `0`/`false`/`no`/`off` off, unset off. */
export function vertexEnabled(env: NodeJS.ProcessEnv): boolean {
    const raw = env.CLAUDE_CODE_USE_VERTEX?.trim().toLowerCase();
    if (!raw) return false;
    return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

/** Vertex model ids are mixed-convention: `claude-haiku-5-5` is bare and GA,
 *  `claude-haiku-4-5@20251001` carries a date suffix, and both are valid on the
 *  wire (live probe, 2026-10-15). Registry and window lookups key on the
 *  version-less family id, so the suffix is stripped for those — never for the
 *  request, which must carry exactly what the user configured. */
export function normalizeVertexModelId(id: string): string {
    const trimmed = id.trim();
    const at = trimmed.indexOf("@");
    return at > 0 ? trimmed.slice(0, at) : trimmed;
}

/** Unwrap bili's own `/bili/` wrapper from a base URL, repeatedly until the value
 *  is not one of ours any more.
 *
 *  A configured base URL is not necessarily the user's: bili writes this key
 *  itself (the managed settings block, and the launcher's per-launch child env),
 *  so the next run reads back a URL we built. Unwrapping ONCE is not enough —
 *  bili 0.1.197's Vertex managed block wrapped an already-managed value, so the
 *  live file can hold two or more layers, and each extra layer targets the
 *  proxy's own port, which the tunnel guard denies (403 detail:"self"). The loop
 *  is bounded because the depth is a hand-built nest, not attacker input; the
 *  related single-shot `unwrapBiliBaseUrl` in plugin-install.ts stays as it is
 *  (ANTHROPIC_BASE_URL's writer cannot nest — it re-wraps only a foreign value). */
export function stripBiliWrappers(value: string): string {
    let out = value.trim();
    for (let i = 0; i < 8; i += 1) {
        const m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/bili\/(?:[a-z]+\/)?(https?:\/\/.+)$/.exec(out);
        if (m === null) return out;
        out = m[1].trim();
    }
    return out;
}
