// kimi SessionStart hook (#963): best-effort attach-only bootstrap. The MCP
// child is authoritative; this hook only routes config.toml to an ALREADY
// RUNNING proxy (never spawns one — a short-lived parent would kill it) so
// sessions started while `bili start` is running get compression without
// waiting for the per-session spawn path. Fails open: always exits 0.

import { resolveProxyOrigin } from "../mcp.js";
import { reportRuntimeInfo, runSessionStartHook } from "../agent/shared.js";
import { planNativeKimi, routeKimiConfig, waitForProxyHealthy } from "./native.js";

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
        process.stdin.on("data", (chunk) => { buf += chunk; });
        process.stdin.on("end", finish);
    });
}

export async function main(): Promise<void> {
    if (process.env.NODE_TEST_CONTEXT !== undefined) return;
    try {
        const payload = await readStdinPayload();
        const plan = planNativeKimi(process.env);
        if (plan.mode === "off") return;
        const origin = plan.mode === "attach" ? plan.attachOrigin : resolveProxyOrigin();
        if (!(await waitForProxyHealthy(origin, HOOK_HEALTH_DEADLINE_MS))) return;
        const applied = await routeKimiConfig({ origin });
        if (!applied) return;
        const model = typeof payload.model === "string" && payload.model.length > 0 ? payload.model : applied.modelId;
        await reportRuntimeInfo(origin, { agent: "kimi", model, baseURL: applied.upstream, source: "session-start-hook" });
    } catch {
        return;
    }
}

if (process.argv[1] && /(?:^|[\\/])bootstrap-hook\.(?:ts|js)$/.test(process.argv[1])) {
    runSessionStartHook(main);
}
