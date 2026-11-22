import http from "node:http";
import { logDumpFailure } from "./observability.js";
import { gcDumpDirIfConfigured } from "../state-gc.js";

/** Read a (small) fetch Response body stream fully into a Buffer. Used for the
 *  non-2xx error path, where we inspect the body for a context-overflow before
 *  passing it through. Error bodies are small JSON, so full buffering is safe —
 *  but the read is still CAPPED (maxBytes, default 1 MiB): a misbehaving upstream
 *  that streams a huge error body must not spike memory. The stream is drained
 *  either way (no backpressure deadlock, no discarded keep-alive connection); only
 *  the retained bytes are capped. Overflow markers live in the first few hundred
 *  bytes, so a cap never loses the signal. */
export async function readStreamToBuffer(stream: ReadableStream<Uint8Array>, maxBytes = 1 << 20): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let kept = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && kept < maxBytes) {
                // Trim the final chunk so retained bytes never exceed maxBytes.
                const take = Math.min(value.length, maxBytes - kept);
                chunks.push(Buffer.from(value.subarray(0, take)));
                kept += take;
            }
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}

/** Buffer a response only while it fits the inspection budget. On overflow,
 *  replay the retained prefix and continue streaming without dropping bytes. */
export async function bufferStreamIfFits(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer | ReadableStream<Uint8Array>> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let kept = 0;
    let handedOff = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return Buffer.concat(chunks, kept);
            if (value.byteLength === 0) continue;
            if (kept + value.byteLength <= maxBytes) {
                chunks.push(Buffer.from(value));
                kept += value.byteLength;
                continue;
            }
            let ended = false;
            const replay = new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(chunk);
                    chunks.length = 0;
                    controller.enqueue(value);
                },
                async pull(controller) {
                    try {
                        const next = await reader.read();
                        if (ended) return;
                        if (next.done) {
                            ended = true;
                            reader.releaseLock();
                            controller.close();
                        } else {
                            controller.enqueue(next.value);
                        }
                    } catch (error) {
                        if (!ended) {
                            ended = true;
                            reader.releaseLock();
                            controller.error(error);
                        }
                    }
                },
                async cancel(reason) {
                    ended = true;
                    try { await reader.cancel(reason); }
                    finally { reader.releaseLock(); }
                },
            });
            handedOff = true;
            return replay;
        }
    } finally {
        if (!handedOff) reader.releaseLock();
    }
}

export function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array(buf));
            controller.close();
        },
    });
}

/** Minimal writable surface {@link awaitDrain} needs — satisfied by
 *  http.ServerResponse and by test recording sinks alike. */
interface DrainableResponse {
    destroyed?: boolean;
    writableEnded?: boolean;
    once(event: string, cb: () => void): unknown;
    removeListener?(event: string, cb: () => void): unknown;
}

// Backpressure wait that also resolves when the CLIENT goes away (#100). A
// drain-only wait hangs forever once the client stops reading mid-stream:
// 'drain' never fires again, while 'close'/'error' do. If the response is
// already dead, resolve immediately — a fresh listener registered after
// 'close' has fired could never fire, so a second backpressure write after
// the disconnect would hang again.
export function awaitDrain(res: DrainableResponse): Promise<void> {
    if (res.destroyed || res.writableEnded) return Promise.resolve();
    return new Promise((resolve) => {
        // One shared settle: when any of the three fires, drop the other two or
        // they leak on every backpressure wait (MaxListenersExceededWarning).
        const done = (): void => {
            res.removeListener?.("drain", done);
            res.removeListener?.("close", done);
            res.removeListener?.("error", done);
            resolve();
        };
        res.once("drain", done);
        res.once("close", done);
        res.once("error", done);
    });
}

export async function pipeThrough(stream: ReadableStream<Uint8Array>, res: http.ServerResponse): Promise<void> {
    const reader = stream.getReader();
    let completed = false;
    const cancel = (): void => { void reader.cancel().catch(() => {}); };
    res.once("close", cancel);
    res.once("error", cancel);
    try {
        if (res.destroyed || res.writableEnded) return;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                completed = true;
                break;
            }
            if (res.destroyed || res.writableEnded) break;
            if (!res.write(Buffer.from(value))) {
                await awaitDrain(res);
            }
        }
    } finally {
        res.removeListener("close", cancel);
        res.removeListener("error", cancel);
        // A tee branch can wait for its sibling's cancellation. Do not hold cleanup on it.
        if (!completed) cancel();
        reader.releaseLock();
        res.end();
    }
}

export async function dumpStreamToFile(stream: ReadableStream<Uint8Array>, dir: string, name: string): Promise<void> {
    const { mkdirSync, createWriteStream } = await import("node:fs");
    const { join } = await import("node:path");
    const { pipeline } = await import("node:stream/promises");
    try {
        mkdirSync(dir, { recursive: true });
        const ws = createWriteStream(join(dir, name));
        await pipeline(stream, ws);
        gcDumpDirIfConfigured(dir);
    } catch (err) {
        logDumpFailure("SSE stream dump", err);
    }
}
