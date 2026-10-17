// #3617-E① / #3394: shared driver for the native interceptor's hot-replace
// scenarios (dispose → re-import → re-apply). Production shape: a host
// hot-swaps the plugin bundle (fresh module state applied in the SAME process)
// or a context teardown disposes an activation LATE — routing must follow the
// NEWEST activation and a superseded activation's disposer must be a no-op.
// The three #3394 regression tests hand-rolled this scaffolding each; new
// dispose/re-import scenarios should be one runHotReplace call.

import assert from "node:assert/strict";
import { installNativeFetchIntercept, liveStateSlotEffect, _resetForTest, type NativeInterceptState } from "../../src/agent/native-intercept.ts";

export interface RecordedCall {
    url: string;
    headers: Record<string, string>;
    at: number;
}

/** Fetch stub that records every dispatch (url + normalized outgoing headers)
 *  into `sink` and answers 200 "{}". */
export function makeRecordingFetch(sink: RecordedCall[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const src = init?.headers !== undefined ? init.headers : input instanceof Request ? input.headers : undefined;
        const headers: Record<string, string> = {};
        if (src !== undefined) for (const [k, v] of new Headers(src).entries()) headers[k] = v;
        sink.push({ url, headers, at: Date.now() });
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

/** One plugin "world": the module-level interceptor state a single applied
 *  instance owns. */
interface HotReplaceWorld {
    readonly state: NativeInterceptState;
    /** Activate this world (the production apply() path). True when THIS call
     *  installed the process's fetch chain; false = a chain already exists
     *  and only the live-state slot was rebound to this world. */
    install(): boolean;
    /** Capture this activation's slot-release effect exactly as the host's
     *  effect runner would (post-commit). Invoke the returned disposer to fire
     *  it — possibly late, after a newer world took over. */
    captureDispose(): () => void;
}

interface HotReplaceApi {
    /** Create a world from its origin (+ optional header stamp); not yet active. */
    world(origin: string, headersFor?: () => Record<string, string>): HotReplaceWorld;
    /** Dispatch a model-API request through the patched fetch; resolves with the recorded call. */
    request(url: string): Promise<RecordedCall>;
    /** Every recorded dispatch, in order. */
    readonly calls: RecordedCall[];
}

/** Run a hot-replace scenario under a recording fetch patch. Saves/restores
 *  globalThis.fetch and resets the interceptor module state afterwards. */
export async function runHotReplace(fn: (api: HotReplaceApi) => Promise<void> | void): Promise<RecordedCall[]> {
    const saved = globalThis.fetch;
    _resetForTest();
    const calls: RecordedCall[] = [];
    globalThis.fetch = makeRecordingFetch(calls);
    try {
        await fn({
            world: (origin, headersFor) => {
                const state: NativeInterceptState = { origin, ready: Promise.resolve(origin), headersFor };
                return {
                    state,
                    install: () => installNativeFetchIntercept(state),
                    captureDispose: () => liveStateSlotEffect(state)(),
                };
            },
            request: async (url) => {
                const res = await globalThis.fetch(url, { method: "POST" });
                assert.equal(res.status, 200);
                return calls[calls.length - 1]!;
            },
            calls,
        });
        return calls;
    } finally {
        globalThis.fetch = saved;
        _resetForTest();
    }
}
