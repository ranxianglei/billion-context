import test from "node:test";
import assert from "node:assert/strict";
import { DecodedRequestAdmission, DecodedRequestBusyError, LARGE_DECODED_ADMISSION_BYTES, largeDecodedBudgetStatus } from "../src/request-body-budget.ts";
import { largeDecodedAdmissionBytes, maxLargeDecodedRequests } from "../src/knobs.ts";

// #7277: the admission-slot budget (count + cost band) is now operator
// config — BILI_MAX_LARGE_DECODED_REQUESTS / BILI_LARGE_DECODED_ADMISSION_BYTES
// (or network.maxLargeDecodedRequests / network.largeDecodedAdmissionBytes) —
// and the 503 refusal reports held/cap + how long the oldest slot has been
// held. The slot counter is module-global, so everything below is ONE
// sequential test. node --test isolates each file's process, so env saves/
// restores cannot leak into other suites.
process.env.BILI_RECEIVE_BODY_BYTES = "104857600"; // pinned 100 MiB, above every band used below

const ENV_CAP = "BILI_MAX_LARGE_DECODED_REQUESTS";
const ENV_BAND = "BILI_LARGE_DECODED_ADMISSION_BYTES";

function saveEnv(): [string | undefined, string | undefined] {
    return [process.env[ENV_CAP], process.env[ENV_BAND]];
}

function setEnv(cap: string | undefined, band: string | undefined): void {
    if (cap === undefined) delete process.env[ENV_CAP]; else process.env[ENV_CAP] = cap;
    if (band === undefined) delete process.env[ENV_BAND]; else process.env[ENV_BAND] = band;
}

test("#7277: admission budget knobs — defaults, env cap, env band, status (sequential: module-global slots)", () => {
    const saved = saveEnv();
    const band = LARGE_DECODED_ADMISSION_BYTES; // 32 MiB shipped default
    assert.ok(band < 104857600, "band sits below the pinned 100 MiB receive cap");
    const large = band + 1;
    try {
        // Phase 0 — shipped defaults: 2 slots, 32 MiB band.
        setEnv(undefined, undefined);
        assert.equal(maxLargeDecodedRequests(), 2);
        assert.equal(largeDecodedAdmissionBytes(), band);
        let st = largeDecodedBudgetStatus();
        assert.equal(st.held, 0);
        assert.equal(st.cap, 2);
        assert.equal(st.bandBytes, band); // min(100MiB cap, 32MiB band)
        assert.equal(st.oldestHeldMs, undefined);

        // Phase 1 — default cap: two over-band bodies admitted, third busy;
        // status reports the hold while it lasts and clears on release.
        const a = new DecodedRequestAdmission(), b = new DecodedRequestAdmission(), c = new DecodedRequestAdmission();
        try {
            a.observe(large);
            b.observe(large);
            st = largeDecodedBudgetStatus();
            assert.equal(st.held, 2);
            assert.ok(st.oldestHeldMs !== undefined && st.oldestHeldMs >= 0, "oldest-held ms reported while slots are held");
            assert.throws(() => c.observe(large), DecodedRequestBusyError);
            a.release();
            c.observe(large); // freed slot admitted
            st = largeDecodedBudgetStatus();
            assert.equal(st.held, 2);
        } finally { a.release(); b.release(); c.release(); }
        assert.equal(largeDecodedBudgetStatus().held, 0, "all slots released");

        // Phase 2 — cap override: BILI_MAX_LARGE_DECODED_REQUESTS=1 admits ONE
        // over-band body; the second is busy even though the old default was 2.
        setEnv("1", undefined);
        assert.equal(maxLargeDecodedRequests(), 1);
        const d = new DecodedRequestAdmission(), e = new DecodedRequestAdmission();
        try {
            d.observe(large);
            assert.throws(() => e.observe(large), DecodedRequestBusyError);
            d.release();
            e.observe(large);
        } finally { d.release(); e.release(); }

        // Phase 3 — band override: a 32 KiB cost band makes a 64 KiB body
        // LARGE (it used to sail through the 32 MiB band), and in-band bodies
        // stay free. 0 is rejected as a band (must be > 0 → default).
        setEnv(undefined, String(32 * 1024));
        assert.equal(largeDecodedAdmissionBytes(), 32 * 1024);
        const f = new DecodedRequestAdmission(), g = new DecodedRequestAdmission();
        try {
            f.observe(32 * 1024); // exactly at the band: free (> not >=)
            f.observe(64 * 1024); // over: takes slot 1
            g.observe(64 * 1024); // over: slot 2
            assert.throws(() => new DecodedRequestAdmission().observe(64 * 1024), DecodedRequestBusyError);
        } finally { f.release(); g.release(); }
        setEnv(undefined, "0");
        assert.equal(largeDecodedAdmissionBytes(), band, "0 is not a valid band — falls back to the default");
    } finally {
        setEnv(saved[0], saved[1]);
    }
});
