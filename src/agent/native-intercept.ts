// Native-mode fetch interception (#519): a globalThis.fetch patch that
// silently routes model-API requests through a bili proxy that the extension
// itself spawned (see pi-native.ts). Verified end-to-end on pi 0.83.6: pi's
// provider stack (pi-stable-ai → Anthropic/OpenAI SDKs) resolves its fetch
// from the global at FIRST-request client construction, so a patch installed
// at extension load always wins. The patch is surgical — it rewrites ONLY
// model-API shaped URLs and leaves every other request untouched.

export interface NativeInterceptState {
    /** Proxy origin ("http://127.0.0.1:PORT") once the bootstrap resolved.
     *  Written by the owner (pi-native.ts); read synchronously on each call. */
    origin: string | undefined;
    /** Resolves to the proxy origin once healthy, or undefined on failure. */
    ready: Promise<string | undefined>;
    /** Owner hook: re-run the bootstrap (proxy died → respawn). */
    respawn?: () => Promise<string | undefined>;
    /** How long a pre-ready model request waits for the bootstrap before
     *  falling back to a direct (uncompressed) send. */
    readyTimeoutMs?: number;
    /** Test/observability hook: every dispatched decision. */
    onDispatch?: (url: string, action: "rewrite" | "direct" | "self" | "retry") => void;
}

const INTERCEPT_FLAG = "__biliNativeFetchIntercept";

// Model-API endpoint suffixes across the wires bili proxies: Anthropic
// `/v1/messages`, OpenAI chat `/v1/chat/completions` (and legacy
// `/v1/completions`), Responses `/v1/responses`, Mistral
// `/v1/chat/completions`|`/v1/conversations`. Version segment is optional
// and unpinned (zhipuai uses `/v4/chat/completions`, bailian mounts
// `/apps/anthropic/v1/messages`), so match on the trailing shape only.
const MODEL_API_SUFFIX = /(?:^|\/)(?:v\d+\/)?(?:messages|chat\/completions|completions|responses|conversations)\/?$/;

/** True when the URL points at a model-API endpoint worth proxying. Never
 *  true for bili's own proxy paths (`/bili/…`, `/__bili/…`) or non-HTTP(S). */
export function isModelApiUrl(url: string): boolean {
    if (!/^https?:\/\//i.test(url)) return false;
    if (url.includes("/__bili/") || url.includes("/__acp/")) return false;
    try {
        const u = new URL(url);
        const segments = u.pathname.split("/").filter((s) => s.length > 0);
        if (segments[0] === "bili") return false;
        const pathname = u.pathname.replace(/\/+$/, "");
        return MODEL_API_SUFFIX.test(pathname);
    } catch {
        return false;
    }
}

function fetchUrlOf(input: string | URL | Request): string | undefined {
    try {
        if (typeof input === "string") return input;
        if (input instanceof URL) return input.href;
        if (input !== null && typeof input === "object" && typeof (input as Request).url === "string") {
            return (input as Request).url;
        }
    } catch {
        // fallthrough
    }
    return undefined;
}

async function withTimeout(p: Promise<string | undefined>, ms: number): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
    });
    try {
        return await Promise.race([p, timeout]);
    } catch {
        return undefined;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function readyOrigin(state: NativeInterceptState): Promise<string | undefined> {
    if (state.origin !== undefined) return state.origin;
    return withTimeout(state.ready, state.readyTimeoutMs ?? 15000);
}

/** Install the global fetch patch. Idempotent: a second call is a no-op
 *  (returns false) so double-loading the entry cannot double-wrap. */
export function installNativeFetchIntercept(state: NativeInterceptState): boolean {
    const g = globalThis as Record<string, unknown>;
    if (g[INTERCEPT_FLAG] === true) return false;
    const orig = globalThis.fetch;
    let warned = false;

    const patched = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = fetchUrlOf(input);
        if (url === undefined || !isModelApiUrl(url)) return orig(input, init);

        const dispatch = (target: string, action: "rewrite" | "self" | "retry"): ReturnType<typeof orig> => {
            state.onDispatch?.(target, action);
            if (typeof input === "string" || input instanceof URL) return orig(target, init);
            return orig(new Request(target, input), init);
        };

        const origin = await readyOrigin(state);
        if (origin === undefined) {
            // Bootstrap failed or timed out — NEVER break the agent: send
            // direct (uncompressed) and say so once.
            if (!warned) {
                warned = true;
                console.error(`bili-native: proxy not ready — model request goes direct (uncompressed): ${url}`);
            }
            state.onDispatch?.(url, "direct");
            return orig(input, init);
        }
        if (url.startsWith(`${origin}/`)) {
            state.onDispatch?.(url, "self");
            return orig(input, init);
        }
        try {
            return await dispatch(`${origin}/bili/${url}`, "rewrite");
        } catch (err) {
            // The spawned proxy can die mid-session (its parent watchdog
            // fires when the FIRST owning pi exits while later sessions
            // still ride it). A network-level failure (undici throws
            // TypeError) triggers one respawn + one retry.
            if (err instanceof TypeError && state.respawn !== undefined) {
                state.origin = undefined;
                state.ready = state.respawn();
                const again = await readyOrigin(state);
                if (again !== undefined) return dispatch(`${again}/bili/${url}`, "retry");
                state.onDispatch?.(url, "direct");
            }
            throw err;
        }
    };

    globalThis.fetch = patched as typeof globalThis.fetch;
    g[INTERCEPT_FLAG] = true;
    return true;
}

/** Test-only: drop the patch guard so a suite can install again. The
 *  caller owns restoring globalThis.fetch. */
export function _resetForTest(): void {
    const g = globalThis as Record<string, unknown>;
    delete g[INTERCEPT_FLAG];
}
