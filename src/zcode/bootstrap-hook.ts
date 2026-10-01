// zcode SessionStart hook (#1145): best-effort attach-only bootstrap. The MCP
// child is authoritative; this hook only routes the provider store to an
// ALREADY RUNNING proxy (never spawns one — a short-lived parent would kill
// it) so sessions started while `bili start` is running get compression
// without waiting for the per-session spawn path. Fails open: always exits 0.

import { resolveProxyOrigin } from "../mcp.js";
import { reportRuntimeInfo } from "../agent/shared.js";
import { planNativeZcode, routeZcodeConfig, waitForProxyHealthy, zcodePolicyFromEnv } from "./native.js";

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
        const plan = planNativeZcode(process.env);
        if (plan.mode === "off") return;
        // #1622: pass the resolved policy — routeZcodeConfig's default ignores BILI_ZCODE_ROUTE / providers direct.
        const policy = zcodePolicyFromEnv(process.env);
        if (policy.route === "none") return;
        const origin = plan.mode === "attach" ? plan.attachOrigin : resolveProxyOrigin();
        if (!(await waitForProxyHealthy(origin, HOOK_HEALTH_DEADLINE_MS))) return;
        const applied = await routeZcodeConfig({ origin, policy });
        if (!applied) return;
        const model = typeof payload.model === "string" && payload.model.length > 0 ? payload.model : "zcode";
        await reportRuntimeInfo(origin, { agent: "zcode", model, baseURL: applied.upstream, source: "session-start-hook" });
    } catch {
        return;
    }
}

if (process.argv[1] && /(?:^|[\\/])bootstrap-hook\.(?:ts|js)$/.test(process.argv[1])) {
    void main().finally(() => process.exit(0));
}
