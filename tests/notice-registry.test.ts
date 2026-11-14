import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #5548 P1: unified built-in notice registry — the table is the single
// per-notice wiring point (adding a notice = entry here + i18n keys + the
// store allowlist id; admin/client/page need no further per-notice code).
// Hermetic: fresh XDG_STATE_HOME + absent BILI_CONFIG_FILE ⇒ defaults
// (promptCache.routing disabled, no rollout override, nothing dismissed).

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "notice-reg-state-"));
const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "notice-reg-cfg-")), "absent.json");
// Hermetic dsh home too: the iot-thinking probe must see NO profiles here, or
// a developer machine that has the plugin installed changes the expectations.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "notice-reg-dsh-"));
process.env.XDG_STATE_HOME = stateDir;
process.env.BILI_CONFIG_FILE = cfgPath;
// #4011 lesson: this suite asserts the pure-sqlite default notice is visible,
// which requires the pure-sqlite SELECTION (unified "sqlite" or absent — the
// gate is unifiedSelectionIsSqlite, not the resolved mode). The suite baseline
// preload pins "legacy" for the broad corpus, so pin the selection explicitly.
process.env.BILI_STORAGE_UNIFIED = "sqlite";

// This suite asserts the PRODUCTION default storage posture. The CI corpus
// baseline (tests/preload-storage-baseline.mjs, #2815) forces
// BILI_STORAGE_UNIFIED=legacy for every test file, which flips the
// pure-sqlite-default notice (#6480) off — pin our own selection per the
// baseline's documented rule (the #4011 lesson).
delete process.env.BILI_STORAGE_UNIFIED;

const { NOTICES, visibleNotices, SQLITE_DEFAULT_NOTICE_ID } = await import("../src/notices.ts");
const { IOT_INCOMPAT_NOTICE_ID, PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID, dismissUpgradeNotice } = await import("../src/pck-notice.ts");
const { MESSAGES, LOCALES } = await import("../src/web/i18n.ts");

test("registry: unique ids, valid tones, every key resolves in both locales", () => {
    const ids = NOTICES.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, "ids must be unique");
    assert.deepEqual([...ids].sort(), [IOT_INCOMPAT_NOTICE_ID, PCK_NOTICE_ID, SQLITE_DEFAULT_NOTICE_ID, WM_FASTPATH_INTRO_ID].sort());
    for (const n of NOTICES) {
        assert.ok(n.tone === "ok" || n.tone === "warn", `${n.id} tone`);
        for (const locale of LOCALES) {
            for (const k of Object.values(n.keys)) {
                assert.equal(typeof MESSAGES[locale][k], "string", `${locale}:${k}`);
                assert.ok((MESSAGES[locale][k] ?? "").length > 0, `${locale}:${k} non-empty`);
            }
        }
    }
});

test("visibleNotices: fresh install sees the default flip + pck + wm intro, registry order (iot absent ⇒ hidden)", () => {
    const v = visibleNotices();
    assert.deepEqual(v.map((n) => n.id), [PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID, SQLITE_DEFAULT_NOTICE_ID]);
    assert.deepEqual(v.map((n) => n.tone), ["warn", "ok", "warn"]);
});

test("storage-sqlite-default notice id is a dismissible builtin (no 400 on close)", () => {
    assert.equal(dismissUpgradeNotice(SQLITE_DEFAULT_NOTICE_ID, process.env), true);
    // restore visibility for the later tests (fresh-state dismissal is persisted per XDG dir)
    fs.rmSync(stateDir, { recursive: true, force: true });
});

test("iot notice id is a dismissible builtin (no 400 on close)", () => {
    assert.equal(dismissUpgradeNotice(IOT_INCOMPAT_NOTICE_ID, process.env), true);
});

test("visibleNotices: dismissing one hides only that one", () => {
    assert.equal(dismissUpgradeNotice(WM_FASTPATH_INTRO_ID, process.env), true);
    const v = visibleNotices();
    assert.deepEqual(v.map((n) => n.id), [PCK_NOTICE_ID, SQLITE_DEFAULT_NOTICE_ID]);
});
