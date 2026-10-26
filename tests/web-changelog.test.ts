/**
 * #3719 web changelog — GitHub Releases → panel cache + endpoint.
 * Covers: JSON mapping (passthrough, newest-first, 20-cap, bad-row skip),
 * the 10-minute throttle (no refetch within TTL, force bypasses), fail-soft
 * on network + HTTP errors (empty/stale releases + error:"offline", never
 * throws), and handleChangelogGet's always-200 JSON response.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { getChangelog, latestChangelog, _resetChangelogForTest } from "../src/web/changelog.ts";

const GH = "https://api.github.com/repos/ranxianglei/billion-context/releases?per_page=20";

/** One canned GitHub Releases API item; `over` lets individual tests mutate. */
function ghRelease(n: number, over?: Record<string, unknown>) {
    return {
        tag_name: `v0.9.${100 - n}`,
        name: n === 3 ? `v0.9.${100 - n}` : `v0.9.${100 - n} — release ${n}`, // row 3 name == tag (dropped)
        published_at: `2026-09-1${n % 9 + 1}T08:00:00Z`,
        body: `notes for ${n}\nsee https://github.com/ranxianglei/billion-context for details`,
        html_url: `https://github.com/ranxianglei/billion-context/releases/tag/v0.9.${100 - n}`,
        ...over,
    };
}

function fetchStub(body: unknown, status = 200): typeof fetch {
    return ((url: string | URL | Request) => {
        assert.equal(String(url), GH);
        return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    }) as typeof fetch;
}

const origFetch = globalThis.fetch;

beforeEach(() => {
    _resetChangelogForTest();
});
afterEach(() => {
    _resetChangelogForTest();
    globalThis.fetch = origFetch;
});

test("maps GitHub releases: passthrough fields, newest-first order, 20-entry cap", async () => {
    const feed: unknown[] = [];
    for (let i = 0; i < 25; i++) feed.push(ghRelease(i)); // GitHub lists newest first
    let hits = 0;
    globalThis.fetch = ((..._a: unknown[]) => { hits += 1; return Promise.resolve(new Response(JSON.stringify(feed), { status: 200 })); }) as typeof fetch;

    const data = await getChangelog();
    assert.equal(data.error, undefined);
    assert.equal(data.releases.length, 20);
    assert.equal(hits, 1);
    // Newest (feed[0]) first; order preserved verbatim.
    assert.equal(data.releases[0].tag, "v0.9.100");
    assert.equal(data.releases[19].tag, "v0.9.81");
    // Passthrough mapping.
    const r0 = data.releases[0];
    assert.equal(r0.name, "v0.9.100 — release 0");
    assert.equal(r0.publishedAt, "2026-09-11T08:00:00Z");
    assert.ok(r0.body?.includes("see https://github.com/"));
    assert.match(r0.url, /^https:\/\/github\.com\/.*releases\/tag\//);
    // Row with name === tag: field dropped, not duplicated in UI.
    const r3 = data.releases[3];
    assert.equal(r3.tag, "v0.9.97");
    assert.equal(r3.name, undefined);
    // Synchronous surface sees the same newest entry.
    assert.equal(latestChangelog()?.tag, "v0.9.100");
});

test("skips malformed rows without failing the feed", async () => {
    const feed = [ghRelease(0), { id: 1 }, null, { tag_name: "no-url" }, ghRelease(1)];
    globalThis.fetch = fetchStub(feed);
    const data = await getChangelog();
    assert.deepEqual(data.releases.map((r) => r.tag), ["v0.9.100", "v0.9.99"]);
    assert.equal(data.error, undefined);
});

test("throttle: second read within TTL does not re-fetch; force bypasses", async () => {
    let hits = 0;
    globalThis.fetch = (() => { hits += 1; return Promise.resolve(fetchStub([ghRelease(0)])(GH)); }) as typeof fetch;
    const first = await getChangelog();
    const second = await getChangelog(); // inside the 10-min window
    assert.equal(hits, 1);
    assert.deepEqual(second.releases, first.releases);
    const forced = await getChangelog({ force: true });
    assert.equal(hits, 2);
    assert.equal(forced.releases.length, 1);
});

test("network failure: resolves empty + error, never throws, latest stays undefined", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ENOTFOUND"))) as typeof fetch;
    const data = await getChangelog(); // must not reject
    assert.deepEqual(data, { releases: [], error: "offline" });
    assert.equal(latestChangelog(), undefined);
    // Failures are throttled too — no retry storm while offline.
    let hits = 0;
    globalThis.fetch = (() => { hits += 1; return Promise.reject(new Error("ECONNREFUSED")); }) as typeof fetch;
    const again = await getChangelog();
    assert.equal(hits, 0);
    assert.equal(again.error, "offline");
});

test("keeps stale releases on failure and recovers on a successful forced check", async () => {
    globalThis.fetch = fetchStub([ghRelease(0)]);
    assert.equal((await getChangelog()).releases[0].tag, "v0.9.100");
    globalThis.fetch = (() => Promise.reject(new Error("EAI_AGAIN"))) as typeof fetch;
    const failed = await getChangelog({ force: true });
    assert.equal(failed.error, "offline");
    assert.equal(failed.releases[0]?.tag, "v0.9.100"); // stale view retained
    globalThis.fetch = fetchStub([ghRelease(5)]);
    const ok = await getChangelog({ force: true });
    assert.equal(ok.error, undefined);
    assert.equal(ok.releases[0]?.tag, "v0.9.95");
});

test("HTTP 500 fails soft like a network error", async () => {
    globalThis.fetch = fetchStub({}, 500);
    const data = await getChangelog();
    assert.deepEqual(data, { releases: [], error: "offline" });
});

test("non-array / non-object payloads fail soft", async () => {
    globalThis.fetch = fetchStub({ message: "API rate limit exceeded" });
    let data = await getChangelog();
    assert.equal(data.releases.length, 0);
    assert.equal(data.error, "offline");
    _resetChangelogForTest();
    globalThis.fetch = fetchStub('"just a string"');
    data = await getChangelog();
    assert.equal(data.releases.length, 0);
    assert.equal(data.error, "offline");
});

function fakeRes(): { res: ServerResponse; status: number | undefined; ct: unknown; body: string } {
    const out: { res: ServerResponse; status: number | undefined; ct: unknown; body: string } =
        { res: undefined as unknown as ServerResponse, status: undefined, ct: undefined, body: "" };
    out.res = {
        writeHead(status: number, headers?: Record<string, string>) { out.status = status; out.ct = headers?.["content-type"]; },
        end(chunk?: string) { if (chunk !== undefined) out.body += chunk; },
    } as unknown as ServerResponse;
    return out;
}

test("handleChangelogGet answers 200 JSON — cached path and offline path", async () => {
    // Cached: no network needed once warm.
    globalThis.fetch = fetchStub([ghRelease(0)]);
    await getChangelog();
    const warm = fakeRes();
    const { handleChangelogGet } = await import("../src/web/changelog.ts");
    await handleChangelogGet(warm.res);
    assert.equal(warm.status, 200);
    assert.equal(warm.ct, "application/json");
    const parsed = JSON.parse(warm.body) as { releases: Array<{ tag: string }>; error?: string };
    assert.equal(parsed.releases[0].tag, "v0.9.100");
    assert.equal(parsed.error, undefined);
    // Offline: still 200 so the panel degrades gracefully.
    _resetChangelogForTest();
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    const cold = fakeRes();
    await handleChangelogGet(cold.res);
    assert.equal(cold.status, 200);
    const parsedCold = JSON.parse(cold.body) as { releases: unknown[]; error: string };
    assert.deepEqual(parsedCold.releases, []);
    assert.equal(parsedCold.error, "offline");
});
