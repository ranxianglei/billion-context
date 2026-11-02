// #5544 follow-up: second green intro banner for the OFF-by-default
// compressAtFoldPoint feature (fold-in-place replacement, #5470). Pins the
// shared-store contract: its own id accepted + independent from the other two,
// unknown ids still rejected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID, CAFP_INTRO_ID, dismissedUpgradeNotices, dismissUpgradeNotice } from "../src/pck-notice.js";

test("#5544 caf intro: upgrade-notice store accepts caf-intro independently", () => {
    const env = { ...process.env, XDG_STATE_HOME: mkdtempSync(path.join(tmpdir(), "bili-cafpnotice-")) };
    assert.equal(dismissUpgradeNotice("foreign-id", env), false);
    assert.equal(dismissUpgradeNotice(CAFP_INTRO_ID, env), true);
    assert.equal(dismissUpgradeNotice(CAFP_INTRO_ID, env), true); // idempotent
    let seen = dismissedUpgradeNotices(env);
    assert.ok(seen.has(CAFP_INTRO_ID));
    assert.ok(!seen.has(WM_FASTPATH_INTRO_ID)); // dismissing caf does not touch wm
    assert.ok(!seen.has(PCK_NOTICE_ID));
    assert.equal(dismissUpgradeNotice(WM_FASTPATH_INTRO_ID, env), true);
    seen = dismissedUpgradeNotices(env);
    assert.ok(seen.has(CAFP_INTRO_ID) && seen.has(WM_FASTPATH_INTRO_ID) && !seen.has(PCK_NOTICE_ID));
});
