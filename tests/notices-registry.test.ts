import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    BUILTIN_NOTICES, KIND_PRIORITY, PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID,
    dismissModeOf, knownNoticeIds, noticeVisible, priorityOf, registerDynamicNoticeIds,
    sortNotices, toneOf, visibleBuiltInNotices, type NoticeRecord,
} from "../src/notices.ts";
import { dismissedUpgradeNotices, dismissUpgradeNotice } from "../src/pck-notice.ts";

const none = new Set<string>();

test("#5548 P1: built-in table integrity — lane A converges the two hand-copied banners", () => {
    assert.equal(BUILTIN_NOTICES.length, 2);
    const ids = BUILTIN_NOTICES.map((b) => b.id).sort();
    assert.deepEqual(ids, [PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID].sort());
    for (const b of BUILTIN_NOTICES) {
        assert.equal(typeof b.title, "object", `${b.id}: multilang title`);
        const t = b.title as Record<string, string>;
        assert.ok(typeof t["zh-CN"] === "string" && t["zh-CN"].length > 0, `${b.id}: zh title`);
        assert.ok(typeof t.en === "string" && t.en.length > 0, `${b.id}: en title`);
        assert.ok(b.desc && typeof b.desc === "object", `${b.id}: desc rides the record`);
        assert.ok(b.hint && typeof b.hint === "object", `${b.id}: hint rides the record`);
        assert.equal(typeof b.active, "function", `${b.id}: active predicate`);
    }
    const pck = BUILTIN_NOTICES.find((b) => b.id === PCK_NOTICE_ID)!;
    const wm = BUILTIN_NOTICES.find((b) => b.id === WM_FASTPATH_INTRO_ID)!;
    // explicit tones pin the pre-P1 CSS classes (.banner.warn / .banner.ok)
    assert.equal(pck.tone, "warn");
    assert.equal(wm.tone, "ok");
    assert.equal(priorityOf(pck), 80);
    assert.equal(priorityOf(wm), 40);
});

test("#5548 P1: active predicates — routing gate and rollout-override gate", () => {
    const pck = BUILTIN_NOTICES[0];
    const wm = BUILTIN_NOTICES[1];
    assert.equal(pck.active({ promptCacheRouting: "disabled", wmOverridePresent: false }), true);
    assert.equal(pck.active({ promptCacheRouting: "auto", wmOverridePresent: false }), false);
    assert.equal(pck.active({ promptCacheRouting: "enabled", wmOverridePresent: true }), false);
    assert.equal(wm.active({ promptCacheRouting: "disabled", wmOverridePresent: false }), true);
    assert.equal(wm.active({ promptCacheRouting: "auto", wmOverridePresent: true }), false);
});

test("#5548 P1: dismiss modes — persistent default, instance memory-only, always un-dismissable", () => {
    const rec = (dismiss?: NoticeRecord["dismiss"]): NoticeRecord => ({ id: "x", kind: "other", title: "t", dismiss });
    assert.equal(dismissModeOf(rec()), "persistent");
    assert.equal(noticeVisible(rec(), new Set(["x"]), none), false, "persistent dismissed hides");
    assert.equal(noticeVisible(rec(), none, new Set(["x"])), true, "instance set does not hide a persistent record");
    assert.equal(noticeVisible(rec("instance"), new Set(["x"]), none), true, "persistent set does not hide an instance record");
    assert.equal(noticeVisible(rec("instance"), none, new Set(["x"])), false, "instance dismissed hides");
    assert.equal(noticeVisible(rec("always"), new Set(["x"]), new Set(["x"])), true, "always is never hidden");
});

test("#5548 P1: kind priority table and explicit override", () => {
    assert.deepEqual(KIND_PRIORITY, { incident: 90, "upgrade-advisory": 80, warning: 70, deprecation: 60, suggestion: 50, "new-feature": 40, other: 30 });
    for (const kind of Object.keys(KIND_PRIORITY) as Array<keyof typeof KIND_PRIORITY>) {
        assert.equal(priorityOf({ kind }), KIND_PRIORITY[kind]);
    }
    assert.equal(priorityOf({ kind: "other", priority: 99 }), 99);
    assert.equal(priorityOf({ kind: "incident", priority: null }), 90);
});

test("#5548 P1: tone derivation — explicit overrides the kind rule", () => {
    assert.equal(toneOf({ kind: "new-feature" }), "ok");
    assert.equal(toneOf({ kind: "warning" }), "warn");
    assert.equal(toneOf({ kind: "incident" }), "warn");
    assert.equal(toneOf({ kind: "deprecation" }), "warn");
    assert.equal(toneOf({ kind: "upgrade-advisory" }), "info");
    assert.equal(toneOf({ kind: "suggestion" }), "info");
    assert.equal(toneOf({ kind: "other" }), "info");
    assert.equal(toneOf({ kind: "new-feature", tone: "warn" }), "warn");
});

test("#5548 P1: sort — priority desc, publishedAt desc, stable for ties", () => {
    const mk = (id: string, priority?: number | null, publishedAt?: string): NoticeRecord => ({ id, kind: "other", title: id, priority, publishedAt });
    const list = sortNotices([
        mk("a"),
        mk("b", 90, "2026-11-01T00:00:00Z"),
        mk("c", 90, "2026-11-02T00:00:00Z"),
        mk("d", undefined, "2026-11-03T00:00:00Z"),
    ]);
    assert.deepEqual(list.map((r) => r.id), ["c", "b", "d", "a"]);
    const tie = sortNotices([mk("t1"), mk("t2")]);
    assert.deepEqual(tie.map((r) => r.id), ["t1", "t2"], "equal records keep input order (stable)");
});

test("#5548 P1: known ids — builtins plus registered dynamic lanes; dismissal allowlist follows", () => {
    const before = knownNoticeIds();
    assert.ok(before.has(PCK_NOTICE_ID) && before.has(WM_FASTPATH_INTRO_ID));
    registerDynamicNoticeIds(["dyn-x"]);
    assert.ok(knownNoticeIds().has("dyn-x"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-registry-"));
    const env = { ...process.env, XDG_STATE_HOME: dir };
    assert.equal(dismissUpgradeNotice("never-registered", env), false);
    assert.equal(dismissUpgradeNotice("dyn-x", env), true, "registered dynamic id passes the allowlist");
});

test("#5548 P1: visibleBuiltInNotices — predicates AND dismissal, sorted, wire-safe", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notices-visible-"));
    const env = { ...process.env, XDG_STATE_HOME: dir };
    const base = { promptCacheRouting: "disabled", wmOverridePresent: false };
    const all = visibleBuiltInNotices(base, { dismissed: dismissedUpgradeNotices(env) });
    assert.deepEqual(all.map((r) => r.id), [PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID], "pck (priority 80) sorts before wm (40)");
    for (const r of all) assert.ok(!("active" in r), `wire record ${r.id} leaks the active function`);
    dismissUpgradeNotice(PCK_NOTICE_ID, env);
    const rest = visibleBuiltInNotices(base, { dismissed: dismissedUpgradeNotices(env) });
    assert.deepEqual(rest.map((r) => r.id), [WM_FASTPATH_INTRO_ID], "dismissing pck leaves only wm");
    // routing auto re-hides pck even though it was dismissed above; a wm rollout override hides wm alone
    assert.deepEqual(visibleBuiltInNotices({ ...base, promptCacheRouting: "auto" }, { dismissed: none }).map((r) => r.id), [WM_FASTPATH_INTRO_ID]);
    assert.deepEqual(visibleBuiltInNotices({ ...base, wmOverridePresent: true }, { dismissed: none }).map((r) => r.id), [PCK_NOTICE_ID]);
});
