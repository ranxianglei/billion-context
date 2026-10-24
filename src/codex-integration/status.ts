import { resolveCodexHome } from "../client-config.js";
import { lanePreferredPort } from "../instance.js";
import {
    codexRouteRecordPath,
    readCodexRoute,
    readCodexRouteRecord,
} from "./route.js";
import fs from "node:fs";
import path from "node:path";

type CodexIntegrationState =
    | "proxy-ready"
    | "configured"
    | "verified"
    | "bypassed"
    | "unknown";

export interface CodexIntegrationReport {
    state: CodexIntegrationState;
    route: "owned" | "foreign" | "absent";
    proxyHealthy: boolean;
    observedCodexRequest: boolean;
    detail: string;
}

interface CodexStatusDeps {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    codexConfigText?: string;
    origin?: string;
}

/** How long a real Codex request keeps counting as evidence. Long enough that a
 *  session idling while the user works still reads as verified, short enough
 *  that a session restored from disk months ago cannot. */
const CODEX_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60_000;

/** Upstreams bili's own tests and E2E harnesses point at. A session served from
 *  one of these proves the forwarding path works, never that a USER's Codex is
 *  routed — those fixtures are why this module needs any exclusion at all. */
function isLoopbackUpstream(value: unknown): boolean {
    if (typeof value !== "string") return false;
    return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:[/]|$)/i.test(
        value.trim(),
    );
}

/** A session that only the native Codex CLI can have created. Two independent
 *  signals, either sufficient:
 *   - `codexClient`: the bounded header hint the server stored at session
 *     creation; absent (null) on sessions that predate it.
 *   - `protocol === "responses"`: the OpenAI Responses wire API, which in this
 *     deployment only Codex's `wire_api = "responses"` selects (every other
 *     lane speaks chat-completions).
 *  A hint naming a DIFFERENT client vetoes the session, so a foreign Responses
 *  client can never be read as Codex evidence. */
function isCodexSession(row: Record<string, unknown>): boolean {
    const hint = row.clientHint;
    if (typeof hint === "string" && hint.length > 0) {
        if (!hint.toLowerCase().includes("codex")) return false;
        return true;
    }
    return row.codexClient === true || row.protocol === "responses";
}

function configText(env: NodeJS.ProcessEnv): string {
    try {
        return fs.readFileSync(
            path.join(resolveCodexHome(env), "config.toml"),
            "utf8",
        );
    } catch {
        return "";
    }
}

/** One session row's worth of evidence: a real, recent, non-fixture Codex
 *  request. Kept separate from `isCodexSession` so the shape predicates and the
 *  freshness policy can be read (and tested) independently. */
function isCodexEvidence(row: Record<string, unknown>, now: number): boolean {
    if (!isCodexSession(row)) return false;
    if (isLoopbackUpstream(row.upstream)) return false;
    if (typeof row.requests !== "number" || row.requests <= 0) return false;
    const lastSeenMs = row.lastSeenMs;
    const lastSeen = row.lastSeen;
    const seenAt =
        typeof lastSeenMs === "number"
            ? lastSeenMs
            : typeof lastSeen === "string"
                ? Date.parse(lastSeen)
                : Number.NaN;
    const age = now - seenAt;
    return age >= 0 && age <= CODEX_EVIDENCE_MAX_AGE_MS;
}

interface ProxyFacts {
    proxyHealthy: boolean;
    observedCodexRequest: boolean;
}

/** Read-only probe of the stable Codex lane origin. Every failure — refused
 *  connection, timeout, malformed payload — reads as "no evidence", never as
 *  negative proof about the user's setup. */
async function probeProxy(
    origin: string,
    fetchImpl: typeof fetch,
): Promise<ProxyFacts> {
    const absent: ProxyFacts = {
        proxyHealthy: false,
        observedCodexRequest: false,
    };
    try {
        const response = await fetchImpl(`${origin}/__bili/health`, {
            signal: AbortSignal.timeout(1200),
        });
        if (!response.ok) return absent;
        const health: unknown = await response.json();
        const healthy =
            health !== null &&
            typeof health === "object" &&
            (health as Record<string, unknown>).ok === true;
        if (!healthy) return absent;
        const stats = await fetchImpl(`${origin}/__bili/stats`, {
            signal: AbortSignal.timeout(1600),
        });
        if (!stats.ok) return { proxyHealthy: true, observedCodexRequest: false };
        const data: unknown = await stats.json();
        const sessions =
            data !== null && typeof data === "object"
                ? (data as Record<string, unknown>).sessions
                : undefined;
        if (!Array.isArray(sessions))
            return { proxyHealthy: true, observedCodexRequest: false };
        const now = Date.now();
        return {
            proxyHealthy: true,
            observedCodexRequest: sessions.some(
                (entry) =>
                    entry !== null &&
                    typeof entry === "object" &&
                    isCodexEvidence(entry as Record<string, unknown>, now),
            ),
        };
    } catch {
        return absent;
    }
}

export async function inspectCodexIntegration(
    deps: CodexStatusDeps = {},
): Promise<CodexIntegrationReport> {
    const env = deps.env ?? process.env;
    const text = deps.codexConfigText ?? configText(env);
    const file = path.join(resolveCodexHome(env), "config.toml");
    const route = readCodexRoute(
        text,
        readCodexRouteRecord(codexRouteRecordPath(file)),
    );
    const origin = (
        deps.origin ?? `http://127.0.0.1:${lanePreferredPort("codex", env)}`
    ).replace(/\/+$/, "");
    const { proxyHealthy, observedCodexRequest } = await probeProxy(
        origin,
        deps.fetchImpl ?? fetch,
    );
    const report = (
        state: CodexIntegrationState,
        detail: string,
        routeOverride?: "owned" | "foreign" | "absent",
    ): CodexIntegrationReport => ({
        state,
        route:
            routeOverride ??
            (route.routed ? "owned" : route.conflict ? "foreign" : "absent"),
        proxyHealthy,
        observedCodexRequest,
        detail,
    });
    if (observedCodexRequest)
        return report("verified", "bili observed a real Codex model request");
    if (route.conflict !== undefined)
        return report(
            "bypassed",
            route.conflict.kind === "shadowed-by-provider"
                ? `Codex provider ${route.conflict.provider} owns the effective base_url`
                : "openai_base_url is not owned by bili; left untouched",
            "foreign",
        );
    if (route.routed)
        return report(
            "configured",
            proxyHealthy
                ? "bili route is configured; no Codex model request observed yet"
                : "bili route is configured; proxy health has not been confirmed",
            "owned",
        );
    if (proxyHealthy)
        return report(
            "proxy-ready",
            "proxy is healthy; Codex model route is not configured",
            "absent",
        );
    return report(
        "unknown",
        text.length === 0
            ? "Codex config is unavailable and no proxy health evidence is available"
            : "no route ownership or live proxy evidence is available",
        "absent",
    );
}
