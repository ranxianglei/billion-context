import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION, BUILD_COMMIT, versionWithCommit, PACKAGE_NAME, gitFallbackExecOptions } from "../src/version.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(root, "dist", "index.js");
// ci.yml runs `npm test` BEFORE `npm run build` — the two end-to-end tests
// below need a built dist, so they skip when absent (same convention as
// writeDshClientShim's "tests running before a build" no-op). The unit-level
// BUILD_COMMIT tests still run everywhere.

test("BUILD_COMMIT resolves to a short hash (dev checkout) or explicit unknown", () => {
    // In this repo's test environment the source tree IS a git checkout, so the
    // dev path must produce a real short hash. CI tarball builds exercise the
    // dist/build-info.json path instead.
    assert.match(BUILD_COMMIT, /^([0-9a-f]{7,12})(-dirty)?$|^unknown$/);
});

test("versionWithCommit renders the banner form", () => {
    assert.equal(versionWithCommit(), `${VERSION} (${BUILD_COMMIT})`);
    assert.match(versionWithCommit(), /^\d+\.\d+\.\d+ \(/);
});

// #2441: pin the git-fallback exec options so a future "simplification" cannot
// drop windowsHide (a console-less GUI host would flash a console per spawn).
// #2834: and cannot drop the explicit stdio either — without it Node forwards
// a failed probe's stderr onto the host terminal at every module load.
test("gitFallbackExecOptions: spawns hidden and keeps a failed probe's stderr off the terminal", () => {
    const opts = gitFallbackExecOptions();
    assert.equal(opts.windowsHide, true, "an unhidden console child makes Windows allocate a console window");
    assert.equal(opts.encoding, "utf8");
    assert.equal(opts.timeout, 10_000);
    assert.deepEqual([...opts.stdio], ["ignore", "pipe", "ignore"], "stdout must stay piped (carries the commit hash), stderr ignored");
});

// #2834: an npm install lives outside any git checkout, so the fallback probe
// fails there by design — and must fail silently. Run the real options through
// a real failing git in a child process and assert nothing reaches its stderr.
test("git fallback probe is silent when the dir is not a git checkout (#2834)", (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-nogit-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // Some sandboxes point TMPDIR at a git worktree; there the probe cannot
    // fail, so the silence assertion would verify nothing — skip honestly
    // (same convention as the dist-gated skips above).
    try {
        execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir });
        t.skip("tmpdir is inside a git checkout — the probe cannot fail there");
        return;
    } catch {}
    const versionUrl = pathToFileURL(path.join(root, "src", "version.ts")).href;
    const script = [
        'import { execFileSync } from "node:child_process";',
        `import { gitFallbackExecOptions } from ${JSON.stringify(versionUrl)};`,
        'try {',
        '  execFileSync("git", ["rev-parse", "--short", "HEAD"], { ...gitFallbackExecOptions(), cwd: process.argv[1] });',
        '} catch (e) {',
        '  if (typeof e?.status !== "number" || e.status === 0) console.error("PROBE-DID-NOT-FAIL");',
        "}",
    ].join("\n");
    const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, dir], { encoding: "utf8" });
    assert.equal(r.status, 0, `probe child crashed: ${r.stderr}`);
    assert.equal(r.stderr, "", "a failing probe must not reach the host terminal");
});

test("--version prints semver plus commit and stays regex-friendly", { skip: !fs.existsSync(distEntry) && "dist not built yet (npm run build)" }, () => {
    const entry = distEntry;
    assert.ok(fs.existsSync(entry), "dist/index.js must exist (run npm run build first)");
    const r = spawnSync(process.execPath, [entry, "--version"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // First token stays a bare semver (existing consumers match /x.y.z/);
    // the parenthesised commit rides after it.
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+ \([0-9a-f]{7,12}(-dirty)?\)$|^unknown$/);
    assert.ok(r.stdout.trim().startsWith(`${VERSION} `), `stdout must lead with ${VERSION}: ${r.stdout}`);
});

test("package name unchanged (sanity)", () => {
    assert.equal(PACKAGE_NAME, "billion-context");
});

test("health and overview endpoints expose the commit", { timeout: 90_000, skip: !fs.existsSync(distEntry) && "dist not built yet (npm run build)" }, async (t) => {
    // Boot a real proxy on a pre-probed free port (repo pattern: isolated XDG,
    // parse the origin from the state-dir log, kill in after()). --port 0 is
    // rejected by loadOptions, so we reserve a port ourselves first.
    const port = await new Promise<number>((resolvePort) => {
        const probe = net.createServer();
        probe.listen(0, "127.0.0.1", () => {
            const p = (probe.address() as net.AddressInfo).port;
            probe.close(() => resolvePort(p));
        });
    });
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bili-buildinfo-"));
    const child = spawn(
        process.execPath,
        [path.join(root, "dist", "index.js"), "start", "--port", String(port)],
        {
            env: {
                ...process.env,
                XDG_STATE_HOME: sandbox,
                XDG_CACHE_HOME: sandbox,
                XDG_DATA_HOME: sandbox,
                XDG_CONFIG_HOME: sandbox,
            },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );
    t.after(() => {
        child.kill("SIGKILL");
        fs.rmSync(sandbox, { recursive: true, force: true });
    });
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    let health: { ok?: boolean; version?: string; commit?: string } | undefined;
    while (Date.now() < deadline) {
        try {
            health = (await (await fetch(`${origin}/__bili/health`)).json()) as typeof health;
            if (health?.ok) break;
        } catch {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(health?.ok, "proxy never became healthy");
    assert.match(String(health.version), /^\d+\.\d+\.\d+$/);
    assert.match(String(health.commit), /^([0-9a-f]{7,12})(-dirty)?$|^unknown$/);
    const overview = (await (await fetch(`${origin}/__bili/overview`)).json()) as { commit?: string };
    assert.match(String(overview.commit), /^([0-9a-f]{7,12})(-dirty)?$|^unknown$/);
});
