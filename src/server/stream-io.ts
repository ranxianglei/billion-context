import http from "node:http";
import { logDumpFailure } from "./observability.js";

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
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (res.destroyed || res.writableEnded) break;
            if (!res.write(Buffer.from(value))) {
                await awaitDrain(res);
            }
        }
    } finally {
        reader.releaseLock();
        res.end();
    }
}

export async function dumpStreamToFile(stream: ReadableStream<Uint8Array>, dir: string, name: string): Promise<void> {
    const { mkdirSync, createWriteStream } = await import("node:fs");
    const { join } = await import("node:path");
    try {
        mkdirSync(dir, { recursive: true });
        const ws = createWriteStream(join(dir, name));
        ws.on("error", (e) => { logDumpFailure("SSE stream dump", e); });
        const reader = stream.getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                ws.write(Buffer.from(value));
            }
        } finally {
            reader.releaseLock();
            ws.end();
        }
    } catch (err) {
        logDumpFailure("SSE stream dump", err);
    }
}
