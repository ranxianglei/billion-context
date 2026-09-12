import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const CODEX_BIN = process.env.E2E_CODEX_BIN ?? "codex";
const DIST = process.env.E2E_BILI_DIST ?? path.resolve(import.meta.dirname, "../../dist/index.js");
const MODEL = process.env.E2E_MODEL ?? "qwen3.8-27b";
const TMO = Number(process.env.E2E_TMO ?? 120_000);
const FAKE_UPSTREAM = path.join(import.meta.dirname, "fake-upstream.mjs");
const WORK_ROOT = path.join(process.cwd(), "tmp");
fs.mkdirSync(WORK_ROOT, { recursive: true });

function codexAvailable(): boolean {
	try { return spawnSync(CODEX_BIN, ["--version"], { timeout: 15_000 }).status === 0; } catch { return false; }
}
const run = process.env.ACP_TEST_E2E_FAKE === "1";
const skipReason = !run
	? "set ACP_TEST_E2E_FAKE=1 (real codex + local fake upstream; deterministic, zero tokens)"
	: (!codexAvailable() ? `codex binary "${CODEX_BIN}" not found on PATH` : undefined);

/** Deterministic filler: unique per index, bulky, carried verbatim in the prompt. */
function filler(i: number, lines: number): string {
	const out: string[] = [];
	for (let n = 0; n < lines; n += 1) {
		out.push(`doc#${String(i).padStart(2, "0")} line${String(n).padStart(4, "0")} checksum ${(n * 7919 + i * 104729) % 999983}`);
	}
	return out.join("\n");
}

type OracleEntry = { t: number; model: string; stream: boolean; isSummary: boolean; inputLen: number; input: unknown[] };

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

async function startCtx(contextWindow: number): Promise<Ctx> {
	const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-codex-fake-"));
	const ctx: Ctx = {
		work,
		codexHome: path.join(work, "codex-home"),
		xdg: { config: path.join(work, "xdg-config"), cache: path.join(work, "xdg-cache"), state: path.join(work, "xdg-state") },
		port: await freePort(),
		fakePort: await freePort(),
		reqLog: path.join(work, "fake-requests.jsonl"),
		resumed: false,
		turnCount: 0,
	};
	for (const d of [ctx.codexHome, ctx.xdg.config, ctx.xdg.cache, ctx.xdg.state]) fs.mkdirSync(d, { recursive: true });

	const fake = spawn(process.execPath, [FAKE_UPSTREAM], {
		env: { ...process.env, FAKE_PORT: String(ctx.fakePort), FAKE_HOST: "127.0.0.1", FAKE_REQLOG: ctx.reqLog, FAKE_MODEL: MODEL },
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
		`base_url = "http://127.0.0.1:${ctx.port}/bili/http://127.0.0.1:${ctx.fakePort}/v1"`,
		'wire_api = "responses"',
		'env_key = "E2E_UPSTREAM_KEY"',
		"",
	].join("\n"));

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
			cwd: ctx.work,
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

test("overflow: compression really happens in codex; bulk folded, sentinels retained", { skip: skipReason }, async (t) => {
	const ctx = await startCtx(12_000);
	t.after(() => teardown(ctx));

	const planted = [4781, 2903, 6577];
	const warm = await turn(ctx, `档案摘要:\n${planted.map((s) => `本档案哨兵值 = ${s}`).join("\n")}\n\n请确认收到, 只回复: 收到#1`);
	assert.equal(warm.code, 0, `warmup failed (code=${warm.code}); log:\n${logs(ctx)}`);

	for (let k = 2; k <= 5; k += 1) {
		const r = await turn(ctx, `${filler(k, 300)}\n\n请确认已读取档案#k, 只回复: 收到#${k}`);
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
	assert.ok(peak <= minLen * 1.3, `despite ~10KB filler injected on every load turn the forwarded payload must stay bounded (min=${minLen}, peak=${peak}); unbounded growth would mean compression is not folding the bulk`);

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
