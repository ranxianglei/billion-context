import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runSessionStartHook } from "../src/agent/shared.js";

const here = (p: string) => path.resolve(path.dirname(fileURLToPath(import.meta.url)), p);

// #2943: short-lived SessionStart hooks must NOT force process.exit(0) on the normal
// path — on Windows + Node 24.14.x that races libuv's win async-handle close (stdin)
// and aborts before any work. runSessionStartHook instead tears down stdin and lets
// the event loop drain (exit code 0), with an unref'd backstop only as a leak guard.
describe("runSessionStartHook (#2943)", () => {
    it("normal path: no forced process.exit, stdin torn down, exit code 0", async () => {
        const prevExitCode = process.exitCode;
        const calls: number[] = [];
        let destroyed = false;
        try {
            runSessionStartHook(async () => {}, {
                input: { destroy: () => { destroyed = true; } },
                exit: (code) => { calls.push(code); },
                backstopMs: 60,
            });
            await new Promise((r) => setTimeout(r, 25)); // < backstop: natural drain should win
            assert.equal(destroyed, true, "stdin must be torn down before draining");
            assert.deepEqual(calls, [], "process.exit must NOT be called on the normal path (libuv race)");
            assert.equal(process.exitCode, 0, "exit code must stay 0 (fails open)");
        } finally {
            process.exitCode = prevExitCode;
        }
    });

    it("leak path: unref'd backstop force-exits 0 when something holds the loop", async () => {
        const calls: number[] = [];
        const leak = setInterval(() => {}, 1000); // ref'd handle keeps the loop alive
        try {
            runSessionStartHook(async () => {}, {
                input: { destroy: () => {} },
                exit: (code) => { calls.push(code); },
                backstopMs: 40,
            });
            await new Promise((r) => setTimeout(r, 130)); // > backstop
            assert.deepEqual(calls, [0], "backstop must force a clean exit(0) when the loop would otherwise stay up");
        } finally {
            clearInterval(leak);
        }
    });
});

describe("zcode bootstrap-hook entry contract (#2943)", () => {
    it("real entry exits 0 promptly and does not hang", async () => {
        const hookPath = here("../src/zcode/bootstrap-hook.ts");
        const env = { ...process.env };
        delete env.NODE_TEST_CONTEXT; // let main() actually run (read stdin, plan, fail open)
        env.BILI_NATIVE_ZCODE = "0";   // planNativeZcode -> mode "off": earliest safe return, no proxy/config side effects
        const child = spawn(process.execPath, ["--import", "tsx", hookPath], { env, stdio: ["pipe", "pipe", "pipe"] });
        const stderr: string[] = [];
        child.stderr.on("data", (d) => stderr.push(String(d)));
        child.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", session_id: "t" }));
        child.stdin.end();
        const kill = setTimeout(() => child.kill("SIGKILL"), 8000); // bounded: never hang the suite
        const code = await new Promise<number | null>((resolve) => {
            child.on("close", (c) => resolve(c));
            child.on("error", () => resolve(null));
        });
        clearTimeout(kill);
        assert.equal(code, 0, `zcode hook must exit 0 (got ${code}); stderr=${stderr.join("")}`);
    });

    // #4692: the hook is an independent entry point from the MCP child — the
    // built-in-account blind spot must be reported on stderr from HERE too.
    async function runHook(env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
        const hookPath = here("../src/zcode/bootstrap-hook.ts");
        const e = { ...env };
        delete e.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ["--import", "tsx", hookPath], { env: e, stdio: ["pipe", "pipe", "pipe"] });
        const stderr: string[] = [];
        child.stderr.on("data", (d) => stderr.push(String(d)));
        child.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", session_id: "t" }));
        child.stdin.end();
        const kill = setTimeout(() => child.kill("SIGKILL"), 15000);
        const code = await new Promise<number | null>((resolve) => {
            child.on("close", (c) => resolve(c));
            child.on("error", () => resolve(null));
        });
        clearTimeout(kill);
        return { code, out: stderr.join("") };
    }

    it("#4692: reports the built-in account on stderr, then fails open (no proxy reachable)", async () => {
        const env = { ...process.env };
        env.ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
        // attach to a dead port: health wait fails after its deadline -> fail-open return BEFORE any store write
        env.BILLION_CONTEXT_PROXY = "http://127.0.0.1:9";
        delete env.BILI_NATIVE_ZCODE;
        delete env.BILI_ZCODE_ROUTE;
        const { code, out } = await runHook(env);
        assert.equal(code, 0, `hook must still fail open (got ${code}); stderr=${out}`);
        assert.match(out, /z\.ai built-in account detected \(ZAI_BUSINESS_BASE_URL=https:\/\/api\.z\.ai\)/);
        assert.match(out, /BYPASSES bili/);
    });

    it("#4692: kill-switch opt-out keeps the hook silent about the built-in account", async () => {
        const env = { ...process.env };
        env.ZAI_BUSINESS_BASE_URL = "https://api.z.ai";
        env.BILI_NATIVE_ZCODE = "0";
        const { code, out } = await runHook(env);
        assert.equal(code, 0, `hook must exit 0 (got ${code}); stderr=${out}`);
        assert.doesNotMatch(out, /built-in account detected/);
    });
});
