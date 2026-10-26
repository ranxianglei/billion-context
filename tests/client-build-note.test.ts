// Newer-than-tested client-build boot note (#4545): shared machinery behind
// the dsh lane's boot note (only dsh is wired today — see the module header
// for why the other, stable-versioned in-process lanes are out of scope).
// Covers the bounded walk-up version resolver, the
// BILI_<LANE>_MAX_TESTED_VERSION cap knob (tri-state), and the message
// composer's decision table (one direction only: STRICTLY NEWER warns;
// at/below-cap, unresolvable and unparseable all fail open to silence).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DSH_BUILD_CHECK, emitNewerClientBuildNote, maxTestedVersion, newerClientBuildMessage, walkUpNodeModuleVersion } from "../src/agent/client-build-note.ts";

const DSH_PKG = "node_modules/@deepseek-ai/dsh/package.json";

test("DSH_BUILD_CHECK matches the CI e2e anchor identity", () => {
    assert.equal(DSH_BUILD_CHECK.pkgId, "@deepseek-ai/dsh");
    assert.equal(DSH_BUILD_CHECK.knobEnv, "BILI_DSH_MAX_TESTED_VERSION");
    assert.equal(DSH_BUILD_CHECK.defaultMaxTested, "0.2.0-rc.2"); // ci-e2e-dsh-native.yml anchor
});

test("walkUpNodeModuleVersion finds the nearest package above startDir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-buildnote-"));
    try {
        fs.mkdirSync(path.join(root, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
        fs.writeFileSync(path.join(root, DSH_PKG), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.1-rc.2" }), "utf8");
        const deep = path.join(root, "nested", "deeper");
        fs.mkdirSync(deep, { recursive: true });
        assert.equal(walkUpNodeModuleVersion(deep, DSH_PKG), "0.2.1-rc.2");
        // also found when starting AT the level that carries node_modules
        assert.equal(walkUpNodeModuleVersion(root, DSH_PKG), "0.2.1-rc.2");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("walkUpNodeModuleVersion respects the hop bound and skips unreadable levels", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-buildnote-"));
    try {
        fs.mkdirSync(path.join(root, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
        fs.writeFileSync(path.join(root, DSH_PKG), JSON.stringify({ version: "0.2.1-rc.2" }), "utf8");
        // nine directory moves down: beyond the default 8-hop bound
        const tooDeep = path.join(root, "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9");
        fs.mkdirSync(tooDeep, { recursive: true });
        assert.equal(walkUpNodeModuleVersion(tooDeep, DSH_PKG), undefined, "default bound stops at 8 hops");
        assert.equal(walkUpNodeModuleVersion(tooDeep, DSH_PKG, 12), "0.2.1-rc.2", "explicit budget reaches it");
        // a malformed json mid-tree is skipped, not fatal
        const mid = path.join(root, "dist", "agent");
        fs.mkdirSync(mid, { recursive: true });
        fs.writeFileSync(path.join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"), "{not json", "utf8");
        fs.writeFileSync(path.join(root, DSH_PKG), JSON.stringify({ version: "0.2.0-rc.2" }), "utf8");
        assert.equal(walkUpNodeModuleVersion(mid, DSH_PKG), "0.2.0-rc.2", "invalid nearest doc falls through to the next valid one");
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("walkUpNodeModuleVersion returns undefined when nothing sits above", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bili-buildnote-empty-"));
    try {
        const deep = path.join(empty, "a", "b");
        fs.mkdirSync(deep, { recursive: true });
        assert.equal(walkUpNodeModuleVersion(deep, DSH_PKG), undefined);
    } finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

test("maxTestedVersion tri-state: default / override / off", () => {
    const KEY = DSH_BUILD_CHECK.knobEnv;
    assert.equal(maxTestedVersion(DSH_BUILD_CHECK, {}), "0.2.0-rc.2", "unset → CI anchor default");
    assert.equal(maxTestedVersion(DSH_BUILD_CHECK, { [KEY]: "0.3.0" }), "0.3.0", "override moves the cap");
    assert.equal(maxTestedVersion(DSH_BUILD_CHECK, { [KEY]: "" }), undefined, "empty string turns the check OFF");
    assert.equal(maxTestedVersion(DSH_BUILD_CHECK, { [KEY]: "   " }), undefined, "whitespace-only also means OFF");
    assert.equal(maxTestedVersion(DSH_BUILD_CHECK, { [KEY]: "  0.4.0 " }), "0.4.0", "trimmed");
});

test("newerClientBuildMessage decision table: only STRICTLY newer warns", () => {
    // nothing resolved — absence of evidence ≠ broken build
    assert.equal(newerClientBuildMessage(DSH_BUILD_CHECK, undefined, {}), null);
    // at the cap: verified territory, silent
    assert.equal(newerClientBuildMessage(DSH_BUILD_CHECK, "0.2.0-rc.2", {}), null);
    // older builds: silent by design (their break modes have dedicated probes)
    assert.equal(newerClientBuildMessage(DSH_BUILD_CHECK, "0.1.7-rc.2", {}), null);
    assert.equal(newerClientBuildMessage(DSH_BUILD_CHECK, "0.2.0-rc.1", {}), null);
    // unparseable found or cap: comparison fails open to silence
    assert.equal(newerClientBuildMessage(DSH_BUILD_CHECK, "garbage", {}), null);
    assert.equal(newerClientBuildMessage(DSH_BUILD_CHECK, "9.9.9", { [DSH_BUILD_CHECK.knobEnv]: "nope" }), null);

    // strictly newer in every direction that dsh actually ships
    for (const v of ["0.2.0-rc.3", "0.2.1-alpha.5", "0.2.1-rc.2", "0.3.0"]) {
        const msg = newerClientBuildMessage(DSH_BUILD_CHECK, v, {});
        assert.ok(msg !== null, `v${v} is newer than the cap and must warn`);
        assert.ok(msg!.includes(`v${v}`), "names the detected build");
        assert.ok(msg!.includes("0.2.0-rc.2"), "names the capped build");
        assert.ok(msg!.includes("[dsh]"), "labels the lane");
        assert.ok(msg!.includes("@deepseek-ai/dsh"), "names the npm id");
    }
});

test("newerClientBuildMessage: knob-off silences; raised cap re-baselines (bilingual text)", () => {
    // off switch silences even a far-newer build
    assert.equal(newerClientBuildMessage(DSH_BUILD_CHECK, "9.9.9", { [DSH_BUILD_CHECK.knobEnv]: "" }), null);
    // ops raise the cap once they verify a newer build
    const env = { [DSH_BUILD_CHECK.knobEnv]: "7.7.7" };
    assert.equal(newerClientBuildMessage(DSH_BUILD_CHECK, "6.6.6", env), null, "below the raised cap: silent");
    const raised = newerClientBuildMessage(DSH_BUILD_CHECK, "8.8.8", env);
    assert.ok(raised !== null && raised.includes("7.7.7"), "names the raised cap");
    // EN + CN halves both present
    const msg = newerClientBuildMessage(DSH_BUILD_CHECK, "0.2.1-rc.2", {})!;
    assert.ok(msg.includes("NEWER than the newest build billion-context has tested against"), "EN guidance");
    assert.ok(msg.includes("压缩能力在该构建上未经我们验证、可能不稳定"), "CN guidance");
    assert.ok(msg.includes("先将客户端回滚到 v0.2.0-rc.2"), "CN roll-back target");
});

test("walkUp: multiple candidate paths are tried at each level", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-buildnote-"));
    try {
        // Second candidate only appears one level up from startDir; first absent.
        fs.mkdirSync(path.join(root, "node_modules", "only-second", "pkg-b"), { recursive: true });
        fs.writeFileSync(path.join(root, "node_modules", "only-second", "pkg-b", "package.json"), JSON.stringify({ version: "7.8.9" }), "utf8");
        const deep = path.join(root, "nested");
        fs.mkdirSync(deep, { recursive: true });
        assert.equal(
            walkUpNodeModuleVersion(deep, [
                "node_modules/pkg-a/package.json",
                path.join("node_modules", "only-second", "pkg-b", "package.json"),
            ]),
            "7.8.9",
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("emitNewerClientBuildNote: channels and tri-state outcomes", () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-buildnote-log-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = logDir;
    const origWarn = console.warn;
    const banners: string[] = [];
    console.warn = ((...parts: unknown[]) => { banners.push(parts.join(" ")); }) as typeof console.warn;
    try {
        // silent: nothing resolved / below cap / check off
        assert.equal(emitNewerClientBuildNote(DSH_BUILD_CHECK, undefined, {}), false);
        assert.equal(emitNewerClientBuildNote(DSH_BUILD_CHECK, "0.2.0-rc.2", {}), false);
        assert.equal(emitNewerClientBuildNote(DSH_BUILD_CHECK, "9.9.9", { [DSH_BUILD_CHECK.knobEnv]: "" }), false);
        assert.equal(banners.length, 0, "no banner when silent");
        // fires: console banner + durable bili.log line
        assert.equal(emitNewerClientBuildNote(DSH_BUILD_CHECK, "0.2.1-rc.2", {}), true);
        assert.equal(banners.length, 1);
        assert.ok(banners[0]!.includes("[dsh]"), "banner carries the lane label");
        assert.ok(banners[0]!.includes("v0.2.1-rc.2") && banners[0]!.includes("v0.2.0-rc.2"), "banner carries both versions");
        const log = fs.readFileSync(path.join(logDir, "billion-context", "bili.log"), "utf8");
        assert.ok(log.includes("[warn]") && log.includes("[native-client]"), "durable warn record present");
        assert.ok(log.includes("v0.2.1-rc.2"), "durable record carries the found version");
        // per-lane knob OFF suppresses even a far-newer build
        assert.equal(emitNewerClientBuildNote(DSH_BUILD_CHECK, "9.9.9", { [DSH_BUILD_CHECK.knobEnv]: "  " }), false);
    } finally {
        console.warn = origWarn;
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevXdg;
        fs.rmSync(logDir, { recursive: true, force: true });
    }
});
