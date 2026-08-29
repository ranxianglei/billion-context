import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";

const run = process.env.ACP_TEST_E2E === "1";
const skipReason = !run ? "set ACP_TEST_E2E=1 (real codex + real upstream; costs tokens)" : undefined;

const UPSTREAM_URL = process.env.E2E_UPSTREAM_URL ?? "http://127.0.0.1:8199/v1";
const UPSTREAM_KEY = process.env.E2E_UPSTREAM_KEY ?? "bili-local-test";
const CODEX_BIN = process.env.E2E_CODEX_BIN ?? "codex";
const DIST = process.env.E2E_BILI_DIST ?? path.resolve(import.meta.dirname, "../../dist/index.js");
const MODEL = process.env.E2E_MODEL ?? "qwen3.8-27b";
const TMO = Number(process.env.E2E_TMO ?? 420_000);
const FORGE = process.env.E2E_FORGE === "1";
const WORK_ROOT = path.join(process.cwd(), "tmp");
fs.mkdirSync(WORK_ROOT, { recursive: true });
const WORK = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-codex-"));

/** Deterministic filler for payload turns: unique per index.
 * Carried verbatim in user messages so context growth is fully deterministic
 * (models routinely shrink tool output like `seq 1 1500 | tail -n 1`). */
function filler(i: number, lines: number): string {
    const out: string[] = [];
    for (let n = 0; n < lines; n += 1) {
        out.push(`doc#${String(i).padStart(2, "0")} line${String(n).padStart(4, "0")} checksum ${(n * 7919 + i * 104729) % 999983}`);
    }
    return out.join("\n");
}
const SENTINELS = [4781, 2903, 6577, 1249, 8461, 30217];

type Ctx = {
    proxy?: { pid: number; logPath: string };
    codexHome: string;
    xdg: { config: string; cache: string; state: string };
    port: number;
    resumed: boolean;
    turnCount: number;
};

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

function writeCodexConfig(ctx: Ctx): void {
    fs.mkdirSync(ctx.codexHome, { recursive: true });
    fs.writeFileSync(path.join(ctx.codexHome, "config.toml"), [
        `model = "${MODEL}"`,
        'model_provider = "e2e"',
        "model_context_window = 60000",
        "",
        "[model_providers.e2e]",
        'name = "OpenAI"',
        `base_url = "http://127.0.0.1:${ctx.port}/bili/${UPSTREAM_URL}"`,
        'wire_api = "responses"',
        'env_key = "E2E_UPSTREAM_KEY"',
        "",
    ].join("\n"));
}

function startProxy(ctx: Ctx, env: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const logPath = path.join(WORK, `bili-${Date.now()}.log`);
        const child = spawn(process.execPath, [DIST, "start", "--port", String(ctx.port), "--no-auto-update"], {
            env: {
                ...process.env,
                XDG_CONFIG_HOME: ctx.xdg.config,
                XDG_CACHE_HOME: ctx.xdg.cache,
                XDG_STATE_HOME: ctx.xdg.state,
                BILLION_CONTEXT_NO_AUTO_UPDATE: "1",
                ...env,
            },
            stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr!.on("data", (c: Buffer) => { try { fs.appendFileSync(logPath, c); } catch { /* noop */ } });
        ctx.proxy = { pid: child.pid!, logPath };
        const started = Date.now();
        const poll = (): void => {
            fetch(`http://127.0.0.1:${ctx.port}/__bili/health`).then((r) => {
                if (r.ok) resolve();
                else retry();
            }).catch(retry);
        };
        const retry = (): void => {
            if (Date.now() - started > 30_000) { killProxy(ctx); reject(new Error("proxy did not start in 30s")); return; }
            setTimeout(poll, 300);
        };
        poll();
        child.on("exit", (code) => {
            if (Date.now() - started < 30_000) reject(new Error(`proxy exited early (code ${code}); log: ${logPath}`));
        });
    });
}

function killProxy(ctx: Ctx): void {
    if (ctx.proxy && ctx.proxy.pid) {
        try { process.kill(ctx.proxy.pid, "SIGTERM"); } catch { /* already gone */ }
    }
    ctx.proxy = undefined;
}

function logs(ctx: Ctx): string {
    const parts: string[] = [];
    const stateLog = path.join(ctx.xdg.state, "billion-context", "bili.log");
    for (const f of fs.existsSync(stateLog) ? [stateLog] : []) parts.push(fs.readFileSync(f, "utf8"));
    for (const f of fs.readdirSync(WORK).filter((x) => x.startsWith("bili-")).sort()) {
        try { parts.push(fs.readFileSync(path.join(WORK, f), "utf8")); } catch { /* mid-rotation */ }
    }
    return parts.join("");
}

function turn(ctx: Ctx, prompt: string, extra: string[] = []): Promise<{ code: number; out: string; last: string }> {
    ctx.turnCount += 1;
    const label = `t${ctx.turnCount}`;
    const outFile = path.join(WORK, `${label}.out`);
    const lastFile = path.join(WORK, `${label}.last`);
    const args = ["exec", "--skip-git-repo-check", "--output-last-message", lastFile, ...extra];
    if (ctx.resumed) args.push("resume", "--last");
    args.push(prompt);
    return new Promise((resolve, reject) => {
        const child = spawn(CODEX_BIN, args, {
            cwd: WORK,
            env: { ...process.env, CODEX_HOME: ctx.codexHome, E2E_UPSTREAM_KEY: UPSTREAM_KEY, RUST_LOG: "error" },
            stdio: ["ignore", "ignore", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
        const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* noop */ }
            reject(new Error(`turn ${label} timed out after ${TMO}ms`));
        }, TMO);
        child.on("exit", (code) => {
            clearTimeout(timer);
            const last = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, "utf8").trim() : "";
            fs.writeFileSync(outFile, `exit=${code}\nstderr:\n${err}\nlast:\n${last}\n`);
            ctx.resumed = true;
            resolve({ code: code ?? -1, out: err, last });
        });
    });
}

/** Turn with one retry when `expect` rejects the answer — the relay sometimes
 * truncates the final message to whitespace while reasoning carries the
 * correct values (the #221 no-content family). */
async function turnExpect(
    ctx: Ctx,
    prompt: string,
    expect: (last: string) => boolean,
    extra: string[] = [],
): Promise<{ code: number; out: string; last: string }> {
    let best: { code: number; out: string; last: string } | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const r = await turn(ctx, attempt === 0
            ? prompt
            : `直接给出上一请求的答案, 不要执行压缩或任何工具调用。${prompt}`, extra);
        if (r.code === 0 && expect(r.last)) return r;
        if (!best || r.code === 0) best = r;
    }
    return best!;
}

function usageInputs(ctx: Ctx): number[] {
    const re = /\[acp-usage\] round \d+ input=(\d+)/g;
    const text = logs(ctx);
    const out: number[] = [];
    for (const m of text.matchAll(re)) out.push(Number(m[1]));
    return out;
}

function digits(s: string): number[] {
    return [...s.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

async function setup(): Promise<Ctx> {
    const ctx: Ctx = {
        codexHome: path.join(WORK, "codex-home"),
        xdg: {
            config: path.join(WORK, "xdg", "config"),
            cache: path.join(WORK, "xdg", "cache"),
            state: path.join(WORK, "xdg", "state"),
        },
        port: await freePort(),
        resumed: false,
        turnCount: 0,
    };
    for (const d of [ctx.codexHome, ctx.xdg.config, ctx.xdg.cache, ctx.xdg.state]) fs.mkdirSync(d, { recursive: true });
    return ctx;
}

test("e2e codex: warmup / load / ACP compress / purity / (forge)", { skip: skipReason }, async (t) => {
    const ctx = await setup();
    t.after(() => { killProxy(ctx); });

    // Phase 1 — warmup with a planted contamination value (purity guard later).
    writeCodexConfig(ctx);
    await startProxy(ctx, windowEnv(32_000));
    const w1 = await turn(ctx,
        `机密校准设定: 本会话的"基准计数"=1400, 仅作校准用。` +
        `请用 shell 工具运行: seq 1 1500 。完成后只回复最后一行数字, 不要其他内容。`);
    assert.strictEqual(w1.code, 0, `warmup exit=${w1.code} last=${w1.last}`);
    assert.ok(w1.last.includes("1500"), `warmup answer wrong: ${w1.last}`);

    // Phase 2 — load growth via payload user-messages (deterministic: content
    // rides the wire verbatim regardless of model behavior; models routinely
    // shrink tool output like `seq 1 1500 | tail -n 1`). Depth also matters:
    // soft protection only covers recent items, so older turns must exist.
    for (let i = 1; i <= 6; i += 1) {
        const li = await turnExpect(ctx,
            `档案片段 #${i} 如下, 请妥善保管:\n${filler(i, 150)}\n本档案哨兵值 = ${SENTINELS[i - 1]}。请只回复: 收到#${i}`,
            (last) => last.includes(`收到#${i}`) || /compress/i.test(last));
        assert.strictEqual(li.code, 0, `load${i} exit=${li.code}`);
        assert.ok(li.last.includes(`收到#${i}`) || /compress/i.test(li.last), `load${i} ack wrong: ${li.last}`);
    }
    const inputs = usageInputs(ctx);
    assert.ok(inputs.length >= 2, `no usage lines: ${logs(ctx).slice(-2000)}`);
    assert.ok(inputs[inputs.length - 1] > inputs[0], `usage did not grow: ${inputs.join(",")}`);

    // Phase 3 — ACP compression (evidence usually appears during the loads —
    // the window makes T1 nudges fire mid-load; one opportunistic extra turn
    // if not). Purity is asked IMMEDIATELY after: at a calm post-fold usage
    // level, or the model narrates another compression instead of answering.
    let compressed = /preflight compressed|compress requested|\[Compressed m/.test(logs(ctx));
    if (!compressed) {
        const c = await turn(ctx,
            `补充档案片段 #7 如下:\n${filler(7, 300)}\n哨兵值 = 9000。请只回复: 收到#7`);
        assert.strictEqual(c.code, 0, `compress-turn exit=${c.code}`);
        compressed = /preflight compressed|compress requested|\[Compressed m/.test(logs(ctx));
    }
    assert.ok(compressed, "no ACP compression observed within 3 turns");
    const post = usageInputs(ctx);
    assert.ok(Math.min(...post.slice(-3)) < Math.max(...post), `usage never dropped after compress: ${post.join(",")}`);

    // Phase 4 — purity: recall must beat the planted 1400 and survive compression.
    // One retry allowed: relays sometimes truncate the final message to
    // whitespace while the reasoning channel carries the correct values.
    const p1 = await turnExpect(ctx,
        "只回答两个数字, 用逗号分隔, 不要其他内容: 第一次 seq 打印了多少行? 档案#6 的哨兵值是多少?",
        (last) => digits(last).includes(SENTINELS[5]) && digits(last).includes(1500));
    assert.strictEqual(p1.code, 0, `purity exit=${p1.code}`);
    const got = digits(p1.last);
    assert.ok(got.includes(1500) && got.includes(SENTINELS[5]), `recall wrong (contaminated?): ${p1.last}`);
    assert.ok(!got.includes(1400), `contamination echo detected (planted 1400): ${p1.last}`);

    // Phase 5 — forge (capability-gated).
    if (!FORGE) { t.diagnostic("E2E_FORGE!=1 — forge phase skipped"); return; }
    // Restart under a big window: persist reloads the SAME session (blocks
    // survive — verified), and the gate's steady-vs-90% margin becomes
    // trivial. The small phase-1 window stays behind for compression phases.
    killProxy(ctx);
    await new Promise((r) => setTimeout(r, 800));
    await startProxy(ctx, { ...windowEnv(128_000), BILI_CODEX_COMPACT: "intercept" });
    const f0 = await turnExpect(ctx, `补充档案片段 #9 如下:\n${filler(9, 300)}\n哨兵值 = 9500。请只回复: 收到#9`,
        (last) => last.includes("收到#9") || /compress/i.test(last),
        ["-c", "model_auto_compact_token_limit=999999"]);
    assert.strictEqual(f0.code, 0, `forge-warm exit=${f0.code}`);
    assert.ok(/preflight compressed|compress requested/.test(logs(ctx)), "forge phase: no ACP block established");
    // Settle turn right after the restart's first fold.
    const f0b = await turnExpect(ctx, "请只回复: OK", (last) => /ok/i.test(last));
    assert.strictEqual(f0b.code, 0, `forge-settle exit=${f0b.code}`);
    const f1 = await turnExpect(ctx, `补充档案片段 #10 如下:\n${filler(10, 200)}\n哨兵值 = 9600。请只回复: 收到#10`,
        (last) => last.includes("收到#10") || /compress/i.test(last),
        ["-c", "model_auto_compact_token_limit=3000"]);
    assert.strictEqual(f1.code, 0, `forge-turn exit=${f1.code}`);
    assert.ok(/codex compact intercepted/.test(logs(ctx)),
        `forge not observed (BILI_CODEX_COMPACT support missing in dist, or gate passed through): last 3000 chars: ${logs(ctx).slice(-3000)}`);
    const f2 = await turnExpect(ctx, "只回答一个数字: 档案#10 的哨兵值是多少?",
        (last) => last.includes("9600"),
        ["-c", "model_auto_compact_token_limit=3000"]);
    assert.strictEqual(f2.code, 0, `post-forge exit=${f2.code}`);
    assert.ok(f2.last.includes("9600"), `post-forge recall wrong: ${f2.last}`);
    // Pre-forge compressed recall: 档案#6's sentinel was folded into an ACP
    // block in phase 3 (phase 4 proved it recallable from the summary) and is
    // NOT in codex's retained tail after the forge — it must survive via the
    // forged-summary handoff (developer-message re-injection), not via the
    // opaque compaction item.
    const f3 = await turnExpect(ctx, "只回答一个数字: 档案#6 的哨兵值是多少?",
        (last) => digits(last).includes(SENTINELS[5]),
        ["-c", "model_auto_compact_token_limit=999999"]);
    assert.strictEqual(f3.code, 0, `pre-forge-compressed recall exit=${f3.code}`);
    assert.ok(digits(f3.last).includes(SENTINELS[5]), `pre-forge compressed value lost after forge: ${f3.last}`);
    const sessionsDir = path.join(ctx.codexHome, "sessions");
    let rolloutHasForgeItem = false;
    if (fs.existsSync(sessionsDir)) {
        const walk = (d: string): void => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p);
                else if (e.name.endsWith(".jsonl") && fs.readFileSync(p, "utf8").includes("fc_bili_")) rolloutHasForgeItem = true;
            }
        };
        walk(sessionsDir);
    }
    assert.ok(rolloutHasForgeItem, "codex rollout has no fc_bili_ compaction item");
});

if (!run && process.env.E2E_CHECK === "1") {
    test("e2e preflight check", async () => {
        fs.accessSync(DIST);
        const v = await new Promise<string>((resolve, reject) => {
            const c = spawn(CODEX_BIN, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
            let o = ""; c.stdout.on("data", (x: Buffer) => { o += x; });
            c.on("exit", () => resolve(o.trim()));
            c.on("error", reject);
        });
        console.log(`codex: ${v}; dist: ${DIST}; upstream: ${UPSTREAM_URL}`);
        const probe = await fetch(`${UPSTREAM_URL}/models`).then((r) => r.status).catch(() => "unreachable");
        console.log(`upstream /models probe: ${probe}`);
    });
}

