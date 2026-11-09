// Codex SessionStart hook (ticket 08): best-effort, attach-only, fails open.
//
// Codex writes one JSON payload (session_id, transcript_path, cwd, hook_event_name)
// to the hook's stdin and waits for it to exit. This hook NEVER spawns a proxy —
// a short-lived parent would kill it — it only (a) confirms an already-running
// bili is reachable at the stable Codex lane origin, and (b) reports the
// session's runtime-info so the proxy can size the window before the first
// model request. Everything is wrapped: a missing proxy, a malformed payload or
// a closed stdin all exit 0, exactly like the kimi/zcode hooks.

import { resolveProxyOrigin } from "../mcp.js";
import { reportRuntimeInfo, runSessionStartHook } from "../agent/shared.js";
import { codexRouteOrigin } from "../codex-integration/route.js";

const HOOK_HEALTH_DEADLINE_MS = 4000;

function readStdinPayload(timeoutMs = 5000): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        let buf = "";
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            process.stdin.removeAllListeners();
            try {
                resolve(JSON.parse(buf) as Record<string, unknown>);
            } catch {
                resolve({});
            }
        };
        const timer = setTimeout(finish, timeoutMs);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            buf += chunk;
        });
        process.stdin.on("end", finish);
    });
}

/** Any bili process listening on the Codex lane's sticky port. Attach-only:
 *  BILI_CODEX_HOOK_ORIGIN overrides the probe target for tests/odd setups. */
export async function waitForProxyHealthy(
    origin: string,
    deadlineMs: number,
    fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
        try {
            const response = await fetchImpl(
                `${origin.replace(/\/+$/, "")}/__bili/health`,
                {
                    signal: AbortSignal.timeout(1200),
                },
            );
            if (response.ok) return true;
        } catch {
            // not up yet (or not ours)
        }
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

export async function main(): Promise<void> {
    if (process.env.NODE_TEST_CONTEXT !== undefined) return;
    try {
        const payload = await readStdinPayload();
        const origin =
            process.env.BILI_CODEX_HOOK_ORIGIN ??
            codexRouteOrigin(process.env) ??
            resolveProxyOrigin();
        if (!(await waitForProxyHealthy(origin, HOOK_HEALTH_DEADLINE_MS))) return;
        const model =
            typeof payload.model === "string" && payload.model.length > 0
                ? payload.model
                : "codex";
        await reportRuntimeInfo(origin, {
            agent: "codex",
            model,
            source: "session-start-hook",
            ...(typeof payload.session_id === "string" &&
            payload.session_id.length > 0
                ? { conversationId: payload.session_id }
                : {}),
        });
    } catch {
        return;
    }
}

if (
    process.argv[1] &&
    /(?:^|[\\/])bootstrap-hook\.(?:ts|js)$/.test(process.argv[1])
) {
    runSessionStartHook(main);
}
