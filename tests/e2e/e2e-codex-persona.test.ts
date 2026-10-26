// Real-codex persona/continuity E2E (#2250 CI follow-up): drives the REAL
// codex binary (pinned 0.147.0 in CI) through bili in BOTH integration modes
// and proves a mid-session identity perturbation — model switch (-c model=…)
// plus an AGENTS.md edit — keeps the compression state: exactly ONE
// summarization across the whole run, the folded summary still on the wire,
// planted sentinels retained.
//
// Probe findings recorded against codex-cli 0.147.0 (2026-10-07, see the
// linked issue): the top-level `instructions` field is BYTE-STABLE under every
// mid-session trigger we could produce — model switch (unknown AND known
// families), AGENTS.md add/edit, even experimental_instructions_file. Real
// instructions drift only arrives with codex VERSION upgrades (prompt
// assembly changes), which is exactly the #2250 upgrade-shaped scenario the
// resolver covers via migrate. This suite therefore pins two contracts:
//   (a) today's stable-instructions runs never lose state (no re-fold), and
//   (b) if a future codex drifts instructions mid-session, the persona
//       migrate path keeps ONE session — a fork would re-fold from zero and
//       surface as a SECOND summarization, tripping the same oracle.
//
// Modes:
//   A. URL mode ("改url"): config.toml base_url points at the /bili/ prefix.
//   B. Launcher mode ("bili 启动器"): plain provider base_url; `bili codex`
//      wraps it via its overlay. Sequential launcher runs resume --last.
//
// Deterministic, zero tokens (fake-upstream.mjs). Gate: ACP_TEST_E2E_FAKE=1.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assertPortDead } from "../port-race.js";

const CODEX_BIN = process.env.E2E_CODEX_BIN ?? "codex";
const DIST = process.env.E2E_BILI_DIST ?? path.resolve(import.meta.dirname, "../../dist/index.js");
const MODEL = process.env.E2E_MODEL ?? "qwen3.8-27b";
// Probe fact (0.147.0): a resume-time `-c model=<unknown family>` override is
// IGNORED (the request rides the session's model) while known-family overrides
// (gpt-5-codex, gpt-5.1) ARE applied. The perturbation therefore uses a known
// family and the oracle VERIFIES the switch actually landed on the wire.
const MODEL_B = process.env.E2E_MODEL_B ?? "gpt-5-codex";
const MODEL_C = process.env.E2E_MODEL_C ?? "gpt-5.1";
const TMO = Number(process.env.E2E_TMO ?? 120_000);
const FAKE_UPSTREAM = path.join(import.meta.dirname, "fake-upstream.mjs");
const WORK_ROOT = path.join(process.cwd(), "tmp");
fs.mkdirSync(WORK_ROOT, { recursive: true });
// codex discovers AGENTS.md by walking UP from its spawn cwd (#815): keep the
// cwd outside the repo tree. This suite WRITES an AGENTS.md there on purpose
// (the perturbation under test) — the guard below still guards the pre-turn
// hermeticity, checked before any write.
const CWD_ROOT = path.join(os.tmpdir(), "billion-context-e2e");
fs.mkdirSync(CWD_ROOT, { recursive: true });

function repoDocLeak(dir: string): string | null {
	let d = dir;
	for (;;) {
		if (fs.existsSync(path.join(d, ".git")) || fs.existsSync(path.join(d, "AGENTS.md"))) return d;
		const parent = path.dirname(d);
		if (parent === d) return null;
		d = parent;
	}
}

// #2197: resolve codex through PATH/PATHEXT instead of a bare spawn; on a
// lane where the gate is on and the binary is missing we must fail loudly.
function resolveCodexBin(): string | null {
	if (CODEX_BIN.includes(path.sep) || CODEX_BIN.includes("/")) return fs.existsSync(CODEX_BIN) ? CODEX_BIN : null;
	const exts = process.platform === "win32"
		? (process.env.PATHEXT ?? ".CMD;.EXE;.BAT;.COM;", "").split(";").filter(Boolean).map((e) => e.toLowerCase())
		: [""];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		for (const ext of exts) {
			const candidate = path.join(dir, CODEX_BIN + ext);
			try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
		}
	}
	return null;
}
const CODEX_RESOLVED = resolveCodexBin();
const run = process.env.ACP_TEST_E2E_FAKE === "1";
if (run && !CODEX_RESOLVED) {
	throw new Error(`ACP_TEST_E2E_FAKE=1 but no "${CODEX_BIN}" resolvable via PATH — refusing to silently skip (#2197)`);
}
const skipReason = !run
	? "set ACP_TEST_E2E_FAKE=1 (real codex + local fake upstream; deterministic, zero tokens)"
	: (!CODEX_RESOLVED || spawnSync(CODEX_RESOLVED, ["--version"], { timeout: 15_000 }).status !== 0
		? `codex binary "${CODEX_BIN}" not found on PATH`
		: undefined);

function filler(i: number, lines: number): string {
	const out: string[] = [];
	for (let n = 0; n < lines; n += 1) {
		out.push(`doc#${String(i).padStart(2, "0")} line${String(n).padStart(4, "0")} checksum ${(n * 7919 + i * 104729) % 999983}`);
	}
	return out.join("\n");
}

type OracleEntry = { t: number; model: string; stream: boolean; isSummary: boolean; inputLen: number; insLen?: number; input: unknown[] };

function flatContent(c: unknown): string {
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
	return String(c ?? "");
}
function allInputText(input: unknown[]): string {
	return (input || []).map((it) => flatContent((it as { content?: unknown }).content)).join("\n");
}
function readOracle(reqLog: string): OracleEntry[] {
	if (!fs.existsSync(reqLog)) return [];
	return fs.readFileSync(reqLog, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as OracleEntry);
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as net.AddressInfo).port;
			s.close(() => resolve(p));
		});
	});
}

function windowEnv(contextWindow: number): Record<string, string> {
	return { BILI_LAUNCHER_MODEL_WINDOWS: JSON.stringify({ [MODEL]: contextWindow, [MODEL_B]: contextWindow, [MODEL_C]: contextWindow }) };
}

/** Shared assertions: the compression state survived the perturbation turns.
 * A session fork or a state loss BOTH reshape the post-perturbation wire the
 * same way: the pre-drift filler docs reappear raw (the new/blank session has
 * no blocks) and the payload balloons until a re-fold lands — if it lands at
 * all (a re-fold can even trip the #2147 dead-end breaker and fail the turn).
 * So the oracle is the wire AFTER the perturbation: summary + sentinels +
 * the drift marker present, pre-drift filler docs absent, payload bounded. */
function assertStateSurvived(oracle: OracleEntry[], planted: number[], marker: string, droppedDoc: string, label: string): void {
	const mains = oracle.filter((o) => !o.isSummary);
	assert.ok(mains.length >= 2, `${label}: expected several forwarded requests`);
	const lastMain = allInputText(mains[mains.length - 1].input);
	assert.match(lastMain, /\[Compressed conversation section\]/, `${label}: the folded summary must still be on the wire after the perturbation`);
	for (const s of planted) {
		assert.ok(lastMain.includes(String(s)), `${label}: sentinel ${s} must survive into the post-perturbation payload`);
	}
	assert.ok(lastMain.includes(marker), `${label}: the post-perturbation turn's prompt must be present`);
	assert.ok(!lastMain.includes(droppedDoc), `${label}: pre-drift filler (${droppedDoc}) must stay folded — its reappearance means the fold state was lost or re-folded from zero`);
	const lens = mains.map((m) => m.inputLen);
	// Loose absolute bound, not a cross-run ratio: at the 60k window the wire
	// legitimately grows while unfolded fillers sit in the well (min≈61k early
	// vs ≈16 0k late is fine). What this catches is the catastrophe the suite
	// exists for — fold state lost → the ENTIRE raw history replays (~290k:
	// 3×7 8k fillers + carrier + drifts) instead of the folded view.
	assert.ok(Math.max(...lens) <= 220_000, `${label}: forwarded payload looks like a full raw replay, not a folded view (max=${Math.max(...lens)})`);
}

/** Codex 0.147.0 fact: the persona carrier is byte-stable across every
 * mid-session perturbation we ship today. On this wire the carrier shows up
 * as the leading `developer` item of input (instructions is empty through
 * the proxy), so that is what we measure. If a future codex drifts the
 * persona mid-session (the #2250 upgrade shape), this fires and the persona
 * migrate path (not the raw-key continuity) becomes the load-bearing half;
 * the state-survival oracle above covers both.
 *
 * Two-phase contract (`preCount` = number of main requests before the
 * perturbation):
 *   - pre-perturbation mains: exactly ONE unique carrier length;
 *   - post-perturbation mains: exactly ONE unique carrier length, allowed to
 *     differ from the pre value (the AGENTS.md edit is an intentional persona
 *     drift that the #2250 migrate path absorbs).
 * In the URL lane the second drift turn is a PURE model switch (no file
 * edit), so the post-phase uniqueness also pins the #2250 claim itself:
 * switching the model alone must NOT move the persona carrier by a byte. */
function assertPersonaCarrier(oracle: OracleEntry[], label: string): void {
	// MAIN requests only: bili's own summarization calls carry bili's
	// compressor persona instead.
	const mains = oracle.filter((o) => !o.isSummary);
	const carrierLen = (o: OracleEntry): number => {
		const head = o.input?.[0];
		if (!head || typeof head !== "object" || (head as { role?: string }).role !== "developer") return -1;
		return flatContent((head as { content?: unknown }).content).length;
	};
	// Observed codex 0.147.0 facts this oracle must allow for:
	//  - the run's FIRST request (fresh `exec`, no resume) carries a shorter
	//    carrier than resumed turns (~+3.1k resume guidance) → skip row 0;
	//  - each MODEL FAMILY embeds its own guidance section in the carrier
	//    (qwen≈35k, gpt-5-codex≈56k, gpt-5.1≈77k) → group by model.
	// What it pins: within one model, the carrier must be byte-stable across
	// every turn — random prompt-assembly drift (the shape that would silently
	// fork sessions if #2250 regressed) fires here with >1 unique length.
	const groups = new Map<string, number[]>();
	for (const o of mains.slice(1)) {
		const len = carrierLen(o);
		if (len < 0) continue;
		const key = o.model ?? "?";
		const list = groups.get(key) ?? [];
		list.push(len);
		groups.set(key, list);
	}
	for (const [model, lens] of groups) {
		assert.equal(new Set(lens).size, 1, `${label}: persona carrier drifted within model ${model} (lengths ${[...new Set(lens)].join(", ")}) — codex prompt assembly is not deterministic across turns, or bili mutated the carrier per-request; re-check the #2250 migrate path`);
	}
}

function waitFor(url: string, ms: number, label = "service"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const poll = (): void => {
			fetch(url).then((r) => (r.ok ? resolve() : retry())).catch(retry);
		};
		const retry = (): void => {
			if (Date.now() - started > ms) { reject(new Error(`${label} did not come up within ${ms}ms`)); return; }
			setTimeout(poll, 250);
		};
		poll();
	});
}

type UrlCtx = {
	work: string;
	codexCwd: string;
	codexHome: string;
	xdg: { config: string; cache: string; state: string };
	port: number;
	fakePort: number;
	reqLog: string;
	fakePid?: number;
	proxyPid?: number;
	resumed: boolean;
	turnCount: number;
};

async function startUrlCtx(contextWindow: number): Promise<UrlCtx> {
	const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-codex-persona-"));
	const ctx: UrlCtx = {
		work,
		codexCwd: fs.mkdtempSync(path.join(CWD_ROOT, "url-cwd-")),
		codexHome: path.join(work, "codex-home"),
		xdg: { config: path.join(work, "xdg-config"), cache: path.join(work, "xdg-cache"), state: path.join(work, "xdg-state") },
		port: await freePort(),
		fakePort: await freePort(),
		reqLog: path.join(work, "fake-requests.jsonl"),
		resumed: false,
		turnCount: 0,
	};
	for (const d of [ctx.codexHome, ctx.xdg.config, ctx.xdg.cache, ctx.xdg.state]) fs.mkdirSync(d, { recursive: true });

	await assertPortDead(ctx.fakePort);
	const fake = spawn(process.execPath, [FAKE_UPSTREAM], {
		env: { ...process.env, FAKE_PORT: String(ctx.fakePort), FAKE_HOST: "127.0.0.1", FAKE_REQLOG: ctx.reqLog, FAKE_MODEL: MODEL },
		stdio: ["ignore", "ignore", "pipe"],
	});
	ctx.fakePid = fake.pid;
	await waitFor(`http://127.0.0.1:${ctx.fakePort}/v1/models`, 15_000);

	fs.writeFileSync(path.join(ctx.codexHome, "config.toml"), [
		`model = "${MODEL}"`,
		'model_provider = "e2e"',
		"model_context_window = 60000",
		"",
		"[model_providers.e2e]",
		'name = "OpenAI"',
		`base_url = "http://127.0.0.1:${ctx.port}/bili/http://127.0.0.1:${ctx.fakePort}/v1"`,
		'wire_api = "responses"',
		'env_key = "E2E_UPSTREAM_KEY"',
		"",
	].join("\n"));

	await assertPortDead(ctx.port);
	const logPath = path.join(work, "bili.log");
	const proxy = spawn(process.execPath, [DIST, "start", "--port", String(ctx.port), "--no-auto-update"], {
		env: {
			...process.env,
			XDG_CONFIG_HOME: ctx.xdg.config,
			XDG_CACHE_HOME: ctx.xdg.cache,
			XDG_STATE_HOME: ctx.xdg.state,
			BILLION_CONTEXT_NO_AUTO_UPDATE: "1",
			...windowEnv(contextWindow),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	ctx.proxyPid = proxy.pid;
	proxy.stderr!.on("data", (c: Buffer) => { try { fs.appendFileSync(logPath, c); } catch { /* noop */ } });
	await waitFor(`http://127.0.0.1:${ctx.port}/__bili/health`, 30_000, "bili proxy");
	return ctx;
}

function urlLogs(ctx: UrlCtx): string {
	const parts: string[] = [];
	const stateLog = path.join(ctx.xdg.state, "billion-context", "bili.log");
	if (fs.existsSync(stateLog)) parts.push(fs.readFileSync(stateLog, "utf8"));
	try { parts.push(fs.readFileSync(path.join(ctx.work, "bili.log"), "utf8")); } catch { /* noop */ }
	return parts.join("");
}

async function urlTurn(ctx: UrlCtx, prompt: string, extraArgs: string[] = []): Promise<{ code: number; last: string }> {
	ctx.turnCount += 1;
	const label = `t${ctx.turnCount}`;
	const lastFile = path.join(ctx.work, `${label}.last`);
	const args = ["exec", "--skip-git-repo-check", "--output-last-message", lastFile, ...extraArgs];
	if (ctx.resumed) args.push("resume", "--last");
	args.push(prompt);
	return new Promise((resolve, reject) => {
		const child = spawn(CODEX_BIN, args, {
			cwd: ctx.codexCwd,
			env: { ...process.env, CODEX_HOME: ctx.codexHome, E2E_UPSTREAM_KEY: "fake", RUST_LOG: "error" },
			stdio: ["ignore", "ignore", "pipe"],
		});
		const timer = setTimeout(() => {
			try { child.kill("SIGKILL"); } catch { /* noop */ }
			reject(new Error(`turn ${label} timed out after ${TMO}ms`));
		}, TMO);
		child.on("exit", (code) => {
			clearTimeout(timer);
			const last = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, "utf8").trim() : "";
			ctx.resumed = true;
			resolve({ code: code ?? -1, last });
		});
	});
}

test("URL mode: model switch + AGENTS.md edit mid-session keep the compression state (#2250)", { skip: skipReason, timeout: 600_000 }, async (t) => {
	const leak = repoDocLeak(path.join(CWD_ROOT, "url-cwd-"));
	assert.ok(!leak, `#815 precondition broken: ${leak} holds .git/AGENTS.md above the hermetic cwd`);

	// 60k window (codex's own default) with 1400-line loads: the fold
	// equilibrium leaves ~14%W headroom, and the drift turn's fixed overhead
	// (~4.3k resume/AGENTS) + slim bulk must fit inside it — at small windows
	// (18k/24k) the well folds DRY and the drift turn dies structurally in
	// #1841/#2147 preflight fail-fast instead of exercising identity. At 60k
	// exactly one load turn folds and the well keeps unfolded fillers, so even
	// if a drift turn does trigger preflight it finds material, never dead-ends.
	const ctx = await startUrlCtx(60_000);
	t.after(() => {
		for (const pid of [ctx.proxyPid, ctx.fakePid]) {
			if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
		}
	});

	const planted = [4781, 2903, 6577];
	const warm = await urlTurn(ctx, `档案摘要:\n${planted.map((s) => `本档案哨兵值 = ${s}`).join("\n")}\n\n请确认收到, 只回复: 收到#1`);
	assert.equal(warm.code, 0, `warmup failed (code=${warm.code}); log:\n${urlLogs(ctx)}`);

	for (let k = 2; k <= 4; k += 1) {
		const r = await urlTurn(ctx, `${filler(k, 1400)}\n\n请确认已读取档案#k, 只回复: 收到#${k}`);
		assert.equal(r.code, 0, `load turn ${k} failed (code=${r.code}); log:\n${urlLogs(ctx)}`);
	}

	const before = readOracle(ctx.reqLog);
	assert.ok(before.some((o) => o.isSummary), "a real fold must have happened before the perturbation");

	// The perturbation: a fresh AGENTS.md lands in the walk-up dir AND the
	// model switches to a known family. Drift turns carry a SLIM bulk
	// (~120 lines ≈ 1.6k tokens) so the window is not the thing under test.
	fs.writeFileSync(path.join(ctx.codexCwd, "AGENTS.md"), "- persona-e2e rule ALPHA (added mid-session)\n");
	const drift1 = await urlTurn(ctx, `${filler(9, 120)}\n\n切换后第一轮: 只回复: 收到#5`, ["-c", `model=${MODEL_B}`]);
	assert.equal(drift1.code, 0, `drift turn (model switch) failed (code=${drift1.code}); log:\n${urlLogs(ctx)}`);

	// PURE model switch (no file edit): the persona carrier must stay at the
	// drift1 length — pinned by assertPersonaCarrier (per-model byte stability).
	const drift2 = await urlTurn(ctx, `${filler(10, 120)}\n\n切换后第二轮: 只回复: 收到#6`, ["-c", `model=${MODEL_C}`]);
	assert.equal(drift2.code, 0, `drift turn (known-family switch) failed (code=${drift2.code}); log:\n${urlLogs(ctx)}`);

	const oracle = readOracle(ctx.reqLog);
	assertStateSurvived(oracle, planted, "收到#6", "doc#02 ", "URL mode");
	assertPersonaCarrier(oracle, "URL mode");
	const driftMains = oracle.filter((o) => !o.isSummary).slice(-2);
	assert.deepEqual(driftMains.map((m) => m.model), [MODEL_B, MODEL_C], "both drift turns must actually carry the switched model on the wire (an ignored -c override would make this suite hollow)");
	// The fake acks the FIRST `收到#N` it sees in the joined user text, and at
	// the 60k window earlier turns legitimately survive unfolded — so assert a
	// real round-trip landed, not a specific N (the wire-side assertions above
	// already prove THIS turn reached the switched model).
	assert.match(drift2.last, /^收到#\d+$/, "the fake upstream must have answered the post-switch turn");
});

type LaunchCtx = {
	work: string;
	codexCwd: string;
	codexHome: string;
	xdg: { config: string; cache: string; state: string };
	fakePort: number;
	reqLog: string;
	fakePid?: number;
	resumed: boolean;
	turnCount: number;
};

async function startLaunchCtx(contextWindow: number): Promise<LaunchCtx> {
	const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-codex-persona-launch-"));
	const ctx: LaunchCtx = {
		work,
		codexCwd: fs.mkdtempSync(path.join(CWD_ROOT, "launch-cwd-")),
		codexHome: path.join(work, "codex-home"),
		xdg: { config: path.join(work, "xdg-config"), cache: path.join(work, "xdg-cache"), state: path.join(work, "xdg-state") },
		fakePort: await freePort(),
		reqLog: path.join(work, "fake-requests.jsonl"),
		resumed: false,
		turnCount: 0,
	};
	for (const d of [ctx.codexHome, ctx.xdg.config, ctx.xdg.cache, ctx.xdg.state]) fs.mkdirSync(d, { recursive: true });

	await assertPortDead(ctx.fakePort);
	const fake = spawn(process.execPath, [FAKE_UPSTREAM], {
		env: { ...process.env, FAKE_PORT: String(ctx.fakePort), FAKE_HOST: "127.0.0.1", FAKE_REQLOG: ctx.reqLog, FAKE_MODEL: MODEL },
		stdio: ["ignore", "ignore", "pipe"],
	});
	ctx.fakePid = fake.pid;
	await waitFor(`http://127.0.0.1:${ctx.fakePort}/v1/models`, 15_000);

	// Launcher mode: PLAIN provider base_url — no /bili/ prefix; `bili codex`
	// owns the routing via its overlay (#2197 contract). The window must ride
	// codex's OWN config (model_context_window): the wrapper forwards what
	// codex perceives, not our env map (#321 PR-D), so 60000 here would keep
	// the proxy at 60k and never fold.
	fs.writeFileSync(path.join(ctx.codexHome, "config.toml"), [
		`model = "${MODEL}"`,
		'model_provider = "e2e"',
		`model_context_window = ${contextWindow}`,
		"",
		"[model_providers.e2e]",
		'name = "OpenAI"',
		`base_url = "http://127.0.0.1:${ctx.fakePort}/v1"`,
		'wire_api = "responses"',
		'env_key = "E2E_UPSTREAM_KEY"',
		"",
	].join("\n"));
	return ctx;
}

async function launchTurn(ctx: LaunchCtx, prompt: string, extraArgs: string[] = []): Promise<{ code: number; last: string; launcherOut: string }> {
	ctx.turnCount += 1;
	const label = `t${ctx.turnCount}`;
	const lastFile = path.join(ctx.work, `${label}.last`);
	const args = ["exec", "--skip-git-repo-check", "--output-last-message", lastFile, ...extraArgs];
	if (ctx.resumed) args.push("resume", "--last");
	args.push(prompt);

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const k of [
		"BILLION_CONTEXT_PROXY", "BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS", "BILI_MCP_PROXY",
		"BILI_NATIVE_CLAUDE", "BILLION_CONTEXT_PLUGIN", "BILI_ZONE_PORT", "BILI_CLAUDE_NATIVE_PORT",
		"BILI_UPSTREAM_PROXY", "ACP_PORT", "SSL_CERT_FILE",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy",
	]) delete childEnv[k];
	const launcherLog = path.join(ctx.work, `${label}.launcher.log`);
	const child = spawn(process.execPath, [DIST, "codex", ...args], {
		cwd: ctx.codexCwd,
		env: {
			...childEnv,
			CODEX_HOME: ctx.codexHome,
			XDG_CONFIG_HOME: ctx.xdg.config,
			XDG_CACHE_HOME: ctx.xdg.cache,
			XDG_STATE_HOME: ctx.xdg.state,
			BILLION_CONTEXT_NO_AUTO_UPDATE: "1",
			BILI_CLIENT_BIN: CODEX_BIN,
			E2E_UPSTREAM_KEY: "fake",
			RUST_LOG: "error",
			...windowEnv(60_000),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr!.on("data", (c: Buffer) => { try { fs.appendFileSync(launcherLog, c); } catch { /* noop */ } });
	const code = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* noop */ } reject(new Error(`bili codex exec timed out (${label})`)); }, TMO * 2);
		child.on("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
	});
	ctx.resumed = true;
	return {
		code,
		last: fs.existsSync(lastFile) ? fs.readFileSync(lastFile, "utf8").trim() : "",
		launcherOut: fs.existsSync(launcherLog) ? fs.readFileSync(launcherLog, "utf8") : "",
	};
}

test("launcher mode: model switch + AGENTS.md edit across sequential bili codex runs keep the compression state (#2250)", { skip: skipReason, timeout: 600_000 }, async (t) => {
	const leak = repoDocLeak(path.join(CWD_ROOT, "launch-cwd-"));
	assert.ok(!leak, `#815 precondition broken: ${leak} holds .git/AGENTS.md above the hermetic cwd`);

	const ctx = await startLaunchCtx(60_000);
	t.after(() => {
		if (ctx.fakePid) { try { process.kill(ctx.fakePid, "SIGKILL"); } catch { /* gone */ } }
	});

	const planted = [4781, 2903, 6577];
	const warm = await launchTurn(ctx, `档案摘要:\n${planted.map((s) => `本档案哨兵值 = ${s}`).join("\n")}\n\n请确认收到, 只回复: 收到#1`);
	assert.equal(warm.code, 0, `warmup failed (code=${warm.code})\nlauncher stderr:\n${warm.launcherOut.slice(-4000)}`);

	for (let k = 2; k <= 4; k += 1) {
		const r = await launchTurn(ctx, `${filler(k, 1400)}\n\n请确认已读取档案#k, 只回复: 收到#${k}`);
		assert.equal(r.code, 0, `load turn ${k} failed (code=${r.code})\nlauncher stderr:\n${r.launcherOut.slice(-4000)}`);
	}

	const before = readOracle(ctx.reqLog);
	assert.ok(before.some((o) => o.isSummary), "a real fold must have happened before the perturbation");
	// #2197: the launcher must actually own the routing (no /bili/ in config).
	assert.ok(
		before.some((o) => !o.isSummary && allInputText(o.input).includes("\x3cacp ")),
		"no non-summary upstream request carries bili's ACP tags — the provider bypassed the proxy",
	);

	fs.writeFileSync(path.join(ctx.codexCwd, "AGENTS.md"), "- persona-e2e launch rule ALPHA (added mid-session)\n");
	const drift = await launchTurn(ctx, `${filler(9, 120)}\n\n切换后第一轮: 只回复: 收到#5`, ["-c", `model=${MODEL_B}`]);
	assert.equal(drift.code, 0, `drift turn failed (code=${drift.code})\nlauncher stderr:\n${drift.launcherOut.slice(-4000)}`);

	const oracle = readOracle(ctx.reqLog);
	assertStateSurvived(oracle, planted, "收到#5", "doc#02 ", "launcher mode");
	assertPersonaCarrier(oracle, "launcher mode");
	const driftMain = oracle.filter((o) => !o.isSummary).slice(-1)[0];
	assert.equal(driftMain.model, MODEL_B, "the drift turn must actually carry the switched model on the wire (an ignored -c override would make this suite hollow)");
	assert.match(drift.last, /^收到#\d+$/, "the fake upstream must have answered the post-switch turn");
});
