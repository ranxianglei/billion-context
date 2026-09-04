import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// #518 integration: drive the REAL `bili daemon` subcommand through a real
// process tree (daemon -> detached proxy), verify the single-line JSON
// contract, then verify #414 parent-gone reaping kills the proxy.
//
// The proxy grandchild is spawned as bare `node <script> start …`; running
// the whole tree under NODE_OPTIONS=--import tsx makes every generation able
// to load the TypeScript sources without a prior build.

const REPO_ROOT = process.cwd();
// index.ts, not cli.ts: main() is invoked from the entry module (mirrors the
// published bin -> dist/index.js wiring).
const CLI = path.join(REPO_ROOT, "src", "index.ts");

interface DaemonJson {
    origin: string;
    port: number;
    pid: number;
    logPath?: string;
}

function cleanEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ACP_PORT;
    delete env.ACP_HOST;
    delete env.BILI_PARENT_PID;
    return env;
}

function waitForExit(proc: ChildProcess, ms: number, label: string): Promise<number | null> {
    if (proc.exitCode !== null || proc.killed) return Promise.resolve(proc.exitCode);
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        proc.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code);
        });
        void label;
    });
}

async function collectStdout(proc: ChildProcess): Promise<string> {
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
    });
    await new Promise<void>((resolve) => proc.once("close", () => resolve()));
    return out;
}

function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

test("e2e daemon: real spawn, JSON handshake, parent-gone reaping (#518)", { timeout: 120_000 }, async () => {
    // Dummy "host agent": the pid the proxy watches via BILI_PARENT_PID.
    const dummy = spawn(process.execPath, ["-e", "setTimeout(()=>{},600000)"], { stdio: "ignore", detached: false });
    assert.ok(dummy.pid, "dummy host pid");

    const daemon = spawn(process.execPath, [CLI, "daemon", "--parent-pid", String(dummy.pid)], {
        cwd: REPO_ROOT,
        env: { ...cleanEnv(), NODE_OPTIONS: "--import tsx" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let daemonErr = "";
    daemon.stderr?.on("data", (d: Buffer) => {
        daemonErr += d.toString("utf8");
    });
    const daemonOut = collectStdout(daemon);

    try {
        const code = await waitForExit(daemon, 60_000, "daemon");
        assert.equal(code, 0, `daemon exited ${code}; stderr:\n${daemonErr}`);

        const out = await daemonOut;
        const lines = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
        assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${JSON.stringify(out)}`);
        const info = JSON.parse(lines[0]) as DaemonJson;
        assert.ok(Number.isInteger(info.port) && info.port > 0, `bad port ${info.port}`);
        assert.equal(info.origin, `http://127.0.0.1:${info.port}`);
        assert.ok(Number.isInteger(info.pid) && info.pid > 0, `bad pid ${info.pid}`);
        assert.ok(pidAlive(info.pid), "proxy must be alive after handshake");

        const health = await fetch(`${info.origin}/__bili/health`).then((r) => r.json()) as { ok?: boolean };
        assert.equal(health.ok, true, "proxy health endpoint must answer");

        // Kill the host: the proxy's #414 watcher (2s interval) must reap it.
        dummy.kill("SIGTERM");
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && pidAlive(info.pid)) {
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.equal(pidAlive(info.pid), false, `proxy ${info.pid} survived host death (log: ${info.logPath})\n${daemonErr}`);
    } finally {
        if (daemon.exitCode === null && !daemon.killed) daemon.kill("SIGTERM");
        if (dummy.exitCode === null && !dummy.killed) dummy.kill("SIGTERM");
    }
});
