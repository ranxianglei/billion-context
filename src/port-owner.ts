import { isProxyInstanceFile, type ProxyInstanceFile } from "./instance.js";

/** #2941: post-bind port-ownership verification + pointer-clobber guard for
 *  same-lane double-spawn residuals (#707 follow-ups). Conservative by
 *  design: positive evidence only — never yield/refuse on ambiguity. */

interface OwnerProbeInfo {
    pid?: number;
    instanceId?: string;
    /** Negative attribution: responder is up but pre-registration (#2941
     *  readiness gate) — see findForeignOwner for the handling. */
    reason?: string;
}

/** Structural fetch shape — global `fetch` satisfies it; tests inject bare objects. */
export type HealthFetcher = (url: string, init?: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

interface ProbeDeps {
    fetchImpl?: HealthFetcher;
    sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 1_500;

// #2941/#1529: a default fetch socket lingers ~4s (pooled keep-alive) AFTER
// the post-bind self-probe completes, sitting in OUR OWN conn ledger and
// inflating [exposure] liveConns in exactly the window the #1529
// hold-until-peer-FIN contract samples it (liveConns=2 instead of 1).
// `connection: close` makes every probe a dedicated socket that dies with
// its response — verified: immediate server-side close vs ~3.8s linger.
function probeFetch(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("connection", "close");
    return fetch(url, { ...init, headers });
}

function healthUrl(origin: string): string {
    return origin.replace(/\/+$/, "") + "/__bili/health";
}

/** One /__bili/health read. undefined when dead/non-JSON/not-ok — absence of
 *  evidence is not evidence of a foreign owner. */
export async function probeOwnerInfo(
    origin: string,
    fetchImpl: HealthFetcher = probeFetch,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<OwnerProbeInfo | undefined> {
    try {
        const res = await fetchImpl(healthUrl(origin), { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) {
            // #2941: our own pre-registration 503 carries reason:"starting" —
            // surface it so findForeignOwner self-attributes instead of burning
            // its probe budget on itself.
            const neg = (await res.json()) as { ok?: unknown; reason?: unknown };
            if (neg.ok === false && typeof neg.reason === "string") return { reason: neg.reason };
            return undefined;
        }
        const data = (await res.json()) as { ok?: unknown; pid?: unknown; instanceId?: unknown };
        if (data.ok !== true) return undefined;
        const info: OwnerProbeInfo = {};
        if (typeof data.pid === "number" && Number.isInteger(data.pid) && data.pid > 0) info.pid = data.pid;
        if (typeof data.instanceId === "string" && data.instanceId !== "") info.instanceId = data.instanceId;
        return info;
    } catch {
        return undefined;
    }
}

/** #2941: foreign live listener co-listening on our just-bound port? Multiple
 *  probes: dual-bind-tolerant platforms may distribute connections among the
 *  listeners, so one round-trip can hit our own socket. A responder WITHOUT a
 *  pid field (pre-#1753 builds) is unattributable — yielding on it would
 *  ratchet sticky ports during upgrade overlaps (#1723). */
export async function findForeignOwner(
    origin: string,
    ownPid: number,
    opts: { attempts?: number; intervalMs?: number; timeoutMs?: number } & ProbeDeps = {},
): Promise<OwnerProbeInfo | undefined> {
    const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS);
    const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = opts.fetchImpl ?? probeFetch;
    const sleepImpl = opts.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleepImpl(intervalMs);
        const info = await probeOwnerInfo(origin, fetchImpl, timeoutMs);
        if (info?.pid !== undefined && info.pid !== ownPid) return info;
        // #2941: a "starting" responder on our just-bound port is ourselves
        // mid-announce — /__bili/health gates until registration completes, so
        // without this every boot burned the full probe budget (~200ms+) on its
        // own pre-registration 503s and delayed pointer/registry publication
        // past callers that expect registration right after bind (#394 warn
        // timing in multi-instance-live). Bind is exclusive on every platform
        // bili ships on (Linux EADDRINUSE; Windows — libuv deliberately omits
        // SO_REUSEADDR there because setting it would allow stealing a port
        // held by another application, libuv src/win/tcp.c uv__tcp_try_bind),
        // so no foreign listener can be in that state here; a hypothetical
        // dual-bind co-starter would be unregistered anyway — the registry/
        // pointer layer surfaces the collision at registration time. Never
        // foreign.
        if (info?.reason === "starting") return undefined;
    }
    return undefined;
}

type PortClaimOutcome =
    | { kind: "claimed" }
    | { kind: "ladder"; nextPort: number; foreign: OwnerProbeInfo }
    | { kind: "die"; message: string };

function portOf(origin: string): number {
    try {
        return Number(new URL(origin).port || 80);
    } catch {
        return 0;
    }
}

/** #2941: what to do with a bound port whose ownership check found a foreign
 *  listener — mirrors the EADDRINUSE ladder contract (#407/#964): late binder
 *  moves +1, ephemeral after the attempt budget, strict-port/manual fail fast. */
export async function resolvePortClaim(params: {
    origin: string;
    ownPid: number;
    /** launchToken && !strictPort — the retry contract exists only for
     *  launcher-spawned children (#407); manual `bili start` stays fail-fast. */
    canLadder: boolean;
    listenAttempts: number;
    maxListenAttempts: number;
    probe?: { attempts?: number; intervalMs?: number; timeoutMs?: number } & ProbeDeps;
}): Promise<PortClaimOutcome> {
    const foreign = await findForeignOwner(params.origin, params.ownPid, params.probe);
    if (foreign === undefined) return { kind: "claimed" };
    const who = `another live proxy (pid ${foreign.pid}${foreign.instanceId !== undefined ? `, id ${foreign.instanceId.slice(0, 8)}` : ""})`;
    if (!params.canLadder) {
        return { kind: "die", message: `port ${portOf(params.origin)} is shared with ${who} — refusing to serve a contested port (#2941)` };
    }
    const attempts = params.listenAttempts + 1;
    const nextPort = attempts >= params.maxListenAttempts ? 0 : portOf(params.origin) + 1;
    return { kind: "ladder", nextPort, foreign };
}

interface PointerGuardResult {
    allow: boolean;
    holder?: { pid: number; instanceId: string; origin: string };
}

/** #2941: proxy-origin pointer overwrite identity check. Refuses ONLY a
 *  different live instance whose recorded pid health-checks as serving the
 *  SAME address. Everything else allows the write: missing/legacy records,
 *  dead pids, draining predecessors (alive process, closed listener — must
 *  keep the #1723 takeover working), responder-pid mismatch (stale record —
 *  overwriting repairs it), cross-address holders (last-writer-wins by
 *  design, #1232). */
export async function mayClobberPointer(params: {
    candidateOrigin: string;
    candidateInstanceId: string;
    read: () => ProxyInstanceFile | { origin: string } | undefined;
    isAlive: (pid: number) => boolean;
    healthOf: (origin: string) => Promise<OwnerProbeInfo | undefined>;
}): Promise<PointerGuardResult> {
    const current = params.read();
    if (!isProxyInstanceFile(current)) return { allow: true };
    if (current.instanceId === params.candidateInstanceId) return { allow: true };
    if (!sameAddress(current.origin, params.candidateOrigin)) return { allow: true };
    if (current.pid <= 0 || !params.isAlive(current.pid)) return { allow: true };
    const health = await params.healthOf(current.origin);
    if (health !== undefined && health.pid === current.pid) {
        return { allow: false, holder: { pid: current.pid, instanceId: current.instanceId, origin: current.origin } };
    }
    return { allow: true };
}

function sameAddress(a: string, b: string): boolean {
    try {
        return new URL(a).host === new URL(b).host;
    } catch {
        return false;
    }
}
