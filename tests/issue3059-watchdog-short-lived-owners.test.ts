import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rmrf } from "./tmp-rm.ts";

// #3059 regression: short-lived sequential CLI owners (pi -p / claude -p
// one-shots) register a watcher pid, work for less than one 2 s watchdog tick,
// and exit. The kill-0 sampler can phase-miss every such blip, observe an empty
// set for >= WATCHER_IDLE_GRACE_MS while clients are still attaching, and
// self-exit the proxy mid-workload (CI forensics: 100 ms owner blips between
// ticks -> premature `watchers-gone` fire -> the next client attached to a dead
// proxy and lost its tools). Strategy: arm a CHILD proxy (its exit path calls
// process.exit(0)) with a spawner owner, kill the spawner, then fire sub-tick
// "blip" owners each anchored ~800 ms after an OBSERVED tick (reactive
// alignment — no period prediction, so timer jitter cannot misplace them).
// Pre-fix, every tick deterministically sees an empty set and the proxy dies
// mid-chain (caught by the health monitor); post-fix, a registration within the
// grace window counts as presence and the chain survives. With the last blip
// gone, the proxy must STILL exit on its own — the recency term must not turn
// it into a squatter.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Telemetry { lastTickAt: number; lastRegistrationAt: number; watchers: number[]; }

async function getHealth(port: number): Promise<{ status: number; body: string } | null> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/__bili/health`, { signal: AbortSignal.timeout(1500) });
        return { status: res.status, body: await res.text() };
    } catch {
        return null;
    }
}

async function readTelemetry(port: number): Promise<Telemetry | null> {
    const h = await getHealth(port);
    if (!h || h.status !== 200) return null;
    try {
        const j = JSON.parse(h.body) as { watchdog?: { lastTickAt?: number; lastRegistrationAt?: number; watchers?: number[] } };
        return { lastTickAt: j.watchdog?.lastTickAt ?? 0, lastRegistrationAt: j.watchdog?.lastRegistrationAt ?? 0, watchers: j.watchdog?.watchers ?? [] };
    } catch {
        return null;
    }
}

test("sub-tick sequential owners must not trip the armed watchdog (#3059)", async () => {
    const root = path.join(tmpdir(), `bili-watchdog-3059-${process.pid}-${Date.now()}`);
    mkdirSync(path.join(root, "config"), { recursive: true });
    const configFile = path.join(root, "config", "billion-context.json");
    writeFileSync(configFile, '{"providers":{}}\n', "utf8");
    const logFile = path.join(root, "proxy-bili.log");
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        BILI_CONFIG_FILE: configFile,
    };
    delete env.BILLION_CONTEXT_PROXY;
    delete env.BILI_PARENT_PID;
    const children: ChildProcess[] = [];
    let helperPath: string | null = null;
    try {
        // Spawner owner — its pid arms the watchdog via BILI_PARENT_PID.
        const spawner = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore", env });
        children.push(spawner);
        await new Promise<void>((resolve, reject) => {
            spawner.once("spawn", () => resolve());
            spawner.once("error", reject);
        });
        assert.ok((spawner.pid ?? 0) > 1, "spawner owner spawned");

        // Child proxy: separate process because the watchdog's exit path calls
        // process.exit(0), which would take this test down with it. The helper
        // must live INSIDE the repo tree: Node resolves its bare "acp-kernel"
        // import by walking up from the FILE's location, and a tmpdir()
        // placement (e.g. /tmp on CI) has no node_modules above it. The
        // server.ts import stays RELATIVE — an absolute Windows path is not a
        // valid ESM specifier (ERR_UNSUPPORTED_ESM_URL_SCHEME on Node 22).
        const helperDir = path.join(repoRoot, "tmp");
        mkdirSync(helperDir, { recursive: true });
        const helper = path.join(helperDir, `issue3059-proxy-child-${process.pid}-${Date.now()}.mts`);
        helperPath = helper;
        writeFileSync(helper, [
            `import { startServer } from "../src/server.ts";`,
            `import { defaultConfig } from "acp-kernel";`,
            `const server = await startServer({ port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1:1", routes: {}, proxy: "", proxyMode: "direct", proxySource: "direct", modelContextLimit: 400_000, kernelConfig: defaultConfig(400_000), compress: { injectTool: true, injectNudge: true }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", logFile: ${JSON.stringify(logFile)}, log: true, debug: false, passthrough: false, autoUpdate: false, autoRestartOnUpdate: false, advisoryCheck: false, releaseNotesCheck: false, compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, updateTag: "latest", mitm: { enabled: false, domains: [] } });`,
            `if (!server.listening) await new Promise<void>((r) => server.once("listening", () => r()));`,
            `const addr = server.address();`,
            `process.stdout.write(\`PORT \${typeof addr === "object" && addr ? addr.port : -1}\\n\`);`,
            `setInterval(() => {}, 60000);`,
        ].join("\n") + "\n", "utf8");
        const proxy = spawn(process.execPath, ["--import", "tsx", helper], { cwd: repoRoot, env: { ...env, BILI_PARENT_PID: String(spawner.pid) }, stdio: ["ignore", "pipe", "pipe"] });
        children.push(proxy);
        let outBuf = "";
        let port = 0;
        proxy.stdout.on("data", (d: Buffer) => {
            outBuf += d.toString();
            const m = outBuf.match(/PORT (\d+)/);
            if (m && !port) port = Number(m[1]);
        });
        const proxyErr: string[] = [];
        proxy.stderr.on("data", (d: Buffer) => proxyErr.push(d.toString()));

        for (let i = 0; i < 300 && port === 0; i++) await sleep(100);
        assert.ok(port > 0, `child proxy printed its port (stdout: ${outBuf.slice(0, 300)}; stderr tail: ${proxyErr.join("").slice(-600)})`);
        for (let i = 0; i < 200; i++) {
            const h = await getHealth(port);
            if (h?.status === 200) break;
            if (i === 199) throw new Error(`proxy never became healthy; stderr tail: ${proxyErr.join("").slice(-600)}`);
            await sleep(50);
        }

        // Baseline: armed, spawner seeded, tick clock running. The first tick
        // lands ~2 s after arming, so poll for it rather than racing it.
        let base: Telemetry | null = null;
        for (let i = 0; i < 60 && !(base && base.lastTickAt > 0); i++) {
            base = await readTelemetry(port);
            if (!base || base.lastTickAt === 0) await sleep(100);
        }
        assert.ok(base, "health exposes watchdog telemetry");
        assert.ok(base!.watchers.length >= 1, "spawner pid seeds the watcher set");
        assert.ok(base!.lastTickAt > 0, "watchdog tick clock is running");

        // Kill the spawner: the set can now empty between blips.
        spawner.kill("SIGKILL");

        // Health monitor: any loss of health during the chain = premature death.
        let monitorStop = false;
        let death: string | null = null;
        const monitor = (async () => {
            while (!monitorStop) {
                const h = await getHealth(port);
                if (!h || h.status !== 200) {
                    death = h ? `HTTP ${h.status}` : "connection failed";
                    break;
                }
                await sleep(250);
            }
        })();

        // Blip owner: registers its own pid, holds ~400 ms (sub-tick), exits.
        const blipScript = [
            "const origin = process.argv[1];",
            'fetch(origin + "/__bili/watcher", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid: process.pid }) })',
            '  .then(async (r) => { if (!r.ok) console.error("BLIP_REG_FAIL", r.status); })',
            "  .catch((e) => console.error(\"BLIP_REG_ERR\", String(e)))",
            "  .finally(() => setTimeout(() => process.exit(0), 400));",
        ].join("\n");

        const N_BLIPS = 6;
        let seenTick = base!.lastTickAt;
        let regBefore = base!.lastRegistrationAt;
        let regMax = regBefore;
        for (let k = 0; k < N_BLIPS && !death; k++) {
            // Anchor reactively to the NEXT observed tick (±50 ms polling). The
            // blip then occupies [tick+~850, tick+~1300]: strictly interior to
            // the interval, so pre-fix sampling misses it deterministically and
            // no period model is needed (setInterval only ever lags, never
            // fires early — the upper bound stays safe under jitter).
            let anchored = false;
            for (let i = 0; i < 120 && !anchored; i++) {
                const t = await readTelemetry(port);
                if (t && t.lastTickAt > seenTick) {
                    seenTick = t.lastTickAt;
                    regBefore = t.lastRegistrationAt;
                    anchored = true;
                } else {
                    await sleep(50);
                }
            }
            assert.ok(anchored, `blip ${k}: watchdog kept ticking during the chain`);
            await sleep(800);
            const blip = spawn(process.execPath, ["-e", blipScript, `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"], env });
            children.push(blip);
            const bErr: string[] = [];
            blip.stderr.on("data", (d: Buffer) => bErr.push(d.toString()));
            await new Promise<void>((resolve) => {
                blip.once("exit", () => resolve());
                setTimeout(resolve, 5000).unref?.();
            });
            const errTxt = bErr.join("");
            assert.ok(!errTxt.includes("BLIP_REG_FAIL") && !errTxt.includes("BLIP_REG_ERR"), `blip ${k} registered cleanly (stderr: ${errTxt.slice(0, 300)})`);
            const t = await readTelemetry(port);
            if (t && t.lastRegistrationAt > regMax) regMax = t.lastRegistrationAt;
        }
        monitorStop = true;
        await monitor;
        assert.equal(death, null, "proxy survived a chain of sub-tick owners (no premature self-exit)");
        assert.ok(regMax > regBefore, "blip registrations advanced the registration clock");

        // Abandonment: no live owners AND no recent registrations — the proxy
        // must still exit on its own (recency must not create a squatter).
        const exited = await new Promise<boolean>((resolve) => {
            if (proxy.exitCode !== null) return resolve(true);
            const t = setTimeout(() => resolve(false), 20_000);
            proxy.once("exit", () => {
                clearTimeout(t);
                resolve(true);
            });
        });
        assert.ok(exited, "proxy exited after the last short-lived owner left (no squatting)");
        const logTxt = `${existsSync(logFile) ? readFileSync(logFile, "utf8") : ""}\n${proxyErr.join("")}`;
        assert.match(logTxt, /watchers-gone|parent-gone/, "self-exit went through the armed-watchdog reason");
    } finally {
        for (const c of children) {
            try { c.kill("SIGKILL"); } catch {}
        }
        if (helperPath) {
            try { rmSync(helperPath, { force: true }); } catch {}
        }
        await rmrf(root);
    }
});
