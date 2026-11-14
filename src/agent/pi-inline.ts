// #3278: pi inline lane — innermost fetch-chain link that serves
// INLINE_ORIGIN traffic IN-PROCESS (no spawned proxy). Installed BEFORE
// installNativeFetchIntercept, so the intercept's `/bili/<upstream>` rewrite
// lands here: model URLs decode to their embedded upstream and run the shared
// pipeline locally; management URLs (/__bili/, /__acp/) take the same pipeline
// through its loopback-gated admin routes. The fetch captured below the link
// is the host's PRE-PATCH fetch — handed to the engine as its upstream
// transport so pipeline egress never re-enters the chain.
import { installFetchChain } from "./fetch-chain/index.js";
import { getInlineEngine, INLINE_ORIGIN, type InlineEngine } from "../inline-engine.js";
import { logHostEvent } from "./host-log.js";

const MODEL_PREFIX = `${INLINE_ORIGIN}/bili/`;

let rawSend: typeof globalThis.fetch | undefined;
let installed = false;
let degradeWarned = false;

function urlOf(input: string | URL | Request): string | undefined {
    try {
        if (typeof input === "string") return input;
        if (input instanceof URL) return input.href;
        return input.url;
    } catch {
        return undefined;
    }
}

/** Install the inline transport as the innermost link of the fetch chain.
 *  Must run before installNativeFetchIntercept (chain order = install order). */
export function installInlineTransport(): boolean {
    if (installed) return true;
    installFetchChain((send) => {
        installed = true;
        rawSend = send;
        return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const url = urlOf(input);
            if (url === undefined || !url.startsWith(INLINE_ORIGIN)) return send(input, init);
            const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
            signal?.throwIfAborted();
            try {
                const engine = await getInlineEngine();
                signal?.throwIfAborted();
                return await engine.dispatch(input, init, rawSend);
            } catch (err) {
                // Caller-side cancel is not an engine failure — propagate it:
                // degrading would consume the one-shot warning and re-send a
                // request the caller already abandoned.
                signal?.throwIfAborted();
                if (err instanceof Error && err.name === "AbortError") throw err;
                const msg = err instanceof Error ? err.message : String(err);
                if (url.startsWith(MODEL_PREFIX)) {
                    // Startup or dispatch failed: try the direct fallback by
                    // stripping the pseudo-origin prefix (the embedded
                    // upstream URL is absolute) and send direct, uncompressed.
                    if (!degradeWarned) {
                        degradeWarned = true;
                        logHostEvent("error", "[native-client]", `[bili-native] inline request failed — attempting direct model fallback (uncompressed): ${msg}`);
                    }
                    const target = url.slice(MODEL_PREFIX.length);
                    if (input instanceof Request) {
                        const direct = new Request(target, new Request(input, init));
                        // Keep transport-specific init fields without serializing the body twice
                        // (a second FormData serialization would choose a different boundary).
                        return await send(direct, init && { ...init, headers: undefined, body: undefined });
                    }
                    return await send(target, init);
                }
                throw err;
            }
        };
    });
    return true;
}

/** Test seam: reset install state so suites can re-install on a fresh chain. */
export function _resetInlineTransportForTest(): void {
    installed = false;
    rawSend = undefined;
    degradeWarned = false;
}

export type { InlineEngine };
