import { findRoute, type ProxyOptions } from "./config.js";
import { SummaryCredentialStore } from "./external-summary-credentials.js";
import { maskUrlForLog } from "./log-mask.js";

/**
 * #2336 lane credential override (forward path). `providers[URL].apiKeyEnv`
 * / `credentialRef` let a lane send ITS OWN key upstream instead of the
 * client's credential — the owner's blueprint case: the agent-side registry
 * (pi) supplies a provider entry without a URL, bili's URL-keyed lane names
 * its own key, and the summary chain borrows the lane identity instead of the
 * client's. Resolution is per-egress-request but cheap: route lookup +
 * credential resolve, with the failure warning deduped per route+reference so
 * a permanently unset variable cannot spam the log on every request.
 *
 * Failure posture: resolve-miss (env unset / secret absent / store unreadable)
 * keeps the CLIENT's headers untouched and warns once — visible, never
 * silently dropping the request's auth to a guaranteed 401.
 */

export interface LaneCredential {
    key: string;
    reference: string;
}

const warnedLaneCredentials = new Set<string>();
let store = new SummaryCredentialStore();

/** Test seam (same convention as persist.ts `_setStoreForTest`): unit tests
 *  stub the credential store instead of touching the real private file. */
export function _setLaneCredentialStoreForTest(replacement: SummaryCredentialStore | undefined): void {
    store = replacement ?? new SummaryCredentialStore();
}

/** Resolve the lane credential for an upstream URL, or undefined when the
 *  lane declares none / the declared credential cannot be resolved (warned
 *  once per route+reference; re-arms after a success so a LATER breakage
 *  warns again). */
export function laneCredential(
    routes: ProxyOptions["routes"],
    upstreamUrl: string | undefined,
    warn: (message: string) => void,
    env: NodeJS.ProcessEnv = process.env,
): LaneCredential | undefined {
    const route = findRoute(routes, upstreamUrl);
    if (!route || (route.apiKeyEnv === undefined && route.credentialRef === undefined)) return undefined;
    const reference = route.apiKeyEnv !== undefined ? `env:${route.apiKeyEnv}` : `secret:${route.credentialRef}`;
    const signature = `${upstreamUrl ?? ""}|${reference}`;
    const fail = (reason: string): undefined => {
        if (!warnedLaneCredentials.has(signature)) {
            warnedLaneCredentials.add(signature);
            warn(`[lane-credential] ${reference} for ${upstreamUrl ? maskUrlForLog(upstreamUrl) : "the lane"} ${reason} — keeping the client's own headers (#2336)`);
        }
        return undefined;
    };
    let key: string | undefined;
    try {
        key = store.resolve(reference, env);
    } catch (error) {
        return fail(`cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
    if (key === undefined) return fail("is not set");
    warnedLaneCredentials.delete(signature);
    return { key, reference };
}

/** Land a resolved lane credential on the shared forward-header object.
 *  Header-replacement rules (documented on ProviderRoute.apiKeyEnv):
 *  - `x-api-key` / `x-goog-api-key` present → replaced outright;
 *  - `authorization` present → replaced ONLY when it is a Bearer token
 *    (anything else is a signature the client computed — replacing it
 *    would desynchronize body and signature);
 *  - none of the three present → inject `authorization: Bearer <key>`.
 *  Applied once to the shared `headers` record so every egress reusing it
 *  (initial send, role-retry, refold, compress-loop, continuation) inherits
 *  the override; call sites skip this when the #1884 re-sign arm is active. */
export function applyLaneCredential(headers: Record<string, string>, credential: LaneCredential, warn: (message: string) => void): void {
    const keyOf = (name: string): string | undefined => {
        if (name in headers) return name;
        return Object.keys(headers).find((h) => h.toLowerCase() === name);
    };
    const authorization = keyOf("authorization");
    const xApiKey = keyOf("x-api-key");
    const xGoogKey = keyOf("x-goog-api-key");
    if (xApiKey !== undefined) headers[xApiKey] = credential.key;
    if (xGoogKey !== undefined) headers[xGoogKey] = credential.key;
    if (authorization !== undefined) {
        if (/^bearer\s/i.test(headers[authorization])) headers[authorization] = `Bearer ${credential.key}`;
        else if (xApiKey === undefined && xGoogKey === undefined)
            warn(`[lane-credential] authorization on this lane is not a Bearer token — signature-owned, left untouched (#2336)`);
    } else if (xApiKey === undefined && xGoogKey === undefined) {
        headers.authorization = `Bearer ${credential.key}`;
    }
}
