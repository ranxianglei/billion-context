import { AsyncLocalStorage } from "node:async_hooks";
import type { FetchOptions } from "./fetch-util.js";

type FetchTransport = (url: string, options: FetchOptions) => Promise<Response>;

const transports = new AsyncLocalStorage<FetchTransport>();

export function withFetchTransport<T>(transport: FetchTransport, run: () => T): T {
    return transports.run(transport, run);
}

export function withoutFetchTransport<T>(run: () => T): T {
    return transports.exit(run);
}

export function currentFetchTransport(): FetchTransport | undefined {
    return transports.getStore();
}
