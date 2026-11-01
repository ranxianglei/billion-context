// #5460(P2): `bili bench <scenario>` — hermetic perf harness, RECORD-ONLY.
// Boots the real proxy (this very entry point) as a child process against an
// in-process deterministic fake upstream inside throwaway XDG dirs, replays a
// seeded fixture as sequential full-resend rounds (the dsh plugin lane's
// traffic shape), then reads the child's perf.sqlite (#5460 P1) and emits a
// JSON artifact with p50/p95/HWM stats. It NEVER judges metrics: slow numbers
// exit 0; only harness failures (server never ready, every round failed,
// telemetry did not arm) fail the run. Baseline tolerance judging is P3.

import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { generateFixture, renderAnthropicBody, renderOpenaiBody, type FixtureShape } from "./perf-fixture.js";
import { BUILD_COMMIT, VERSION } from "./version.js";
import { openSqliteDatabase } from "./storage/driver.js";

export interface BenchScenario {
    id: string;
    desc: string;
    shape: FixtureShape;
    msgs: number;
    seed: number;
    /** Declared model context window (tokens) forcing compression density;
     *  undefined = the store's fallback window applies. */
    window?: number;
    /** core = cheap enough for frequent runs; nightly = heavy (S-large). */
    tier: "core" | "nightly";
}

export const BENCH_SCENARIOS: readonly BenchScenario[] = [
    { id: "smoke-openai-tiny", desc: "harness smoke: 8 openai rounds, no compression pressure", shape: "openai", msgs: 8, seed: 0x546000, tier: "core" },
    { id: "proxy-append-openai-s-small", desc: "pure-proxy append, 50 rounds (~200 KB final history)", shape: "openai", msgs: 50, seed: 0x546001, tier: "core" },
    { id: "proxy-append-openai-s-med", desc: "pure-proxy append, 2000 rounds (~7 MB final history; late rounds cross the fallback window)", shape: "openai", msgs: 2000, seed: 0x546002, tier: "core" },
    { id: "proxy-append-anthropic-s-med", desc: "pure-proxy append on the anthropic wire, 2000 rounds", shape: "anthropic", msgs: 2000, seed: 0x546003, tier: "core" },
    { id: "proxy-compress-openai-s-med", desc: "16K declared window: preflight/nudge compression fires mid-run every turn", shape: "openai", msgs: 2000, seed: 0x546004, window: 16_000, tier: "core" },
    { id: "proxy-append-openai-s-large", desc: "#5403 shape: 20k rounds, ~80 MiB final history — nightly only", shape: "openai", msgs: 20_000, seed: 0x546005, tier: "nightly" },
];

const BENCH_MODEL = "bench-model";
const HEALTH_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const ROUND_ERROR_CAP = 5;

export interface BenchStat { min: number; p50: number; p95: number; max: number; mean: number }

/** Nearest-rank percentile on a sorted copy: idx = ceil(q*n)-1. Pure so the
 *  report math is unit-testable without booting anything. */
export function computeStats(values: number[]): BenchStat | null {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const pick = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
    const mean = s.reduce((acc, v) => acc + v, 0) / s.length;
    return { min: s[0], p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1], mean };
}

interface PerfRow { id: number; kind: string; session_id: string | null; inbound_bytes: number | null; outbound_bytes: number | null; total_ms: number | null; payload_json: string | null }

/** Rows inserted after `minId` — each run slices its own window so run N's
 *  report never absorbs run N-1's rows. Engine acquisition goes through the
 *  shared storage driver seam (#5460 C1), so the bench degrades like the
 *  store itself instead of hard-requiring the Node builtin. */
function readPerfRows(dbFile: string, minId: number): PerfRow[] {
    const { db } = openSqliteDatabase(dbFile);
    try {
        return db.prepare("SELECT id, kind, session_id, inbound_bytes, outbound_bytes, total_ms, payload AS payload_json FROM perf_events WHERE id > ? ORDER BY id").all(minId) as unknown as PerfRow[];
    } finally {
        db.close();
    }
}

function maxPerfId(dbFile: string): number {
    // The child creates perf.sqlite lazily at first insert — absent here is normal.
    if (!fs.existsSync(dbFile)) return 0;
    const { db } = openSqliteDatabase(dbFile);
    try {
        const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM perf_events").get() as { m: number };
        return row.m;
    } finally {
        db.close();
    }
}

export interface BenchRunReport {
    run: number;
    rounds_run: number;
    rounds_failed: number;
    round_errors: string[];
    client_wall_ms_total: number;
    metrics: {
        req_rows: number;
        mem_samples: number;
        total_ms: BenchStat | null;
        inbound_bytes: { total: number; max_per_req: number } | null;
        outbound_bytes: { total: number; max_per_req: number } | null;
        mem_hwm: { rss_bytes: number; heap_used_bytes: number } | null;
    };
}

export interface BenchArtifact {
    schema_version: 1;
    generated_at: string;
    bili_version: string;
    commit: string;
    scenario: { id: string; desc: string; shape: FixtureShape; msgs: number; seed: number; window: number | null; tier: string };
    fixture: { bytes: number };
    env: { os: string; arch: string; node: string; storage_mode: string };
    runs: BenchRunReport[];
}

function buildRunReport(run: number, rows: PerfRow[], roundsRun: number, roundErrors: string[], wallMsTotal: number): BenchRunReport {
    const reqs = rows.filter((r) => r.kind === "req");
    const mems = rows.filter((r) => r.kind === "mem");
    const totals = reqs.map((r) => r.total_ms).filter((v): v is number => typeof v === "number");
    const inb = reqs.map((r) => r.inbound_bytes).filter((v): v is number => typeof v === "number");
    const outb = reqs.map((r) => r.outbound_bytes).filter((v): v is number => typeof v === "number");
    let hwmRss = 0;
    let hwmHeap = 0;
    for (const m of mems) {
        try {
            const p = JSON.parse(m.payload_json ?? "{}") as Record<string, unknown>;
            if (typeof p.rss === "number") hwmRss = Math.max(hwmRss, p.rss);
            if (typeof p.heapUsed === "number") hwmHeap = Math.max(hwmHeap, p.heapUsed);
        } catch { /* keep scanning: one bad sample must not void the HWM */ }
    }
    return {
        run,
        rounds_run: roundsRun,
        rounds_failed: roundErrors.length,
        round_errors: roundErrors.slice(0, ROUND_ERROR_CAP),
        client_wall_ms_total: Math.round(wallMsTotal),
        metrics: {
            req_rows: reqs.length,
            mem_samples: mems.length,
            total_ms: computeStats(totals),
            inbound_bytes: inb.length > 0 ? { total: inb.reduce((a, b) => a + b, 0), max_per_req: Math.max(...inb) } : null,
            outbound_bytes: outb.length > 0 ? { total: outb.reduce((a, b) => a + b, 0), max_per_req: Math.max(...outb) } : null,
            mem_hwm: mems.length > 0 ? { rss_bytes: hwmRss, heap_used_bytes: hwmHeap } : null,
        },
    };
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address() as net.AddressInfo;
            srv.close(() => resolve(port));
        });
    });
}

async function waitPortDead(port: number): Promise<void> {
    await new Promise<void>((resolve) => {
        const sock = net.connect({ port, host: "127.0.0.1" });
        sock.once("connect", () => { sock.destroy(); resolve(); });
        sock.once("error", () => resolve());
    });
}

/** Deterministic fake upstream speaking both wires the scenarios use.
 *  Recognizes bili's own summarization requests by their task text and
 *  answers them sentinel-preserving, exactly like tests/e2e/fake-upstream.mjs
 *  does for the codex lane, so compression stays deterministic. */
function startFakeUpstream(port: number): Promise<{ close: () => Promise<void>; requests: () => number }> {
    let n = 0;
    const estIn = (s: string) => Math.max(1, Math.round(s.length / 4));
    const estOut = (s: string) => Math.max(1, Math.round(s.length / 4));
    const SUMMARY_RE = /must be compressed because the session context exceeds|Write a \*?\*?(tier-1|\d+-tier) compression summary/;
    const summaryFor = (raw: string): string | null => {
        if (!SUMMARY_RE.test(raw)) return null;
        const sentinels = [...new Set([...raw.matchAll(/sentinel value:\s*(\d+)/g)].map((m) => m[1]))];
        const docs = [...new Set(raw.match(/doc#\d+/g) || [])];
        let text = `[Compressed conversation section] — folded ${docs.length || "?"} archive fragment(s). Preserved sentinel values: ${sentinels.length ? sentinels.join(", ") : "(none)"}. Verbatim filler lines omitted to save tokens.`;
        while (text.length < 50) text += " (context preserved)";
        return text;
    };
    const chatSse = (res: http.ServerResponse, model: string, text: string, raw: string): void => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const base = { id: `chatcmpl_${++n}`, object: "chat.completion.chunk", model, created: 0 };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: estIn(raw), completion_tokens: estOut(text), total_tokens: estIn(raw) + estOut(text) } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
    };
    const anthropicSse = (res: http.ServerResponse, model: string, text: string, raw: string): void => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const ev = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        ev("message_start", { type: "message_start", message: { id: `msg_${++n}`, type: "message", role: "assistant", model, usage: { input_tokens: estIn(raw), output_tokens: 1 } } });
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
        ev("content_block_stop", { type: "content_block_stop", index: 0 });
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: estOut(text) } });
        ev("message_stop", { type: "message_stop" });
        res.end();
    };
    const server = http.createServer((req, res) => {
        try {
            if (req.method === "GET" && /\/models$/.test(req.url ?? "")) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ object: "list", data: [{ id: BENCH_MODEL, object: "model" }] }));
                return;
            }
            if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
            let raw = "";
            req.on("data", (c) => (raw += c));
            req.on("end", () => {
                n++;
                const summary = summaryFor(raw);
                const text = summary ?? `ack${n % 1000}`;
                if (/\/chat\/completions$/.test(req.url ?? "")) chatSse(res, BENCH_MODEL, text, raw);
                else if (/\/(v1\/)?messages$/.test(req.url ?? "")) anthropicSse(res, BENCH_MODEL, text, raw);
                else { res.writeHead(404); res.end(); }
            });
        } catch {
            try { res.writeHead(500); res.end(); } catch { /* socket already gone */ }
        }
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve({ close: () => new Promise((r) => server.close(() => r())), requests: () => n }));
    });
}

interface HermeticEnv { env: NodeJS.ProcessEnv; configHome: string; dataHome: string }

function hermetic(workdir: string): HermeticEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        // Every bili side-channel leaves: the child must see a vanilla host,
        // or the measurement inherits this process's posture.
        if (/^BILI_/.test(k) || /^ACP_/.test(k)) continue;
        if (k === "BILLION_CONTEXT_PROXY" || k === "NODE_OPTIONS" || k === "NODE_TEST_CONTEXT") continue;
        env[k] = v;
    }
    const home = path.join(workdir, "home");
    const configHome = path.join(workdir, "xdg", "config");
    const cacheHome = path.join(workdir, "xdg", "cache");
    const stateHome = path.join(workdir, "xdg", "state");
    const dataHome = path.join(workdir, "xdg", "data");
    const tmpHome = path.join(workdir, "tmp");
    env.HOME = home;
    env.XDG_CONFIG_HOME = configHome;
    env.XDG_CACHE_HOME = cacheHome;
    env.XDG_STATE_HOME = stateHome;
    env.XDG_DATA_HOME = dataHome;
    env.TMPDIR = tmpHome;
    env.ACP_AUTO_UPDATE = "0";
    // Telemetry arms only in DB-backed modes (#5460 constraint 1); pin the
    // current default explicitly so the baseline never silently shifts if the
    // default ever changes.
    env.BILI_STORAGE_UNIFIED = "full";
    for (const dir of [home, configHome, cacheHome, stateHome, dataHome, tmpHome, path.join(workdir, "log")]) fs.mkdirSync(dir, { recursive: true });
    return { env, configHome, dataHome };
}

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const resp = await fetch(url, { signal: AbortSignal.timeout(2000) });
            if (resp.ok) return;
        } catch { /* not up yet */ }
        if (Date.now() > deadline) throw new Error(`proxy never became healthy at ${url}`);
        await new Promise((r) => setTimeout(r, 250));
    }
}

function stopChild(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
        if (child.exitCode !== null || child.killed) return resolve();
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        child.once("exit", finish);
        child.kill("SIGTERM");
        setTimeout(() => { if (!done) { try { child.kill("SIGKILL"); } catch { /* already gone */ } finish(); } }, STOP_TIMEOUT_MS).unref?.();
    });
}

function resolveDist(explicit?: string): string {
    const candidate = explicit ?? process.env.E2E_BILI_DIST ?? process.argv[1];
    if (!candidate) throw new Error("cannot locate the bili entry point — pass --dist or set E2E_BILI_DIST when running from source");
    const abs = path.resolve(candidate);
    if (!fs.existsSync(abs)) throw new Error(`bili entry point missing: ${abs} (run npm run build first)`);
    return abs;
}

export interface BenchOptions {
    scenarioId: string;
    rounds?: number;
    dist?: string;
    workdirRoot?: string;
    keepWorkdir?: boolean;
    log?: (msg: string) => void;
}

export async function runBench(opts: BenchOptions): Promise<{ artifact: BenchArtifact; workdir: string }> {
    const scenario = BENCH_SCENARIOS.find((s) => s.id === opts.scenarioId);
    if (!scenario) throw new Error(`unknown bench scenario "${opts.scenarioId}" — valid: ${BENCH_SCENARIOS.map((s) => s.id).join(", ")}`);
    const rounds = opts.rounds ?? 1;
    if (!Number.isInteger(rounds) || rounds < 1) throw new Error(`bench rounds must be a positive integer, got ${rounds}`);
    const log = opts.log ?? (() => { /* silent */ });
    const dist = resolveDist(opts.dist);
    const fixture = generateFixture({ seed: scenario.seed, msgs: scenario.msgs, shape: scenario.shape });
    const workdir = path.join(opts.workdirRoot ?? os.tmpdir(), `bili-bench-${scenario.id}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(workdir, { recursive: true });
    const he = hermetic(workdir);
    const fakePort = await freePort();
    const proxyPort = await freePort();
    await waitPortDead(proxyPort);
    const fake = await startFakeUpstream(fakePort);
    if (scenario.window !== undefined) {
        const cfgDir = path.join(he.configHome, "billion-context");
        fs.mkdirSync(cfgDir, { recursive: true });
        fs.writeFileSync(path.join(cfgDir, "billion-context.json"), JSON.stringify({ providers: { [`http://127.0.0.1:${fakePort}`]: { models: { [BENCH_MODEL]: { context: scenario.window } } } } }, null, 1));
    }
    const outLog = fs.openSync(path.join(workdir, "log", "proxy.out.log"), "w");
    const errLog = fs.openSync(path.join(workdir, "log", "proxy.err.log"), "w");
    const child = spawn(process.execPath, [dist, "start", "--port", String(proxyPort), "--no-auto-update"], {
        cwd: workdir,
        env: he.env,
        stdio: ["ignore", outLog, errLog],
    });
    const perfDb = perfDbPath(he.dataHome);
    let lastRowId = maxPerfId(perfDb);
    let harnessError: Error | null = null;
    const runs: BenchRunReport[] = [];
    try {
        await waitForHealth(`http://127.0.0.1:${proxyPort}/__bili/health`, HEALTH_TIMEOUT_MS);
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${fakePort}/v1/${scenario.shape === "openai" ? "chat/completions" : "messages"}`;
        for (let run = 1; run <= rounds; run++) {
            const sessionId = `bench-${scenario.id}-r${run}`;
            const errors: string[] = [];
            let wallMs = 0;
            for (let k = 1; k <= fixture.count; k++) {
                const body = JSON.stringify(scenario.shape === "openai"
                    ? renderOpenaiBody(BENCH_MODEL, fixture.messages.slice(0, k))
                    : renderAnthropicBody(BENCH_MODEL, fixture.messages.slice(0, k)));
                const t0 = performance.now();
                try {
                    const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-session-id": sessionId }, body });
                    const text = await resp.text();
                    if (!resp.ok) errors.push(`round ${k}: HTTP ${resp.status} ${text.slice(0, 160)}`);
                } catch (e) {
                    errors.push(`round ${k}: ${String(e)}`);
                }
                wallMs += performance.now() - t0;
            }
            log(`run ${run}/${rounds}: ${fixture.count} rounds, ${errors.length} failed`);
            const rows = readPerfRows(perfDb, lastRowId);
            lastRowId = rows.reduce((m, r) => Math.max(m, r.id), lastRowId);
            if (errors.length === fixture.count) harnessError = new Error(`every round failed in run ${run}; first: ${errors[0]}`);
            else runs.push(buildRunReport(run, rows, fixture.count, errors, wallMs));
            if (harnessError) break;
        }
    } catch (e) {
        harnessError = e instanceof Error ? e : new Error(String(e));
    } finally {
        // Snapshot death state BEFORE our own SIGTERM: a 143 at teardown is
        // normal, a non-null exitCode before teardown is a real mid-run crash.
        const preDeath = child.exitCode;
        await stopChild(child);
        await fake.close();
        fs.closeSync(outLog);
        fs.closeSync(errLog);
        if (preDeath !== null && !harnessError) {
            const tail = safeReadTail(path.join(workdir, "log", "proxy.err.log"));
            harnessError = new Error(`proxy exited ${preDeath} during the run${tail ? `:\n${tail}` : ""}`);
        }
    }
    if (harnessError) {
        if (!opts.keepWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
        throw harnessError;
    }
    if (!fs.existsSync(perfDb)) harnessError = new Error(`telemetry did not arm: ${perfDb} missing (storage mode?)`);
    if (harnessError) {
        if (!opts.keepWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
        throw harnessError;
    }
    const artifact: BenchArtifact = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        bili_version: VERSION,
        commit: BUILD_COMMIT,
        scenario: { id: scenario.id, desc: scenario.desc, shape: scenario.shape, msgs: scenario.msgs, seed: scenario.seed, window: scenario.window ?? null, tier: scenario.tier },
        fixture: { bytes: fixture.bytes },
        env: { os: os.platform(), arch: os.arch(), node: process.version, storage_mode: "full" },
        runs,
    };
    if (!opts.keepWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
    return { artifact, workdir };
}

function perfDbPath(dataHome: string): string {
    return path.join(dataHome, "billion-context", "sessions", "perf.sqlite");
}

function safeReadTail(file: string): string {
    try {
        const buf = fs.readFileSync(file);
        return buf.subarray(Math.max(0, buf.length - 2000)).toString("utf8");
    } catch {
        return "";
    }
}
