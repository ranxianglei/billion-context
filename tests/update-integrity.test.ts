import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyTarballIntegrity, shouldStealLock } from "../src/update.ts";

function integrityField(buf: Buffer, alg = "sha512"): string {
    return `${alg}-${crypto.createHash(alg).update(buf).digest("base64")}`;
}

test("verifyTarballIntegrity: accepts a correct sha512 integrity", () => {
    const buf = Buffer.from("tarball-bytes");
    const r = verifyTarballIntegrity(buf, integrityField(buf));
    assert.deepEqual(r, { ok: true });
});

test("verifyTarballIntegrity: rejects a mismatching integrity", () => {
    const buf = Buffer.from("tarball-bytes");
    const other = integrityField(Buffer.from("other-bytes"));
    const r = verifyTarballIntegrity(buf, other);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /mismatch/);
});

test("verifyTarballIntegrity: accepts a correct legacy sha1 shasum", () => {
    const buf = Buffer.from("tarball-bytes");
    const shasum = crypto.createHash("sha1").update(buf).digest("hex");
    const r = verifyTarballIntegrity(buf, undefined, shasum);
    assert.deepEqual(r, { ok: true });
});

test("verifyTarballIntegrity: rejects a mismatching shasum", () => {
    const r = verifyTarballIntegrity(Buffer.from("a"), undefined, "deadbeef");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /shasum mismatch/);
});

test("verifyTarballIntegrity: fails closed on a garbage integrity field", () => {
    const r = verifyTarballIntegrity(Buffer.from("a"), "not-a-valid-field");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /malformed|unsupported/);
});

test("verifyTarballIntegrity: fails closed on unknown hash algorithm instead of throwing", () => {
    const r = verifyTarballIntegrity(Buffer.from("a"), "md9000-AAAA");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /unsupported integrity algorithm/);
});

test("shouldStealLock: dead holder is stealable at any age (#117)", () => {
    assert.equal(shouldStealLock(false, 0), true);
    assert.equal(shouldStealLock(false, 60_000), true);
});

test("shouldStealLock: live recent holder is never stolen (#117)", () => {
    assert.equal(shouldStealLock(true, 0), false);
    assert.equal(shouldStealLock(true, 5 * 60_000), false);
});

test("shouldStealLock: live holder past LOCK_MAX_AGE_MS is stolen (pid-reuse residue)", () => {
    // A real install never runs 30 minutes; an "alive" holder that old is a
    // crashed process whose pid was reused by an unrelated process.
    assert.equal(shouldStealLock(true, 30 * 60 * 1000), true);
    assert.equal(shouldStealLock(true, 60 * 60 * 1000), true);
});
