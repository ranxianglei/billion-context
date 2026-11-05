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
const TMO = Number(process.env.E2E_TMO ?? 120_000);
const FAKE_UPSTREAM = path.join(import.meta.dirname, "fake-upstream.mjs");
const WORK_ROOT = path.join(process.cwd(), "tmp");
const EXTERNAL_ATTACH = (process.env.E2E_CODEX_ATTACH_ORIGIN ?? "").trim();
const UPSTREAM_HOST = (process.env.E2E_UPSTREAM_HOST ?? "127.0.0.1").trim();
const UPSTREAM_URL_HOST =
	(process.env.E2E_UPSTREAM_URL_HOST ?? (UPSTREAM_HOST === "0.0.0.0" ? "host.docker.internal" : UPSTREAM_HOST)).trim();
fs.mkdirSync(WORK_ROOT, { recursive: true });
// codex discovers AGENTS.md by walking UP from its spawn cwd (#815): keep the
// cwd outside the repo tree or the whole repo doc leaks into every request.
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
const cwdLeakDir = repoDocLeak(CWD_ROOT);

// #2197: a bare spawnSync("codex") misses Windows `.cmd` shims — on a Windows
// lane where codex IS installed the whole suite silently skipped. Resolve
// explicitly through PATH/PATHEXT; when the gate is enabled on win32, an
// unresolvable binary is a broken environment and must fail loudly, not skip.
function resolveCodexBin(): string | null {
	if (CODEX_BIN.includes(path.sep) || CODEX_BIN.includes("/")) return fs.existsSync(CODEX_BIN) ? CODEX_BIN : null;
	const exts = process.platform === "win32"
		? (process.env.PATHEXT ?? ".CMD;.EXE;.BAT;.COM;").split(";").filter(Boolean).map((e) => e.toLowerCase())
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
if (run && !CODEX_RESOLVED && process.platform === "win32") {
	throw new Error(`ACP_TEST_E2E_FAKE=1 but no "${CODEX_BIN}" resolvable via PATH/PATHEXT — refusing to silently skip (#2197)`);
}
const skipReason = !run
	? "set ACP_TEST_E2E_FAKE=1 (real codex + local fake upstream; deterministic, zero tokens)"
	: (!CODEX_RESOLVED || spawnSync(CODEX_RESOLVED, ["--version"], { timeout: 15_000 }).status !== 0
		? `codex binary "${CODEX_BIN}" not found on PATH`
		: undefined);
const overflowSkipReason = skipReason ?? (cwdLeakDir
	? `#815 precondition broken: ${cwdLeakDir} holds .git/AGENTS.md above the hermetic cwd, so repo docs would leak into every payload and skew the calibrated window; point TMPDIR outside any repository`
	: undefined);

/** Deterministic filler: unique per index, bulky, carried verbatim in the prompt. */
function filler(i: number, lines: number): string {
	const out: string[] = [];
	for (let n = 0; n < lines; n += 1) {
		out.push(`doc#${String(i).padStart(2, "0")} line${String(n).padStart(4, "0")} checksum ${(n * 7919 + i * 104729) % 999983}`);
	}
	return out.join("\n");
}

type OracleEntry = {
	t: number;
	model: string;
	stream: boolean;
	isSummary: boolean;
	inputLen: number;
	plugin: string | null;
	tools: string[];
	nativeTool: string | null;
	functionCallOutputs: Array<{ callId: string; output: unknown }>;
	input: unknown[];
};

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
	return { BILI_LAUNCHER_MODEL_WINDOWS: JSON.stringify({ [MODEL]: contextWindow }) };
}

type Ctx = {
	work: string;
	codexCwd: string;
	codexHome: string;
	xdg: { config: string; cache: string; state: string };
	port: number;
	fakePort: number;
	reqLog: string;
	fakePid?: number;
	proxyPid?: number;
	external: boolean;
	resumed: boolean;
	turnCount: number;
};

async function startCtx(contextWindow: number, fakeEnv: Record<string, string> = {}): Promise<Ctx> {
	const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-codex-fake-"));
	const ctx: Ctx = {
		work,
		codexCwd: fs.mkdtempSync(path.join(CWD_ROOT, "cwd-")),
		codexHome: path.join(work, "codex-home"),
		xdg: { config: path.join(work, "xdg-config"), cache: path.join(work, "xdg-cache"), state: path.join(work, "xdg-state") },
		port: await freePort(),
		fakePort: await freePort(),
		reqLog: path.join(work, "fake-requests.jsonl"),
		external: EXTERNAL_ATTACH.length > 0,
		resumed: false,
		turnCount: 0,
	};
	for (const d of [ctx.codexHome, ctx.xdg.config, ctx.xdg.cache, ctx.xdg.state]) fs.mkdirSync(d, { recursive: true });

	await assertPortDead(ctx.fakePort); // #1689: prove still free right before the child binds it
	const fake = spawn(process.execPath, [FAKE_UPSTREAM], {
		env: { ...process.env, FAKE_PORT: String(ctx.fakePort), FAKE_HOST: UPSTREAM_HOST, FAKE_REQLOG: ctx.reqLog, FAKE_MODEL: MODEL, ...fakeEnv },
		stdio: ["ignore", "pipe", "pipe"],
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
		ctx.external
			? `base_url = "${EXTERNAL_ATTACH}/bili/http://${UPSTREAM_URL_HOST}:${ctx.fakePort}/v1"`
			: `base_url = "http://127.0.0.1:${ctx.port}/bili/http://127.0.0.1:${ctx.fakePort}/v1"`,
		'wire_api = "responses"',
		'env_key = "E2E_UPSTREAM_KEY"',
		"",
	].join("\n"));

	if (!ctx.external) {
		await assertPortDead(ctx.port); // #1689: prove still free right before the child binds it
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
	}
	return ctx;
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

function teardown(ctx: Ctx): void {
	for (const pid of [ctx.proxyPid, ctx.fakePid]) {
		if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
	}
}

function logs(ctx: Ctx): string {
	const parts: string[] = [];
	const stateLog = path.join(ctx.xdg.state, "billion-context", "bili.log");
	if (fs.existsSync(stateLog)) parts.push(fs.readFileSync(stateLog, "utf8"));
	try { parts.push(fs.readFileSync(path.join(ctx.work, "bili.log"), "utf8")); } catch { /* noop */ }
	return parts.join("");
}

function turn(ctx: Ctx, prompt: string): Promise<{ code: number; last: string }> {
	ctx.turnCount += 1;
	const label = `t${ctx.turnCount}`;
	const lastFile = path.join(ctx.work, `${label}.last`);
	const args = ["exec", "--skip-git-repo-check", "--output-last-message", lastFile];
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

test("overflow: compression really happens in codex; bulk folded, sentinels retained", { skip: overflowSkipReason }, async (t) => {
	// Window calibration for the #829-corrected estimate (input[] developer/
	// system items now count): clean-env turn-1 estimate ≈15.3k, overhead-only
	// floor ≈14k (pinned codex 0.147.0, hermetic cwd). 18k clears both — no
	// warmup fail-fast 502, preflight still engages early. 10k/12k were
	// calibrated on the old under-counting estimate or reported tokens and
	// 502 on the warmup turn once the system prompt counts. The 600-line
	// filler (~5k tokens) makes the crossing decisive by turn 2 so repeated
	// folds fit inside the five load turns; the forwarded payload must stay
	// bounded as a result (assertion below).
	const ctx = await startCtx(18_000);
	t.after(() => teardown(ctx));

	const planted = [4781, 2903, 6577];
	const warm = await turn(ctx, `档案摘要:\n${planted.map((s) => `本档案哨兵值 = ${s}`).join("\n")}\n\n请确认收到, 只回复: 收到#1`);
	assert.equal(warm.code, 0, `warmup failed (code=${warm.code}); log:\n${logs(ctx)}`);

	for (let k = 2; k <= 5; k += 1) {
		const r = await turn(ctx, `${filler(k, 600)}\n\n请确认已读取档案#k, 只回复: 收到#${k}`);
		assert.equal(r.code, 0, `load turn ${k} failed (code=${r.code}); log:\n${logs(ctx)}`);
	}

	const log = logs(ctx);
	assert.match(log, /preflight compressed|compress requested|\[Compressed m\d/, "a real compression event must occur once context exceeds the window");

	const oracle = readOracle(ctx.reqLog);
	assert.ok(oracle.some((o) => o.isSummary), "summarization must call the upstream at least once");
	const summaries = oracle.filter((o) => o.isSummary);
	assert.ok(summaries.length >= 2, `expected repeated summarization as context accumulated (got ${summaries.length})`);
	const mains = oracle.filter((o) => !o.isSummary);
	assert.ok(mains.length >= 2, "expected several forwarded requests");
	const lens = mains.map((m) => m.inputLen);
	const minLen = Math.min(...lens);
	const peak = Math.max(...lens);
	assert.ok(peak <= minLen * 1.3, `despite ~20KB filler injected on every load turn the forwarded payload must stay bounded (min=${minLen}, peak=${peak}); unbounded growth would mean compression is not folding the bulk`);

	const lastMain = allInputText(mains[mains.length - 1].input);
	assert.match(lastMain, /\[Compressed conversation section\]/, "final payload must carry the summary block");
	for (const s of planted) {
		assert.ok(lastMain.includes(String(s)), `sentinel ${s} must survive compression into the final payload`);
	}
});

test("under-window: no compression occurs (control)", { skip: skipReason }, async (t) => {
	const ctx = await startCtx(60_000);
	t.after(() => teardown(ctx));

	const r = await turn(ctx, "请只回复: 收到");
	assert.equal(r.code, 0, `codex exec should succeed (got ${r.code})\nbili log:\n${logs(ctx)}`);

	const log = logs(ctx);
	assert.doesNotMatch(log, /preflight compressed|compress requested/, "control turn must NOT trigger compression");

	const oracle = readOracle(ctx.reqLog);
	assert.ok(oracle.length > 0, "fake upstream received no requests");
	assert.ok(oracle.every((o) => !o.isSummary), "control turn must make no summarization calls");
});

test("native tools: real codex uses bili-injected ACP tools without MCP", { skip: skipReason, timeout: 300_000 }, async (t) => {
	const ctx = await startCtx(60_000, { FAKE_NATIVE_TOOL: "acp_status" });
	t.after(() => teardown(ctx));

	const config = fs.readFileSync(path.join(ctx.codexHome, "config.toml"), "utf8");
	assert.doesNotMatch(config, /\[mcp_servers\./i, "this lane must not register bili through MCP");

	const r = await turn(ctx, "请执行原生注入验收, 只回复: 收到");
	assert.equal(r.code, 0, `codex exec should succeed (got ${r.code})\nbili log:\n${logs(ctx)}`);

	const oracle = readOracle(ctx.reqLog);
	const injected = oracle.find((o) => !o.isSummary && o.nativeTool === "acp_status");
	assert.ok(injected, `upstream never saw bili's injected ACP tool surface: ${JSON.stringify(oracle)}`);
	assert.equal(injected.plugin, null, "codex must use proxy-mode wire injection, not a plugin header");
	assert.ok(injected.tools.includes("compress"), `compress tool missing from injected surface: ${injected.tools.join(",")}`);
	assert.ok(injected.tools.includes("acp_status"), `acp_status tool missing from injected surface: ${injected.tools.join(",")}`);

	const executed = oracle.find((o) => !o.isSummary && o.functionCallOutputs.some((out) => out.callId.startsWith("call_native_")));
	assert.ok(executed, `bili never re-requested with function_call_output; log:\n${logs(ctx)}`);
	const output = String(executed.functionCallOutputs.find((out) => out.callId.startsWith("call_native_"))?.output ?? "");
	assert.match(output, /context|window|token|session|messages/i, `unexpected acp_status result: ${output}`);
	assert.match(logs(ctx), /proxy tool executed; re-requesting/, "server-side native tool execution was not logged");
});

test(
	"native tools: real codex reaches an external Docker bili without MCP",
	{
		skip:
			skipReason ??
			(EXTERNAL_ATTACH.length === 0
				? "set E2E_CODEX_ATTACH_ORIGIN=http://127.0.0.1:8787 to exercise a running Docker proxy"
				: undefined),
		timeout: 300_000,
	},
	async (t) => {
		const ctx = await startCtx(60_000, { FAKE_NATIVE_TOOL: "acp_status" });
		t.after(() => teardown(ctx));

		const config = fs.readFileSync(path.join(ctx.codexHome, "config.toml"), "utf8");
		assert.match(config, new RegExp(`base_url = "${EXTERNAL_ATTACH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/bili/`));
		assert.doesNotMatch(config, /\[mcp_servers\./i, "this lane must not register bili through MCP");

		const r = await turn(ctx, "请执行 Docker 原生注入验收, 只回复: 收到");
		assert.equal(r.code, 0, `codex exec should succeed (got ${r.code})`);

		const oracle = readOracle(ctx.reqLog);
		const injected = oracle.find((o) => !o.isSummary && o.nativeTool === "acp_status");
		assert.ok(injected, `Docker bili never injected ACP tools: ${JSON.stringify(oracle)}`);
		assert.equal(injected.plugin, null, "codex must use proxy-mode wire injection, not a plugin header");
		assert.ok(injected.tools.includes("compress"), `compress tool missing from injected surface: ${injected.tools.join(",")}`);
		assert.ok(injected.tools.includes("acp_status"), `acp_status tool missing from injected surface: ${injected.tools.join(",")}`);

		const executed = oracle.find((o) => !o.isSummary && o.functionCallOutputs.some((out) => out.callId.startsWith("call_native_")));
		assert.ok(executed, "Docker bili never re-requested with function_call_output");
		const output = String(executed.functionCallOutputs.find((out) => out.callId.startsWith("call_native_"))?.output ?? "");
		assert.match(output, /context|window|token|session|messages/i, `unexpected acp_status result: ${output}`);
	},
);

test("#1802: a hostile user .env cannot reroute a bili-launched codex", { skip: skipReason, timeout: 300_000 }, async (t) => {
	// The #1802 blind spot: nothing here runs through startCtx/turn (those
	// pre-bake the proxy into base_url). This launch goes through the REAL
	// launcher (`dist/index.js codex`) with a PLAIN base_url — routing must
	// survive via the launcher's injected env — while the user's own
	// $CODEX_HOME/.env tries to reroute everything to a dead socks5h proxy
	// (codex's load_dotenv() set_var()s it over the spawn env pre-#1806, and
	// its custom-CA rustls client cannot speak socks at all).
	const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-codex-env-"));
	const codexCwd = fs.mkdtempSync(path.join(CWD_ROOT, "cwd-"));
	const codexHome = path.join(work, "codex-home");
	const xdg = {
		config: path.join(work, "xdg-config"),
		cache: path.join(work, "xdg-cache"),
		state: path.join(work, "xdg-state"),
	};
	for (const d of [codexHome, xdg.config, xdg.cache, xdg.state]) fs.mkdirSync(d, { recursive: true });
	const fakePort = await freePort();
	const reqLog = path.join(work, "fake-requests.jsonl");
	t.after(() => { for (const pid of [fake?.pid]) if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } });

	await assertPortDead(fakePort);
	const fake = spawn(process.execPath, [FAKE_UPSTREAM], {
		env: { ...process.env, FAKE_PORT: String(fakePort), FAKE_HOST: "127.0.0.1", FAKE_REQLOG: reqLog, FAKE_MODEL: MODEL },
		stdio: ["ignore", "ignore", "pipe"],
	});
	await waitFor(`http://127.0.0.1:${fakePort}/v1/models`, 15_000);

	// PLAIN upstream base_url: no /bili/ pre-bake — only the launcher's
	// HTTP(S)_PROXY injection (or, pre-fix, the hostile .env) decides routing.
	fs.writeFileSync(path.join(codexHome, "config.toml"), [
		`model = "${MODEL}"`,
		'model_provider = "e2e"',
		"",
		"[model_providers.e2e]",
		'name = "OpenAI"',
		`base_url = "http://127.0.0.1:${fakePort}/v1"`,
		'wire_api = "responses"',
		'env_key = "E2E_UPSTREAM_KEY"',
		"",
	].join("\n"));
	const hostileEnv = [
		"HTTP_PROXY=socks5h://127.0.0.1:7890",
		"https_proxy=socks5h://127.0.0.1:7890",
		"ALL_PROXY=socks5h://127.0.0.1:7890",
		"E2E_INNOCENT=keepme",
		"",
	].join("\n");
	fs.writeFileSync(path.join(codexHome, ".env"), hostileEnv);

	// Hermetic launcher env: strip this session's own bili/proxy vars so the
	// launcher spawns its own lane proxy in the isolated XDG state instead of
	// attaching to an outer one.
	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const k of [
		"BILLION_CONTEXT_PROXY", "BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS", "BILI_MCP_PROXY",
		"BILI_NATIVE_CLAUDE", "BILLION_CONTEXT_PLUGIN", "BILI_ZONE_PORT", "BILI_CLAUDE_NATIVE_PORT",
		"BILI_UPSTREAM_PROXY", "ACP_PORT", "SSL_CERT_FILE",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy",
	]) delete childEnv[k];
	const launcherLog = path.join(work, "launcher.log");
	const lastFile = path.join(work, "t1.last");
	const child = spawn(process.execPath, [
		DIST, "codex", "exec", "--skip-git-repo-check", "--output-last-message", lastFile, "请只回复: 收到",
	], {
		cwd: codexCwd,
		env: {
			...childEnv,
			CODEX_HOME: codexHome,
			XDG_CONFIG_HOME: xdg.config,
			XDG_CACHE_HOME: xdg.cache,
			XDG_STATE_HOME: xdg.state,
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
		const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } reject(new Error("bili codex exec timed out")); }, TMO * 2);
		child.on("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
	});
	const launcherOut = fs.existsSync(launcherLog) ? fs.readFileSync(launcherLog, "utf8") : "";
	assert.equal(code, 0, `bili codex exec must succeed despite the hostile .env (code=${code})\nlauncher stderr:\n${launcherOut}`);

	const last = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, "utf8").trim() : "";
	assert.match(last, /收到/, `the fake upstream must have answered through bili (last="${last}")`);

	const oracle = readOracle(reqLog);
	assert.ok(oracle.length > 0, "fake upstream received no requests — routing was rerouted away from bili");

	// The overlay .env pins this launch's routing and preserves the user's
	// innocent variables; the real .env stays byte-identical. Shared-mode
	// launches (#2222/#3203) use a per-session slot (<home>-bili-s<N>); legacy
	// mode uses the fixed <home>-bili. Scan both shapes — this test launches
	// once, so exactly one overlay must exist.
	const overlayDir = fs.readdirSync(path.dirname(codexHome), { withFileTypes: true })
		.find((d) => d.isDirectory() && d.name.startsWith(`${path.basename(codexHome)}-bili`));
	assert.ok(overlayDir, "no codex overlay found beside the real home after the launch");
	const overlayEnvPath = path.join(path.dirname(codexHome), overlayDir.name, ".env");
	assert.ok(fs.existsSync(overlayEnvPath), "the overlay must own the generated .env (#1806)");
	const overlayEnv = fs.readFileSync(overlayEnvPath, "utf8");
	assert.match(overlayEnv, /^HTTP_PROXY=http:\/\/127\.0\.0\.1:\d+$/m, "HTTP_PROXY must be pinned to this launch's bili origin");
	assert.ok(overlayEnv.includes("E2E_INNOCENT=keepme"), "the user's own variables must survive into the overlay .env");
	assert.ok(!overlayEnv.includes("socks5h"), "no socks5h residue may remain in the overlay .env");
	assert.equal(fs.readFileSync(path.join(codexHome, ".env"), "utf8"), hostileEnv, "the real home .env must never be modified");
});

// node:sqlite (flag-free since Node 22.13) inspects the written-back db; on an
// older runtime the content assertions degrade to the native-resume proof below.
let sqliteMod: typeof import("node:sqlite") | undefined;
try { sqliteMod = await import("node:sqlite"); } catch { /* degraded mode */ }

test("#1965: a clean bili exit writes the run's state back into the real home; native codex resumes it", { skip: skipReason, timeout: 300_000 }, async (t) => {
	// Same hermetic shape as the #1802 test: real launcher (dist/index.js codex),
	// PLAIN base_url, isolated CODEX_HOME/XDG — then, with NO bili involved, a
	// native `codex exec resume --last` straight off the real home.
	const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-codex-1965-"));
	const codexCwd = fs.mkdtempSync(path.join(CWD_ROOT, "cwd-"));
	const codexHome = path.join(work, "codex-home");
	const xdg = {
		config: path.join(work, "xdg-config"),
		cache: path.join(work, "xdg-cache"),
		state: path.join(work, "xdg-state"),
	};
	for (const d of [codexHome, xdg.config, xdg.cache, xdg.state]) fs.mkdirSync(d, { recursive: true });
	const fakePort = await freePort();
	const reqLog = path.join(work, "fake-requests.jsonl");
	let fake: ReturnType<typeof spawn> | undefined;
	t.after(() => { if (fake?.pid) { try { process.kill(fake.pid, "SIGKILL"); } catch { /* gone */ } } });

	await assertPortDead(fakePort);
	fake = spawn(process.execPath, [FAKE_UPSTREAM], {
		env: { ...process.env, FAKE_PORT: String(fakePort), FAKE_HOST: "127.0.0.1", FAKE_REQLOG: reqLog, FAKE_MODEL: MODEL },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await waitFor(`http://127.0.0.1:${fakePort}/v1/models`, 15_000);

	const cfgText = [
		`model = "${MODEL}"`,
		'model_provider = "e2e"',
		"",
		"[model_providers.e2e]",
		'name = "OpenAI"',
		`base_url = "http://127.0.0.1:${fakePort}/v1"`,
		'wire_api = "responses"',
		'env_key = "E2E_UPSTREAM_KEY"',
		"",
	].join("\n");
	fs.writeFileSync(path.join(codexHome, "config.toml"), cfgText);

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const k of [
		"BILLION_CONTEXT_PROXY", "BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS", "BILI_MCP_PROXY",
		"BILI_NATIVE_CLAUDE", "BILLION_CONTEXT_PLUGIN", "BILI_ZONE_PORT", "BILI_CLAUDE_NATIVE_PORT",
		"BILI_UPSTREAM_PROXY", "ACP_PORT", "SSL_CERT_FILE",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy",
	]) delete childEnv[k];

	// Phase 1: one real turn through the launcher.
	const lastFile = path.join(work, "t1.last");
	const launcherLog = path.join(work, "launcher.log");
	const child = spawn(process.execPath, [DIST, "codex", "exec", "--skip-git-repo-check", "--output-last-message", lastFile, "请只回复: 收到#1"], {
		cwd: codexCwd,
		env: {
			...childEnv,
			CODEX_HOME: codexHome,
			XDG_CONFIG_HOME: xdg.config,
			XDG_CACHE_HOME: xdg.cache,
			XDG_STATE_HOME: xdg.state,
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
		const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } reject(new Error("bili codex exec timed out")); }, TMO * 2);
		child.on("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
	});
	assert.equal(code, 0, `bili codex exec must succeed (code=${code})\nlauncher stderr:\n${fs.existsSync(launcherLog) ? fs.readFileSync(launcherLog, "utf8").slice(-4000) : ""}`);
	assert.match(fs.readFileSync(lastFile, "utf8"), /收到#1/, "the turn must have completed through the fake upstream");

	// Phase 2: the exit-time write-back — the run's records are readable in the
	// REAL home immediately, with no second bili start.
	const realEntries = fs.readdirSync(codexHome);
	assert.ok(realEntries.includes("state_5.sqlite"), `the run's thread db must be back in the real home after a clean exit: ${JSON.stringify(realEntries)}`);
	for (const n of realEntries.filter((x) => x.startsWith(".bili-"))) assert.fail(`bili metadata leaked into the real home: ${n}`);
	assert.equal(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), cfgText, "the real config.toml must never absorb generated content");
	if (sqliteMod) {
		const db = new sqliteMod.DatabaseSync(path.join(codexHome, "state_5.sqlite"), { readOnly: true });
		try {
			assert.equal(String(db.prepare("PRAGMA quick_check").get()!.quick_check), "ok", "written-back db must pass quick_check");
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => String(r.name));
			const threadTable = tables.find((x) => /thread/i.test(x));
			assert.ok(threadTable, `state_5.sqlite must carry a thread table, got ${JSON.stringify(tables)}`);
			const rows = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${threadTable}`).get()!.c);
			assert.ok(rows >= 1, "this run's thread record must be readable in the real home");
		} finally {
			db.close();
		}
	}

	// Phase 3: NATIVE codex (no bili) resumes the session straight off the real home.
	const lastFile2 = path.join(work, "t2.last");
	// #2197: spawn the explicitly resolved binary — a bare name misses Windows shims.
	const native = spawn(CODEX_RESOLVED ?? CODEX_BIN, ["exec", "--skip-git-repo-check", "--output-last-message", lastFile2, "resume", "--last", "请只回复: 收到#2"], {
		cwd: codexCwd,
		env: {
			...childEnv,
			CODEX_HOME: codexHome,
			XDG_CONFIG_HOME: xdg.config,
			XDG_CACHE_HOME: xdg.cache,
			XDG_STATE_HOME: xdg.state,
			E2E_UPSTREAM_KEY: "fake",
			RUST_LOG: "error",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	let nativeStderr = "";
	native.stderr!.on("data", (chunk: Buffer) => { nativeStderr = (nativeStderr + chunk.toString("utf8")).slice(-4000); });
	const code2 = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => { try { native.kill("SIGKILL"); } catch { /* gone */ } reject(new Error("native codex resume timed out")); }, TMO * 2);
		native.on("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
	});
	assert.equal(code2, 0, `native codex resume must succeed off the real home (code=${code2})\nnative stderr:\n${nativeStderr}`);
	// The fake answers from the FIRST 收到#N anywhere in the replayed user text:
	// "#1" coming back proves the ORIGINAL turn's message was restored from the
	// recovered thread (a fresh session could not contain it).
	assert.match(fs.readFileSync(lastFile2, "utf8"), /收到#1/, "the resumed session must carry the original turn back into the model's view");
	const oracle = readOracle(reqLog);
	const flat = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("") : String(c ?? ""));
	const inputText = (oracle[oracle.length - 1]?.input || []).map((it) => flat((it as { content?: unknown }).content)).join("\n");
	assert.ok(inputText.includes("收到#1"), "the resume request must replay the original turn's prompt");
	assert.ok(inputText.includes("收到#2"), "the resume request must append the new turn");
});

test("#2195: two sequential bili launches keep every thread in the real home", { skip: skipReason, timeout: 480_000 }, async (t) => {
	// Issue #2195 repro shape: two SEQUENTIAL `bili codex exec` runs, no
	// concurrent codex. Each run's thread must end up in the REAL home's ACTIVE
	// state_5.sqlite after a clean exit — never quarantined into .bili-conflict.
	// On Windows a file copy preserves the source mtime and a WAL-only commit
	// leaves the main db's bytes AND mtime untouched, so this is the real-machine
	// gate for the generation-winner selection (unit-covered deterministically
	// in tests/launcher-sqlite-overlay.test.ts).
	const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-codex-2195-"));
	const codexCwd = fs.mkdtempSync(path.join(CWD_ROOT, "cwd-"));
	const codexHome = path.join(work, "codex-home");
	const xdg = {
		config: path.join(work, "xdg-config"),
		cache: path.join(work, "xdg-cache"),
		state: path.join(work, "xdg-state"),
	};
	for (const d of [codexHome, xdg.config, xdg.cache, xdg.state]) fs.mkdirSync(d, { recursive: true });
	const fakePort = await freePort();
	let fake: ReturnType<typeof spawn> | undefined;
	t.after(() => { if (fake?.pid) { try { process.kill(fake.pid, "SIGKILL"); } catch { /* gone */ } } });

	await assertPortDead(fakePort);
	fake = spawn(process.execPath, [FAKE_UPSTREAM], {
		env: { ...process.env, FAKE_PORT: String(fakePort), FAKE_HOST: "127.0.0.1", FAKE_MODEL: MODEL },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await waitFor(`http://127.0.0.1:${fakePort}/v1/models`, 15_000);

	// PLAIN base_url (no /bili/ pre-bake): routing comes from the launcher's own
	// injection, exactly like a user's real `bili codex` invocation.
	fs.writeFileSync(path.join(codexHome, "config.toml"), [
		`model = "${MODEL}"`,
		'model_provider = "e2e"',
		"",
		"[model_providers.e2e]",
		'name = "OpenAI"',
		`base_url = "http://127.0.0.1:${fakePort}/v1"`,
		'wire_api = "responses"',
		'env_key = "E2E_UPSTREAM_KEY"',
		"",
	].join("\n"));

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const k of [
		"BILLION_CONTEXT_PROXY", "BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS", "BILI_MCP_PROXY",
		"BILI_NATIVE_CLAUDE", "BILLION_CONTEXT_PLUGIN", "BILI_ZONE_PORT", "BILI_CLAUDE_NATIVE_PORT",
		"BILI_UPSTREAM_PROXY", "ACP_PORT", "SSL_CERT_FILE",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy",
	]) delete childEnv[k];

	const launcherRun = (label: string, prompt: string): Promise<void> => new Promise((resolve, reject) => {
		const lastFile = path.join(work, `${label}.last`);
		const logFile = path.join(work, `${label}.log`);
		const child = spawn(process.execPath, [DIST, "codex", "exec", "--skip-git-repo-check", "--output-last-message", lastFile, prompt], {
			cwd: codexCwd,
			env: {
				...childEnv,
				CODEX_HOME: codexHome,
				XDG_CONFIG_HOME: xdg.config,
				XDG_CACHE_HOME: xdg.cache,
				XDG_STATE_HOME: xdg.state,
				BILLION_CONTEXT_NO_AUTO_UPDATE: "1",
				BILI_CLIENT_BIN: CODEX_BIN,
				E2E_UPSTREAM_KEY: "fake",
				RUST_LOG: "error",
				...windowEnv(60_000),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr!.on("data", (c: Buffer) => { try { fs.appendFileSync(logFile, c); } catch { /* noop */ } });
		const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } reject(new Error(`${label} timed out after ${TMO * 2}ms`)); }, TMO * 2);
		child.on("exit", (code) => {
			clearTimeout(timer);
			const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-4000) : "";
			if ((code ?? -1) !== 0) reject(new Error(`${label} exited with code=${code}\nlauncher stderr:\n${tail}`));
			else if (!fs.existsSync(lastFile) || !/收到#/.test(fs.readFileSync(lastFile, "utf8"))) reject(new Error(`${label}: the fake upstream never answered\nlauncher stderr:\n${tail}`));
			else resolve();
		});
	});

	const threadCountOf = (p: string): number => {
		assert.ok(sqliteMod, "node:sqlite unavailable for db assertions");
		const db = new sqliteMod.DatabaseSync(p, { readOnly: true });
		try {
			assert.equal(String(db.prepare("PRAGMA integrity_check").get()!.integrity_check), "ok", `${p} must pass integrity_check`);
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => String(r.name));
			const threadTable = tables.find((x) => /thread/i.test(x));
			assert.ok(threadTable, `state_5.sqlite must carry a thread table, got ${JSON.stringify(tables)}`);
			return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${threadTable}`).get()!.c);
		} finally {
			db.close();
		}
	};
	const realThreads = (): number => {
		const p = path.join(codexHome, "state_5.sqlite");
		assert.ok(fs.existsSync(p), `state_5.sqlite must be back in the real home, got ${JSON.stringify(fs.readdirSync(codexHome))}`);
		return threadCountOf(p);
	};

	// Launch 1: creates thread A.
	await launcherRun("t1", "请只回复: 收到#1");
	const c1 = realThreads();
	assert.ok(c1 >= 1, "first launch's thread record must be readable in the real home");
	for (const n of fs.readdirSync(codexHome)) assert.ok(!n.includes("bili-conflict"), `no quarantined generation after launch 1: ${n}`);

	// Launch 2: creates thread B — the step that lost B into .bili-conflict on Windows.
	await launcherRun("t2", "请只回复: 收到#2");
	const c2 = realThreads();
	assert.equal(c2, c1 + 1, `the second launch's thread must ALSO be in the real home's active db (#2195): before=${c1} after=${c2}`);
	for (const n of fs.readdirSync(codexHome)) assert.ok(!n.includes("bili-conflict"), `no quarantined generation on sequential runs: ${n}`);

	// Launch 3 in flight: the NEXT active state must already carry A+B (the
	// acceptance criterion beyond the exit-time write-back). Legacy mode
	// carries them in the in-flight overlay copy (present from the copy phase
	// until this launch's finalize); shared mode (#2222) carries them in the
	// REAL home's live db, where launch 3's own thread lands as count c2+1.
	const run3 = launcherRun("t3", "请只回复: 收到#3");
	const overlayDb = path.join(`${codexHome}-bili`, "state_5.sqlite");
	const realDb = path.join(codexHome, "state_5.sqlite");
	let saw = -1;
	let sawAllThreadsBeforeExit = false;
	const pollStart = Date.now();
	while (!sawAllThreadsBeforeExit && Date.now() - pollStart < 90_000) {
		if (fs.existsSync(overlayDb)) {
			try { saw = threadCountOf(overlayDb); } catch { /* transient lock mid-copy/mid-write: retry */ }
			sawAllThreadsBeforeExit = saw >= c2;
		} else if (fs.existsSync(realDb)) {
			try { saw = threadCountOf(realDb); } catch { /* transient lock mid-write: retry */ }
			sawAllThreadsBeforeExit = saw >= c2 + 1;
		}
		if (!sawAllThreadsBeforeExit) await new Promise((r) => setTimeout(r, 250));
	}
	assert.ok(sawAllThreadsBeforeExit, `the next launch's active state must already carry all previous threads (saw ${saw}, need >= ${c2} in the legacy overlay or >= ${c2 + 1} in the shared real-home db)`);
	await run3;
	assert.equal(realThreads(), c2 + 1, "launch 3's thread writes back on top of A+B");
	for (const n of fs.readdirSync(codexHome)) assert.ok(!n.includes("bili-conflict"), `no quarantined generation after launch 3: ${n}`);

	// Native codex (NO bili) resumes the latest session straight off the real
	// home — the issue left `codex resume` recovery unverified.
	const lastFile4 = path.join(work, "t4.last");
	const native = spawn(CODEX_BIN, ["exec", "--skip-git-repo-check", "--output-last-message", lastFile4, "resume", "--last", "请只回复: 收到#4"], {
		cwd: codexCwd,
		env: {
			...childEnv,
			CODEX_HOME: codexHome,
			XDG_CONFIG_HOME: xdg.config,
			XDG_CACHE_HOME: xdg.cache,
			XDG_STATE_HOME: xdg.state,
			E2E_UPSTREAM_KEY: "fake",
			RUST_LOG: "error",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	const code4 = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => { try { native.kill("SIGKILL"); } catch { /* gone */ } reject(new Error("native codex resume timed out")); }, TMO * 2);
		native.on("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
	});
	assert.equal(code4, 0, "native codex resume must succeed off the real home");
	// The fake answers from the FIRST 收到#N in the replayed text: "#3" coming
	// back proves launch 3's turn was restored from the recovered thread.
	assert.match(fs.readFileSync(lastFile4, "utf8"), /收到#3/, "the resumed session must carry launch 3's turn back into the model's view");
});

// ── #2197: profile / CLI-selected providers must participate in route discovery ──
// All three cases launch the REAL launcher (`dist/index.js codex`) with a PLAIN
// base_url (no /bili/ pre-bake) and isolated CODEX_HOME/XDG. For a plaintext-http
// upstream buildCodexEnv injects only HTTPS_PROXY, so without the launcher's
// -c base_url rewrite the traffic goes DIRECT to the fake upstream and the
// oracle payload carries no bili ACP tags — those tags plus the session
// write-back are what prove the proxy actually processed the request.
async function runProfileCase(
	t: { after(fn: () => void): void },
	opts: { tag: string; configToml: string; profileFiles?: Record<string, string>; extraArgs: string[]; prompt: string; fakePorts: number[] },
): Promise<{ code: number; last: string; oracles: OracleEntry[][]; codexHome: string; launcherOut: string }> {
	const work = fs.mkdtempSync(path.join(WORK_ROOT, `e2e-codex-${opts.tag}-`));
	const codexCwd = fs.mkdtempSync(path.join(CWD_ROOT, "cwd-"));
	const codexHome = path.join(work, "codex-home");
	const xdg = {
		config: path.join(work, "xdg-config"),
		cache: path.join(work, "xdg-cache"),
		state: path.join(work, "xdg-state"),
	};
	for (const d of [codexHome, xdg.config, xdg.cache, xdg.state]) fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(path.join(codexHome, "config.toml"), opts.configToml);
	for (const [name, text] of Object.entries(opts.profileFiles ?? {})) fs.writeFileSync(path.join(codexHome, `${name}.config.toml`), text);
	const reqLogs = opts.fakePorts.map((_, i) => path.join(work, `fake-requests-${i}.jsonl`));
	for (const port of opts.fakePorts) await assertPortDead(port);
	const fakes = opts.fakePorts.map((port, i) => spawn(process.execPath, [FAKE_UPSTREAM], {
		env: { ...process.env, FAKE_PORT: String(port), FAKE_HOST: "127.0.0.1", FAKE_REQLOG: reqLogs[i], FAKE_MODEL: MODEL },
		stdio: ["ignore", "ignore", "pipe"],
	}));
	t.after(() => { for (const f of fakes) if (f.pid) { try { process.kill(f.pid, "SIGKILL"); } catch { /* gone */ } } });
	for (let i = 0; i < opts.fakePorts.length; i += 1) await waitFor(`http://127.0.0.1:${opts.fakePorts[i]}/v1/models`, 15_000);

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const k of [
		"BILLION_CONTEXT_PROXY", "BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS", "BILI_MCP_PROXY",
		"BILI_NATIVE_CLAUDE", "BILLION_CONTEXT_PLUGIN", "BILI_ZONE_PORT", "BILI_CLAUDE_NATIVE_PORT",
		"BILI_UPSTREAM_PROXY", "ACP_PORT", "SSL_CERT_FILE",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy",
	]) delete childEnv[k];
	const launcherLog = path.join(work, "launcher.log");
	const lastFile = path.join(work, "t1.last");
	const child = spawn(process.execPath, [DIST, "codex", "exec", "--skip-git-repo-check", "--output-last-message", lastFile, ...opts.extraArgs, opts.prompt], {
		cwd: codexCwd,
		env: {
			...childEnv,
			CODEX_HOME: codexHome,
			XDG_CONFIG_HOME: xdg.config,
			XDG_CACHE_HOME: xdg.cache,
			XDG_STATE_HOME: xdg.state,
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
		const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } reject(new Error(`bili codex exec timed out (${opts.tag})`)); }, TMO * 2);
		child.on("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
	});
	return {
		code,
		last: fs.existsSync(lastFile) ? fs.readFileSync(lastFile, "utf8").trim() : "",
		oracles: reqLogs.map(readOracle),
		codexHome,
		launcherOut: fs.existsSync(launcherLog) ? fs.readFileSync(launcherLog, "utf8") : "",
	};
}

function assertRoutedThroughBili(oracle: OracleEntry[], label: string): void {
	assert.ok(oracle.length > 0, `${label}: fake upstream received no requests`);
	assert.ok(
		oracle.some((o) => !o.isSummary && allInputText(o.input).includes("\x3cacp ")),
		`${label}: no non-summary upstream request carries bili's ACP tags — the provider bypassed the proxy (#2197)`,
	);
}

function assertThreadRecorded(codexHome: string): void {
	assert.ok(fs.existsSync(path.join(codexHome, "state_5.sqlite")), "the run's thread db must be back in the real home after a clean exit");
	if (!sqliteMod) return; // degraded mode, same as the #1965 test
	const db = new sqliteMod.DatabaseSync(path.join(codexHome, "state_5.sqlite"), { readOnly: true });
	try {
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => String(r.name));
		const threadTable = tables.find((x) => /thread/i.test(x));
		assert.ok(threadTable, `state_5.sqlite must carry a thread table, got ${JSON.stringify(tables)}`);
		const rows = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${threadTable}`).get()!.c);
		assert.ok(rows >= 1, "this run's thread record must be readable in the real home");
	} finally {
		db.close();
	}
}

test("#2197: a provider defined ONLY in the selected -p profile file must route through bili", { skip: skipReason, timeout: 300_000 }, async (t) => {
	const pA = await freePort();
	const r = await runProfileCase(t, {
		tag: "2197a",
		configToml: [`model = "${MODEL}"`, ""].join("\n"),
		profileFiles: {
			review: [
				'model_provider = "revprov"',
				"",
				"[model_providers.revprov]",
				'name = "OpenAI"',
				`base_url = "http://127.0.0.1:${pA}/v1"`,
				'wire_api = "responses"',
				'env_key = "E2E_UPSTREAM_KEY"',
				"",
			].join("\n"),
		},
		extraArgs: ["-p", "review"],
		prompt: "请只回复: 收到#7",
		fakePorts: [pA],
	});
	assert.equal(r.code, 0, `bili codex exec -p review must succeed (code=${r.code})\nlauncher stderr:\n${r.launcherOut.slice(-4000)}`);
	assert.match(r.last, /收到#7/, `the turn must have completed through the fake upstream (last="${r.last}")`);
	assertRoutedThroughBili(r.oracles[0], "profile-only provider");
	assertThreadRecorded(r.codexHome);
});

test("#2197: a CLI-selected provider (-c model_provider / model_providers.<id>.base_url) must route through bili", { skip: skipReason, timeout: 300_000 }, async (t) => {
	const pA = await freePort();
	const r = await runProfileCase(t, {
		tag: "2197b",
		configToml: [`model = "${MODEL}"`, ""].join("\n"),
		// codex validates every model_providers entry: name must be present (#2197 probe).
		extraArgs: [
			"-c", "model_provider=e2e",
			"-c", "model_providers.e2e.name=OpenAI",
			"-c", `model_providers.e2e.base_url=http://127.0.0.1:${pA}/v1`,
			"-c", "model_providers.e2e.wire_api=responses",
			"-c", "model_providers.e2e.env_key=E2E_UPSTREAM_KEY",
		],
		prompt: "请只回复: 收到#8",
		fakePorts: [pA],
	});
	assert.equal(r.code, 0, `bili codex exec with -c provider selection must succeed (code=${r.code})\nlauncher stderr:\n${r.launcherOut.slice(-4000)}`);
	assert.match(r.last, /收到#8/, `the turn must have completed through the fake upstream (last="${r.last}")`);
	assertRoutedThroughBili(r.oracles[0], "CLI-selected provider");
	assertThreadRecorded(r.codexHome);
});

test("#2197: a user -c base_url override selects the target AND still routes through bili", { skip: skipReason, timeout: 300_000 }, async (t) => {
	const pA = await freePort();
	const pB = await freePort();
	const r = await runProfileCase(t, {
		tag: "2197c",
		configToml: [
			`model = "${MODEL}"`,
			'model_provider = "e2e"',
			"",
			"[model_providers.e2e]",
			'name = "OpenAI"',
			`base_url = "http://127.0.0.1:${pA}/v1"`,
			'wire_api = "responses"',
			'env_key = "E2E_UPSTREAM_KEY"',
			"",
		].join("\n"),
		extraArgs: ["-c", `model_providers.e2e.base_url=http://127.0.0.1:${pB}/v1`],
		prompt: "请只回复: 收到#9",
		fakePorts: [pA, pB],
	});
	assert.equal(r.code, 0, `bili codex exec with a -c base_url override must succeed (code=${r.code})\nlauncher stderr:\n${r.launcherOut.slice(-4000)}`);
	assert.match(r.last, /收到#9/, `the turn must have completed through the overridden endpoint (last="${r.last}")`);
	assert.ok(r.oracles[1].length > 0, "the CLI-overridden endpoint must be the one that served the request");
	assert.equal(r.oracles[0].length, 0, "the base-config endpoint must stay untouched once the user overrides it");
	assertRoutedThroughBili(r.oracles[1], "CLI-overridden endpoint");
	assertThreadRecorded(r.codexHome);
});

test("#2222: shared state — the live db stays in the real home across bili and native runs", { skip: skipReason, timeout: 480_000 }, async (t) => {
	// Issue #2222: with CODEX_SQLITE_HOME pointed at the real home (shared
	// state mode, the new default for codex >= 0.147.0), codex keeps its
	// WAL-mode state db on the SINGLE physical path in the REAL home instead
	// of bili copying it into the overlay per launch. Consequences pinned
	// here: the launcher announces the mode, the overlay never holds any
	// sqlite files, each thread lands directly in the live db, and a NATIVE
	// run (no bili) sees the history immediately — no merge-back window, no
	// .bili-conflict generation possible.
	const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-codex-2222-"));
	const codexCwd = fs.mkdtempSync(path.join(CWD_ROOT, "cwd-"));
	const codexHome = path.join(work, "codex-home");
	const xdg = {
		config: path.join(work, "xdg-config"),
		cache: path.join(work, "xdg-cache"),
		state: path.join(work, "xdg-state"),
	};
	for (const d of [codexHome, xdg.config, xdg.cache, xdg.state]) fs.mkdirSync(d, { recursive: true });
	const fakePort = await freePort();
	let fake: ReturnType<typeof spawn> | undefined;
	t.after(() => { if (fake?.pid) { try { process.kill(fake.pid, "SIGKILL"); } catch { /* gone */ } } });

	await assertPortDead(fakePort);
	fake = spawn(process.execPath, [FAKE_UPSTREAM], {
		env: { ...process.env, FAKE_PORT: String(fakePort), FAKE_HOST: "127.0.0.1", FAKE_MODEL: MODEL },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await waitFor(`http://127.0.0.1:${fakePort}/v1/models`, 15_000);

	fs.writeFileSync(path.join(codexHome, "config.toml"), [
		`model = "${MODEL}"`,
		'model_provider = "e2e"',
		"",
		"[model_providers.e2e]",
		'name = "OpenAI"',
		`base_url = "http://127.0.0.1:${fakePort}/v1"`,
		'wire_api = "responses"',
		'env_key = "E2E_UPSTREAM_KEY"',
		"",
	].join("\n"));

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const k of [
		"BILLION_CONTEXT_PROXY", "BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS", "BILI_MCP_PROXY",
		"BILI_NATIVE_CLAUDE", "BILLION_CONTEXT_PLUGIN", "BILI_ZONE_PORT", "BILI_CLAUDE_NATIVE_PORT",
		"BILI_UPSTREAM_PROXY", "ACP_PORT", "SSL_CERT_FILE",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy",
		// This lane pins the SHARED mechanism itself: an inherited mode override
		// or foreign sqlite home would silently move the db elsewhere and turn
		// the assertions into noise.
		"BILI_CODEX_STATE_MODE", "CODEX_SQLITE_HOME",
	]) delete childEnv[k];

	const launcherRun = (label: string, prompt: string): Promise<void> => new Promise((resolve, reject) => {
		const lastFile = path.join(work, `${label}.last`);
		const logFile = path.join(work, `${label}.log`);
		const child = spawn(process.execPath, [DIST, "codex", "exec", "--skip-git-repo-check", "--output-last-message", lastFile, prompt], {
			cwd: codexCwd,
			env: {
				...childEnv,
				CODEX_HOME: codexHome,
				XDG_CONFIG_HOME: xdg.config,
				XDG_CACHE_HOME: xdg.cache,
				XDG_STATE_HOME: xdg.state,
				BILLION_CONTEXT_NO_AUTO_UPDATE: "1",
				BILI_CLIENT_BIN: CODEX_BIN,
				E2E_UPSTREAM_KEY: "fake",
				RUST_LOG: "error",
				...windowEnv(60_000),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr!.on("data", (c: Buffer) => { try { fs.appendFileSync(logFile, c); } catch { /* noop */ } });
		const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } reject(new Error(`${label} timed out after ${TMO * 2}ms`)); }, TMO * 2);
		child.on("exit", (code) => {
			clearTimeout(timer);
			const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-4000) : "";
			if ((code ?? -1) !== 0) reject(new Error(`${label} exited with code=${code}\nlauncher stderr:\n${tail}`));
			else if (!fs.existsSync(lastFile) || !/收到#/.test(fs.readFileSync(lastFile, "utf8"))) reject(new Error(`${label}: the fake upstream never answered\nlauncher stderr:\n${tail}`));
			else resolve();
		});
	});

	const assertNoSqliteInOverlay = (): void => {
		// #3203: shared-mode overlays are per-session slots (<home>-bili-s<N>)
		// beside the real home; scan every one of them.
		const parent = path.dirname(codexHome);
		const prefix = `${path.basename(codexHome)}-bili`;
		for (const n of fs.readdirSync(parent)) {
			if (!n.startsWith(prefix)) continue;
			const p = path.join(parent, n);
			if (!fs.lstatSync(p).isDirectory()) continue;
			const offenders = fs.readdirSync(p).filter((x) => /\.(db|sqlite|sqlite3)(-.*)?$/.test(x));
			assert.deepEqual(offenders, [], `overlay ${n} must hold no sqlite files in shared mode, got ${JSON.stringify(offenders)}`);
		}
	};
	const assertNoConflicts = (): void => {
		for (const n of fs.readdirSync(codexHome)) assert.ok(!n.includes("bili-conflict"), `no quarantined generation in the real home: ${n}`);
	};
	const threadsInRealHome = (): number => {
		assert.ok(sqliteMod, "node:sqlite unavailable for db assertions");
		const p = path.join(codexHome, "state_5.sqlite");
		const db = new sqliteMod.DatabaseSync(p, { readOnly: true });
		try {
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => String(r.name));
			const threadTable = tables.find((x) => /thread/i.test(x));
			assert.ok(threadTable, `state_5.sqlite must carry a thread table, got ${JSON.stringify(tables)}`);
			return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${threadTable}`).get()!.c);
		} finally {
			db.close();
		}
	};

	// Launch 1: the shared-state mechanism must be ACTIVE (not silently
	// degraded to legacy), and the thread lands straight in the real home.
	await launcherRun("t1", "请只回复: 收到#1");
	assert.match(fs.readFileSync(path.join(work, "t1.log"), "utf8"), /codex state shared/, "the shared-state mechanism must be active for a modern codex");
	assert.ok(fs.existsSync(path.join(codexHome, "state_5.sqlite")), "the live db must live in the real home from the very first launch");
	const c1 = threadsInRealHome();
	assert.ok(c1 >= 1, "first launch's thread record must be readable in the real home");
	assertNoSqliteInOverlay();
	assertNoConflicts();

	// Launch 2: the second thread lands in the SAME live db — no copy, no
	// merge-back, nothing to adjudicate.
	await launcherRun("t2", "请只回复: 收到#2");
	const c2 = threadsInRealHome();
	assert.equal(c2, c1 + 1, `the second launch's thread must land directly in the shared live db: before=${c1} after=${c2}`);
	assertNoSqliteInOverlay();
	assertNoConflicts();

	// Native codex (NO bili) resumes the latest session immediately — under
	// the old overlay mechanism this was only guaranteed AFTER bili's
	// exit-time write-back; here there is no write-back window at all.
	const lastFile3 = path.join(work, "t3.last");
	const native = spawn(CODEX_BIN, ["exec", "--skip-git-repo-check", "--output-last-message", lastFile3, "resume", "--last", "请只回复: 收到#3"], {
		cwd: codexCwd,
		env: {
			...childEnv,
			CODEX_HOME: codexHome,
			XDG_CONFIG_HOME: xdg.config,
			XDG_CACHE_HOME: xdg.cache,
			XDG_STATE_HOME: xdg.state,
			E2E_UPSTREAM_KEY: "fake",
			RUST_LOG: "error",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	const code3 = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => { try { native.kill("SIGKILL"); } catch { /* gone */ } reject(new Error("native codex resume timed out")); }, TMO * 2);
		native.on("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
	});
	assert.equal(code3, 0, "native codex resume must succeed off the shared live db");
	assert.match(fs.readFileSync(lastFile3, "utf8"), /收到#2/, "the resumed session must carry launch 2's turn back into the model's view");
});

test("#3203: two concurrent bili codex sessions on ONE CODEX_HOME both run and keep their history", { skip: skipReason, timeout: 480_000 }, async (t) => {
	// Issue #3203: two terminals, same project dir, same CODEX_HOME — both
	// `bili codex` launches must work. Pre-#3203 the second one died with
	// BILI_OVERLAY_BUSY because every launch shared the fixed-name overlay
	// under an exclusive lease. Now each shared-mode launch takes its own
	// slot (<home>-bili-s<N>) while the state db stays canonical in the real
	// home (#2222), so both sessions route through their own proxy and land
	// their threads in the SAME live db with nothing to arbitrate.
	const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-codex-3203-"));
	const codexCwd = fs.mkdtempSync(path.join(CWD_ROOT, "cwd-"));
	const codexHome = path.join(work, "codex-home");
	const xdg = {
		config: path.join(work, "xdg-config"),
		cache: path.join(work, "xdg-cache"),
		state: path.join(work, "xdg-state"),
	};
	for (const d of [codexHome, xdg.config, xdg.cache, xdg.state]) fs.mkdirSync(d, { recursive: true });
	const fakePort = await freePort();
	let fake: ReturnType<typeof spawn> | undefined;
	t.after(() => { if (fake?.pid) { try { process.kill(fake.pid, "SIGKILL"); } catch { /* gone */ } } });

	await assertPortDead(fakePort);
	fake = spawn(process.execPath, [FAKE_UPSTREAM], {
		env: { ...process.env, FAKE_PORT: String(fakePort), FAKE_HOST: "127.0.0.1", FAKE_MODEL: MODEL },
		stdio: ["ignore", "pipe", "pipe"],
	});
	await waitFor(`http://127.0.0.1:${fakePort}/v1/models`, 15_000);

	fs.writeFileSync(path.join(codexHome, "config.toml"), [
		`model = "${MODEL}"`,
		'model_provider = "e2e"',
		"",
		"[model_providers.e2e]",
		'name = "OpenAI"',
		`base_url = "http://127.0.0.1:${fakePort}/v1"`,
		'wire_api = "responses"',
		'env_key = "E2E_UPSTREAM_KEY"',
		"",
	].join("\n"));

	const childEnv: NodeJS.ProcessEnv = { ...process.env };
	for (const k of [
		"BILLION_CONTEXT_PROXY", "BILI_PROVIDER_REWRITES", "BILI_MITM_HOSTS", "BILI_MCP_PROXY",
		"BILI_NATIVE_CLAUDE", "BILLION_CONTEXT_PLUGIN", "BILI_ZONE_PORT", "BILI_CLAUDE_NATIVE_PORT",
		"BILI_UPSTREAM_PROXY", "ACP_PORT", "SSL_CERT_FILE",
		"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
		"http_proxy", "https_proxy", "all_proxy", "no_proxy",
		// Pin the mechanism itself: an inherited mode override or foreign
		// sqlite home would silently move the db and mute the assertions.
		"BILI_CODEX_STATE_MODE", "CODEX_SQLITE_HOME",
	]) delete childEnv[k];

	const launcherRun = (label: string, prompt: string): Promise<void> => new Promise((resolve, reject) => {
		const lastFile = path.join(work, `${label}.last`);
		const logFile = path.join(work, `${label}.log`);
		const child = spawn(process.execPath, [DIST, "codex", "exec", "--skip-git-repo-check", "--output-last-message", lastFile, prompt], {
			cwd: codexCwd,
			env: {
				...childEnv,
				CODEX_HOME: codexHome,
				XDG_CONFIG_HOME: xdg.config,
				XDG_CACHE_HOME: xdg.cache,
				XDG_STATE_HOME: xdg.state,
				BILLION_CONTEXT_NO_AUTO_UPDATE: "1",
				BILI_CLIENT_BIN: CODEX_BIN,
				E2E_UPSTREAM_KEY: "fake",
				RUST_LOG: "error",
				...windowEnv(60_000),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr!.on("data", (c: Buffer) => { try { fs.appendFileSync(logFile, c); } catch { /* noop */ } });
		const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } reject(new Error(`${label} timed out after ${TMO * 2}ms`)); }, TMO * 2);
		child.on("exit", (code) => {
			clearTimeout(timer);
			const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-4000) : "";
			if ((code ?? -1) !== 0) reject(new Error(`${label} exited with code=${code}\nlauncher stderr:\n${tail}`));
			else if (!fs.existsSync(lastFile) || !/收到#/.test(fs.readFileSync(lastFile, "utf8"))) reject(new Error(`${label}: the fake upstream never answered\nlauncher stderr:\n${tail}`));
			else resolve();
		});
	});

	const assertNoSqliteInOverlay = (): void => {
		const parent = path.dirname(codexHome);
		const prefix = `${path.basename(codexHome)}-bili`;
		for (const n of fs.readdirSync(parent)) {
			if (!n.startsWith(prefix)) continue;
			const p = path.join(parent, n);
			if (!fs.lstatSync(p).isDirectory()) continue;
			const offenders = fs.readdirSync(p).filter((x) => /\.(db|sqlite|sqlite3)(-.*)?$/.test(x));
			assert.deepEqual(offenders, [], `overlay ${n} must hold no sqlite files in shared mode, got ${JSON.stringify(offenders)}`);
		}
	};
	const assertNoConflicts = (): void => {
		for (const n of fs.readdirSync(codexHome)) assert.ok(!n.includes("bili-conflict"), `no quarantined generation in the real home: ${n}`);
	};
	const threadsInRealHome = (): number => {
		assert.ok(sqliteMod, "node:sqlite unavailable for db assertions");
		const p = path.join(codexHome, "state_5.sqlite");
		const db = new sqliteMod.DatabaseSync(p, { readOnly: true });
		try {
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => String(r.name));
			const threadTable = tables.find((x) => /thread/i.test(x));
			assert.ok(threadTable, `state_5.sqlite must carry a thread table, got ${JSON.stringify(tables)}`);
			return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${threadTable}`).get()!.c);
		} finally {
			db.close();
		}
	};
	const slotDirs = (): string[] => {
		const parent = path.dirname(codexHome);
		const prefix = `${path.basename(codexHome)}-bili-s`;
		return fs.readdirSync(parent).filter((n) => {
			if (!n.startsWith(prefix)) return false;
			try { return fs.lstatSync(path.join(parent, n)).isDirectory(); } catch { return false; }
		});
	};

	// Pre-warm the fresh home with ONE sequential session before the
	// concurrent pair. codex ≤0.147.0 applies its sqlx migrations
	// non-atomically when first opening a brand-new state db: two codex
	// processes cold-starting milliseconds apart can interleave those
	// migrations and one of them aborts its whole state-runtime init ("while
	// executing migration 2: table logs already exists" — WARN only, hidden at
	// RUST_LOG=error), so that session's thread row is never written although
	// its rollout JSONL survives on disk. That race is upstream of bili (which
	// owns neither codex's schema nor its migrations), is not what this lane
	// tests, and does not occur in #3203's real scenario — two terminals in
	// the SAME project almost always share an already-migrated home. The warm
	// session closes the fresh-db window so the concurrency asserts below are
	// deterministic.
	await launcherRun("warm", "请只回复: 收到#1");
	const c0 = threadsInRealHome();

	// THE assertion of this issue: BOTH launches start at the same moment and
	// both must complete — pre-#3203 exactly one of them exited 1 with
	// BILI_OVERLAY_BUSY before spawning codex.
	// Digit suffixes: the fake answers with the FIRST 收到#<digits> it sees in
	// the request, so each session's marker must be digit-shaped.
	await Promise.all([
		launcherRun("cA", "请只回复: 收到#11"),
		launcherRun("cB", "请只回复: 收到#12"),
	]);

	const lanes = new Map<string, string>();
	for (const label of ["cA", "cB"]) {
		const log = fs.readFileSync(path.join(work, `${label}.log`), "utf8");
		assert.match(log, /codex state shared/, `${label}: the shared-state mechanism must be active`);
		assert.ok(!log.includes("BILI_OVERLAY_BUSY"), `${label}: must not be refused by the overlay lease\n${log.slice(-2000)}`);
		// Each session's proxy runs on its OWN per-session lane — the #3044
		// twin rule matches same lane+port+build, so a shared "codex" lane is
		// exactly what made the second concurrent launch die at EADDRINUSE.
		const m = log.match(/proxy runs on lane (codex-s\d+)/);
		assert.ok(m, `${label}: the launcher must declare its per-session proxy lane\n${log.slice(-2000)}`);
		lanes.set(label, m[1]);
	}
	assert.notEqual(lanes.get("cA"), lanes.get("cB"), `concurrent sessions must run on distinct proxy lanes: ${JSON.stringify([...lanes])}`);

	// Each session took its own slot from the bounded pool.
	const slots = slotDirs();
	assert.ok(slots.length >= 2, `expected >=2 per-session slots beside the real home, got ${JSON.stringify(slots)}`);

	// Both threads landed in the SAME live db — neither session's history was
	// lost to arbitration, regardless of which process exited first.
	const cEnd = threadsInRealHome();
	assert.equal(cEnd, c0 + 2, `both concurrent threads must survive in the shared live db: before=${c0} after=${cEnd}`);
	assertNoSqliteInOverlay();
	assertNoConflicts();
	assert.ok(fs.existsSync(path.join(codexHome, "installation_id")), "one canonical installation_id must exist in the real home");

	// A NATIVE run (no bili) resumes one of the two sessions immediately —
	// exit order of the two bili processes must not matter.
	const lastFile3 = path.join(work, "c3.last");
	const native = spawn(CODEX_BIN, ["exec", "--skip-git-repo-check", "--output-last-message", lastFile3, "resume", "--last", "请只回复: 收到#C"], {
		cwd: codexCwd,
		env: {
			...childEnv,
			CODEX_HOME: codexHome,
			XDG_CONFIG_HOME: xdg.config,
			XDG_CACHE_HOME: xdg.cache,
			XDG_STATE_HOME: xdg.state,
			E2E_UPSTREAM_KEY: "fake",
			RUST_LOG: "error",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	const code3 = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => { try { native.kill("SIGKILL"); } catch { /* gone */ } reject(new Error("native codex resume timed out")); }, TMO * 2);
		native.on("exit", (c) => { clearTimeout(timer); resolve(c ?? -1); });
	});
	assert.equal(code3, 0, "native codex resume must succeed after two concurrent bili sessions");
	assert.match(fs.readFileSync(lastFile3, "utf8"), /收到#1[12]/, "the resumed session must carry one of the concurrent turns back into the model's view");
});
