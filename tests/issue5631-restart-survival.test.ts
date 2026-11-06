// #5631 — restart survival: folded context and prefix-cache recovery across
// repeated proxy kills (SIGTERM / SIGKILL / clean admin shutdown).
//
// What this proves, end to end, with zero real model tokens:
//   An agent-shaped client that ALWAYS resends its complete RAW history under
//   one fixed session id (exactly what dsh headless and pi do after a crash
//   and relaunch) keeps getting a FOLDED-AND-STABLE payload forwarded to the
//   upstream through any number of proxy restarts:
//     * every outbound body stays far below the raw fiber size (fold state
//       survived the reload — the disk store carried it);
//     * the byte-level longest-common-prefix ratio between consecutive
//       upstream bodies stays >= 50% (parity with release-gate Lane A): the
//       wire prefix did not reshuffle across the process boundary, so a real
//       prefix-caching upstream (SGLang etc.) keeps hitting;
//     * the folded state is provably on disk ("deterministic digest" block),
//       i.e. the hard-kill (-9) cycles did not leave the store behind.
//   Bidirectional control arm (Gate Test Discipline #3617): a second proxy
//   instance runs with a wall so high that folding never triggers — there the
//   upstream must keep receiving the FULL multi-MB fiber on every turn. That
//   is the "blow up" state the main arm exists to prevent, and it keeps this
//   suite from being vacuously green.
//
// How the fold is forced hermetically: `compress.modelContextLimit` is a hard
// preflight wall — a payload overshooting it by more than the LLM fold path's
// coverage bound switches every fold to the DETERMINISTIC DIGEST regime
// (#2383, EMERGENCY_FOLD_COVERAGE in src/preflight.ts = 19.2x): zero upstream
// summarization calls, no external summary chain needed, originals restorable
// via decompress. The fiber below overshoots by ~150x, deep inside that
// regime, so the whole matrix runs against a dumb recording upstream.
//
// The client here is deliberately the WORST case — pure proxy mode (no
// x-bili-plugin stamps), no cooperation with the nudge protocol, full raw
// resend every turn. Plugin-mode hosts (dsh/pi with the native plugin) keep
// strictly LESS mass in flight across a restart because they also carry
// their own compression receipts; if the dumb client survives, the
// cooperating hosts ride the same stable prefix. Real-host fidelity (the
// host's own history persistence plus true token billing across kill cycles)
// is covered by the restart lane added to the docker-based bili-gate gate —
// see issue #5631 part ②.
//
// Registered in scripts/live-files.mjs (append-only tail) because this suite
// spawns real proxy children with OS signals. Ports are probed free first and
// re-probed on every restart (no band reuse); homes are private mkdtemp dirs,
// so the file coexists safely under --test-concurrency 4.
//
// No new configuration surface: only shipped keys `compress.modelContextLimit`
// and `update.checkIntervalMs` are written into throwaway config files.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { rmrf } from "./tmp-rm.ts";

const root = path.resolve(import.meta.dirname, "..");

// ---- tunables --------------------------------------------------------------------

function clampEnv(name: string, def: number, lo: number, hi: number): number {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw >= lo ? Math.min(raw, hi) : def;
}

/** Raw fiber size in bytes (~FIBER_BYTES/4 tokens). Default 6 MiB ≈ 1.5M
 *  tokens — far past the 19.2x emergency-fold coverage bound against the 16k
 *  wall, small enough to keep CI wall-clock honest. */
const FIBER_BYTES = clampEnv("RESTART_SURVIVAL_FIBER_BYTES", 6 * 1024 * 1024, 1 << 20, 32 << 20);
const WALL_TOKENS = 16_384;                 // main arm: small wall => proactive fold
const NOFOLD_WALL_TOKENS = 10_000_000;      // control arm: above the fiber itself => never folds
const POST_FOLD_CAP = 512 * 1024;           // max bytes the upstream may ever receive (main arm)
const MIN_FORWARD_BODY = 512;               // sanity floor: the payload is folded, not dropped
const CACHE_RATIO = 0.5;                    // parity with release-gate Lane A (cache >= 50%)
const KILL_ORDER = ["sigterm", "sigkill", "clean", "sigkill", "sigterm"] as const;
type KillVariant = (typeof KILL_ORDER)[number];
const STEADY_TURNS_PER_CYCLE = 2;           // on-generation turns before each kill
const RESUMES_PER_KILL = 2;                 // post-restart turns per kill
const SETTLE_BEFORE_KILL_MS = 500;          // store flush debounce is ms-scale; give it its window
const debugDir = (): string => process.env.RESTART_SURVIVAL_DUMP ?? "";

const SUITE_TIMEOUT_MS = clampEnv("RESTART_SURVIVAL_TMO", 480_000, 60_000, 3_600_000);
const TURN_TIMEOUT_MS = 90_000;
const SESSION_HEADER = "x-acp-session";
/** No pooled keep-alive sockets toward the proxy children: the clean-shutdown
 *  drain must be able to outlive the last real request. */
const NOKEEP = { connection: "close" as const };

type Role = "user" | "assistant";
interface WireMsg { role: Role; content: string; }
interface LaneShape { name: "dsh" | "pi"; model: string; endpoint: string; }

const LANES: LaneShape[] = [
    { name: "dsh", model: "gpt-test", endpoint: "/chat/completions" },     // openai chat shape
    // Neutral model id: the #388 side-request passthrough arms on client
    // EVIDENCE only (agent headers, output budget <= 200, host-sidecar shapes
    // — src/server/side-request.ts), never on model family, so any id stays
    // on the main compression path here; a neutral id keeps the suite off the
    // claude registry/window-table entries.
    { name: "pi", model: "test-anthropic-model", endpoint: "/v1/messages" },  // anthropic shape
];

// ---- fiber -------------------------------------------------------------------------

/** Deterministic ~N-byte history: user section texts (with code words) and
 *  short assistant acks, ASCII-only so char === byte everywhere downstream
 *  (JSON stringify math, LCP loops, token estimates all line up). Splitting
 *  the mass over many messages also keeps the recent-protection zone from
 *  pinning the whole fiber (it covers only the trailing few thousand tokens). */
function buildHistory(targetBytes: number): WireMsg[] {
    const msgs: WireMsg[] = [];
    let used = 0;
    let k = 0;
    while (used < targetBytes) {
        const size = k % 7 === 6 ? Math.max(4096, targetBytes - used - 256) : 96 * 1024;
        const text = sectionText(k, size);
        msgs.push({ role: "user", content: text });
        msgs.push({ role: "assistant", content: `noted section ${k}` });
        used += text.length + 48;
        k += 1;
    }
    return msgs;
}

function sectionText(k: number, bytes: number): string {
    let s = `[SECTION ${k}] code-word RS5631-${k % 7} `.padEnd(64, " ");
    let n = k;
    while (s.length < bytes) {
        n += 1;
        s += `fiber-token-${n % 899} `;
    }
    return s.slice(0, bytes);
}

function rawTextBytes(history: WireMsg[]): number {
    let n = 0;
    for (const m of history) n += m.content.length;
    return n;
}

// ---- recording upstream --------------------------------------------------------------

interface UpstreamHit {
    url: string;
    /** Raw wire bytes received — the "does the model drown" number. */
    bytes: number;
    /** Canonical serialization of ONLY the prompt (system + messages) —
     *  exactly what a real upstream's prefix cache keys on. Envelope fields
     *  (max_tokens, stream, idiosyncratic rewrites) vary per turn and must
     *  not poison the stability signal. */
    prompt: string;
    lcpPromptBytes: number;
    ack: string;
}

class UpstreamRecorder {
    private server: http.Server | null = null;
    private port = 0;
    private readonly lastPrompt = new Map<string, string>();
    readonly hits: UpstreamHit[] = [];

    /** Canonical prompt extraction: drop envelope noise, keep what the model
     *  actually reads. OpenAI-shape: messages[]. Anthropic-shape: top-level
     *  system (string|array-of-blocks) + messages[]. */
    static canonicalPrompt(body: string): string {
        try {
            const j = JSON.parse(body) as Record<string, unknown>;
            const msgs = Array.isArray(j.messages) ? j.messages : [];
            const sys = j.system !== undefined ? j.system : null;
            return JSON.stringify([sys === null ? "" : sys, msgs]);
        } catch {
            return body;
        }
    }

    get recPort(): number {
        return this.port;
    }

    async start(): Promise<void> {
        await new Promise<void>((resolveP, rejectP) => {
            const srv = http.createServer((req, res) => { void this.handle(req, res); });
            srv.on("error", rejectP);
            srv.listen(0, "127.0.0.1", () => {
                this.server = srv;
                this.port = (srv.address() as net.AddressInfo).port;
                resolveP();
            });
        });
    }

    async stop(): Promise<void> {
        const srv = this.server;
        this.server = null;
        if (!srv) return;
        srv.closeAllConnections?.();
        await new Promise<void>((resolveP) => srv.close(() => resolveP()));
    }

    static lcp(a: string, b: string): number {
        const n = Math.min(a.length, b.length);
        let i = 0;
        while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
        return i;
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const key = req.url ?? "/";
        const chunks: Buffer[] = [];
        let bytes = 0;
        req.on("data", (c: Buffer) => {
            bytes += c.length;
            if (bytes <= 48 * 1024 * 1024) chunks.push(c);
        });
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const prompt = UpstreamRecorder.canonicalPrompt(body);
            const prev = this.lastPrompt.get(key);
            const lcpPromptBytes = prev !== undefined ? UpstreamRecorder.lcp(prompt, prev) : 0;
            this.lastPrompt.set(key, prompt);
            const dump = debugDir();
            if (dump) {
                try {
                    fs.mkdirSync(dump, { recursive: true });
                    fs.writeFileSync(`${dump}/up_${String(this.hits.length).padStart(3, "0")}_${key.replace(/[^a-z0-9]+/gi, "_")}.json`, body);
                } catch { /* best effort */ }
            }
            const seq = this.hits.length;
            const ack = `ack-${seq}`;
            this.hits.push({ url: key, bytes, prompt, lcpPromptBytes, ack });
            const modelMatch = body.match(/"model"\s*:\s*"([^"]+)"/);
            const model = modelMatch?.[1] ?? "unknown";
            const promptTokens = Math.ceil(bytes / 4);
            const cachedTokens = Math.floor(lcpPromptBytes / 4);
            const json = key.includes("/messages")
                ? JSON.stringify({
                    id: `msg_${seq}`,
                    type: "message",
                    role: "assistant",
                    model,
                    content: [{ type: "text", text: ack }],
                    stop_reason: "end_turn",
                    stop_sequence: null,
                    usage: { input_tokens: promptTokens, output_tokens: 4, cache_read_input_tokens: cachedTokens },
                })
                : JSON.stringify({
                    id: `chatcmpl_${seq}`,
                    object: "chat.completion",
                    created: 1,
                    model,
                    choices: [{ index: 0, message: { role: "assistant", content: ack }, finish_reason: "stop" }],
                    usage: {
                        prompt_tokens: promptTokens,
                        completion_tokens: 4,
                        total_tokens: promptTokens + 4,
                        prompt_tokens_details: { cached_tokens: cachedTokens },
                    },
                });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(json);
        });
        req.on("error", () => { /* client went away; nothing to record */ });
    }
}

// ---- proxy child lifecycle -------------------------------------------------------------

let rootDistEnsured = false;

/** House pattern (tests/index-entry-guard.test.ts): CI runs tests before the
 *  package `npm run build`, so exercise the BUILT entry and build on demand
 *  when dist/ is absent or stale relative to src/. kernel/pi-subagents dists
 *  come from ci-pretest-cache (CI runs it via `npm run pretest`). */
function ensureRootDist(): void {
    if (rootDistEnsured) return;
    rootDistEnsured = true;
    const kernelDist = path.join(root, "node_modules", "acp-kernel", "dist", "index.js");
    if (!fs.existsSync(kernelDist)) {
        execFileSync(process.execPath, ["scripts/ci-pretest-cache.mjs"], { cwd: root, stdio: "inherit", timeout: 600_000 });
    }
    const entry = path.join(root, "dist", "index.js");
    if (!fs.existsSync(entry) || distStale(entry)) {
        execFileSync(process.execPath, [path.join(root, "node_modules", "tsup", "dist", "cli-default.js")], { cwd: root, stdio: "inherit", timeout: 300_000 });
    }
    assert.ok(fs.existsSync(entry), "build did not produce dist/index.js");
}

function distStale(entry: string): boolean {
    let newest = 0;
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(ts|tsx)$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
        }
    };
    walk(path.join(root, "src"));
    return fs.statSync(entry).mtimeMs < newest;
}

function probeFreePort(): Promise<number> {
    return new Promise((resolveP, rejectP) => {
        const probe = net.createServer();
        probe.on("error", rejectP);
        probe.listen(0, "127.0.0.1", () => {
            const p = (probe.address() as net.AddressInfo).port;
            probe.close(() => resolveP(p));
        });
    });
}

interface ProxyHandle { proc: ChildProcess; origin: string; logPath: string; }

async function startProxy(home: string, cfg: Record<string, unknown>, tag: string): Promise<ProxyHandle> {
    const port = await probeFreePort();
    const cfgDir = path.join(home, "config-gen");
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, `${tag}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const logPath = path.join(home, "logs", `${tag}-${port}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const proc = spawn(process.execPath, [path.join(root, "dist", "index.js"), "start", "--port", String(port)], {
        cwd: root,
        env: {
            ...process.env,
            XDG_STATE_HOME: home,
            XDG_CACHE_HOME: home,
            XDG_DATA_HOME: home,
            XDG_CONFIG_HOME: home,
            BILI_CONFIG_FILE: cfgPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (d: Buffer) => logStream.write(d));
    proc.stderr?.on("data", (d: Buffer) => logStream.write(d));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
        if (proc.exitCode !== null || proc.signalCode !== null) {
            proc.kill("SIGKILL");
            logStream.end();
            throw new Error(`proxy exited before becoming healthy (${tag}, code=${proc.exitCode}, signal=${proc.signalCode}); log: ${logPath}`);
        }
        try {
            const h = await fetch(`${origin}/__bili/health`, { headers: NOKEEP });
            if (h.ok) {
                const j = (await h.json()) as { ok?: boolean };
                if (j.ok) return { proc, origin, logPath };
            }
        } catch { /* not listening yet */ }
        if (Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 150));
    }
    proc.kill("SIGKILL");
    logStream.end();
    throw new Error(`proxy never became healthy (${tag}); log: ${logPath}`);
}

async function awaitExit(proc: ChildProcess, graceMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const deadline = Date.now() + graceMs;
    for (;;) {
        if (proc.exitCode !== null || proc.signalCode !== null) {
            return { code: proc.exitCode, signal: proc.signalCode ?? null };
        }
        if (Date.now() > deadline) return { code: null, signal: null };
        await new Promise((r) => setTimeout(r, 50));
    }
}

async function stopProxy(h: ProxyHandle, variant: KillVariant): Promise<void> {
    if (variant === "clean") {
        // Admin rotation endpoint (src/server.ts #3544): graceful drain+exit.
        try { await fetch(`${h.origin}/__bili/shutdown`, { method: "POST", headers: NOKEEP }); } catch { /* may exit mid-response */ }
        const refusedDeadline = Date.now() + 15_000;
        let refused = false;
        while (Date.now() < refusedDeadline) {
            try { await fetch(`${h.origin}/__bili/health`, { headers: NOKEEP }); } catch { refused = true; break; }
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(refused, "clean shutdown: port still serving after 15s");
        const ex = await awaitExit(h.proc, 10_000);
        assert.ok(ex.code !== null || ex.signal !== null, "clean shutdown: process still alive 10s after drain");
        return;
    }
    h.proc.kill(variant === "sigterm" ? "SIGTERM" : "SIGKILL");
    const ex = await awaitExit(h.proc, variant === "sigterm" ? 20_000 : 5_000);
    assert.ok(ex.code !== null || ex.signal !== null, `${variant}: process did not exit within grace`);
}

// ---- turn driver ------------------------------------------------------------------------

interface ArmContext {
    lane: LaneShape;
    recorder: UpstreamRecorder;
    sessionId: string;
    /** The CLIENT's own raw view of the conversation — always resent whole. */
    history: WireMsg[];
}

async function sendTurn(ctx: ArmContext, proxy: ProxyHandle, note: string): Promise<UpstreamHit> {
    const upstreamBase = `http://127.0.0.1:${ctx.recorder.recPort}`;
    const url = `${proxy.origin}/bili/${upstreamBase}${ctx.lane.endpoint}`;
    const messages = ctx.history.map((m) => ({ role: m.role, content: m.content }));
    const body = ctx.lane.name === "pi"
        ? JSON.stringify({
            model: ctx.lane.model, stream: false, max_tokens: 8192,
            system: "Compact-aware assistant.",
            messages,
        })
        : JSON.stringify({ model: ctx.lane.model, stream: false, max_tokens: 8192, messages });
    const before = ctx.recorder.hits.length;
    let res: Response;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { ...NOKEEP, "content-type": "application/json", [SESSION_HEADER]: ctx.sessionId },
            body,
            signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
        });
    } catch (err) {
        throw new Error(`${note}: request failed: ${String(err)} (proxy log: ${proxy.logPath})`);
    }
    const text = await res.text().catch(() => "");
    assert.equal(res.status, 200, `${note}: status ${res.status}: ${text.slice(0, 300)} (proxy log: ${proxy.logPath})`);
    const hit = ctx.recorder.hits[before];
    assert.ok(hit, `${note}: upstream never saw the request despite HTTP ${res.status}`);
    // No byte-equality check here: the proxy legitimately RESERIALIZES the
    // payload (and, when the wall is hot, FOLDS it before forwarding).
    return hit;
}

/** Client-side bookkeeping: the exchange it observed becomes part of the RAW
 *  history it will resend next time. */
function pushExchange(ctx: ArmContext, userText: string, assistantAck: string): void {
    ctx.history.push({ role: "user", content: userText });
    ctx.history.push({ role: "assistant", content: assistantAck });
}

// ---- disk proof ------------------------------------------------------------------------------

/** Recursively confirm the folded state landed on disk (the deterministic
 *  digest marker renders into stored blocks). Deliberately loose about which
 *  container file holds it — the substring must survive somewhere under the
 *  home dir regardless of format changes. */
function homeContainsFoldProof(home: string): boolean {
    const stack = [home];
    let budget = 256 * 1024 * 1024;
    while (stack.length > 0 && budget > 0) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            if (!e.isFile()) continue;
            let st: fs.Stats;
            try { st = fs.statSync(p); } catch { continue; }
            if (st.size > budget) continue;
            budget -= st.size;
            try {
                if (fs.readFileSync(p, "utf8").includes("deterministic digest")) return true;
            } catch { /* unreadable/binary — skip */ }
        }
    }
    return false;
}

// ---- one lane: both arms -----------------------------------------------------------------------

async function runLane(lane: LaneShape, t: TestContext): Promise<void> {
    ensureRootDist();
    const mainHome = fs.mkdtempSync(path.join(os.tmpdir(), `rs5631-${lane.name}-main-`));
    const controlHome = fs.mkdtempSync(path.join(os.tmpdir(), `rs5631-${lane.name}-ctrl-`));
    const recorder = new UpstreamRecorder();
    await recorder.start();
    let live: ProxyHandle | null = null;
    t.after(async () => {
        if (live) { try { live.proc.kill("SIGKILL"); } catch { /* already dead */ } }
        await recorder.stop();
        await rmrf(mainHome);
        await rmrf(controlHome);
    });

    const fiber = buildHistory(FIBER_BYTES);

    // -- main arm: small wall; every outbound body must stay FOLDED ----------
    const ctx: ArmContext = {
        lane,
        recorder,
        sessionId: `rs5631-${lane.name}-main`,
        history: [...fiber],
    };
    live = await startProxy(mainHome, compressCfg(WALL_TOKENS), `${lane.name}-main-0`);
    const first = await sendTurn(ctx, live, "initial oversized load");
    assert.ok(first.bytes <= POST_FOLD_CAP,
        `fold never engaged: upstream received ${first.bytes} bytes on first contact (fiber ${rawTextBytes(fiber)}, cap ${POST_FOLD_CAP})`);
    assert.ok(first.bytes >= MIN_FORWARD_BODY, `payload appears dropped: only ${first.bytes} bytes forwarded`);
    pushExchange(ctx, "confirm you hold all sections", first.ack);

    let prev: UpstreamHit = first;
    for (let c = 0; c < KILL_ORDER.length; c++) {
        const variant = KILL_ORDER[c]!;
        for (let r = 0; r < STEADY_TURNS_PER_CYCLE; r++) {
            const hit = await sendTurn(ctx, live, `cycle${c}/${variant}/steady ${r}`);
            assert.ok(hit.bytes <= POST_FOLD_CAP,
                `cycle${c}/${variant} steady ${r}: OUTBOUND BLOW-UP mid-session — ${hit.bytes} bytes forwarded (cap ${POST_FOLD_CAP})`);
            const denom = Math.min(hit.prompt.length, prev.prompt.length);
            assert.ok(denom > 0 && hit.lcpPromptBytes / denom >= CACHE_RATIO,
                `cycle${c}/${variant} steady ${r}: prompt-prefix stability ${(100 * hit.lcpPromptBytes / Math.max(1,denom)).toFixed(1)}% < ${100 * CACHE_RATIO}% — wire prefix unstable before any restart`);
            pushExchange(ctx, `steady turn ${c}.${r}; list section code words you can still see`, hit.ack);
            prev = hit;
        }
        await new Promise((r) => setTimeout(r, SETTLE_BEFORE_KILL_MS));
        await stopProxy(live, variant);
        live = await startProxy(mainHome, compressCfg(WALL_TOKENS), `${lane.name}-main-${c + 1}`);

        for (let r = 0; r < RESUMES_PER_KILL; r++) {
            const hit = await sendTurn(ctx, live, `cycle${c}/${variant}/post-restart ${r}`);
            assert.ok(hit.bytes <= POST_FOLD_CAP,
                `after ${variant.toUpperCase()} RESTART: fold state did NOT survive — upstream received ${hit.bytes} bytes (cap ${POST_FOLD_CAP}); the reloaded proxy fell back to forwarding raw history`);
            const postDenom = Math.min(hit.prompt.length, prev.prompt.length);
            assert.ok(postDenom > 0 && hit.lcpPromptBytes / postDenom >= CACHE_RATIO,
                `after ${variant.toUpperCase()} restart ${r}: prompt-prefix stability vs pre-restart turn ${(100 * hit.lcpPromptBytes / Math.max(1,postDenom)).toFixed(1)}% < ${100 * CACHE_RATIO}% — the wire prefix reshuffled across the process boundary (upstream prefix cache would MISS)`);
            pushExchange(ctx, `post-${variant} turn ${r}`, hit.ack);
            prev = hit;
        }
    }
    assert.ok(homeContainsFoldProof(mainHome),
        "no 'deterministic digest' fold evidence anywhere under the main home dir — folded state never persisted");
    await stopProxy(live, "sigkill");
    live = null;

    // -- control arm: giant wall; NOTHING may fold ----------------------------
    // Same fiber, same resend pattern, wall above the whole payload: the
    // upstream must keep eating the full multi-MB body every turn. If that
    // were ever cheap again, this arm (not the main one) would go red — the
    // suite proves it discriminates.
    // Own recorder per arm: lastPrompt keys by URL only, so a shared recorder
    // would baseline the control arm's first LCP against the MAIN arm's last
    // prompt.
    const ctrlRecorder = new UpstreamRecorder();
    await ctrlRecorder.start();
    t.after(() => ctrlRecorder.stop());
    const cctx: ArmContext = {
        lane,
        recorder: ctrlRecorder,
        sessionId: `rs5631-${lane.name}-ctrl`,
        history: [...fiber],
    };
    live = await startProxy(controlHome, compressCfg(NOFOLD_WALL_TOKENS), `${lane.name}-ctrl-0`);
    for (let r = 0; r < 3; r++) {
        const hit = await sendTurn(cctx, live, `control ${r}`);
        const floor = rawTextBytes(cctx.history) * 0.9;
        assert.ok(hit.bytes >= floor,
            `control arm ${r}: expected the UNFOLDED fiber to pass through whole (>= ~${floor} bytes), upstream saw ${hit.bytes} — control indistinguishable from main arm (vacuous suite)`);
        pushExchange(cctx, `control turn ${r}`, hit.ack);
    }
    await stopProxy(live, "sigkill");
    live = null;
}

function compressCfg(wall: number): Record<string, unknown> {
    return {
        compress: { modelContextLimit: wall },
        update: { checkIntervalMs: 3_600_000 },
    };
}

// ---- entry --------------------------------------------------------------------------------------

test("restart survival: fold + prefix cache across repeated agent-host restarts (#5631)", { timeout: SUITE_TIMEOUT_MS }, async (t) => {
    await t.test("dsh lane (openai chat shape)", async () => { await runLane(LANES[0]!, t); });
    await t.test("pi lane (anthropic shape)", async () => { await runLane(LANES[1]!, t); });
});
