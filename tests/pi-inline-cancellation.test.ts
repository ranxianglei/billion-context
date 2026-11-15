import test from "node:test";
import assert from "node:assert/strict";
import { _resetInlineEngineForTest, _setEngineFactoryForTest, INLINE_ORIGIN, type InlineEngine } from "../src/inline-engine.ts";
import { _resetInlineTransportForTest, installInlineTransport } from "../src/agent/pi-inline.ts";
import { resetFetchChainForTest } from "../src/agent/fetch-chain/index.ts";

const modelUrl = `${INLINE_ORIGIN}/bili/http://upstream.invalid/v1/messages`;

async function withTransport(factory: () => Promise<InlineEngine>, run: (sends: string[]) => Promise<void>): Promise<void> {
    const saved = globalThis.fetch;
    const sends: string[] = [];
    resetFetchChainForTest();
    _resetInlineTransportForTest();
    _resetInlineEngineForTest();
    globalThis.fetch = async (input) => {
        sends.push(input instanceof Request ? input.url : String(input));
        return new Response("direct");
    };
    _setEngineFactoryForTest(factory);
    try {
        installInlineTransport();
        await run(sends);
    } finally {
        resetFetchChainForTest();
        _resetInlineTransportForTest();
        _setEngineFactoryForTest(undefined);
        _resetInlineEngineForTest();
        globalThis.fetch = saved;
    }
}

function engine(dispatch: InlineEngine["dispatch"]): InlineEngine {
    return { origin: INLINE_ORIGIN, dispatch, dispatchHttp: async () => {}, wsOrigin: Promise.resolve(undefined), webOrigin: Promise.resolve(undefined) };
}

for (const source of ["init", "request", "undefined-override"] as const) {
    for (const reason of [new Error("caller cancelled"), new TypeError("caller cancelled"), "cancelled", { cancelled: true }, new DOMException("deadline", "TimeoutError")]) {
        test(`inline ${source} cancellation never retries a ${typeof reason === "object" && reason !== null && "name" in reason ? reason.name : typeof reason} reason`, async () => {
            const controller = new AbortController();
            await withTransport(async () => engine(async () => {
                controller.abort(reason);
                throw reason;
            }), async sends => {
                const input = source === "init" ? modelUrl : new Request(modelUrl, { signal: controller.signal });
                const init = source === "init" ? { signal: controller.signal } : source === "undefined-override" ? { signal: undefined } : undefined;
                await assert.rejects(fetch(input, init), error => error === reason);
                assert.deepEqual(sends, [], "a cancelled generation must never enter direct fallback");
            });
        });
    }
}

test("pre-aborted Request does not start the inline engine", async () => {
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    let starts = 0;
    await withTransport(async () => {
        starts++;
        return engine(async () => new Response("unexpected"));
    }, async sends => {
        await assert.rejects(fetch(new Request(modelUrl, { signal: controller.signal })), error => error === reason);
        assert.equal(starts, 0);
        assert.deepEqual(sends, []);
    });
});

test("cancellation while the inline engine starts prevents model dispatch", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during startup");
    let dispatches = 0;
    await withTransport(async () => {
        controller.abort(reason);
        return engine(async () => { dispatches++; return new Response("unexpected"); });
    }, async sends => {
        await assert.rejects(fetch(modelUrl, { signal: controller.signal }), error => error === reason);
        assert.equal(dispatches, 0);
        assert.deepEqual(sends, []);
    });
});

for (const override of [null, "replacement"] as const) {
    test(`a ${override} signal override still allows genuine engine failure to degrade`, async () => {
        const original = new AbortController();
        original.abort(new Error("overridden cancellation"));
        const replacement = new AbortController();
        await withTransport(async () => { throw new Error("engine unavailable"); }, async sends => {
            const response = await fetch(new Request(modelUrl, { signal: original.signal }), {
                signal: override === null ? null : replacement.signal,
            });
            assert.equal(await response.text(), "direct");
            assert.deepEqual(sends, ["http://upstream.invalid/v1/messages"]);
        });
    });
}

test("a transport AbortError still propagates without caller cancellation", async () => {
    const reason = new DOMException("transport cancelled", "AbortError");
    await withTransport(async () => engine(async () => { throw reason; }), async sends => {
        await assert.rejects(fetch(modelUrl), error => error === reason);
        assert.deepEqual(sends, []);
    });
});
