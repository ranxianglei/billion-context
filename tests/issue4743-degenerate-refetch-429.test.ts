import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

process.env.NODE_ENV = "test";

import { makeContinuationRefetch } from "../src/degenerate-retry.ts";
import { withFetchTransport } from "../src/fetch-transport.ts";
import { _resetUpstreamThrottleForTest, activeThrottleHolds, noteUpstreamThrottle429, noteUpstreamThrottleResolved, reserveUpstreamThrottleClassification, upstreamThrottleGate, type ThrottleClassificationReservation } from "../src/upstream-throttle.ts";

function throttleReject(url: string, headers: Record<string, string>, now?: number, requestModel?: string) {
    return upstreamThrottleGate(url, headers, now, requestModel).reject;
}

// #4743 (PR #4725 round-3 residue, cherry-picked from #4752 ab6a7f10): the
// degenerate-turn continuation refetch is an egress send like any other, but
// it was invisible to the 429 governor — a 429-storming upstream never armed
// the hold from retry traffic, and an already-armed hold still burned an
// upstream slot on the retry. The refetch now (a) answers locally under an
// armed hold (passing the empty turn through — holding the CLIENT's open
// stream is not an option), and (b) feeds noteUpstreamThrottle429 /
// noteUpstreamThrottleResolved like every other egress send.
//
// Both assertions are RED on master (no gate call, no notes): the hold case
// records a real server hit on master, and the 429 case leaves the governor
// un-armed.

const CHAT_BODY = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });

function opts(url: string, label: string, signal: AbortSignal = new AbortController().signal) {
    return {
        protocol: "openai" as const,
        body: CHAT_BODY,
        model: "m",
        upstreamUrl: url,
        reqHeaders: {},
        signal,
        log: () => {},
        label,
    };
}

async function recordedServer(status: number, body: string): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
    let hitCount = 0;
    const server = http.createServer((_req, res) => {
        hitCount++;
        res.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
        res.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (typeof addr !== "object" || addr === null) throw new Error("no addr");
    return {
        url: `http://127.0.0.1:${addr.port}/v1/chat/completions`,
        hits: () => hitCount,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

test("#4743 A: an armed 429 hold answers the continuation refetch locally — the empty turn passes through and the upstream records ZERO hits", async () => {
    const srv = await recordedServer(200, "event: message_start\ndata: {}\n\n");
    try {
        // arm the governor for this exact upstream (same streak shape as the
        // loop-lane contract test: two consecutive verdicts)
        noteUpstreamThrottle429(srv.url, {}, null);
        noteUpstreamThrottle429(srv.url, {}, null);
        assert.ok(throttleReject(srv.url, {}), "precondition: hold armed");

        const refetch = makeContinuationRefetch(opts(srv.url, "gate-4743"));
        const out = await refetch();
        assert.equal(out, null, "the refetch must be answered locally (null = empty turn passes through)");
        assert.equal(srv.hits(), 0, "the armed hold must NOT burn an upstream slot on the retry");
    } finally {
        await srv.close();
        noteUpstreamThrottleResolved(srv.url, {}, 200);
    }
});

test("#4743 B: the refetch's own 429 verdict arms the governor; a resolved retry lifts the hold", async () => {
    const rejected = await recordedServer(429, JSON.stringify({ error: { code: "keyring_all_limited", model: "m", message: "all keys limited" } }));
    const ok = await recordedServer(200, "event: message_start\ndata: {}\n\n");
    try {
        assert.equal(throttleReject(rejected.url, {}), undefined, "precondition: no hold yet");

        const first = await makeContinuationRefetch(opts(rejected.url, "storm-4743"))();
        assert.equal(first, null, "a rejected retry passes the empty turn through");

        const armed = throttleReject(rejected.url, {}, Date.now(), "m");
        assert.ok(armed, "keyring_all_limited remains an origin+credential hold");
        assert.ok(throttleReject(rejected.url, {}, Date.now(), "other-model"), "account quota holds all models");

        const second = await makeContinuationRefetch(opts(ok.url, "lift-4743"))();
        assert.ok(second, "an ok retry still yields its stream");
        // the ok settle resolved the (different-host) governor key of its own
        // upstream; verify the observe pair by checking the rejected host's
        // hold is still armed until an explicit resolved verdict lifts it
        assert.ok(throttleReject(rejected.url, {}, Date.now(), "m"), "hold on the storming host persists until a resolved verdict");
        noteUpstreamThrottleResolved(rejected.url, {}, 200);
        assert.equal(throttleReject(rejected.url, {}), undefined, "resolved verdict lifts the account-wide hold");
    } finally {
        await rejected.close();
        await ok.close();
    }
});

test("#4743 C: a structured KeyRing model refusal holds only the matching model", async () => {
    const rejected = await recordedServer(
        429,
        JSON.stringify({ error: { code: "keyring_model_temporarily_unavailable", model: "m", message: "model unavailable" } }),
    );
    try {
        assert.equal(throttleReject(rejected.url, {}, Date.now(), "m"), undefined, "precondition: model has no hold");
        assert.equal(throttleReject(rejected.url, {}, Date.now(), "other-model"), undefined, "precondition: other model has no hold");

        const first = await makeContinuationRefetch(opts(rejected.url, "model-limited-refetch"))();
        assert.equal(first, null, "a rejected continuation passes the original empty turn through");
        assert.ok(throttleReject(rejected.url, {}, Date.now(), "m"), "the matching model is held");
        assert.equal(throttleReject(rejected.url, {}, Date.now(), "other-model"), undefined, "other models remain eligible on the same credential");
        assert.equal(activeThrottleHolds()[0].model, "m", "the recorded hold retains its model scope");

        const gated = await makeContinuationRefetch(opts(rejected.url, "model-hold-gate"))();
        assert.equal(gated, null);
        assert.equal(rejected.hits(), 1, "the held model's retry is answered locally without egress");
    } finally {
        await rejected.close();
        noteUpstreamThrottleResolved(rejected.url, {}, 200, Date.now(), "m");
    }
});

// Real timers are intentional: both concurrent response bodies finish after
// the former 1s cutoff, while the continuation callbacks stop waiting at 250ms.
test("#4743 D: concurrent delayed KeyRing bodies over 1s refine their own provisional holds without delaying callbacks", { timeout: 5_000 }, async () => {
    const url = "http://delayed-keyring-429.invalid/v1/chat/completions";
    const host = new URL(url).host;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const completedModels = new Set<string>();
    const canceledModels = new Set<string>();
    const { promise: bothRequests, resolve: resolveBothRequests } = Promise.withResolvers<void>();
    let calls = 0;
    const { promise: firstBodyComplete, resolve: resolveFirstBody } = Promise.withResolvers<void>();
    const { promise: bothBodiesComplete, resolve: resolveBothBodies } = Promise.withResolvers<void>();
    const transport = async () => {
        const index = calls++;
        if (calls === 2) resolveBothRequests();
        await bothRequests;
        const model = index === 0 ? "m" : "n";
        const finishDelay = index === 0 ? 1_300 : 1_500;
        return new Response(
            new ReadableStream<Uint8Array>({
                start(controller) {
                    const encoder = new TextEncoder();
                    timers.push(setTimeout(() => {
                        if (!canceledModels.has(model)) controller.enqueue(encoder.encode('{"error":{"code":"keyring_'));
                    }, 350));
                    timers.push(setTimeout(() => {
                        if (!canceledModels.has(model)) {
                            controller.enqueue(encoder.encode(`model_temporarily_unavailable","model":"${model}","message":"model unavailable"}}`));
                        }
                    }, 400));
                    timers.push(setTimeout(() => {
                        if (!canceledModels.has(model)) {
                            completedModels.add(model);
                            controller.close();
                            if (model === "m") resolveFirstBody();
                            if (completedModels.size === 2) resolveBothBodies();
                        }
                    }, finishDelay));
                },
                cancel() {
                    canceledModels.add(model);
                },
            }),
            { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } },
        );
    };
    const mController = new AbortController();
    const nController = new AbortController();
    const mOpts = { ...opts(url, "delayed-m-4743"), signal: mController.signal };
    const nOpts = { ...opts(url, "delayed-n-4743"), model: "n", signal: nController.signal };
    let mProbeToken: symbol | undefined;
    let nProbeToken: symbol | undefined;

    try {
        const started = Date.now();
        const results = await withFetchTransport(transport, () => Promise.all([
            makeContinuationRefetch(mOpts)(),
            makeContinuationRefetch(nOpts)(),
        ]));
        assert.deepEqual(results, [null, null]);
        assert.ok(Date.now() - started < 600, "both callbacks return near the 250ms initial body budget");
        assert.equal(completedModels.size, 0, "both bodies are still incomplete when callbacks return");
        assert.ok(activeThrottleHolds().some((hold) => hold.host === host && hold.model === undefined), "pending observations retain provisional account scope");

        await firstBodyComplete;
        let holds = activeThrottleHolds().filter((hold) => hold.host === host);
        for (let attempt = 0; attempt < 20 && !holds.some((hold) => hold.model === "m"); attempt++) {
            await setImmediate();
            holds = activeThrottleHolds().filter((hold) => hold.host === host);
        }
        assert.ok(holds.some((hold) => hold.model === "m"), "the first complete exact body refines after 1s");
        assert.ok(holds.some((hold) => hold.model === undefined), "the still-pending second observation keeps its provisional account evidence");

        await bothBodiesComplete;
        holds = activeThrottleHolds().filter((hold) => hold.host === host);
        for (let attempt = 0; attempt < 20 && (!holds.some((hold) => hold.model === "m") || !holds.some((hold) => hold.model === "n")); attempt++) {
            await setImmediate();
            holds = activeThrottleHolds().filter((hold) => hold.host === host);
        }
        assert.deepEqual(holds.map((hold) => hold.model).sort(), ["m", "n"], "each complete response narrows only its own observation");
        const mAdmission = upstreamThrottleGate(url, {}, Date.now(), "m");
        mProbeToken = mAdmission.probeToken;
        assert.ok(mAdmission.reject, "the matching model is held");
        const nAdmission = upstreamThrottleGate(url, {}, Date.now(), "n");
        nProbeToken = nAdmission.probeToken;
        assert.ok(nAdmission.reject, "the other exact model is also held");
        assert.equal(upstreamThrottleGate(url, {}, Date.now(), "other-model").reject, undefined, "unrelated models stay eligible");
    } finally {
        mController.abort();
        nController.abort();
        for (const timer of timers) clearTimeout(timer);
        noteUpstreamThrottleResolved(url, {}, 200, Date.now(), "m", mProbeToken);
        noteUpstreamThrottleResolved(url, {}, 200, Date.now(), "n", nProbeToken);
    }
});

test("#4743 E: an oversized 429 body with a never-settling cancellation promise returns promptly with account scope", { timeout: 1_000 }, async () => {
    const url = "http://oversized-keyring-429.invalid/v1/chat/completions";
    let cancelCalled = false;
    const transport = async () => new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new Uint8Array(16 * 1024 + 1));
            },
            cancel() {
                cancelCalled = true;
                return new Promise<void>(() => {});
            },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
    );

    try {
        const started = Date.now();
        const out = await withFetchTransport(transport, () => makeContinuationRefetch(opts(url, "oversized-scope-4743"))());
        assert.equal(out, null);
        assert.ok(Date.now() - started < 500, "cancellation is fire-and-forget rather than part of callback latency");
        assert.equal(cancelCalled, true, "the oversized body is canceled");
        const hold = activeThrottleHolds().find((entry) => entry.host === new URL(url).host);
        assert.ok(hold, "the ambiguous oversized response still arms a hold");
        assert.equal(hold.model, undefined, "oversized error bodies remain account-wide");
        assert.ok(throttleReject(url, {}, Date.now(), "m"));
        assert.ok(throttleReject(url, {}, Date.now(), "other-model"));
    } finally {
        noteUpstreamThrottleResolved(url, {}, 200, Date.now(), "m");
    }
});

test("#4743 F: an aborted retry releases its own probe token without clearing the model hold", { timeout: 5_000 }, async () => {
    const url = "http://aborted-keyring-429.invalid/v1/chat/completions";
    const previousToggle = process.env.BILI_THROTTLE_429;
    process.env.BILI_THROTTLE_429 = "1";
    _resetUpstreamThrottleForTest();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const transport = async (_url: string, options: { signal?: AbortSignal | null }): Promise<Response> => {
        const signal = options.signal;
        assert.ok(signal, "fetch transport receives the relay abort signal");
        return await new Promise<Response>((_resolve, reject) => {
            if (signal.aborted) {
                started.resolve();
                reject(new Error("request aborted"));
                return;
            }
            signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
            started.resolve();
        });
    };

    try {
        noteUpstreamThrottle429(url, {}, null, Date.now() - 60_000, "m");
        assert.ok(activeThrottleHolds().some((hold) => hold.model === "m"), "the model-scoped hold is armed before the probe");
        const pendingSend = withFetchTransport(transport, () => makeContinuationRefetch(opts(url, "abort-probe-4743", controller.signal))());
        await started.promise;
        controller.abort();
        assert.equal(await pendingSend, null, "an aborted refetch passes the empty turn through");

        const nextAdmission = upstreamThrottleGate(url, {}, Date.now(), "m");
        assert.equal(nextAdmission.reject, undefined, "the cancelled request releases its in-flight probe claim");
        assert.equal(typeof nextAdmission.probeToken, "symbol", "the model hold remains armed and grants a new owned probe");
        assert.ok(activeThrottleHolds().some((hold) => hold.model === "m"), "cancellation does not clear the model hold");
    } finally {
        controller.abort();
        _resetUpstreamThrottleForTest();
        if (previousToggle === undefined) delete process.env.BILI_THROTTLE_429;
        else process.env.BILI_THROTTLE_429 = previousToggle;
    }
});
test("#4204 continuation classifications stay isolated when one origin saturates", { timeout: 5_000 }, async () => {
    const previousToggle = process.env.BILI_THROTTLE_429;
    process.env.BILI_THROTTLE_429 = "1";
    _resetUpstreamThrottleForTest();
    const saturatedUrl = "http://saturated-keyring-429.invalid/v1/chat/completions";
    const otherUrl = "http://other-keyring-429.invalid/v1/chat/completions";
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    const allStarted = Promise.withResolvers<void>();
    let saturatedHits = 0;
    let otherHits = 0;
    const attempts: Array<Promise<ReadableStream<Uint8Array> | null>> = [];
    const transport = async (url: string): Promise<Response> => {
        if (url === saturatedUrl) {
            saturatedHits++;
            return new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    bodies.push(controller);
                    if (bodies.length === 64) allStarted.resolve();
                },
            }), { status: 429, headers: { "content-type": "application/json" } });
        }
        otherHits++;
        return new Response("event: message_start\ndata: {}\n\n", { status: 200 });
    };

    try {
        await withFetchTransport(transport, async () => {
            for (let i = 0; i < 64; i++) {
                attempts.push(makeContinuationRefetch(opts(saturatedUrl, `saturated-${i}`))());
            }
            await allStarted.promise;
            const pending = await Promise.all(attempts);
            assert.ok(pending.every((body) => body === null), "slow 429 retries return the original empty turns promptly");

            const saturatedRetry = await makeContinuationRefetch(opts(saturatedUrl, "saturated-overflow"))();
            assert.equal(saturatedRetry, null, "the 65th same-credential retry is declined before egress");
            assert.equal(saturatedHits, 64, "saturated same-origin admission adds no upstream request");

            const otherBody = await makeContinuationRefetch(opts(otherUrl, "other-provider"))();
            assert.ok(otherBody, "another origin's continuation still receives its upstream stream");
            await otherBody.cancel();
            assert.equal(otherHits, 1, "the unrelated origin proceeds while saturated bodies remain unresolved");
            assert.equal(throttleReject(otherUrl, {}, Date.now(), "m"), undefined, "saturation does not create a misleading hold for the other origin");

            const accountLimit = new TextEncoder().encode(JSON.stringify({ error: { code: "keyring_all_limited" } }));
            for (const body of bodies) {
                body.enqueue(accountLimit);
                body.close();
            }

            const reopened: ThrottleClassificationReservation[] = [];
            for (let attempt = 0; attempt < 20 && reopened.length < 64; attempt++) {
                while (reopened.length < 64) {
                    const reservation = reserveUpstreamThrottleClassification(saturatedUrl, {});
                    if (reservation === undefined) break;
                    reopened.push(reservation);
                }
                if (reopened.length < 64) await setImmediate();
            }
            assert.equal(reopened.length, 64, "every completed slow body releases its reserved classification slot");
            for (const reservation of reopened) reservation.release();

            const accountHold = activeThrottleHolds().find((hold) => hold.host === new URL(saturatedUrl).host);
            assert.ok(accountHold, "ambiguous saturated 429 bodies retain account-wide evidence");
            assert.equal(accountHold.model, undefined, "account-wide quota is not narrowed to a model");
            assert.ok(throttleReject(saturatedUrl, {}, Date.now(), "other-model"), "the new account-limit evidence blocks all models on its credential");
            assert.equal(throttleReject(otherUrl, {}, Date.now(), "m"), undefined, "the saturated origin's evidence does not affect another provider");
        });
    } finally {
        for (const body of bodies) {
            try {
                if (body.desiredSize !== null) {
                    body.enqueue(new TextEncoder().encode("{}"));
                    body.close();
                }
            } catch { /* best-effort cleanup for a failed assertion */ }
        }
        await Promise.allSettled(attempts);
        _resetUpstreamThrottleForTest();
        if (previousToggle === undefined) delete process.env.BILI_THROTTLE_429;
        else process.env.BILI_THROTTLE_429 = previousToggle;
    }
});

test("#4204 continuation classification reservations release on every exit", { timeout: 5_000 }, async () => {
    const previousToggle = process.env.BILI_THROTTLE_429;
    process.env.BILI_THROTTLE_429 = "1";
    _resetUpstreamThrottleForTest();
    const assertReleased = async (
        label: string,
        run: (url: string) => Promise<ReadableStream<Uint8Array> | null>,
    ): Promise<void> => {
        _resetUpstreamThrottleForTest();
        const url = `http://reservation-release-${label}.invalid/v1/chat/completions`;
        const seeded: ThrottleClassificationReservation[] = [];
        const reopened: ThrottleClassificationReservation[] = [];
        try {
            for (let i = 0; i < 63; i++) {
                const reservation = reserveUpstreamThrottleClassification(url, {});
                assert.ok(reservation, `${label}: seed reservation ${i} is admitted`);
                seeded.push(reservation);
            }
            const body = await run(url);
            if (body !== null) await body.cancel();

            for (let attempt = 0; attempt < 20 && reopened.length < 1; attempt++) {
                while (reopened.length < 1) {
                    const reservation = reserveUpstreamThrottleClassification(url, {});
                    if (reservation === undefined) break;
                    reopened.push(reservation);
                }
                if (reopened.length < 1) await setImmediate();
            }
            assert.equal(reopened.length, 1, `${label}: the retry's classification reservation is released on exit`);
        } finally {
            for (const reservation of seeded) reservation.release();
            for (const reservation of reopened) reservation.release();
            _resetUpstreamThrottleForTest();
        }
    };

    try {
        await assertReleased("local-gate", async (url) => {
            noteUpstreamThrottle429(url, {}, null);
            let hits = 0;
            const body = await withFetchTransport(async () => {
                hits++;
                return new Response("ok");
            }, () => makeContinuationRefetch(opts(url, "reservation-local-gate"))());
            assert.equal(hits, 0, "a locally held retry does not reach transport");
            return body;
        });
        await assertReleased("resign-error", async (url) => withFetchTransport(async () => {
            throw new Error("unexpected egress");
        }, () => makeContinuationRefetch({
            ...opts(url, "reservation-resign-error"),
            resign: () => { throw new Error("resign failed"); },
        })()));
        await assertReleased("fetch-error", async (url) => withFetchTransport(async () => {
            throw new Error("fetch failed");
        }, () => makeContinuationRefetch(opts(url, "reservation-fetch-error"))()));
        await assertReleased("abort", async (url) => {
            const controller = new AbortController();
            const started = Promise.withResolvers<void>();
            const transport = async (_url: string, options: { signal?: AbortSignal | null }): Promise<Response> => {
                const signal = options.signal;
                assert.ok(signal, "the transport receives the retry abort signal");
                const { promise, reject } = Promise.withResolvers<Response>();
                if (signal.aborted) {
                    started.resolve();
                    reject(new Error("request aborted"));
                    return promise;
                }
                signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
                started.resolve();
                return promise;
            };
            const pending = withFetchTransport(transport, () => makeContinuationRefetch(opts(url, "reservation-abort", controller.signal))());
            await started.promise;
            controller.abort();
            return pending;
        });
        await assertReleased("non-429", async (url) => withFetchTransport(async () => new Response("error", { status: 500 }),
            () => makeContinuationRefetch(opts(url, "reservation-non-429"))()));
        await assertReleased("success", async (url) => withFetchTransport(async () => new Response("event: message_start\ndata: {}\n\n", { status: 200 }),
            () => makeContinuationRefetch(opts(url, "reservation-success"))()));
        await assertReleased("settled-429", async (url) => withFetchTransport(async () => new Response("{}", { status: 429 }),
            () => makeContinuationRefetch(opts(url, "reservation-settled-429"))()));
    } finally {
        _resetUpstreamThrottleForTest();
        if (previousToggle === undefined) delete process.env.BILI_THROTTLE_429;
        else process.env.BILI_THROTTLE_429 = previousToggle;
    }
});
test("#4743 remains model-scoped when Promise.withResolvers is unavailable", async () => {
    const previousToggle = process.env.BILI_THROTTLE_429;
    const withResolversDescriptor = Object.getOwnPropertyDescriptor(Promise, "withResolvers");
    process.env.BILI_THROTTLE_429 = "1";
    _resetUpstreamThrottleForTest();
    const url = "http://without-promise-with-resolvers.invalid/v1/chat/completions";

    try {
        Object.defineProperty(Promise, "withResolvers", { configurable: true, writable: true, value: undefined });
        const body = JSON.stringify({ error: { code: "keyring_model_temporarily_unavailable", model: "m" } });
        const result = await withFetchTransport(async () => new Response(body, { status: 429 }),
            () => makeContinuationRefetch(opts(url, "without-with-resolvers"))());
        assert.equal(result, null);
        const holds = activeThrottleHolds().filter((hold) => hold.host === new URL(url).host);
        assert.deepEqual(holds.map((hold) => hold.model), ["m"], "the exact model refusal is retained without the newer Promise API");
        assert.ok(throttleReject(url, {}, Date.now() - 60_000, "m"), "the refused model remains held");
        assert.equal(throttleReject(url, {}, Date.now() - 60_000, "other-model"), undefined, "unrelated models stay eligible");
    } finally {
        if (withResolversDescriptor === undefined) Reflect.deleteProperty(Promise, "withResolvers");
        else Object.defineProperty(Promise, "withResolvers", withResolversDescriptor);
        _resetUpstreamThrottleForTest();
        if (previousToggle === undefined) delete process.env.BILI_THROTTLE_429;
        else process.env.BILI_THROTTLE_429 = previousToggle;
    }
});
