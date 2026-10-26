import { AsyncLocalStorage } from "node:async_hooks";
import type { FetchOptions } from "./fetch-util.js";

type FetchTransport = (url: string, options: FetchOptions) => Promise<Response>;

const transports = new AsyncLocalStorage<FetchTransport>();

/** Transports tagged as the Responses-WS lane (#3701 Finding 1). The egress
 * shed byte budget may only trim requests that actually ride a WebSocket:
 * the close-1009 oversize verdict was observed exclusively there. Managed
 * HTTP transports (dsh-inline, inline-engine.ts) deliver large bodies fine
 * (16 MiB observed succeeding) and must pass through untouched. */
const wsLaneTransports = new WeakSet<FetchTransport>();

/** Tag a transport (and return it) as the Responses-WS lane. */
export function markWsLaneTransport(transport: FetchTransport): FetchTransport {
    wsLaneTransports.add(transport);
    return transport;
}

/** True only for transports installed via markWsLaneTransport. */
export function isWsLaneTransport(transport: FetchTransport | undefined): boolean {
    return transport !== undefined && wsLaneTransports.has(transport);
}

export function withFetchTransport<T>(transport: FetchTransport, run: () => T): T {
    return transports.run(transport, run);
}

export function currentFetchTransport(): FetchTransport | undefined {
    return transports.getStore();
}
