// Three-state liveness probing (#3654). A health probe that times out is NOT
// evidence of death: on loopback the kernel accept queue keeps answering TCP
// connects while the listener's JS event loop is blocked (measured hermetically:
// connect ~2ms during an 8s synchronous block; the HTTP answer only arrives
// after the unblock), so "connected but no health answer within the budget" is
// the signature of a BUSY proxy — alive and saturated (typically a large
// compression) — not dead. ECONNREFUSED and its kin remain the instant death
// signal, so the fast path that detects a truly gone proxy costs milliseconds,
// not the full probe budget. Every consumer (the per-request live-origin
// resolver in native-intercept.ts, launcher discovery diagnostics, spawn-side
// twin adoption) shares this one classification so busy and dead are never
// conflated again.

import net from "node:net";

type LivenessState = "alive" | "busy" | "dead";

export interface LivenessVerdict {
    state: LivenessState;
    /** Failure class for non-alive verdicts (ECONNREFUSED / HTTP status / timeout class). */
    detail?: string;
}

/** Budget for the TCP connect pre-probe. Loopback connects land in
 *  milliseconds; the cap covers a machine whose network stack itself is wedged,
 *  where any answer would be too late to matter. */
const CONNECT_PROBE_TIMEOUT_MS = 2_000;

function originHostPort(origin: string): { host: string; port: number } | undefined {
    try {
        const u = new URL(origin);
        if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
        const host = u.hostname.replace(/^\[|\]$/g, "");
        if (host === "") return undefined;
        const port = u.port !== "" ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
        return Number.isInteger(port) && port > 0 ? { host, port } : undefined;
    } catch {
        return undefined;
    }
}

interface ConnectOutcome {
    ok: boolean;
    /** errno class when the connect itself failed (ECONNREFUSED, …). */
    detail?: string;
}

function attemptConnect(host: string, port: number, timeoutMs: number): Promise<ConnectOutcome> {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (outcome: ConnectOutcome): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(outcome);
        };
        const socket = net.connect({ host, port });
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => settle({ ok: true }));
        socket.once("timeout", () => settle({ ok: false, detail: `connect timeout after ${timeoutMs}ms` }));
        socket.once("error", (err: NodeJS.ErrnoException) =>
            settle({ ok: false, detail: typeof err.code === "string" && err.code.length > 0 ? err.code : String(err.message ?? err) }));
    });
}

/** True when the origin's socket accepts a TCP connection within the budget.
 *  Proves the LISTENING side exists at the kernel level — including a proxy
 *  whose event loop is blocked, because its accept queue still drains. Used by
 *  the launcher's twin adoption (a live pid alone does not prove the socket
 *  serves — Windows pid reuse) and by discovery diagnostics. */
export async function tcpConnectable(origin: string, timeoutMs: number = CONNECT_PROBE_TIMEOUT_MS): Promise<boolean> {
    const hp = originHostPort(origin);
    if (hp === undefined) return false;
    const outcome = await attemptConnect(hp.host, hp.port, timeoutMs);
    return outcome.ok;
}

function errCodeOf(err: unknown): string | undefined {
    const e = err as { cause?: { code?: unknown; name?: unknown }; code?: unknown; name?: unknown } | null;
    const code = e?.cause?.code ?? e?.code;
    return typeof code === "string" && code.length > 0 ? code : undefined;
}

/** Timeout-class error from fetch/undici under AbortSignal.timeout — the
 *  "connected but never answered" signature. Everything else that throws is a
 *  transport failure (reset, closed, refused mid-flight) → dead. */
function isTimeoutErr(err: unknown): boolean {
    const e = err as { cause?: { name?: unknown; code?: unknown }; name?: unknown; code?: unknown } | null;
    const names = [e?.name, e?.cause?.name];
    const codes = [e?.code, e?.cause?.code];
    return names.includes("TimeoutError") || names.includes("AbortError") ||
        codes.includes("ABORT_ERR") || codes.includes("UND_ERR_HEADERS_TIMEOUT");
}

/** Full three-state probe of GET `<origin>/__bili/health` under `budgetMs`,
 *  preceded by the TCP connect pre-probe. The "alive" claim additionally
 *  validates the PAYLOAD (`{ ok: true }`) — a foreign service answering 200 on
 *  every path must not read as a healthy bili proxy (#1753 discipline, which
 *  the launcher-side probes already applied but the resolver-side probe did
 *  not). */
export async function probeLiveness(origin: string, budgetMs: number): Promise<LivenessVerdict> {
    const hp = originHostPort(origin);
    if (hp === undefined) return { state: "dead", detail: "unparseable origin" };
    // Connect first: a refused connection is a high-confidence death signal on
    // loopback and costs ~0ms, so it short-circuits before paying the HTTP
    // budget at all.
    const conn = await attemptConnect(hp.host, hp.port, CONNECT_PROBE_TIMEOUT_MS);
    if (!conn.ok) return { state: "dead", detail: conn.detail ?? "connect failed" };
    try {
        const res = await fetch(`${origin}/__bili/health`, { signal: AbortSignal.timeout(budgetMs) });
        if (!res.ok) return { state: "dead", detail: `HTTP ${res.status}` };
        try {
            const data = (await res.json()) as { ok?: unknown };
            if (data.ok !== true) return { state: "dead", detail: "health payload reports not-ok" };
        } catch {
            return { state: "dead", detail: "non-JSON health payload (foreign listener?)" };
        }
        return { state: "alive" };
    } catch (err) {
        if (isTimeoutErr(err)) return { state: "busy", detail: `no health answer within ${budgetMs}ms after TCP connect` };
        return { state: "dead", detail: errCodeOf(err) ?? String((err as Error)?.message ?? err).slice(0, 120) };
    }
}
