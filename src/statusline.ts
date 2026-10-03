// #1920: `bili statusline` — the command written into claude's managed
// settings block (statusLine). Claude Code runs it periodically and renders
// its stdout as the bottom status bar; stdin carries JSON with session_id
// (= x-claude-code-session-id, the proxy's conversation identity). We print
// the PROXY-rendered statusLine.min — same single renderer as pi/omp footer,
// so every client shows identical numbers. Contract: NEVER fail claude — any
// error prints nothing and exits 0 (an empty line is the correct degraded
// state; a non-zero exit or stderr noise would surface in the host).

import { detectProxyBase } from "./agent/shared.js";
import { lanePreferredPort } from "./instance.js";

const STATUSLINE_TIMEOUT_MS = 3000;
const STDIN_TIMEOUT_MS = 2000;

export interface StatuslineOptions {
    /** Explicit origin (--origin / BILI_MCP_PROXY); wins over everything. */
    origin?: string;
    env?: NodeJS.ProcessEnv;
    /** Test seam — defaults to reading claude's stdin payload. */
    readPayload?: () => Promise<string>;
}

/** First hit wins: explicit override > ANTHROPIC_BASE_URL (the launcher and
 *  the managed block pin it to the bili proxy, possibly /bili/-wrapped —
 *  detectProxyBase unwraps both and honors the kill switch) > the claude
 *  lane's sticky zone port (> plain default port as last resort). */
export function resolveStatuslineOrigin(opts: StatuslineOptions): string | undefined {
    const env = opts.env ?? process.env;
    const explicit = opts.origin?.trim() || env.BILI_MCP_PROXY?.trim();
    if (explicit !== undefined && explicit.length > 0 && /^https?:\/\//i.test(explicit)) return explicit.replace(/\/+$/, "");
    const fromBaseUrl = detectProxyBase(env.ANTHROPIC_BASE_URL);
    if (fromBaseUrl !== undefined) return fromBaseUrl;
    try {
        return `http://127.0.0.1:${lanePreferredPort("claude", env)}`;
    } catch {
        return "http://127.0.0.1:8787";
    }
}

async function readStdinPayload(): Promise<string> {
    if (process.stdin.isTTY === true) return "";
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => process.stdin.destroy(), STDIN_TIMEOUT_MS);
    try {
        for await (const chunk of process.stdin) {
            chunks.push(Buffer.from(chunk));
        }
    } catch {
        // destroyed by the timeout guard — whatever arrived is all we get
    } finally {
        clearTimeout(timer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** Returns the line to print ("" = print nothing). Never throws. */
export async function runStatusline(opts: StatuslineOptions = {}): Promise<string> {
    try {
        const payload = await (opts.readPayload ?? readStdinPayload)();
        let sessionId: string | undefined;
        try {
            const parsed = JSON.parse(payload) as { session_id?: unknown };
            if (typeof parsed.session_id === "string" && parsed.session_id.length > 0) sessionId = parsed.session_id;
        } catch {
            // no JSON payload — nothing we can address
        }
        if (sessionId === undefined) return "";
        const origin = resolveStatuslineOrigin(opts);
        if (origin === undefined) return "";
        const res = await fetch(`${origin}/__bili/plugin/status?conversationId=${encodeURIComponent(sessionId)}`, {
            signal: AbortSignal.timeout(STATUSLINE_TIMEOUT_MS),
        });
        if (!res.ok) return "";
        const data = (await res.json()) as { statusLine?: { min?: unknown } };
        return typeof data.statusLine?.min === "string" ? data.statusLine.min : "";
    } catch {
        return "";
    }
}
