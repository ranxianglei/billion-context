// Install-gate tests (scripts/check-dist-ready.mjs): the dist × checkout
// matrix, the unconditional pack/publish requirement, and the filesystem
// markers the verdict reads (#2471).

import { test } from "node:test";
import assert from "node:assert/strict";
const gateSpec = "../scripts/check-dist-ready.mjs";
const { distEntryReady, selfBuildableCheckout, distReadyVerdict } = await import(gateSpec) as {
    distEntryReady: (dir: string) => boolean;
    selfBuildableCheckout: (dir: string) => boolean;
    distReadyVerdict: (state: { distReady: boolean; selfBuildable: boolean; npmCommand?: string; localPrefix?: string; root?: string }) => { ok: boolean; reason: string };
};
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rmrf } from "./tmp-rm.ts";

test("matrix: dist present passes in every context, pack included", () => {
    assert.equal(distReadyVerdict({ distReady: true, selfBuildable: false, npmCommand: undefined }).ok, true);
    assert.equal(distReadyVerdict({ distReady: true, selfBuildable: false, npmCommand: "pack" }).ok, true);
});

test("matrix: dist missing + dev checkout passes install-time prepare", () => {
    assert.equal(distReadyVerdict({ distReady: false, selfBuildable: true, npmCommand: "install" }).ok, true);
});

test("matrix: dist missing + fetched source copy fails with guidance", () => {
    const verdict = distReadyVerdict({ distReady: false, selfBuildable: false, npmCommand: undefined });
    assert.equal(verdict.ok, false);
});

test("pack/publish requires dist unconditionally, dev checkout included", () => {
    assert.equal(distReadyVerdict({ distReady: false, selfBuildable: true, npmCommand: "pack" }).ok, false);
    assert.equal(distReadyVerdict({ distReady: false, selfBuildable: true, npmCommand: "publish" }).ok, false);
});

test("npm lane: .git present but consuming prefix differs from root fails (#2471 F2)", () => {
    const consumer = mkdtempSync(path.join(tmpdir(), "bc-npmlane-consumer-"));
    const cloneRoot = mkdtempSync(path.join(tmpdir(), "bc-npmlane-clone-"));
    try {
        const verdict = distReadyVerdict({ distReady: false, selfBuildable: true, npmCommand: "install", localPrefix: consumer, root: cloneRoot });
        assert.equal(verdict.ok, false);
    } finally {
        rmrf(consumer);
        rmrf(cloneRoot);
    }
});

test("npm lane: prefix equal to root passes (dev/CI root install)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-npmlane-root-"));
    try {
        const verdict = distReadyVerdict({ distReady: false, selfBuildable: true, npmCommand: "install", localPrefix: root, root });
        assert.equal(verdict.ok, true);
    } finally {
        rmrf(root);
    }
});

test("prefix absent leaves the verdict unchanged in both directions", () => {
    assert.equal(distReadyVerdict({ distReady: false, selfBuildable: true, npmCommand: "install", localPrefix: undefined, root: undefined }).ok, true);
    assert.equal(distReadyVerdict({ distReady: false, selfBuildable: false, npmCommand: undefined, localPrefix: undefined, root: undefined }).ok, false);
});

test("markers read the filesystem: dist/index.js and .git", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bc-distready-"));
    try {
        assert.equal(distEntryReady(root), false);
        assert.equal(selfBuildableCheckout(root), false);
        mkdirSync(path.join(root, "dist"));
        writeFileSync(path.join(root, "dist", "index.js"), "");
        assert.equal(distEntryReady(root), true);
        mkdirSync(path.join(root, ".git"));
        assert.equal(selfBuildableCheckout(root), true);
    } finally {
        rmrf(root);
    }
});
