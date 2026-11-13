import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// This release flipped the storage default to pure-sqlite: JSON envelopes are
// no longer written by default, so index.db is the sole durable copy. The
// registry surfaces that as a one-time warn notice, gated on the NEW default
// posture actually being in effect — any explicit jsonWriter choice or an
// explicit unified selection means the user made the call, and the notice
// must stay silent (same discipline as the iot-incompat gate). Hermetic: fresh
// state + config isolated, storage/encryption/persist knobs cleared from the
// inherited env so the DEFAULT posture is what we assert on.

const state = fs.mkdtempSync(path.join(os.tmpdir(), "sqdef-notice-state-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sqdef-notice-home-"));
for (const k of [
    "BILI_STORAGE_UNIFIED",
    "BILI_STORAGE_JSON_WRITER",
    "BILI_STORAGE_BACKEND",
    "BILI_ENCRYPTION_KEY",
    "BILI_PERSIST",
]) {
    delete process.env[k];
}
process.env.XDG_STATE_HOME = state;
process.env.DSH_HOME = home;
process.env.BILI_CONFIG_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sqdef-notice-cfg-")), "absent.json");

const { NOTICES, sqliteDefaultNoticeActive } = await import("../src/notices.ts");
const { SQLITE_DEFAULT_NOTICE_ID, dismissUpgradeNotice } = await import("../src/pck-notice.ts");

const entry = () => {
    const found = NOTICES.find((n) => n.id === SQLITE_DEFAULT_NOTICE_ID);
    assert.ok(found, "registry carries the sqlite-default entry");
    return found;
};

test("default posture (nothing set) ⇒ gate active, notice shows", () => {
    assert.equal(sqliteDefaultNoticeActive(process.env), true);
    assert.equal(entry().active(), true);
});

test("explicit jsonWriter=on ⇒ user made the call, notice silent", () => {
    assert.equal(sqliteDefaultNoticeActive({ ...process.env, BILI_STORAGE_JSON_WRITER: "on" }), false);
});

test("explicit jsonWriter=off ⇒ user made the call, notice silent", () => {
    assert.equal(sqliteDefaultNoticeActive({ ...process.env, BILI_STORAGE_JSON_WRITER: "off" }), false);
});

test("explicit unified=full ⇒ historical dual-write default, notice silent", () => {
    assert.equal(sqliteDefaultNoticeActive({ ...process.env, BILI_STORAGE_UNIFIED: "full" }), false);
});

test("explicit unified=sqlite ⇒ same pure-sqlite posture, notice shows", () => {
    assert.equal(sqliteDefaultNoticeActive({ ...process.env, BILI_STORAGE_UNIFIED: "sqlite" }), true);
});

test("encryption key set ⇒ unified sidecar blocked, notice silent", () => {
    assert.equal(sqliteDefaultNoticeActive({ ...process.env, BILI_ENCRYPTION_KEY: "k" }), false);
});

test("non-sqlite backend (mysql) ⇒ envelopes kept, notice silent", () => {
    assert.equal(sqliteDefaultNoticeActive({ ...process.env, BILI_STORAGE_BACKEND: "mysql" }), false);
});

test("dismissal hides the notice for later polls", () => {
    assert.equal(dismissUpgradeNotice(SQLITE_DEFAULT_NOTICE_ID, process.env), true);
    assert.equal(sqliteDefaultNoticeActive(process.env), true, "gate is posture-only (still true)");
    assert.equal(entry().active(), false);
});
