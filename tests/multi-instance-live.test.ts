import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rmrf } from "./tmp-rm.ts";

// Two LIVE proxy instances over one sessions dir (#394 shape, end-to-end).
//
// What is proven here — the documented contract only, not multi-writer
// coherence (src/persist.ts deliberately rejects an election/lock):
//   1. both instances keep serving through interleaved turns on the SAME
//      session id (no crash, no head-of-line poisoning across processes);
//   2. the on-disk record stays a valid envelope at EVERY observed moment
//      (atomic tmp+rename) while two processes write it;
//   3. stats.requests on disk NEVER decreases (the #405 monotonic-counter
//      guard holds under real traffic, not just unit-shaped writes);
//   4. a stale resident's write is rejected AND the resident converges to the
//      newer disk lineage (#2401) — observable as: A's post-convergence write
//      is accepted and continues the DISK counter, not A's stale one;
//   5. the late-starting instance warns about the overlap (#394) at
//      registration.
//
// NOT proven (documented residuals, pinned separately in
// tests/multi-instance-persist.test.ts): tie passthrough, counter catch-up
// re-clobber, content-store last-writer-wins.

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

        // Phase 2 — instance B boots over the SAME dir (boot-hydrates the
        // session), serves 2 turns. B's writes must be fresh (accepted).
        children.push(await spawnChild(upstreamPort, childEnv(2)));
        const B = children[1]!;
        await turn(B, 4);
        await turn(B, 5);
        await waitFor(sessionsDir, (v) => v.requests >= 5, "B's turns persisted (fresh lineage accepted)");

        // B registered last: it must have seen A and warned (#394).
        const bErr = B.stderr.join("");
        assert.ok(bErr.includes("#394"), "late starter must warn about the overlapping instance");
        assert.ok(bErr.includes("another bili instance"), `unexpected warn text: ${bErr.slice(-400)}`);

        // Phase 3 — the STALE resident: A never re-read the file (its pool
        // entry is resident), so A's counter (3+1=4) is behind disk (5). Its
        // write must be REJECTED (#405) and A must converge (#2401).
        await turn(A, 6);
        await new Promise((r) => setTimeout(r, 300));
        const aErr1 = A.stderr.join("");
        assert.ok(aErr1.includes("rejected stale snapshot"), `stale write must be rejected (stderr tail: ${aErr1.slice(-500)})`);

        // Phase 4 — A's next write continues from the CONVERGED (disk)
        // counter: 5+1=6, accepted; disk must show exactly 6.
        await turn(A, 7);
        const converged = await waitFor(sessionsDir, (v) => v.requests >= 6, "A's post-convergence write accepted");
        assert.equal(converged.requests, 6, "converged resident must continue the DISK counter, not its stale one");

        // End-state: the session still serves through BOTH instances. B is now
        // itself behind (its resident counter is 5, disk is 6 after A's accepted
        // write), so B's turn lands on the documented TIE: equal request
        // counters + equal nextBlockId → staleDiskPayload returns null → the
        // write passes through (last-writer-wins on ties, persist.ts:76-87).
        // Either way the file must stay valid and the counter non-decreasing —
        // the reader loop below is the real teeth for that.
        await turn(B, 8);
        const final2 = await waitFor(sessionsDir, (v) => v.requests >= 6, "B serves after A's convergence");
        assert.equal(final2.requests, 6, "disk counter reflects the last accepted lineage (B tie-passthrough at 6)");

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
