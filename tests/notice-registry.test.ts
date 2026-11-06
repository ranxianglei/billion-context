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
process.env.XDG_STATE_HOME = stateDir;
process.env.BILI_CONFIG_FILE = cfgPath;

const { NOTICES, visibleNotices } = await import("../src/notices.ts");
const { PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID, dismissUpgradeNotice } = await import("../src/pck-notice.ts");
const { MESSAGES, LOCALES } = await import("../src/web/i18n.ts");

test("registry: unique ids, valid tones, every key resolves in both locales", () => {
    const ids = NOTICES.map((n) => n.id);
    assert.equal(new Set(ids).size, ids.length, "ids must be unique");
    assert.deepEqual([...ids].sort(), [PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID].sort());
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

test("visibleNotices: fresh install sees both, registry order", () => {
    const v = visibleNotices();
    assert.deepEqual(v.map((n) => n.id), [PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID]);
    assert.deepEqual(v.map((n) => n.tone), ["warn", "ok"]);
});

test("visibleNotices: dismissing one hides only that one", () => {
    assert.equal(dismissUpgradeNotice(WM_FASTPATH_INTRO_ID, process.env), true);
    const v = visibleNotices();
    assert.deepEqual(v.map((n) => n.id), [PCK_NOTICE_ID]);
});
