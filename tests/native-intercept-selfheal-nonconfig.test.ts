import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { installNativeFetchIntercept } from "../src/agent/native-intercept.js";
import { runFetchIntegrityCheckForTest } from "../src/agent/fetch-chain/index.js";

// #5959 review finding: a NON-configurable accessor masking our own top made
// the watchdog's defineProperty fallback throw out of the timer callback →
// uncaughtException → host process death. Non-configurability is permanent
// for the process lifetime (no later test could restore the slot), so this
// regression lives in its own file — node --test runs each file in its own
// process. Diagnostics route to the shared bili.log (#2827); keep this suite
// hermetic like its sibling.
const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "bili-selfheal-nonconfig-"));
const PREV_XDG_STATE_HOME = process.env.XDG_STATE_HOME;
process.env.XDG_STATE_HOME = STATE_ROOT;
const CHAIN_LOG_FILE = path.join(STATE_ROOT, "billion-context", "bili.log");
after(() => {
    if (PREV_XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = PREV_XDG_STATE_HOME;
    fs.rmSync(STATE_ROOT, { recursive: true, force: true });
});

function fakeFetch(sink: string[]) {
    return (async (input: string | URL | Request, _init?: RequestInit) => {
        sink.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
        return new Response("{}", { status: 200 });
    }) as typeof fetch;
}

test("#5959: a non-configurable accessor masking our own top cannot crash the watchdog", async () => {
    const nativeSink: string[] = [];
    const nativeFetch = fakeFetch(nativeSink);
    const { _resetForTest } = await import("../src/agent/native-intercept.js");
    _resetForTest();
    globalThis.fetch = nativeFetch;
    try {
        fs.mkdirSync(path.dirname(CHAIN_LOG_FILE), { recursive: true });
        fs.writeFileSync(CHAIN_LOG_FILE, "");
        assert.equal(installNativeFetchIntercept({ origin: "http://127.0.0.1:40001", ready: Promise.resolve("http://127.0.0.1:40001") }), true);
        assert.equal(runFetchIntegrityCheckForTest(), true, "integrity watchdog must be armed");
        const top = globalThis.fetch;
        // The evictor freezes the slot: an accessor that hands back our own top
        // but can never be redefined again.
        Object.defineProperty(globalThis, "fetch", { get: () => top, configurable: false });
        // Pre-fix each of these threw TypeError("Cannot redefine property: fetch")
        // out of the timer callback (uncaughtException → host death).
        assert.doesNotThrow(() => runFetchIntegrityCheckForTest());
        assert.doesNotThrow(() => runFetchIntegrityCheckForTest());
        // Third consecutive unproductive repair → loud give-up, not a crash.
        assert.doesNotThrow(() => runFetchIntegrityCheckForTest());
        const lines = fs.readFileSync(CHAIN_LOG_FILE, "utf8").split("\n").filter((l) => l.length > 0);
        assert.ok(lines.some((l) => l.includes("[error]") && l.includes("cannot take back globalThis.fetch")),
            `expected a give-up error line, got: ${lines.join(" | ")}`);
    } finally {
        _resetForTest();
    }
});
