import { test } from "node:test";
import assert from "node:assert/strict";
import { staleInstallStatus } from "../src/update.ts";

test("staleInstallStatus: disk newer than running process → restart (#327 scenario)", () => {
    assert.equal(staleInstallStatus("0.1.62", "0.1.55"), "restart");
});

test("staleInstallStatus: disk == running → current", () => {
    assert.equal(staleInstallStatus("0.1.62", "0.1.62"), "current");
});

test("staleInstallStatus: disk older than running (manual downgrade) → current", () => {
    assert.equal(staleInstallStatus("0.1.55", "0.1.62"), "current");
});

test("staleInstallStatus: no install dir found → current", () => {
    assert.equal(staleInstallStatus(undefined, "0.1.62"), "current");
});

test("staleInstallStatus: numeric (not lexicographic) compare across digit widths", () => {
    assert.equal(staleInstallStatus("0.1.10", "0.1.9"), "restart");
    assert.equal(staleInstallStatus("0.1.9", "0.1.10"), "current");
});
