import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexCatalogFetch } from "../src/server/codex-catalog-cache.js";
import type { FetchOptions, fetchWithTimeout } from "../src/fetch-util.js";
type FetchResult = Awaited<ReturnType<typeof fetchWithTimeout>>;

const url = "https://chatgpt.com/backend-api/codex/models?client_version=0.163.0";
const init = {
    method: "GET",
    headers: {
        authorization: "Bearer SYNTHETIC_A",
        "chatgpt-account-id": "FAKE_ACCOUNT_A",
    },
};
const catalog = {
    models: [
        {
            slug: "gpt-6.1-sol",
            context_window: 500000,
            max_context_window: 872000,
            tool_mode: "code_mode_only",
            supports_search_tool: true,
            comp_hash: "synthetic",
            model_messages: { instructions_template: "SYNTHETIC_INSTRUCTIONS" },
        },
    ],
};
const text = JSON.stringify(catalog);
const result = (body: string | null = text, status = 200, headers: Record<string, string> = {}): FetchResult => ({
    response: new Response(body, { status, headers }),
    clearTimer() {},
    stopIdleTimer() {},
});
const offline = async () => {
    throw Object.assign(new Error("synthetic offline"), { code: "ENETUNREACH" });
};
const send = (
    fetch: ReturnType<typeof createCodexCatalogFetch>,
    operation: (signal?: AbortSignal) => Promise<FetchResult>,
    u = url,
    i: FetchOptions = init,
    signal?: AbortSignal,
) => fetch(operation, u, i, signal);

test("warm -> offline -> recovered preserves exact metadata and refreshes removed capabilities", async () => {
    const f = createCodexCatalogFetch({ directory: null });
    assert.equal(await (await send(f, async () => result())).response.text(), text);
    const fallback = await send(f, offline);
    assert.equal(fallback.response.status, 200);
    assert.equal(fallback.response.headers.get("x-bili-model-catalog"), "offline-cache");
    assert.deepEqual(await fallback.response.json(), catalog);
    const updated = JSON.stringify({
        models: [
            {
                ...catalog.models[0],
                context_window: 400000,
                supports_search_tool: false,
            },
        ],
    });
    await send(f, async () => result(updated));
    assert.equal(await (await send(f, offline)).response.text(), updated);
});

test("private disk cache survives factory restart without storing credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bili-catalog-"));
    try {
        await send(createCodexCatalogFetch({ directory: dir }), async () => result());
        const files = await readdir(dir);
        assert.equal(files.length, 1);
        assert.match(files[0], /^[a-f0-9]{64}\.json$/);
        const stored = await readFile(join(dir, files[0]), "utf8");
        assert.ok(!stored.includes("SYNTHETIC_A"));
        assert.ok(!stored.includes("FAKE_ACCOUNT_A"));
        assert.equal(await (await send(createCodexCatalogFetch({ directory: dir }), offline)).response.text(), text);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("separates bearer, account, organization, project and client version", async () => {
    const f = createCodexCatalogFetch({ directory: null });
    await send(f, async () => result());
    for (const [name, value] of [
        ["authorization", "Bearer SYNTHETIC_B"],
        ["chatgpt-account-id", "B"],
        ["openai-organization", "B"],
        ["openai-project", "B"],
    ]) {
        await assert.rejects(
            () =>
                send(f, offline, url, {
                    ...init,
                    headers: { ...init.headers, [name]: value },
                }),
            /synthetic offline/,
        );
    }
    await assert.rejects(() => send(f, offline, url.replace("0.163.0", "0.164.0")), /synthetic offline/);
});

test("401/403 and authoritative removal invalidate stale catalogs, including on disk", async () => {
    for (const status of [401, 403, 404, 429]) {
        const dir = await mkdtemp(join(tmpdir(), "bili-catalog-auth-"));
        try {
            const f = createCodexCatalogFetch({ directory: dir });
            await send(f, async () => result());
            assert.equal((await send(f, async () => result("denied", status))).response.status, status);
            await assert.rejects(() => send(f, offline), /synthetic offline/);
            await assert.rejects(() => send(createCodexCatalogFetch({ directory: dir }), offline), /synthetic offline/);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    }
});

test("malformed/empty/oversized successful catalog is forwarded but never rescued or cached", async () => {
    for (const body of ["invalid JSON", '{"models":[]}', JSON.stringify({ models: [{ slug: "IDs_ONLY" }] }), "x".repeat(1024 * 1024 + 1)]) {
        const f = createCodexCatalogFetch({ directory: null });
        await send(f, async () => result());
        const response = await send(f, async () => result(body));
        assert.equal(await response.response.text(), body);
        await assert.rejects(() => send(f, offline), /synthetic offline/);
    }
});

test("temporary HTTP outages recover; a NEGOTIATED 304 revalidation is a complete 200 catalog", async () => {
    const f = createCodexCatalogFetch({ directory: null });
    await send(f, async () => result());
    for (const status of [500, 502, 503, 504]) assert.equal(await (await send(f, async () => result("outage", status))).response.text(), text);
    // The client revalidated (conditional header on the request), so the
    // 304 replays the cached catalog as a full 200.
    const conditional = { ...init, headers: { ...init.headers, "if-none-match": '"synthetic-v1"' } };
    const recovered = await send(f, async () => result(null, 304), url, conditional);
    assert.equal(recovered.response.status, 200);
    assert.deepEqual(await recovered.response.json(), catalog);
});

test("an UNCONDITIONAL 304 is off-spec: no phantom hit — pass it through and drop the cache", async () => {
    const f = createCodexCatalogFetch({ directory: null });
    await send(f, async () => result());
    // No if-none-match / if-modified-since on the request: nothing was
    // revalidated, so a 304 from a broken middlebox must not extend
    // freshness or masquerade as the catalog.
    const odd = await send(f, async () => result(null, 304));
    assert.equal(odd.response.status, 304, "the off-spec response is passed through untouched");
    await assert.rejects(() => send(f, offline), /synthetic offline/, "cache invalidated, no phantom rescue");
});

test("outage does not renew cache age; expired and cold caches fail honestly", async () => {
    let clock = 1000;
    const f = createCodexCatalogFetch({
        directory: null,
        now: () => clock,
        maxAgeMs: 100,
    });
    await assert.rejects(() => send(f, offline), /synthetic offline/);
    await send(f, async () => result());
    clock = 1090;
    assert.equal((await send(f, offline)).response.status, 200);
    clock = 1101;
    await assert.rejects(() => send(f, offline), /synthetic offline/);
});

test("cached request has a bounded network deadline; caller cancellation never becomes 200", async () => {
    const f = createCodexCatalogFetch({ directory: null, deadlineMs: 25 });
    await send(f, async () => result());
    const hanging = (signal?: AbortSignal) =>
        new Promise<FetchResult>((resolve, reject) =>
            signal!.addEventListener("abort", () => reject(signal!.reason), {
                once: true,
            }),
        );
    assert.equal((await send(f, hanging)).response.status, 200);
    const caller = new AbortController();
    const promise = send(f, hanging, url, init, caller.signal);
    setTimeout(() => caller.abort(new Error("synthetic caller abort")), 5);
    await assert.rejects(() => promise, /synthetic caller abort/);
});

test("does not intercept inference, other providers, unauthenticated GET or programming errors", async () => {
    const f = createCodexCatalogFetch({ directory: null });
    await send(f, async () => result());
    for (const [u, i] of [
        [url.replace("/models?", "/responses?"), { ...init, method: "POST" }],
        [url.replace("chatgpt.com", "api.openai.com"), init],
        [url, { method: "GET", headers: {} }],
    ] as [string, FetchOptions][]) {
        let calls = 0;
        await assert.rejects(
            () =>
                send(
                    f,
                    async () => {
                        calls++;
                        return offline();
                    },
                    u,
                    i,
                ),
            /synthetic offline/,
        );
        assert.equal(calls, 1);
    }
    await assert.rejects(
        () =>
            send(f, async () => {
                throw new TypeError("programming defect");
            }),
        /programming defect/,
    );
});
