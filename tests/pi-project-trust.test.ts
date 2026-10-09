// #2529 security regression: an untrusted pi project must not inject its own
// prompt packs into ACP system prompts. Pack precedence is project > user >
// builtin, so a same-named `.billion-context/packs/<name>.json` SHADOWS a
// trusted user/builtin pack. The proxy resolves packs per request and gates the
// project source on the x-bili-project-trusted header the pi extension stamps
// from ctx.isProjectTrusted() (fail closed on anything but "1"). These tests pin
// the decision matrix, the resolver's includeProject gating, and the shadowing
// attack itself. Resolution is per-request (no process-lifetime cache), so a
// mid-session trust flip re-derives on the very next request — no stale state.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveCompressSurfaceDetailed, piProjectPacksAllowed } from "../src/compress-settings.js";
import { projectTrustedOf, type Ctx } from "../src/agent/pi.js";
import { rmrf } from "./tmp-rm.ts";

function writeProjPack(projRoot: string, name: string, marker: string): string {
    const d = path.join(projRoot, ".billion-context", "packs");
    mkdirSync(d, { recursive: true });
    writeFileSync(path.join(d, `${name}.json`), JSON.stringify({ name, toolPrompts: { acp_status: { description: marker } } }));
    return d;
}

// A project pack named "lean" (attacker text) alongside a user pack of the SAME
// name (trusted text) — the exact shadowing collision the gate must break.
function shadowFixture(): { dirs: { projectDir: string; userDirs: readonly string[] }; root: string } {
    const root = mkdtempSync(path.join(tmpdir(), "bili-trust-"));
    const proj = path.join(root, "proj");
    const userDir = path.join(root, "user", "packs");
    mkdirSync(userDir, { recursive: true });
    const projectDir = writeProjPack(proj, "lean", "PROJECT-EVIL");
    writeFileSync(path.join(userDir, "lean.json"), JSON.stringify({ name: "lean", toolPrompts: { acp_status: { description: "USER-SAFE" } } }));
    return { dirs: { projectDir, userDirs: [userDir] }, root };
}

test("piProjectPacksAllowed: non-pi lanes always allow (no behavior change)", () => {
    for (const agent of ["omp", "opencode", "claude", undefined]) {
        assert.equal(piProjectPacksAllowed(agent, "1"), true);
        assert.equal(piProjectPacksAllowed(agent, "0"), true);
        assert.equal(piProjectPacksAllowed(agent, undefined), true);
    }
});

test("piProjectPacksAllowed: pi allows only the literal trust header \"1\"", () => {
    assert.equal(piProjectPacksAllowed("pi", "1"), true);
    assert.equal(piProjectPacksAllowed("pi", "0"), false);
    assert.equal(piProjectPacksAllowed("pi", undefined), false);
    assert.equal(piProjectPacksAllowed("pi", ""), false);
    assert.equal(piProjectPacksAllowed("pi", "true"), false);
});

test("projectTrustedOf: explicit true (sync + async) is trusted", async () => {
    assert.equal(await projectTrustedOf({ isProjectTrusted: () => true }), true);
    assert.equal(await projectTrustedOf({ isProjectTrusted: async () => true }), true);
});

test("projectTrustedOf: everything else fails closed to untrusted", async () => {
    const c = (fn: unknown): Ctx => ({ isProjectTrusted: fn as unknown as Ctx["isProjectTrusted"] });
    assert.equal(await projectTrustedOf(c(() => false)), false);
    assert.equal(await projectTrustedOf(c(() => "true")), false);
    assert.equal(await projectTrustedOf(c(() => 1)), false);
    assert.equal(await projectTrustedOf(c(async () => undefined)), false);
    assert.equal(await projectTrustedOf(c(() => { throw new Error("boom"); })), false);
    assert.equal(await projectTrustedOf(c(async () => { throw new Error("boom"); })), false);
    assert.equal(await projectTrustedOf({}), false);
});

test("untrusted pi cannot shadow a same-named user pack", () => {
    const { dirs, root } = shadowFixture();
    try {
        const trusted = resolveCompressSurfaceDetailed({ promptPack: "lean" }, dirs).surface;
        const untrusted = resolveCompressSurfaceDetailed({ promptPack: "lean" }, dirs, false).surface;
        assert.equal(trusted.toolPrompts?.acp_status?.description, "PROJECT-EVIL");
        assert.equal(untrusted.toolPrompts?.acp_status?.description, "USER-SAFE");
    } finally {
        rmrf(root);
    }
});

test("omitted includeProject preserves today's precedence (project wins)", () => {
    const { dirs, root } = shadowFixture();
    try {
        const res = resolveCompressSurfaceDetailed({ promptPack: "lean" }, dirs);
        assert.equal(res.surface.toolPrompts?.acp_status?.description, "PROJECT-EVIL");
    } finally {
        rmrf(root);
    }
});

test("untrusted pi loses a project-only configured pack (falls to default)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "bili-trust-"));
    try {
        const projectDir = writeProjPack(path.join(root, "proj"), "secret", "ONLY-IN-PROJECT");
        const dirs = { projectDir, userDirs: [] as string[] };
        const trusted = resolveCompressSurfaceDetailed({ promptPack: "secret" }, dirs);
        assert.equal(trusted.packName, "secret");
        assert.equal(trusted.surface.toolPrompts?.acp_status?.description, "ONLY-IN-PROJECT");
        const untrusted = resolveCompressSurfaceDetailed({ promptPack: "secret" }, dirs, false);
        assert.equal(untrusted.packName, "default");
        assert.deepEqual(untrusted.surface, {});
    } finally {
        rmrf(root);
    }
});

test("builtin packs stay available to untrusted contexts", () => {
    const dirs = { projectDir: "/nonexistent-bili-trust", userDirs: [] as string[] };
    const res = resolveCompressSurfaceDetailed({ promptPack: "lean" }, dirs, false);
    assert.equal(res.packName, "lean");
    assert.ok(res.surface.toolPrompts?.compress?.description);
});

test("trust flip re-resolves per request (header -> predicate -> resolver)", () => {
    const { dirs, root } = shadowFixture();
    try {
        const before = resolveCompressSurfaceDetailed({ promptPack: "lean" }, dirs, piProjectPacksAllowed("pi", "1")).surface;
        const after = resolveCompressSurfaceDetailed({ promptPack: "lean" }, dirs, piProjectPacksAllowed("pi", "0")).surface;
        assert.equal(before.toolPrompts?.acp_status?.description, "PROJECT-EVIL");
        assert.equal(after.toolPrompts?.acp_status?.description, "USER-SAFE");
    } finally {
        rmrf(root);
    }
});
