import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRoutes } from "../src/config.ts";
import { setLogCapture } from "../src/logger.ts";
import { rmrf } from "./tmp-rm.ts";

type Captured = { level: string; msg: string };

const WARN_PREFIX = "[acp-config] ";

function inertWarns(captured: Captured[]): Captured[] {
    return captured.filter((e) => e.level === "warn" && e.msg.startsWith(WARN_PREFIX) && e.msg.includes("is INERT"));
}

function captureLogs(): { captured: Captured[]; stop: () => void } {
    const captured: Captured[] = [];
    setLogCapture((level, msg) => captured.push({ level, msg }));
    return { captured, stop: () => setLogCapture(null) };
}

function withConfigFile(body: string, fn: (file: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue2260-"));
    const file = path.join(dir, "billion-context.json");
    fs.writeFileSync(file, body);
    const prev = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = file;
    try {
        fn(file);
    } finally {
        if (prev === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = prev;
        rmrf(dir);
    }
}

// Seals BILI_RESIGN around fn: the enabled cascade reads it directly, and a
// CI shell that happens to export it would flip the guard-active premises.
function withSealedResignEnv(fn: () => void): void {
    const prev = process.env.BILI_RESIGN;
    delete process.env.BILI_RESIGN;
    try {
        fn();
    } finally {
        if (prev === undefined) delete process.env.BILI_RESIGN;
        else process.env.BILI_RESIGN = prev;
    }
}

// Module-level signature state is shared across these tests (one process per
// file); they are ordered so each step's premise holds: "" -> x-ofm -> "".
test("#2260(B)/#2090: inert non-builtin passthrough key warns once at config load", () => {
    const { captured, stop } = captureLogs();
    try {
        withSealedResignEnv(() => withConfigFile(
            JSON.stringify({ resign: { "x-ofm-signature": { passthrough: true } } }),
            () => {
                const first = loadRoutes();
                let warns = inertWarns(captured);
                assert.equal(warns.length, 1, `expected exactly 1 warning, got: ${captured.map((e) => e.msg).join(" | ")}`);
                assert.ok(warns[0].msg.includes('resign["x-ofm-signature"].passthrough'), warns[0].msg);
                assert.ok(warns[0].msg.includes('"sdk-hmac-sha256"'), warns[0].msg);
                assert.ok(warns[0].msg.includes('enabled=false') && warns[0].msg.includes("BILI_RESIGN=0"), warns[0].msg);

                const second = loadRoutes();
                assert.equal(inertWarns(captured).length, 1, "identical dead-key set must not repeat the warning");
                assert.deepEqual(Object.keys(first), Object.keys(second), "routes must parse identically with or without the warning");
            },
        ));
    } finally {
        stop();
    }
});

test("#2260(B): builtin-scheme passthrough is live — no warning", () => {
    const { captured, stop } = captureLogs();
    try {
        withSealedResignEnv(() => withConfigFile(
            JSON.stringify({ resign: { "sdk-hmac-sha256": { passthrough: true } } }),
            () => {
                loadRoutes();
                assert.equal(inertWarns(captured).length, 0, `no warning expected: ${captured.map((e) => e.msg).join(" | ")}`);
            },
        ));
    } finally {
        stop();
    }
});

test("#2260(B): guard-disabled key is not dead — no warning", () => {
    const { captured, stop } = captureLogs();
    try {
        withSealedResignEnv(() => withConfigFile(
            JSON.stringify({ resign: { "x-ofm-signature": { passthrough: true, enabled: false } } }),
            () => {
                loadRoutes();
                assert.equal(inertWarns(captured).length, 0, `no warning expected: ${captured.map((e) => e.msg).join(" | ")}`);
            },
        ));
    } finally {
        stop();
    }
});

test("#2260(B): provider-scope inert key warns; changing the dead-key set re-warns", () => {
    const { captured, stop } = captureLogs();
    try {
        withSealedResignEnv(() => withConfigFile(
            JSON.stringify({ providers: { "https://api.example.com/v1": { resign: { "aws4-hmac-sha256": { passthrough: true } } } } }),
            (file) => {
                loadRoutes();
                let warns = inertWarns(captured);
                assert.equal(warns.length, 1, `expected exactly 1 warning, got: ${captured.map((e) => e.msg).join(" | ")}`);
                assert.ok(warns[0].msg.includes('resign["aws4-hmac-sha256"].passthrough'), warns[0].msg);

                fs.writeFileSync(file, JSON.stringify({ resign: { "b-cryptosig": { passthrough: true } } }));
                loadRoutes();
                warns = inertWarns(captured);
                assert.equal(warns.length, 2, "changed dead-key set must re-warn");
                assert.ok(warns[1].msg.includes('resign["b-cryptosig"].passthrough'), warns[1].msg);
                assert.ok(!warns[1].msg.includes("aws4-hmac-sha256"), "fixed key must not be re-listed");

                loadRoutes();
                assert.equal(inertWarns(captured).length, 2, "stable dead-key set stays quiet");
            },
        ));
    } finally {
        stop();
    }
});
