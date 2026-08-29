import { test } from "node:test";
import assert from "node:assert/strict";
import { isVersionNewer, checkForUpdate } from "../src/update.ts";

test("isVersionNewer compares numeric segments", () => {
    assert.equal(isVersionNewer("0.1.43", "0.1.41"), true);
    assert.equal(isVersionNewer("0.1.41", "0.1.43"), false);
    assert.equal(isVersionNewer("0.1.41", "0.1.41"), false);
    assert.equal(isVersionNewer("0.2.0", "0.10.0"), false);
    assert.equal(isVersionNewer("1.0.0", "0.9.9"), true);
    assert.equal(isVersionNewer("v1.2.3", "1.2.2"), true);
});

test("isVersionNewer handles prerelease ordering (pre < release, numeric pre parts)", () => {
    // A prerelease is OLDER than its release: 0.1.46-pr.202.1 < 0.1.46
    assert.equal(isVersionNewer("0.1.46", "0.1.46-pr.202.1"), true);
    assert.equal(isVersionNewer("0.1.46-pr.202.1", "0.1.46"), false);
    // Higher prerelease number is newer
    assert.equal(isVersionNewer("0.1.46-pr.203.1", "0.1.46-pr.202.1"), true);
    // A release is newer than any prerelease of a lower version
    assert.equal(isVersionNewer("0.1.47", "0.1.46-pr.999.1"), true);
});

// checkForUpdate must fetch the configured dist-tag channel, not always
// /latest. We mock global fetch to capture the URL and return a version that
// is never newer (0.0.1) so no install is triggered. force=true bypasses the
// throttle read; the throttle write is a harmless timestamp.
async function capturedFetchUrl(updateTag?: string): Promise<string[]> {
    const urls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
        urls.push(String(input));
        return { ok: true, json: async () => ({ version: "0.0.1" }) } as Response;
    }) as unknown as typeof fetch;
    try {
        await checkForUpdate(
            { packageName: "billion-context", currentVersion: "999.0.0", autoUpdate: true, updateTag },
            true,
        );
    } finally {
        globalThis.fetch = original;
    }
    return urls;
}

test("checkForUpdate follows updateTag: 'dev' → fetch /dev (not /latest)", async () => {
    const urls = await capturedFetchUrl("dev");
    assert.equal(urls.length, 1);
    assert.match(urls[0], /registry\.npmjs\.org\/billion-context\/dev$/);
});

test("checkForUpdate defaults to /latest when updateTag is unset", async () => {
    const urls = await capturedFetchUrl(undefined);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /registry\.npmjs\.org\/billion-context\/latest$/);
});

test("checkForUpdate follows a PR preview tag only when explicitly configured", async () => {
    const urls = await capturedFetchUrl("pr-202");
    assert.equal(urls.length, 1);
    assert.match(urls[0], /registry\.npmjs\.org\/billion-context\/pr-202$/);
});
