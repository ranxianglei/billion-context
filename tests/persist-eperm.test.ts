import { test } from "node:test";
import assert from "node:assert/strict";
import { PersistEpermAlert, buildAlertMessage } from "../src/persist-eperm.ts";

const DIR = "/home/u/.local/share/billion-context/sessions";

function failLine(id: string, count: number, code = "EPERM", where = "; data spilled to /x"): string {
    const err = `${code}: operation not permitted, rename '/x/.tmp-${id}' -> '/x/${id}.json'`;
    return `[persist] write failed for ${id} (total ${count}x): ${err}${where}`;
}

type Fired = { dir: string; count: number };

function makeAlert(opts: { platform?: NodeJS.Platform; threshold?: number; repeatMs?: number; now?: () => number } = {}): { alert: PersistEpermAlert; fired: Fired[] } {
    const fired: Fired[] = [];
    const alert = new PersistEpermAlert({
        dir: DIR,
        platform: opts.platform ?? "win32",
        threshold: opts.threshold ?? 5,
        repeatMs: opts.repeatMs ?? 0,
        now: opts.now ?? Date.now,
        onAlert: (dir, count) => fired.push({ dir, count }),
    });
    return { alert, fired };
}

test("win32: kernel count crosses threshold → one alert carrying the kernel's N", () => {
    const { alert, fired } = makeAlert({ threshold: 5 });
    assert.equal(alert.observe("error", failLine("ses-1", 1)), false, "N=1 < 5");
    assert.equal(alert.observe("warn", failLine("ses-1", 2)), false, "N=2 < 5");
    assert.equal(alert.observe("warn", failLine("ses-1", 4)), false, "N=4 < 5");
    assert.equal(alert.observe("warn", failLine("ses-1", 8)), true, "N=8 >= 5");
    assert.equal(fired.length, 1);
    assert.equal(fired[0].dir, DIR);
    assert.equal(fired[0].count, 8);
});

test("win32: kernel count stays below threshold → no alert", () => {
    const { alert, fired } = makeAlert({ threshold: 5 });
    alert.observe("error", failLine("ses-1", 1));
    alert.observe("warn", failLine("ses-1", 2));
    alert.observe("warn", failLine("ses-1", 4));
    assert.equal(fired.length, 0);
});

test("win32: non-lock error (ENOENT) → no alert even at high count", () => {
    const { alert, fired } = makeAlert();
    alert.observe("warn", failLine("ses-1", 16, "ENOENT"));
    assert.equal(fired.length, 0);
});

test("win32: 'warn' accepted (kernel logs count>=2 as warn), 'info' rejected", () => {
    const warn = makeAlert();
    assert.equal(warn.alert.observe("warn", failLine("ses-1", 8)), true);
    assert.equal(warn.fired.length, 1);
    const info = makeAlert();
    info.alert.observe("info", failLine("ses-1", 8));
    assert.equal(info.fired.length, 0);
});

test("non-win32 (linux): EPERM at high count → no alert", () => {
    const { alert, fired } = makeAlert({ platform: "linux" });
    alert.observe("warn", failLine("ses-1", 16));
    assert.equal(fired.length, 0);
});

test("one-shot (repeatMs=0): many high-count lines → still one alert", () => {
    const { alert, fired } = makeAlert({ repeatMs: 0 });
    alert.observe("warn", failLine("ses-1", 8));
    alert.observe("warn", failLine("ses-1", 16));
    alert.observe("warn", failLine("ses-1", 32));
    assert.equal(fired.length, 1);
});

test("rate-limited: re-alerts at most every repeatMs", () => {
    let t = 0;
    const { alert, fired } = makeAlert({ repeatMs: 60000, now: () => t });
    alert.observe("warn", failLine("ses-1", 8));
    assert.equal(fired.length, 1, "first alert at t=0");
    t = 30000;
    alert.observe("warn", failLine("ses-1", 16));
    assert.equal(fired.length, 1, "no re-alert within the window");
    t = 60000;
    alert.observe("warn", failLine("ses-1", 16));
    assert.equal(fired.length, 2, "re-alert once the window elapses");
    t = 61000;
    alert.observe("warn", failLine("ses-1", 16));
    assert.equal(fired.length, 2, "no immediate re-alert right after one");
    t = 121000;
    alert.observe("warn", failLine("ses-1", 16));
    assert.equal(fired.length, 3, "re-alert again after another full window");
});

test("reads the kernel's N directly — a single high-N line alerts (not a line count)", () => {
    const { alert, fired } = makeAlert({ threshold: 5 });
    alert.observe("warn", failLine("ses-1", 16));
    assert.equal(fired.length, 1);
    assert.equal(fired[0].count, 16);
});

test("all three lock codes (EPERM/EBUSY/EACCES) trigger the alert", () => {
    for (const code of ["EPERM", "EBUSY", "EACCES"]) {
        const { alert, fired } = makeAlert();
        alert.observe("warn", failLine("ses-1", 8, code));
        assert.equal(fired.length, 1, `${code} triggers`);
    }
});

test("unrelated kernel log lines never match", () => {
    const { alert, fired } = makeAlert();
    alert.observe("error", "[persist] builder failed for ses-1: EPERM: operation not permitted");
    alert.observe("warn", `[persist] could not create dir ${DIR}: EPERM: operation not permitted`);
    alert.observe("error", "[persist] shutdown flush failed for ses-1: EPERM: operation not permitted, rename '/x' -> '/y'");
    alert.observe("info", "[persist] loaded 3 sessions");
    alert.observe("error", "EPERM: operation not permitted, rename '/x' -> '/y'");
    assert.equal(fired.length, 0);
});

test("alert message names the dir and points at Defender exclusions + OneDrive", () => {
    const msg = buildAlertMessage(DIR, 8);
    assert.ok(msg.includes(DIR), "names the session dir");
    assert.ok(/Defender/i.test(msg), "mentions Defender");
    assert.ok(/exclusion/i.test(msg), "mentions exclusions");
    assert.ok(/OneDrive/i.test(msg), "warns about OneDrive");
    assert.ok(msg.includes("8"), "includes the failure count");
});
