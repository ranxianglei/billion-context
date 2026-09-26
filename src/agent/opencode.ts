// Thin opencode plugin for the billion-context proxy (`bili opencode`).
//
// Activates ONLY when BILLION_CONTEXT_PROXY is set (the launcher sets it);
// otherwise it is a no-op so shipping it inside the package is harmless.
// Mirrors the pi/omp plugin (src/agent/pi.ts):
//   - registers the /acp command (config hook + command.execute.before)
//   - binds the opencode session id to the proxy session via the
//     pending-register queue (POST /__bili/plugin/register on session.created)
//   - renders the proxy's buildStatusPanel via an ignored chat message
//
// OpenCode 2.x (V2 plugin API) loads `{ id, setup }` instead of `.server()` —
// setup comes from the shared factory src/agent/opencode-v2.ts, which the
// native npm entry (opencode-native.ts) reuses so both deployment modes share
// one protocol implementation. The V2 runtime-API facts live in that file.
//
// The /acp command hooks themselves live in src/agent/opencode-acp-command.ts
// and are shared with the native V1 entry (opencode-native.ts).

import { LAUNCHER_DEFAULT_HOST, ensureProxyRunning } from "../launcher.js";
import { createAcpCommandHooks } from "./opencode-acp-command.js";
import { nativeProxyScriptPath, singleFlight } from "./native-bootstrap.js";
import { createLiveOriginResolver, installNativeFetchIntercept, isModelApiUrl, replaceRequestTarget, routedBiliModelUrl, setDeclaredModelEndpoints, type NativeInterceptState } from "./native-intercept.js";
import { loadDeclaredModelEndpoints } from "../model-endpoints.js";
import { createOpencodeV2Setup, type V2HttpRequestEvent, type V2State } from "./opencode-v2.js";
import { fetchProxyVersion } from "./shared.js";

export { showAcpText } from "./opencode-acp-command.js";
export type {
    OpencodeCommandConfig,
    OpencodeConfig,
    OpencodePromptPart,
    OpencodeClient,
    OpencodeCommandInput,
    OpencodeAcpHooks,
} from "./opencode-acp-command.js";

interface OpencodeSessionInfo {
    id?: unknown;
}

interface OpencodeEvent {
    type?: string;
    properties?: { info?: OpencodeSessionInfo; [key: string]: unknown };
}

interface OpencodeEventInput {
    event?: OpencodeEvent;
}

interface OpencodePluginContext {
    client?: import("./opencode-acp-command.js").OpencodeClient;
}

interface OpencodeHooks {
    config?: (input: import("./opencode-acp-command.js").OpencodeConfig) => Promise<void>;
    event?: (input: OpencodeEventInput) => Promise<void>;
    "command.execute.before"?: (input: import("./opencode-acp-command.js").OpencodeCommandInput, output: { parts: unknown[] }) => Promise<void>;
}

const proxyBase = process.env.BILLION_CONTEXT_PROXY ?? "";

// #1135: shared lifecycle state for BOTH lanes — the V1 fetch patch and the
// V2 http.request route observe the same proxy and drive the same recovery.
// The launcher's proxy is often SHARED across multiple `bili opencode`
// launches (instance discovery attaches later launches to the first one);
// when the owning launcher exits, its parent-pid watchdog tears the proxy
// down and every attach-side client's baked URLs point at a dead port.
// Spawning our own replacement (watchdog = THIS opencode process) restores
// compression without a manual restart — the ownership transfer is the
// watchdog's job, and instance discovery may find another healthy one first.
let _respawnForTest: (() => Promise<string | undefined>) | undefined;

/** Test hook: replace the attach respawn body (re-probe + self-spawn) with a
 *  stub so suites never fork a real proxy. Pass undefined to restore. */
export function _setRespawnForTest(fn?: () => Promise<string | undefined>): void {
    _respawnForTest = fn;
}

/** Test hook: expose the armed intercept state so stub respawns can publish
 *  their landed origin exactly like the real respawnOwnProxy does. */
export function _interceptStateForTest(): NativeInterceptState | undefined {
    return intercept;
}

const intercept: NativeInterceptState | undefined = proxyBase === "" ? undefined : {
    origin: proxyBase,
    ready: Promise.resolve(proxyBase),
    respawn: singleFlight(() => (_respawnForTest ?? respawnOwnProxy)()),
    onGiveUp: () => {
        delete process.env.BILLION_CONTEXT_PROXY;
    },
};

// #1295: declared custom-wire endpoints — same config source as the proxy;
// takes effect on the next host start (config is read once at load time).
if (intercept !== undefined) void loadDeclaredModelEndpoints().then(setDeclaredModelEndpoints);

/** Re-probe the attached origin first: a transient blip must not migrate the
 *  session to a fresh proxy — restore the same origin when it is back. Only a
 *  truly dead origin falls through to spawning our own replacement. */
async function respawnOwnProxy(): Promise<string | undefined> {
    if (proxyBase !== "") {
        const version = await fetchProxyVersion(proxyBase).catch(() => undefined);
        if (version !== undefined) {
            if (intercept !== undefined) intercept.origin = proxyBase;
            process.env.BILLION_CONTEXT_PROXY = proxyBase;
            return proxyBase;
        }
    }
    try {
        const handle = await ensureProxyRunning(
            { host: LAUNCHER_DEFAULT_HOST, port: 0, passthrough: false, debug: false, lane: "opencode" },
            { scriptPath: nativeProxyScriptPath() },
        );
        if (intercept !== undefined) intercept.origin = handle.origin;
        process.env.BILLION_CONTEXT_PROXY = handle.origin;
        return handle.origin;
    } catch (err) {
        console.error(`[bili-opencode] proxy respawn failed — model traffic goes direct (uncompressed): ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
    }
}

const server = async (ctx: OpencodePluginContext): Promise<OpencodeHooks> => {
    if (!proxyBase) return {};
    console.log("[bili-opencode] plugin active (proxy " + proxyBase + ")");
    // V1 host: same SDK-default-baseURL gap as the native entry — the
    // launcher's config-file rewrite only catches explicit baseURLs. Global
    // fetch patch catches the rest; runtime recovery rides the shared state.
    if (intercept !== undefined && installNativeFetchIntercept(intercept)) {
        console.log("[bili-opencode] v1: fetch patch installed (catches providers without an explicit baseURL)");
    }
    return {
        ...createAcpCommandHooks(() => intercept?.origin ?? proxyBase, ctx),
    };
};

// V2 lane: routes provider requests through the LIVE proxy origin. Handles
// BOTH URL shapes: baked `<proxy>/bili/<upstream>` overlays from the
// launcher's config rewrite (re-baked to the current origin on recovery) and
// raw model-API URLs from SDK-default providers (routed like the native
// entry does). A dead origin degrades to a DIRECT send of the upstream URL
// rather than failing closed — compression is lost, the session survives.
const route = intercept === undefined ? undefined : (() => {
    const resolveLive = createLiveOriginResolver(intercept);
    let warned = false;
    return async (e: V2HttpRequestEvent, s: V2State): Promise<void> => {
        const url = typeof e.request?.url === "string" ? e.request.url : undefined;
        if (url === undefined) return;
        const upstream = routedBiliModelUrl(url);
        if (upstream === undefined && !isModelApiUrl(url)) return;
        const live = await resolveLive();
        if (live === undefined) {
            if (!warned) {
                warned = true;
                console.error("[bili-opencode] no live bili proxy — model requests go direct (uncompressed)");
            }
            s.proxyBase = undefined;
            if (upstream !== undefined) replaceRequestTarget(e, upstream);
            return;
        }
        warned = false;
        s.proxyBase = live;
        const target = `${live}/bili/${upstream ?? url}`;
        if (target !== url) replaceRequestTarget(e, target);
    };
})();

const setup = createOpencodeV2Setup(route === undefined ? {} : { route });

export default { id: "billion-context-opencode", setup, server };
