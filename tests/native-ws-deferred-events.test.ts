import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { getEventListeners } from "node:events";
import { installNativeWebSocketIntercept, _resetForTest } from "../src/agent/native-ws-intercept.ts";

class EventSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: EventSocket[] = [];
    readonly url: string;
    readyState = 0;
    bufferedAmount = 0;
    protocol = "";
    extensions = "";
    binaryType = "blob";
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onmessage: ((event: Event) => void) | null = null;
    constructor(url: string) {
        super();
        this.url = url;
        EventSocket.instances.push(this);
    }
    send(): void {}
    close(): void { this.readyState = EventSocket.CLOSED; }
}

async function withDeferred(run: (socket: EventSocket, attach: () => Promise<EventSocket>) => Promise<void>): Promise<void> {
    const saved = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    _resetForTest();
    EventSocket.instances = [];
    Object.defineProperty(globalThis, "WebSocket", { value: EventSocket, configurable: true, writable: true });
    let resolve!: (origin: string | undefined) => void;
    const ready = new Promise<string | undefined>((done) => { resolve = done; });
    try {
        installNativeWebSocketIntercept({ origin: undefined, ready });
        const Constructor = globalThis.WebSocket as unknown as new (url: string) => EventSocket;
        const socket = new Constructor("wss://chatgpt.com/backend-api/codex/responses");
        await run(socket, async () => {
            resolve("http://127.0.0.1:8787");
            await tick();
            await tick();
            assert.equal(EventSocket.instances.length, 1);
            return EventSocket.instances[0];
        });
    } finally {
        resolve(undefined);
        await tick();
        _resetForTest();
        if (saved) Object.defineProperty(globalThis, "WebSocket", saved);
        else Reflect.deleteProperty(globalThis, "WebSocket");
    }
}

test("deferred boolean listener options preserve capture without enabling once", async () => {
    await withDeferred(async (socket, attach) => {
        let count = 0;
        socket.addEventListener("message", () => count++, true);
        const real = await attach();
        real.dispatchEvent(new Event("message"));
        real.dispatchEvent(new Event("message"));
        assert.equal(count, 2);
    });
});

test("deferred listeners honor already-aborted and pre-attach abort signals", async () => {
    await withDeferred(async (socket, attach) => {
        let count = 0;
        const aborted = new AbortController();
        aborted.abort();
        const pending = new AbortController();
        socket.addEventListener("message", () => count++, { signal: aborted.signal });
        socket.addEventListener("message", () => count++, { signal: pending.signal });
        pending.abort();
        const real = await attach();
        real.dispatchEvent(new Event("message"));
        assert.equal(count, 0);
        assert.equal(getEventListeners(pending.signal, "abort").length, 0);
    });
});

test("deferred listener signal transfers to the real socket", async () => {
    await withDeferred(async (socket, attach) => {
        const controller = new AbortController();
        let count = 0;
        socket.addEventListener("message", () => count++, { signal: controller.signal });
        const real = await attach();
        real.dispatchEvent(new Event("message"));
        controller.abort();
        real.dispatchEvent(new Event("message"));
        assert.equal(count, 1);
    });
});

test("deferred listener removal matches capture and detaches its abort hook", async () => {
    await withDeferred(async (socket, attach) => {
        const controller = new AbortController();
        let count = 0;
        const listener = (): void => { count++; };
        socket.addEventListener("message", listener, { capture: false, signal: controller.signal });
        socket.addEventListener("message", listener, { capture: true });
        socket.removeEventListener("message", listener, { capture: true });
        const real = await attach();
        real.dispatchEvent(new Event("message"));
        assert.equal(count, 1);
        controller.abort();
        real.dispatchEvent(new Event("message"));
        assert.equal(count, 1);
    });
});

test("deferred duplicate registration dispatches once and explicit removal clears signal", async () => {
    await withDeferred(async (socket) => {
        let count = 0;
        const listener = (): void => { count++; };
        socket.addEventListener("message", listener);
        socket.addEventListener("message", listener);
        socket.dispatchEvent(new Event("message"));
        assert.equal(count, 1);
        const controller = new AbortController();
        socket.addEventListener("close", listener, { signal: controller.signal });
        socket.removeEventListener("close", listener);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        socket.close();
    });
});

test("deferred once listener is removed before a reentrant dispatch", async () => {
    await withDeferred(async (socket) => {
        let count = 0;
        socket.addEventListener("message", () => {
            count++;
            if (count === 1) socket.dispatchEvent(new Event("message"));
        }, { once: true });
        socket.dispatchEvent(new Event("message"));
        assert.equal(count, 1);
        socket.close();
    });
});

test("deferred close reaches CLOSED before notifying listeners and cannot open later", async () => {
    await withDeferred(async (socket) => {
        const states: number[] = [];
        socket.addEventListener("close", () => states.push(socket.readyState));
        socket.close();
        assert.equal(socket.readyState, EventSocket.CLOSING);
        await tick();
        assert.deepEqual(states, [EventSocket.CLOSED]);
        assert.equal(socket.readyState, EventSocket.CLOSED);
        socket.close();
        await tick();
        assert.equal(states.length, 1);
        assert.equal(EventSocket.instances.length, 0);
    });
});
