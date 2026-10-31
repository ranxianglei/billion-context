import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { _setRmImplForTest, rmrf } from "./tmp-rm.ts";

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "bili-tmp-rm-"));
}

function errno(code: string): NodeJS.ErrnoException {
    const err = new Error(`fake ${code}`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
}

test("rmrf: removes a plain tree; missing target is a no-op (force)", () => {
    const dir = tmpRoot();
    fs.mkdirSync(path.join(dir, "anthropic"));
    fs.writeFileSync(path.join(dir, "anthropic", "session.json"), "{}");
    rmrf(dir);
    assert.equal(fs.existsSync(dir), false);
    rmrf(path.join(dir, "already-gone")); // must not throw ENOENT
});

test("rmrf: cleans up while an in-process writer is armed (smoke)", () => {
    // An in-process timer cannot interleave with the synchronous delete — one
    // event loop — so this pass never triggers a retry and pins coexistence
    // only; the retry loop itself is pinned through _setRmImplForTest below.
    const dir = tmpRoot();
    fs.mkdirSync(path.join(dir, "anthropic"), { recursive: true });
    fs.writeFileSync(path.join(dir, "anthropic", "seed.json"), "{}");
    let ticks = 0;
    const writer = setInterval(() => {
        ticks += 1;
        fs.mkdirSync(path.join(dir, "anthropic"), { recursive: true });
        fs.writeFileSync(path.join(dir, "anthropic", `late-${ticks}.json`), "{}");
    }, 10);
    setTimeout(() => clearInterval(writer), 250).unref();
    rmrf(dir);
    assert.equal(fs.existsSync(dir), false);
});

test("rmrf: rides the backoff over transient failures and recovers", () => {
    const dir = tmpRoot();
    fs.mkdirSync(path.join(dir, "anthropic"), { recursive: true });
    fs.writeFileSync(path.join(dir, "anthropic", "seed.json"), "{}");
    let calls = 0;
    _setRmImplForTest((target) => {
        calls += 1;
        if (calls <= 3) throw errno("ENOTEMPTY");
        fs.rmSync(target, { recursive: true, force: true });
    });
    try {
        rmrf(dir);
    } finally {
        _setRmImplForTest();
    }
    assert.equal(calls, 4, "three ENOTEMPTYs → three backoffs → quiet tree deletes");
    assert.equal(fs.existsSync(dir), false);
});

test("rmrf: a transient storm past the budget throws after the full ladder", () => {
    let calls = 0;
    _setRmImplForTest(() => {
        calls += 1;
        throw errno("ENOTEMPTY");
    });
    const t0 = Date.now();
    try {
        assert.throws(() => rmrf("/definitely/not/a/path"), /fake ENOTEMPTY/);
    } finally {
        _setRmImplForTest();
    }
    assert.equal(calls, 12, "one attempt + all eleven backoffs, then give up");
    assert.ok(Date.now() - t0 >= 15750, "paid the 25..3200ms ladder (~16s)");
});

test("rmrf: non-transient errors throw at once, no backoff", () => {
    let calls = 0;
    _setRmImplForTest(() => {
        calls += 1;
        throw errno("ELOOP");
    });
    try {
        assert.throws(() => rmrf("/definitely/not/a/path"), /fake ELOOP/);
    } finally {
        _setRmImplForTest();
    }
    assert.equal(calls, 1);
});

test("rmrf: invalid input still throws TypeError (default impl)", () => {
    assert.throws(() => rmrf(42 as unknown as string), TypeError);
});
