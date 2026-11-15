import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePinDuration, readPin, writePin, clearPin, activePin, isVersionPinned, setPin, _resetPinForTest } from "../src/update-pin.js";

test("parsePinDuration parses h and d units", () => {
    assert.equal(parsePinDuration("1h"), 3600000);
    assert.equal(parsePinDuration("12h"), 43200000);
    assert.equal(parsePinDuration("1d"), 86400000);
    assert.equal(parsePinDuration("7d"), 604800000);
    assert.equal(parsePinDuration("  1h  "), 3600000);
    assert.equal(parsePinDuration("1H"), 3600000);
});

test("parsePinDuration rejects invalid input", () => {
    assert.equal(parsePinDuration("forever"), undefined);
    assert.equal(parsePinDuration("1x"), undefined);
    assert.equal(parsePinDuration("h"), undefined);
    assert.equal(parsePinDuration("0h"), undefined);
    assert.equal(parsePinDuration("-1h"), undefined);
    assert.equal(parsePinDuration("1.5h"), undefined);
    assert.equal(parsePinDuration(""), undefined);
});

test("setPin writes and readPin reads the state", async () => {
    await _resetPinForTest();
    const pin = await setPin("0.1.215", 3600000);
    assert.equal(pin.v, 1);
    assert.equal(pin.version, "0.1.215");
    assert.ok(pin.setAt > 0);
    assert.ok(pin.until !== undefined);
    assert.ok(pin.until > pin.setAt);

    const read = await readPin();
    assert.ok(read);
    assert.equal(read.version, "0.1.215");
    assert.equal(read.until, pin.until);
    await _resetPinForTest();
});

test("setPin without duration = indefinite (no until field)", async () => {
    await _resetPinForTest();
    const pin = await setPin("0.1.215");
    assert.equal(pin.until, undefined);

    const read = await readPin();
    assert.ok(read);
    assert.equal(read.version, "0.1.215");
    assert.equal(read.until, undefined);
    await _resetPinForTest();
});

test("activePin returns the pin when not expired", async () => {
    await _resetPinForTest();
    await setPin("0.1.215", 3600000);
    const active = await activePin();
    assert.ok(active);
    assert.equal(active.version, "0.1.215");
    await _resetPinForTest();
});

test("activePin returns undefined when expired", async () => {
    await _resetPinForTest();
    // Write a pin with an already-expired `until`
    const expiredPin = { v: 1 as const, version: "0.1.215", setAt: Date.now() - 7200000, until: Date.now() - 3600000 };
    await writePin(expiredPin);
    const active = await activePin();
    assert.equal(active, undefined);
    await _resetPinForTest();
});

test("activePin returns undefined when no pin file exists", async () => {
    await _resetPinForTest();
    const active = await activePin();
    assert.equal(active, undefined);
});

test("isVersionPinned returns true when version matches and pin is active", async () => {
    await _resetPinForTest();
    await setPin("0.1.215", 3600000);
    assert.equal(await isVersionPinned("0.1.215"), true);
    assert.equal(await isVersionPinned("0.1.216"), false);
    await _resetPinForTest();
});

test("isVersionPinned returns false when pin is expired", async () => {
    await _resetPinForTest();
    const expiredPin = { v: 1 as const, version: "0.1.215", setAt: Date.now() - 7200000, until: Date.now() - 3600000 };
    await writePin(expiredPin);
    assert.equal(await isVersionPinned("0.1.215"), false);
    await _resetPinForTest();
});

test("clearPin removes the pin file", async () => {
    await _resetPinForTest();
    await setPin("0.1.215", 3600000);
    await clearPin();
    const read = await readPin();
    assert.equal(read, undefined);
    const active = await activePin();
    assert.equal(active, undefined);
});

test("readPin returns undefined for corrupt JSON", async () => {
    await _resetPinForTest();
    // Write corrupt JSON directly
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const { cacheDir } = await import("../src/paths.js");
    const pinFile = path.join(cacheDir(), ".pin.json");
    await mkdir(path.dirname(pinFile), { recursive: true });
    await writeFile(pinFile, "not json", "utf-8");
    const read = await readPin();
    assert.equal(read, undefined);
    await _resetPinForTest();
});

test("readPin returns undefined for wrong version field", async () => {
    await _resetPinForTest();
    const { writeFile, mkdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const { cacheDir } = await import("../src/paths.js");
    const pinFile = path.join(cacheDir(), ".pin.json");
    await mkdir(path.dirname(pinFile), { recursive: true });
    await writeFile(pinFile, JSON.stringify({ v: 2, version: "0.1.215", setAt: Date.now() }), "utf-8");
    const read = await readPin();
    assert.equal(read, undefined);
    await _resetPinForTest();
});

test("pinAction sets a pin with duration", async () => {
    const { pinAction, unpinAction, _resetUpdateActionsForTest, registerUpdateActions } = await import("../src/server/update-actions.js");
    await _resetPinForTest();
    _resetUpdateActionsForTest();
    registerUpdateActions({ packageName: "billion-context", currentVersion: "0.1.214", autoUpdate: false, installDir: "/tmp/test-install" });
    const r = await pinAction("0.1.215", "1h");
    assert.equal(r.ok, true);
    assert.ok(r.pin);
    assert.equal(r.pin.version, "0.1.215");
    assert.ok(r.pin.until !== undefined);
    const active = await activePin();
    assert.ok(active);
    assert.equal(active.version, "0.1.215");
    await _resetPinForTest();
    _resetUpdateActionsForTest();
});

test("pinAction sets an indefinite pin with 'forever'", async () => {
    const { pinAction, _resetUpdateActionsForTest, registerUpdateActions } = await import("../src/server/update-actions.js");
    await _resetPinForTest();
    _resetUpdateActionsForTest();
    registerUpdateActions({ packageName: "billion-context", currentVersion: "0.1.214", autoUpdate: false, installDir: "/tmp/test-install" });
    const r = await pinAction("0.1.215", "forever");
    assert.equal(r.ok, true);
    assert.ok(r.pin);
    assert.equal(r.pin.version, "0.1.215");
    assert.equal(r.pin.until, undefined);
    await _resetPinForTest();
    _resetUpdateActionsForTest();
});

test("pinAction rejects invalid duration", async () => {
    const { pinAction, _resetUpdateActionsForTest, registerUpdateActions } = await import("../src/server/update-actions.js");
    await _resetPinForTest();
    _resetUpdateActionsForTest();
    registerUpdateActions({ packageName: "billion-context", currentVersion: "0.1.214", autoUpdate: false, installDir: "/tmp/test-install" });
    const r = await pinAction("0.1.215", "1x");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /invalid duration/);
    await _resetPinForTest();
    _resetUpdateActionsForTest();
});

test("unpinAction clears an active pin", async () => {
    const { pinAction, unpinAction, _resetUpdateActionsForTest, registerUpdateActions } = await import("../src/server/update-actions.js");
    await _resetPinForTest();
    _resetUpdateActionsForTest();
    registerUpdateActions({ packageName: "billion-context", currentVersion: "0.1.214", autoUpdate: false, installDir: "/tmp/test-install" });
    await pinAction("0.1.215", "1h");
    const active = await activePin();
    assert.ok(active);
    const r = await unpinAction();
    assert.equal(r.ok, true);
    const after = await activePin();
    assert.equal(after, undefined);
    await _resetPinForTest();
    _resetUpdateActionsForTest();
});

test("unpinAction is a no-op when no pin is active", async () => {
    const { unpinAction, _resetUpdateActionsForTest, registerUpdateActions } = await import("../src/server/update-actions.js");
    await _resetPinForTest();
    _resetUpdateActionsForTest();
    registerUpdateActions({ packageName: "billion-context", currentVersion: "0.1.214", autoUpdate: false, installDir: "/tmp/test-install" });
    const r = await unpinAction();
    assert.equal(r.ok, true);
    _resetUpdateActionsForTest();
});
