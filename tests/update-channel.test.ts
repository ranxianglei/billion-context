import { test } from "node:test";
import assert from "node:assert/strict";
import { isVersionNewer, normalizeRegistryBase, normalizeUpdateTag, registryUrlFor } from "../src/update.ts";

test("isVersionNewer compares numeric segments", () => {
    assert.equal(isVersionNewer("0.1.43", "0.1.41"), true);
    assert.equal(isVersionNewer("0.1.41", "0.1.43"), false);
    assert.equal(isVersionNewer("0.1.41", "0.1.41"), false);
    assert.equal(isVersionNewer("0.2.0", "0.10.0"), false);
    assert.equal(isVersionNewer("1.0.0", "0.9.9"), true);
    assert.equal(isVersionNewer("v1.2.3", "1.2.2"), true);
});

test("isVersionNewer tolerates the fetchProxyVersion ` (commit)` display suffix (#6900)", () => {
    // The dsh-native #3544 rotation compares the resident's manifest version
    // (rendered `X.Y.Z (hexcommit)` by fetchProxyVersion) against VERSION. A
    // trailing commit suffix must not defeat the comparison — the regression
    // that silently killed the rotation.
    assert.equal(isVersionNewer("0.1.215", "0.1.214 (abc123)"), true);
    assert.equal(isVersionNewer("0.1.214 (abc123)", "0.1.215"), false);
    assert.equal(isVersionNewer("0.1.215 (def456)", "0.1.214 (abc123)"), true);
    // Equal versions with a suffix are NOT newer (strict comparison).
    assert.equal(isVersionNewer("0.1.215 (abc123)", "0.1.215 (abc123)"), false);
    // Clean semvers are unaffected by the tolerance (the strip is a no-op).
    assert.equal(isVersionNewer("0.1.215", "0.1.214"), true);
    // A non-hex parenthetical is NOT a commit suffix — still rejected.
    assert.equal(isVersionNewer("0.1.215", "0.1.214 (notahex)"), false);
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

test("registryUrlFor follows the configured dist-tag channel", () => {
    assert.equal(registryUrlFor("billion-context", "dev"), "https://registry.npmjs.org/billion-context/dev");
    assert.equal(registryUrlFor("billion-context", "stable"), "https://registry.npmjs.org/billion-context/stable");
});

test("normalizeRegistryBase keeps the production default when unset and strips trailing slashes", () => {
    assert.equal(normalizeRegistryBase(undefined), "https://registry.npmjs.org");
    assert.equal(normalizeRegistryBase(""), "https://registry.npmjs.org");
    assert.equal(normalizeRegistryBase("   "), "https://registry.npmjs.org");
    assert.equal(normalizeRegistryBase("http://127.0.0.1:4873"), "http://127.0.0.1:4873");
    assert.equal(normalizeRegistryBase(" http://127.0.0.1:4873 "), "http://127.0.0.1:4873");
    assert.equal(normalizeRegistryBase("http://127.0.0.1:4873/"), "http://127.0.0.1:4873");
    assert.equal(normalizeRegistryBase("http://127.0.0.1:4873///"), "http://127.0.0.1:4873");
});

test("normalizeUpdateTag defaults to latest and trims/blank-folds", () => {
    assert.equal(normalizeUpdateTag(undefined), "latest");
    assert.equal(normalizeUpdateTag("  "), "latest");
    assert.equal(normalizeUpdateTag("dev"), "dev");
    assert.equal(normalizeUpdateTag(" dev "), "dev");
});

test("registryUrlFor encodes exotic tag names and only follows them when explicitly configured", () => {
    // PR preview tags (pr-N) are distinct dist-tags — a stable install keeps
    // fetching /latest; the URL only becomes /pr-592 when the user opts in.
    assert.equal(registryUrlFor("billion-context", "pr-592"), "https://registry.npmjs.org/billion-context/pr-592");
    assert.notEqual(registryUrlFor("billion-context", normalizeUpdateTag(undefined)), "https://registry.npmjs.org/billion-context/pr-592");
    assert.equal(registryUrlFor("billion-context", "we ird+tag"), "https://registry.npmjs.org/billion-context/we%20ird%2Btag");
});
