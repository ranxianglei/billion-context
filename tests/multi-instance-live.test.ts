import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rmrf } from "./tmp-rm.ts";

// One LIVE proxy instance serving a session, plus a SECOND instance whose
// boot over the SAME sessions dir must be REFUSED (owner decision chain
// #5046 -> 2026-10-30 "no degradation in any case"). End-to-end proof that:
//   1. the surviving instance (A) keeps serving through real traffic and the
//      on-disk record stays a valid envelope at EVERY observed moment
//      (atomic tmp+rename), with stats.requests NEVER decreasing (#405
//      monotonic-counter guard under real traffic);
//   2. the late-starting instance B dies at boot with ONE actionable error
//      (isolate via BILI_SESSIONS_DIR / BILI_CONFIG_FILE) and a non-zero
//      exit code — NOT the old legacy-degraded coexistence. The old
//      serve-guard-converge interleave (#394/#2401, former phases 2-4) is
//      unreachable by construction now: the double-writer never starts. Its
//      envelope guards remain pinned at unit level in
//      tests/multi-instance-persist.test.ts and stay reachable through manual
//      file edits. Cross-lane sharing (distinct lanes, one dir) stays SUPPORTED
//      (#5082/#5091) and is pinned in
//      tests/issue5046-second-writer-degrade.test.ts.

const SESSION = "mi-live-session";
const MODEL = "claude-sonnet-4-5";
const TURN_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 10_000;

function sseBlock(type: string, data: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function textScript(msgId: string, text: string): string {
    return [
        sseBlock("message_start", { message: { id: msgId, role: "assistant", usage: { input_tokens: 40 } } }),
        sseBlock("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
        sseBlock("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
        sseBlock("content_block_stop", { index: 0 }),
        sseBlock("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }),
        sseBlock("message_stop", {}),
    ].join("");
}

interface Child {
    proc: ReturnType<typeof spawn>;
    port: number;
    stderr: string[];
}

interface Refusal {
    exitCode: number | null;
    stderr: string;
}

/** Spawns a child that is expected to DIE AT BOOT (no MI_READY) and collects
 *  its exit code + full stderr — the refusal-policy counterpart of
 *  spawnChild's success path. */
async function spawnChildRefusing(upstreamPort: number | string, env: NodeJS.ProcessEnv): Promise<Refusal> {
    const proc = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures/multi-instance-child.ts"), String(upstreamPort)], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    let ready = false;
    let stdoutBuf = "";
    const stderrChunks: string[] = [];
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (c: string) => {
        stdoutBuf += c;
        if (stdoutBuf.includes("MI_READY")) ready = true;
    });
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (c: string) => stderrChunks.push(c));
    const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child did not refuse within 30s")), 30_000);
        proc.on("exit", (c) => {
            clearTimeout(timer);
            resolve(c);
        });
        // A child that DID become ready violated the expectation — fail fast.
        const poll = setInterval(() => {
            if (ready) {
                clearInterval(poll);
                clearTimeout(timer);
                proc.kill("SIGTERM");
                reject(new Error("child became READY — expected a boot refusal"));
            }
        }, 100);
        proc.on("exit", () => clearInterval(poll));
    });
    return { exitCode: code, stderr: stderrChunks.join("") };
}

async function spawnChild(upstreamPort: number | string, env: NodeJS.ProcessEnv): Promise<Child> {
    const proc = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures/multi-instance-child.ts"), String(upstreamPort)], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (c: string) => {
        stderr.push(c);
        process.stderr.write(`[child] ${c}`);
    });
    const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("child did not become ready in 30s")), 30_000);
        let buf = "";
        proc.stdout!.setEncoding("utf8");
        proc.stdout!.on("data", (c: string) => {
            buf += c;
            const m = buf.match(/MI_READY (\d+)/);
            if (m) {
                clearTimeout(timer);
                resolve(Number(m[1]));
            }
        });
        proc.on("exit", (code) => reject(new Error(`child exited early (code ${code})`)));
    });
    return { proc, port, stderr };
}

interface DiskView {
    file: string;
    requests: number;
}

function readDisk(sessionsDir: string): DiskView | null {
    let dirs: string[];
    try {
        dirs = readdirSync(sessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
        return null;
    }
    for (const d of dirs) {
        for (const f of readdirSync(join(sessionsDir, d))) {
            if (!f.endsWith(".json") || f.endsWith(".content-store.json") || f.includes(".tmp-")) continue;
            const p = join(sessionsDir, d, f);
            let parsed: { id?: string; payload?: { stats?: { requests?: number } } };
            try {
                parsed = JSON.parse(readFileSync(p, "utf8"));
            } catch {
                // torn read of an in-flight rename — the reader loop treats any
                // parse failure as a violation; here just skip (the loop catches it)
                throw new Error(`on-disk session record failed to parse: ${p}`);
            }
            if (parsed.id === SESSION) {
                return { file: p, requests: parsed.payload?.stats?.requests ?? -1 };
            }
        }
    }
    return null;
}

async function waitFor(sessionsDir: string, pred: (v: DiskView) => boolean, what: string): Promise<DiskView> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    for (;;) {
        const v = (() => {
            try {
                return readDisk(sessionsDir);
            } catch {
                return null;
            }
        })();
        if (v && pred(v)) return v;
        if (Date.now() > deadline) throw new Error(`timeout waiting for: ${what} (last=${JSON.stringify(v)})`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

test("two live instances over one sessions dir: serve, guard, converge (#394/#405/#2401)", { timeout: 120_000 }, async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), "bili-mi-sessions-"));
    const stateDir = mkdtempSync(join(tmpdir(), "bili-mi-state-"));
    const children: Child[] = [];

    // Reader loop: the shared record must parse at every observed moment and
    // its request counter must never decrease (atomicity + monotonic guard).
    let reads = 0;
    let maxRequests = -1;
    let readerBroken: string | null = null;
    const reader = setInterval(() => {
        try {
            const v = readDisk(sessionsDir);
            reads++;
            if (v) {
                if (v.requests < maxRequests) readerBroken = `disk requests rolled back: ${v.requests} < ${maxRequests}`;
                maxRequests = Math.max(maxRequests, v.requests);
            }
        } catch (e) {
            readerBroken = readerBroken ?? String(e);
        }
    }, 5);

    const upstream = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(textScript(`msg_${Date.now()}`, `reply ok`));
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const childEnv = (p: number): NodeJS.ProcessEnv => ({
        ...process.env,
        // The global baseline preload pins BILI_STORAGE_UNIFIED=legacy process-wide;
        // spread into every child it would keep them BOTH legacy — A would never
        // write the sidecar lockfile and B would have nothing to refuse over
        // (boot-refusal needs a live foreign writer holding the shared index.db).
        // Pin the production default so the refusal contract runs like a real boot.
        BILI_STORAGE_UNIFIED: "full",
        BILI_SESSIONS_DIR: sessionsDir,
        XDG_STATE_HOME: stateDir,
        // #5012: non-TTY pipes now mute once the file leg proves live; this
        // suite asserts the overlap warn over stderr by design - "off" pins the tee
        ACP_LOG_FILE: "off",
        BILI_PERSIST_DEBOUNCE_MS: "30",
        BILI_UPDATE_CHECK_INTERVAL_MS: String(60 * 60 * 1000),
        MI_NOP: String(p),
    });

    const turn = async (child: Child, n: number): Promise<void> => {
        const url = `http://127.0.0.1:${child.port}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": SESSION },
            body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: true, messages: [{ role: "user", content: `turn ${n}: hello` }] }),
            signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        });
        const body = await res.text();
        assert.equal(res.status, 200, `turn ${n} via :${child.port}: ${body.slice(0, 300)}`);
        assert.ok(body.includes("message_stop"), `turn ${n}: stream incomplete`);
    };

    try {
        // Phase 1 — instance A alone warms the session (3 turns, persisted).
        children.push(await spawnChild(upstreamPort, childEnv(1)));
        const A = children[0]!;
        await turn(A, 1);
        await turn(A, 2);
        await turn(A, 3);
        const warmed = await waitFor(sessionsDir, (v) => v.requests >= 3, "A's 3 turns persisted");
        assert.equal(warmed.requests, 3, "each turn must count exactly once");

        // Phase 2 (rewritten 2026-10-30, owner chain "#5046 -> no degradation
        // in any case"): instance B booting over the SAME sessions dir now
        // REFUSES TO START — exit 1 with the actionable isolation error —
        // instead of the old serve-legacy-degraded coexistence. Consequence:
        // the former Phase 3/4 stale-write + converge/tie interleave below is
        // UNREACHABLE BY CONSTRUCTION (the second writer never runs); those
        // envelope guards stay pinned at unit level in
        // tests/multi-instance-persist.test.ts and remain reachable through
        // manual/multi-process file edits. Cross-LANE sharing (distinct
        // BILI_LAUNCHER_LANE) remains the supported shared topology (#5082/
        // #5091, pinned in tests/issue5046-second-writer-degrade.test.ts).
        const b = await spawnChildRefusing(upstreamPort, childEnv(2));
        assert.equal(b.exitCode, 1, "instance B must die at boot, not serve degraded");
        assert.ok(
            b.stderr.includes("unified storage REFUSED") && b.stderr.includes("REFUSES TO START"),
            `B's death must carry the actionable refusal (stderr tail: ${b.stderr.slice(-400)})`,
        );
        assert.ok(b.stderr.includes("BILI_SESSIONS_DIR"), "refusal names the fix");

        // A is UNAFFECTED by B's refused boot: it keeps serving fresh turns
        // and the on-disk counter advances exactly as before.
        await turn(A, 4);
        await turn(A, 5);
        const servedAfterRefusal = await waitFor(sessionsDir, (v) => v.requests >= 5, "A kept serving through B's refused boot");
        assert.equal(servedAfterRefusal.requests, 5, "A's turns count exactly once each");
        // Reader loop verdict.
        clearInterval(reader);
        assert.ok(reads > 10, `reader loop ran (reads=${reads})`);
        assert.equal(readerBroken, null, `shared record violated the always-valid/monotonic contract: ${readerBroken}`);

        // Both children stayed alive through the whole interleave.
        for (const c of children) {
            assert.equal(c.proc.exitCode, null, "a child died mid-test");
            assert.equal(c.proc.signalCode, null, "a child was killed mid-test");
        }
    } finally {
        clearInterval(reader);
        upstream.close();
        for (const c of children) {
            c.proc.kill("SIGTERM");
        }
        await new Promise((r) => setTimeout(r, 300));
        for (const c of children) {
            if (c.proc.exitCode === null) c.proc.kill("SIGKILL");
        }
        rmrf(sessionsDir);
        rmrf(stateDir);
    }
});
