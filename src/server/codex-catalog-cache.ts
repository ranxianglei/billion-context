import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { cacheDir } from "../paths.js";
import type { FetchOptions, fetchWithTimeout } from "../fetch-util.js";

type FetchResult = Awaited<ReturnType<typeof fetchWithTimeout>>;
type Entry = { key: string; savedAt: number; body: string };
type Log = (level: "info" | "warn", message: string) => void;
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 16;
const TRANSIENT_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
]);

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validCatalog(text: unknown): text is string {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) return false;
    try {
        const body: unknown = JSON.parse(text);
        const seen = new Set<string>();
        return (
            record(body) &&
            Array.isArray(body.models) &&
            body.models.length > 0 &&
            body.models.every((model: unknown) => {
                if (
                    !record(model) ||
                    typeof model.slug !== "string" ||
                    !model.slug ||
                    seen.has(model.slug) ||
                    typeof model.context_window !== "number" ||
                    !Number.isFinite(model.context_window) ||
                    model.context_window <= 0 ||
                    !record(model.model_messages)
                )
                    return false;
                seen.add(model.slug);
                return true;
            })
        );
    } catch {
        return false;
    }
}

function transient(error: unknown): boolean {
    const seen = new Set<unknown>();
    for (let current = error; record(current) && !seen.has(current); current = current.cause) {
        seen.add(current);
        if ((typeof current.code === "string" && TRANSIENT_CODES.has(current.code)) || current.name === "TimeoutError") return true;
    }
    return false;
}

export function isCodexCatalogRequest(url: string, init: FetchOptions): boolean {
    try {
        const parsed = new URL(url);
        return (
            (init.method ?? "GET") === "GET" &&
            parsed.origin === "https://chatgpt.com" &&
            parsed.pathname === "/backend-api/codex/models" &&
            /^Bearer \S+$/i.test(new Headers(init.headers).get("authorization") ?? "")
        );
    } catch {
        return false;
    }
}

export function createCodexCatalogFetch(
    options: {
        directory?: string | null;
        now?: () => number;
        maxAgeMs?: number;
        deadlineMs?: number;
    } = {},
) {
    const memory = new Map<string, Entry>();
    const invalidated = new Set<string>();
    const offSpec304Noted = new Set<string>();
    const clock = options.now ?? Date.now;
    const maxAge = options.maxAgeMs ?? 6 * 60 * 60 * 1000;
    const fresh = (entry: unknown): entry is Entry =>
        record(entry) &&
        typeof entry.key === "string" &&
        typeof entry.savedAt === "number" &&
        Number.isFinite(entry.savedAt) &&
        clock() >= entry.savedAt &&
        clock() - entry.savedAt <= maxAge &&
        validCatalog(entry.body);
    return async (
        operation: (signal?: AbortSignal) => Promise<FetchResult>,
        url: string,
        init: FetchOptions,
        signal?: AbortSignal,
        log: Log = () => {},
    ): Promise<FetchResult> => {
        if (!isCodexCatalogRequest(url, init)) return operation(signal);
        signal?.throwIfAborted();
        const headers = new Headers(init.headers);
        const key = createHash("sha256")
            .update(
                JSON.stringify([
                    new URL(url).href,
                    ...["authorization", "chatgpt-account-id", "openai-organization", "openai-project"].map((name) => headers.get(name) ?? ""),
                ]),
            )
            .digest("hex");
        const directory = options.directory === undefined ? path.join(cacheDir(), "codex-model-catalog-v1") : options.directory;
        const file = directory ? path.join(directory, `${key}.json`) : null;
        let entry = invalidated.has(key) ? undefined : memory.get(key);
        if (!entry && file && !invalidated.has(key)) {
            try {
                if ((await fs.stat(file)).size <= MAX_BYTES * 2) {
                    const saved: unknown = JSON.parse(await fs.readFile(file, "utf8"));
                    if (fresh(saved) && saved.key === key) entry = saved;
                }
            } catch {
                /* Cache absence or corruption is a miss. */
            }
        }
        if (!fresh(entry)) entry = undefined;
        const remember = async (value: Entry) => {
            entry = value;
            invalidated.delete(key);
            memory.delete(key);
            memory.set(key, value);
            while (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value!);
            if (!file || !directory) return;
            const temp = `${file}.${randomUUID()}.tmp`;
            try {
                await fs.mkdir(directory, { recursive: true, mode: 0o700 });
                await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600 });
                await fs.rename(temp, file);
                const names = (await fs.readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
                if (names.length > MAX_ENTRIES) {
                    const dated = await Promise.all(
                        names.map(async (name) => ({
                            name,
                            mtime: (await fs.stat(path.join(directory, name))).mtimeMs,
                        })),
                    );
                    dated.sort((a, b) => b.mtime - a.mtime);
                    await Promise.all(dated.slice(MAX_ENTRIES).map((item) => fs.unlink(path.join(directory, item.name)).catch(() => {})));
                }
            } catch {
                log("warn", "[model-catalog] private cache write unavailable; using memory cache");
            } finally {
                await fs.unlink(temp).catch(() => {});
            }
        };
        const invalidate = async () => {
            entry = undefined;
            memory.delete(key);
            invalidated.add(key);
            if (invalidated.size > 256) invalidated.delete(invalidated.values().next().value!);
            if (file) {
                // A tombstone prevents a failed deletion from reviving old capabilities.
                await fs
                    .writeFile(file, JSON.stringify({ key, invalidated: true }), {
                        mode: 0o600,
                    })
                    .catch(() => {});
                await fs.unlink(file).catch(() => {});
            }
        };
        const discard = (result?: FetchResult) => {
            result?.clearTimer();
            result?.stopIdleTimer();
            void result?.response.body?.cancel().catch(() => {});
        };
        const replay = (saved: Entry, offline = true): FetchResult => ({
            response: new Response(saved.body, {
                status: 200,
                headers: {
                    "content-type": "application/json",
                    "cache-control": "no-store",
                    ...(offline ? { "x-bili-model-catalog": "offline-cache" } : {}),
                },
            }),
            clearTimer: () => {},
            stopIdleTimer: () => {},
        });
        const cached = (reason: string, result?: FetchResult) => {
            signal?.throwIfAborted();
            discard(result);
            log(
                "warn",
                `[model-catalog] serving last valid catalog after ${reason}; age=${Math.floor((clock() - entry!.savedAt) / 1000)}s; model metadata preserved`,
            );
            return replay(entry!);
        };
        const deadline = new AbortController();
        const timeout = entry ? setTimeout(() => deadline.abort(), options.deadlineMs ?? 4000) : undefined;
        const linked = entry ? AbortSignal.any([...(signal ? [signal] : []), deadline.signal]) : signal;
        let result: FetchResult | undefined;
        try {
            result = await operation(linked);
            signal?.throwIfAborted();
            const status = result.response.status;
            if ([500, 502, 503, 504].includes(status)) return fresh(entry) ? cached(`temporary HTTP ${status}`, result) : result;
            if (status === 304) {
                if (!entry) return result;
                // A 304 only means "not modified" when THIS request was
                // conditional — the wrapper itself never sends a validator,
                // but the end client may have added if-none-match /
                // if-modified-since and that negotiated 304 replays the
                // cached 200 legitimately. An UNCONDITIONAL 304 is off-spec
                // (some transparent middleboxes answer it anyway): treat it
                // like any other unexpected status — drop the cache, pass
                // the oddity through — instead of extending freshness on a
                // phantom hit whose real headers we would also discard.
                if (!headers.has("if-none-match") && !headers.has("if-modified-since")) {
                    // A gateway looping on this off-spec answer would otherwise
                    // stay invisible; one warn per credential makes it traceable.
                    if (!offSpec304Noted.has(key)) {
                        offSpec304Noted.add(key);
                        log("warn", `[model-catalog] upstream answered 304 to an unconditional GET; dropping cached catalog and passing the response through; age=${Math.floor((clock() - entry.savedAt) / 1000)}s`);
                    }
                    await invalidate();
                    return result;
                }
                await remember({ ...entry, savedAt: clock() });
                discard(result);
                return replay(entry, false);
            }
            if (status !== 200) {
                await invalidate();
                return result;
            }
            const reader = result.response.clone().body?.getReader();
            const chunks: Buffer[] = [];
            let size = 0,
                complete = false;
            if (reader) {
                try {
                    while (true) {
                        const part = await reader.read();
                        if (part.done) {
                            complete = true;
                            break;
                        }
                        size += part.value.byteLength;
                        if (size > MAX_BYTES) break;
                        chunks.push(Buffer.from(part.value));
                    }
                } finally {
                    if (!complete) void reader.cancel().catch(() => {});
                }
            }
            const text = complete ? Buffer.concat(chunks).toString("utf8") : "";
            if (validCatalog(text)) {
                await remember({ key, savedAt: clock(), body: text });
                log("info", "[model-catalog] complete catalog refreshed; offline protection ready");
            } else {
                await invalidate();
            }
            return result;
        } catch (error) {
            if (signal?.aborted) {
                discard(result);
                throw error;
            }
            if (fresh(entry) && (deadline.signal.aborted || transient(error))) return cached("network interruption", result);
            discard(result);
            throw error;
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    };
}

export const fetchWithCodexCatalogCache = createCodexCatalogFetch();
