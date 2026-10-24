import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    formatStallDiagnostic,
    installNativeFetchIntercept,
    _resetForTest,
    _setStallTimingForTest,
    _setStallSinkForTest,
    type NativeInterceptState,
} from "../src/agent/native-intercept.ts";
import { rmrf } from "./tmp-rm.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// #4129: pi attaches to a HEALTHY shared proxy, prints the banner, then the
// first model request stalls forever because the proxy's event loop is saturated
// by concurrent compression (#3654) — the socket connects but never answers, so
// undici never throws and the old recovery path (only fires on TypeError) never
// runs. The fix adds a bounded, evidence-based watchdog on that send. These
// tests pin the wording contract (pure) and the watchdog's fire/suppress/re-fire
// behavior (integration, driven through the real fetch chain).

const DEAD_ORIGIN = "http://127.0.0.1:1"; // loopback port 1 → connect refused, fast "dead" probe
const MODEL_URL = "http://127.0.0.1:8199/v1/messages";
const MODEL_INIT: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };

type Announce = { level: "info" | "warn"; line: string };

const hangingFetch = ((_input?: unknown, _init?: unknown) => new Promise<Response>(() => {})) as typeof fetch;
const fastFetch = (async (_input?: unknown, _init?: unknown) => new Response("{}", { status: 200 })) as typeof fetch;

function stateFor(origin = DEAD_ORIGIN): NativeInterceptState {
    return { origin, ready: Promise.resolve(origin) };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("formatStallDiagnostic: busy → warn + saturation wording", () => {
    const { level, line } = formatStallDiagnostic(DEAD_ORIGIN, 12_345, { state: "busy", detail: "no health answer within 1500ms after TCP connect" });
    assert.equal(level, "warn");
    assert.match(line, /event loop saturated/);
    assert.match(line, /health=busy \(no health answer within 1500ms after TCP connect\)/);
    assert.match(line, /still pending after 12s/);
});

test("formatStallDiagnostic: alive → info + queued-behind-work wording", () => {
    const { level, line } = formatStallDiagnostic(DEAD_ORIGIN, 20_000, { state: "alive" });
    assert.equal(level, "info");
    assert.match(line, /queued behind in-flight work/);
    assert.match(line, /health=alive;/);
    assert.match(line, /still pending after 20s/);
});

test("formatStallDiagnostic: dead without detail → warn + respawn wording", () => {
    const { level, line } = formatStallDiagnostic(DEAD_ORIGIN, 20_000, { state: "dead" });
    assert.equal(level, "warn");
    assert.match(line, /recovery respawns on the next failure/);
    assert.match(line, /health=dead;/);
});

test("#4129: a model request stalled against a held origin emits ONE note, rate-limited per origin, re-fires after cooldown", async () => {
    const seen: Announce[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    _setStallTimingForTest(20, 100);
    _setStallSinkForTest((level, line) => seen.push({ level, line }));
    const fetchTop = (() => {
        globalThis.fetch = hangingFetch;
        assert.equal(installNativeFetchIntercept(stateFor()), true);
        return globalThis.fetch;
    })();
    try {
        void fetchTop(MODEL_URL, MODEL_INIT);
        await sleep(60);
        assert.equal(seen.length, 1, `first stall → exactly one note (got ${seen.length})`);
        assert.match(seen[0].line, /model request to http:\/\/127\.0\.0\.1:1 still pending after \ds/);
        assert.match(seen[0].line, /health=(busy|dead|alive)/);

        void fetchTop(MODEL_URL, MODEL_INIT);
        await sleep(80);
        assert.equal(seen.length, 1, "second stall within the cooldown window must be suppressed");

        await sleep(120);
        void fetchTop(MODEL_URL, MODEL_INIT);
        await sleep(80);
        assert.equal(seen.length, 2, "a stall after the cooldown elapses must re-announce");
    } finally {
        _setStallSinkForTest(undefined);
        _setStallTimingForTest(undefined, undefined);
        _resetForTest();
        globalThis.fetch = saved;
    }
});

test("#4129: a model request that completes before the probe window emits no note", async () => {
    const seen: Announce[] = [];
    const saved = globalThis.fetch;
    _resetForTest();
    _setStallTimingForTest(50, 1000);
    _setStallSinkForTest((level, line) => seen.push({ level, line }));
    const fetchTop = (() => {
        globalThis.fetch = fastFetch;
        assert.equal(installNativeFetchIntercept(stateFor()), true);
        return globalThis.fetch;
    })();
    try {
        const res = await fetchTop(MODEL_URL, MODEL_INIT);
        assert.equal(res.status, 200, "the routed request must reach the (fake) downstream");
        await sleep(80);
        assert.equal(seen.length, 0, "a fast response must not trip the stall watchdog");
    } finally {
        _setStallSinkForTest(undefined);
        _setStallTimingForTest(undefined, undefined);
        _resetForTest();
        globalThis.fetch = saved;
    }
});

// #4129 review: EPIPE on a severed stderr pipe arrives as an ASYNC 'error'
// event, not a sync throw — a try/catch around write() cannot see it, and
// unhandled it crashes the host process on the very diagnostic this feature
// exists to emit. In a real pi host logger.ts's #1233 handler is always
// co-loaded (native-intercept → apig-resign → config → logger) and absorbs
// the error — but the feature's own contract must not rest on that
// transitive-import coincidence, so the child below strips every pre-existing
// 'error' listener to test the guard in isolation. Mechanism verified: Node's
// internal pipe onerror handler REMOVES ITSELF and re-emits when no other
// listener remains — with none left, the 'error' throws as uncaughtException.
// The parent closes its end of the pipe right after READY (the supervisor
// scenario); the child must survive AND keep the durable record.
test("#4129: a severed stderr pipe must not crash the host when the stall note fires", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-4129-epipe-"));
    const childScript = path.join(dir, "child.ts");
    const modulePath = path.join(root, "src", "agent", "native-intercept.ts");
    fs.writeFileSync(childScript, [
        `import { installNativeFetchIntercept, _setStallTimingForTest } from ${JSON.stringify(modulePath)};`,
        `globalThis.fetch = ((_input?: unknown, _init?: unknown) => new Promise<Response>(() => {})) as typeof fetch;`,
        `_setStallTimingForTest(50, 1000);`,
        `installNativeFetchIntercept({ origin: "http://127.0.0.1:1", ready: Promise.resolve("http://127.0.0.1:1") });`,
        `process.stderr.removeAllListeners("error");`,
        // Signal readiness, then fire the hanging request ~200ms later — by then
        // the parent has already closed its end of the stderr pipe, so the
        // stall note's stderr write hits a real EPIPE.
        `process.stdout.write("READY\\n");`,
        `setTimeout(() => {`,
        `    void globalThis.fetch("http://127.0.0.1:8199/v1/messages", { method: "POST", body: "{}" });`,
        `    setTimeout(() => { process.stdout.write("SURVIVED\\n"); process.exit(0); }, 300);`,
        `}, 200);`,
    ].join("\n"));

    const child = spawn(process.execPath, ["--import", "tsx", childScript], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, XDG_STATE_HOME: dir },
    });

    let out = "";
    let earlyErr = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (earlyErr += d));

    await new Promise<void>((resolve, reject) => {
        const fail = setTimeout(() => reject(new Error(`child did not start: ${earlyErr.slice(0, 500)}`)), 15000);
        child.stdout.once("data", () => { clearTimeout(fail); resolve(); });
        child.on("exit", (code) => { clearTimeout(fail); reject(new Error(`child exited before READY code=${code}: ${earlyErr.slice(0, 500)}`)); });
    });
    // Close our end of the pipe now — the child's stall note fires ~250ms after READY.
    child.stderr.destroy();

    const code = await new Promise<number | null>((resolve, reject) => {
        const fail = setTimeout(() => reject(new Error(`child timed out after pipe close: ${earlyErr.slice(0, 500)}`)), 15000);
        child.on("close", (c) => { clearTimeout(fail); resolve(c); });
    });

    const logContent = fs.readFileSync(path.join(dir, "billion-context", "bili.log"), "utf8");
    try { child.kill(); } catch { /* already exited */ }
    rmrf(dir);

    assert.equal(code, 0, `host process must survive a severed stderr pipe, got ${code}; stderr: ${earlyErr.slice(0, 500)}`);
    assert.match(out, /SURVIVED/);
    assert.match(logContent, /model request to http:\/\/127\.0\.0\.1:1 still pending after \ds/, "the stall note must reach the durable file record even with stderr gone");
});
