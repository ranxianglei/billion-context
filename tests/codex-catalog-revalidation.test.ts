import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexCatalogFetch } from "../src/server/codex-catalog-cache.js";

const url = "https://chatgpt.com/backend-api/codex/models";
const catalog = JSON.stringify({ models: [{ slug: "synthetic", context_window: 10000, model_messages: {} }] });
const headers = { authorization: "Bearer SYNTHETIC" };
const result = (body: string | null, status = 200, extra: Record<string, string> = {}) => ({
    response: new Response(body, { status, headers: extra }), clearTimer() {}, stopIdleTimer() {},
});
const offline = async () => { throw Object.assign(new Error("offline"), { code: "ENETUNREACH" }); };

test("a 304 for another client validator cannot renew or replay the stored catalog", async () => {
    const f = createCodexCatalogFetch({ directory: null });
    await f(async () => result(catalog, 200, { etag: '"old"' }), url, { headers });
    const revalidated = await f(async () => result(null, 304), url, { headers: { ...headers, "if-none-match": '"new"' } });
    assert.equal(revalidated.response.status, 304);
    await assert.rejects(() => f(offline, url, { headers }), /offline/);
});

test("a cached response without validators is not revalidated by an arbitrary conditional request", async () => {
    const f = createCodexCatalogFetch({ directory: null });
    await f(async () => result(catalog), url, { headers });
    const revalidated = await f(async () => result(null, 304), url, { headers: { ...headers, "if-none-match": '"unknown"' } });
    assert.equal(revalidated.response.status, 304);
});

test("a matching weak entity tag revalidates the complete catalog", async () => {
    const f = createCodexCatalogFetch({ directory: null });
    await f(async () => result(catalog, 200, { etag: '"same"' }), url, { headers });
    const revalidated = await f(async () => result(null, 304), url, { headers: { ...headers, "if-none-match": 'W/"same"' } });
    assert.equal(revalidated.response.status, 200);
    assert.equal(await revalidated.response.text(), catalog);
});

test("304 response validators disambiguate lists and reject a different representation", async () => {
    for (const [responseTag, expected] of [['W/"same"', 200], ['"other"', 304]] as const) {
        const f = createCodexCatalogFetch({ directory: null });
        await f(async () => result(catalog, 200, { etag: '"same"' }), url, { headers });
        const revalidated = await f(async () => result(null, 304, { etag: responseTag }), url, {
            headers: { ...headers, "if-none-match": '"same", "other"' },
        });
        assert.equal(revalidated.response.status, expected);
    }
});

test("an ambiguous entity-tag list or wildcard does not prove the stored representation unchanged", async () => {
    for (const condition of ['"same", "other"', '*']) {
        const f = createCodexCatalogFetch({ directory: null });
        await f(async () => result(catalog, 200, { etag: '"same"' }), url, { headers });
        const revalidated = await f(async () => result(null, 304), url, { headers: { ...headers, "if-none-match": condition } });
        assert.equal(revalidated.response.status, 304);
    }
});

test("Last-Modified revalidation requires the stored timestamp and honors ETag precedence", async () => {
    const modified = "Wed, 21 Oct 2015 07:28:00 GMT";
    for (const [condition, extra, expected] of [
        [modified, {}, 200],
        ["Thu, 22 Oct 2015 07:28:00 GMT", {}, 304],
        [modified, { "if-none-match": '"different"' }, 304],
    ] as const) {
        const f = createCodexCatalogFetch({ directory: null });
        await f(async () => result(catalog, 200, { "last-modified": modified, etag: '"same"' }), url, { headers });
        const revalidated = await f(async () => result(null, 304), url, {
            headers: { ...headers, "if-modified-since": condition, ...extra },
        });
        assert.equal(revalidated.response.status, expected);
    }
});

test("validator identity survives a private disk-cache restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bili-catalog-validator-"));
    try {
        await createCodexCatalogFetch({ directory })(async () => result(catalog, 200, { etag: '"disk"' }), url, { headers });
        const f = createCodexCatalogFetch({ directory });
        const revalidated = await f(async () => result(null, 304), url, { headers: { ...headers, "if-none-match": '"disk"' } });
        assert.equal(revalidated.response.status, 200);
        assert.equal(await revalidated.response.text(), catalog);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
