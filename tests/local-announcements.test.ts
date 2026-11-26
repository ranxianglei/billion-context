import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #5548 P2: local announcements (owner-dropped JSON next to the config file).
// Hermetic: BILI_CONFIG_FILE relocates the announcements dir to a temp tree,
// XDG_STATE_HOME isolates the dismissal store. Every gate below asserts both
// directions (triggers when it should, NOT when it should not — #3617).

const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-ann-"));
process.env.BILI_CONFIG_FILE = path.join(root, "cfg.json"); // absent ⇒ defaults
process.env.XDG_STATE_HOME = path.join(root, "state");
const annDir = path.join(root, "announcements");

const { matchesVersion, validateRecord, visibleLocalNotices, mergedNotices, contentHash16, markInstanceDismissal, localDismissMode, noticeBucket, localDismissKey } = await import("../src/announcements.ts");
const { PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID, dismissUpgradeNotice, dismissedUpgradeNotices } = await import("../src/pck-notice.ts");

function drop(name: string, rec: unknown): void {
    fs.mkdirSync(annDir, { recursive: true });
    fs.writeFileSync(path.join(annDir, name), typeof rec === "string" ? rec : JSON.stringify(rec, null, 2));
}
function clear(): void {
    try { fs.rmSync(annDir, { recursive: true, force: true }); } catch { /* absent */ }
}
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => Object.assign({
    id: "team-note",
    kind: "suggestion",
    title: { "zh-CN": "提示", en: "Note" },
}, over);

test("matchesVersion: exact / ranges / caret / tilde / range-list both directions", () => {
    const v = "0.1.212";
    assert.equal(matchesVersion(v, v), true);
    assert.equal(matchesVersion(">=0.1.210 <0.1.220", v), true);
    assert.equal(matchesVersion(">=0.1.213", v), false);
    assert.equal(matchesVersion("<0.1.212", v), false);
    // npm semantics: with zero major, caret pins the MINOR (^0.1.x := <0.2.0),
    // so ^0.1.99 DOES cover 0.1.212 — pin negatives use a non-overlapping major/minor.
    assert.equal(matchesVersion("^0.1.210", v), true);
    assert.equal(matchesVersion("^0.1.99", v), true);
    assert.equal(matchesVersion("^0.1.213", v), false);
    assert.equal(matchesVersion("^1.0.0", v), false);
    // tilde likewise pins the minor: ~0.1.209 := >=0.1.209 <0.2.0 covers 0.1.212
    assert.equal(matchesVersion("~0.1.210", v), true);
    assert.equal(matchesVersion("~0.1.209", v), true);
    assert.equal(matchesVersion("~0.2.0", v), false);
    assert.equal(matchesVersion("[0.1.210 0.1.214]", v), true);
    assert.equal(matchesVersion("[0.1.210 0.1.211] || [0.1.212 0.1.219]", v), true);
    assert.equal(matchesVersion("[0.1.210 0.1.211] || [0.1.213 0.1.219]", v), false);
    assert.equal(matchesVersion("not-a-version", v), false);
    assert.equal(matchesVersion(">=bogus", "dev"), false);
});

test("noticeBucket: stable for a pair, bounded to 0-99", () => {
    const b = noticeBucket("team-note", "identity-1");
    assert.ok(b >= 0 && b <= 99);
    assert.equal(b, noticeBucket("team-note", "identity-1"));
});

test("validateRecord: whitelist copy, caps, kinds, tone derivation", () => {
    const ok = validateRecord(base())!;
    assert.ok(ok);
    assert.equal(ok.tone, "info");
    assert.equal(ok.priority, 50);
    assert.equal(ok.dismiss, "persistent");
    assert.equal(validateRecord(base({ kind: "new-feature" }))?.tone, "ok");
    assert.equal(validateRecord(base({ kind: "incident" }))?.tone, "warn");
    assert.equal(validateRecord(base({ kind: "deprecation", tone: "ok" }))?.tone, "ok");
    assert.equal(validateRecord({ ...base(), extra: 1 })?.id, "team-note");
    assert.equal((validateRecord(base({ title: "x".repeat(121) })) ?? null), null);
    assert.equal((validateRecord(base({ desc: "x".repeat(601) })) ?? null), null);
    assert.equal((validateRecord(base({ ctaLabel: "查看" })) ?? null), null, "half CTA pair is invalid");
    assert.equal(validateRecord(base({ ctaLabel: "查看", ctaUrl: "https://example.com/x" }))?.ctaUrl, "https://example.com/x");
    assert.equal((validateRecord(base({ ctaLabel: "查看", ctaUrl: "javascript:alert(1)" })) ?? null), null);
    assert.equal((validateRecord({ ...base(), kind: "wat" }) ?? null), null);
    assert.equal((validateRecord({ ...base(), id: "UPPER" }) ?? null), null);
    assert.equal((validateRecord(base({ percent: 101 })) ?? null), null);
    assert.equal((validateRecord(base({ since: "yesterday" })) ?? null), null);
});

test("visible: empty/missing dir yields nothing, valid file renders wire-shaped", () => {
    clear();
    assert.deepEqual(visibleLocalNotices().map((n) => n.id), []);
    drop("a.json", base());
    const v = visibleLocalNotices();
    assert.equal(v.length, 1);
    assert.equal(v[0].source, "local");
    assert.deepEqual(v[0].title, { "zh-CN": "提示", en: "Note" });
    clear();
});

test("versions gate: hides when this build misses, shows when it hits (live VERSION)", () => {
    clear();
    drop("miss.json", base({ id: "v-miss", versions: [">=999.0.0"] }));
    drop("hit.json", base({ id: "v-hit", versions: ["<=999.0.0"] }));
    const ids = visibleLocalNotices().map((n) => n.id);
    assert.equal(ids.includes("v-miss"), false);
    assert.equal(ids.includes("v-hit"), true);
    clear();
});

test("percent gate: 0 never, 100 always", () => {
    clear();
    drop("p0.json", base({ id: "p-zero", percent: 0 }));
    drop("p100.json", base({ id: "p-full", percent: 100 }));
    const ids = visibleLocalNotices().map((n) => n.id);
    assert.equal(ids.includes("p-zero"), false);
    assert.equal(ids.includes("p-full"), true);
    clear();
});

test("time window: until-past and since-future hide, open window shows", () => {
    clear();
    drop("past.json", base({ id: "t-past", until: "2020-01-01T00:00:00Z" }));
    drop("future.json", base({ id: "t-future", since: "2999-01-01T00:00:00Z" }));
    drop("open.json", base({ id: "t-open", since: "2020-01-01T00:00:00Z", until: "2999-01-01T00:00:00Z" }));
    const ids = visibleLocalNotices().map((n) => n.id);
    assert.equal(ids.includes("t-past"), false);
    assert.equal(ids.includes("t-future"), false);
    assert.equal(ids.includes("t-open"), true);
    clear();
});

test("one bad file never blanks the good ones; duplicate ids collapse to the sorted-first file", () => {
    clear();
    fs.mkdirSync(annDir, { recursive: true });
    fs.writeFileSync(path.join(annDir, "0-broken.json"), "{ not json ");
    drop("1-good.json", base({ id: "dup-id", priority: 10 }));
    drop("2-good.json", base({ id: "dup-id", priority: 99 }));
    const v = visibleLocalNotices();
    assert.equal(v.length, 1);
    assert.equal(v[0].priority, 10);
    clear();
});

test("dismiss persistent: id@content-hash; edited content re-nags exactly once", () => {
    clear();
    drop("d.json", base({ id: "d-perm", title: { "zh-CN": "一版", en: "v1" } }));
    assert.equal(visibleLocalNotices().length, 1);
    const rec = validateRecord(base({ id: "d-perm", title: { "zh-CN": "一版", en: "v1" } }))!;
    const key = `${rec.id}@${contentHash16(rec)}`;
    assert.equal(dismissUpgradeNotice(key, process.env), true);
    assert.equal(visibleLocalNotices().length, 0, "dismissed while content is identical");
    drop("d.json", base({ id: "d-perm", title: { "zh-CN": "二版", en: "v2" } }));
    assert.equal(visibleLocalNotices().length, 1, "edited content changes the hash and shows again");
    clear();
});

test("dismiss instance: process memory only, store untouched, always-mode ignores the store entirely", () => {
    clear();
    drop("inst.json", base({ id: "d-inst", dismiss: "instance" }));
    drop("alm.json", base({ id: "d-always", dismiss: "always" }));
    const before = dismissedUpgradeNotices(process.env).size;
    assert.equal(localDismissMode("d-inst"), "instance");
    assert.equal(localDismissMode("d-always"), "always");
    assert.equal(localDismissMode("never-there"), "absent");
    markInstanceDismissal("d-inst");
    let ids = visibleLocalNotices().map((n) => n.id);
    assert.equal(ids.includes("d-inst"), false, "instance dismissal hides for the rest of the process");
    assert.equal(ids.includes("d-always"), true);
    assert.equal(dismissedUpgradeNotices(process.env).size, before, "nothing persisted for instance mode");
    const almRec = validateRecord(base({ id: "d-always", dismiss: "always" }))!;
    assert.equal(dismissUpgradeNotice(`${almRec.id}@${contentHash16(almRec)}`, process.env), true, "store accepts hashed keys");
    ids = visibleLocalNotices().map((n) => n.id);
    assert.equal(ids.includes("d-always"), true, "always-mode is immune to dismissal");
    clear();
});

test("mergedNotices: local shadows built-in on equal id, priority sorts the list", () => {
    clear();
    drop("shadow.json", base({ id: PCK_NOTICE_ID, kind: "warning", title: "本地覆盖内置提示", priority: 90 }));
    const m = mergedNotices(process.env);
    assert.equal(m.filter((n) => n.id === PCK_NOTICE_ID).length, 1, "shadowed builtin must not double-render");
    assert.equal(m.find((n) => n.id === PCK_NOTICE_ID)?.source, "local");
    assert.ok(m.some((n) => n.id === WM_FASTPATH_INTRO_ID), "untouched builtin stays");
    assert.equal(m[0].id, PCK_NOTICE_ID, "priority 90 sorts first");
    clear();
    const plain = mergedNotices(process.env);
    assert.ok(plain.every((n) => n.source === "builtin"));
    assert.deepEqual(plain.map((n) => n.id).filter((id) => id === PCK_NOTICE_ID || id === WM_FASTPATH_INTRO_ID), [PCK_NOTICE_ID, WM_FASTPATH_INTRO_ID], "registry order preserved among equals");
});

test("store cap: 200+ hashed keys trim down without dropping built-in ids", () => {
    for (let i = 0; i < 210; i++) {
        assert.equal(dismissUpgradeNotice(`pad-${String(i).padStart(3, "0")}@${"a".repeat(16)}`, process.env), true);
    }
    assert.equal(dismissUpgradeNotice(PCK_NOTICE_ID, process.env), true);
    const set = dismissedUpgradeNotices(process.env);
    assert.ok(set.size <= 200, `trimmed to <=200, got ${set.size}`);
    assert.ok(set.has(PCK_NOTICE_ID), "built-in id protected from trimming");
});

test("dismiss key contract (handler path): bare id rejected, id@hash stored, edit re-nags once", () => {
    clear();
    // The store-cap test above left ~200 pad keys; start clean so trimming
    // cannot evict the key under assertion.
    fs.rmSync(path.join(root, "state"), { recursive: true, force: true });
    const rec = base({ id: "handler-key", title: { en: "Handler path", "zh-CN": "处理器路径" } });
    drop("h.json", rec);
    assert.equal(dismissUpgradeNotice("handler-key", process.env), false, "bare local id must NOT be storable (allowlist)");
    assert.ok(visibleLocalNotices().some((p) => p.id === "handler-key"));
    const key = localDismissKey("handler-key");
    assert.ok(key && /^handler-key@[0-9a-f]{16}$/.test(key), `key shape id@hash16: ${key}`);
    assert.equal(dismissUpgradeNotice(key!, process.env), true);
    assert.ok(!visibleLocalNotices().some((p) => p.id === "handler-key"), "gate filters on exactly this key");
    drop("h.json", Object.assign({}, rec, { title: { en: "Edited", "zh-CN": "改了" } }));
    assert.ok(visibleLocalNotices().some((p) => p.id === "handler-key"), "new content ⇒ new hash ⇒ shown again once");
    clear();
});
