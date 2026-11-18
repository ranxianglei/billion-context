import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import { unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexCatalogFetch } from "../src/server/codex-catalog-cache.js";
import type { fetchWithTimeout } from "../src/fetch-util.js";

type FetchResult = Awaited<ReturnType<typeof fetchWithTimeout>>;
const url = "https://chatgpt.com/backend-api/codex/models?client_version=race-fixture";
const init = { method: "GET", headers: { authorization: "Bearer SYNTHETIC_CATALOG_RACE" } };
const catalog = (slug = "fixture-model") => JSON.stringify({ models: [{ slug, context_window: 200000, model_messages: {} }] });
const result = (status = 200, body: string | ReadableStream<Uint8Array> | null = catalog()): FetchResult => ({
    response: new Response(body, { status }), clearTimer() {}, stopIdleTimer() {},
});
const offline = async (): Promise<FetchResult> => { throw Object.assign(new Error("fixture offline"), { code: "ENETUNREACH" }); };
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

for (const failure of ["http", "network"] as const) {
    test(`an overlapping ${failure} failure cannot replay a catalog invalidated by 401`, async () => {
        const cache = createCodexCatalogFetch({ directory: null });
        await cache(async () => result(), url, init);
        const gate = deferred<FetchResult>();
        const entered = deferred<void>();
        const old = cache(() => { entered.resolve(); return gate.promise; }, url, init);
        await entered.promise;
        assert.equal((await cache(async () => result(401, "denied"), url, init)).response.status, 401);
        if (failure === "http") {
            gate.resolve(result(503, "temporarily unavailable"));
            assert.equal((await old).response.status, 503);
        } else {
            gate.reject(Object.assign(new Error("fixture offline"), { code: "ENETUNREACH" }));
            await assert.rejects(old, /fixture offline/);
        }
        await assert.rejects(cache(offline, url, init), /fixture offline/);
    });
}

test("a successful body already being read cannot revive a subsequently invalidated memory or disk catalog", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "bili-catalog-body-race-"));
    let release!: () => void;
    try {
        const cache = createCodexCatalogFetch({ directory: dir });
        await cache(async () => result(), url, init);
        const entered = deferred<void>();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"models":'));
                release = () => { release = () => {}; controller.enqueue(new TextEncoder().encode(catalog("old-response").slice('{"models":'.length))); controller.close(); };
            },
        });
        const old = cache(() => { entered.resolve(); return Promise.resolve(result(200, body)); }, url, init);
        await entered.promise;
        assert.equal((await cache(async () => result(403, "denied"), url, init)).response.status, 403);
        release();
        assert.equal(await (await old).response.text(), catalog("old-response"), "the original successful response still reaches its caller");
        await assert.rejects(cache(offline, url, init), /fixture offline/);
        await assert.rejects(createCodexCatalogFetch({ directory: dir })(offline, url, init), /fixture offline/);
    } finally { release?.(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("a newer post-invalidation refresh survives an older response finishing last", async () => {
    const cache = createCodexCatalogFetch({ directory: null });
    await cache(async () => result(), url, init);
    const gate = deferred<FetchResult>();
    const entered = deferred<void>();
    const old = cache(() => { entered.resolve(); return gate.promise; }, url, init);
    await entered.promise;
    await cache(async () => result(401, "denied"), url, init);
    await cache(async () => result(200, catalog("new-generation")), url, init);
    gate.resolve(result(200, catalog("old-generation")));
    await old;
    assert.equal(await (await cache(offline, url, init)).response.text(), catalog("new-generation"));
});

test("an old conditional 304 cannot replay a catalog invalidated while it was in flight", async () => {
    const cache = createCodexCatalogFetch({ directory: null });
    const seed = result();
    seed.response.headers.set("etag", '"fixture-v1"');
    await cache(async () => seed, url, init);
    const gate = deferred<FetchResult>();
    const entered = deferred<void>();
    const old = cache(() => { entered.resolve(); return gate.promise; }, url, {
        ...init, headers: { ...init.headers, "if-none-match": '"fixture-v1"' },
    });
    await entered.promise;
    await cache(async () => result(401, "denied"), url, init);
    gate.resolve(result(304, null));
    assert.equal((await old).response.status, 304);
    await assert.rejects(cache(offline, url, init), /fixture offline/);
});

test("a stale denial cannot erase a refreshed catalog from after the invalidation", async () => {
    const cache = createCodexCatalogFetch({ directory: null });
    await cache(async () => result(), url, init);
    const gate = deferred<FetchResult>();
    const entered = deferred<void>();
    const old = cache(() => { entered.resolve(); return gate.promise; }, url, init);
    await entered.promise;
    await cache(async () => result(401, "denied"), url, init);
    await cache(async () => result(200, catalog("fresh-login")), url, init);
    gate.resolve(result(403, "old denial"));
    assert.equal((await old).response.status, 403);
    assert.equal(await (await cache(offline, url, init)).response.text(), catalog("fresh-login"));
});

test("invalidation and queued writes cannot be overtaken by an already pending disk rename", async (t) => {
    const dir = await fs.mkdtemp(join(tmpdir(), "bili-catalog-rename-race-"));
    const resume = deferred<void>();
    let old: Promise<FetchResult> | undefined;
    let denial: Promise<FetchResult> | undefined;
    try {
        const cache = createCodexCatalogFetch({ directory: dir });
        await cache(async () => result(), url, init);
        const file = join(dir, (await fs.readdir(dir))[0]);
        const entered = deferred<void>();
        const originalRename = fs.rename;
        const originalWrite = fs.writeFile;
        const originalUnlink = fs.unlink;
        t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
            if (args[1] === file) { entered.resolve(); await resume.promise; }
            return originalRename(...args);
        });
        // Make the invalidation's fixture-only disk steps synchronous, so one
        // event-loop turn determines their ordering without a timing threshold.
        t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
            if (args[0] === file && typeof args[1] === "string" && args[1].includes('"invalidated":true')) {
                writeFileSync(file, args[1], { mode: 0o600 });
                return;
            }
            return originalWrite(...args);
        });
        t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
            if (args[0] === file) { unlinkSync(file); return; }
            return originalUnlink(...args);
        });
        syncBuiltinESMExports();
        old = cache(async () => result(200, catalog("pending-rename")), url, init);
        await entered.promise;
        denial = cache(async () => result(401, "denied"), url, init);
        await new Promise<void>((resolve) => setImmediate(resolve));
        resume.resolve();
        await Promise.all([old, denial]);
        await assert.rejects(createCodexCatalogFetch({ directory: dir })(offline, url, init), /fixture offline/);
    } finally {
        resume.resolve();
        await Promise.allSettled([old, denial]);
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("invalidating one credential leaves another credential's offline protection intact", async () => {
    const cache = createCodexCatalogFetch({ directory: null });
    const other = { ...init, headers: { authorization: "Bearer SYNTHETIC_OTHER_CATALOG" } };
    await cache(async () => result(), url, init);
    await cache(async () => result(200, catalog("other-account")), url, other);
    await cache(async () => result(401, "denied"), url, init);
    assert.equal(await (await cache(offline, url, other)).response.text(), catalog("other-account"));
});
