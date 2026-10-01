// Release canary (#1811): a fully automated NO-OP self-update verification
// that runs against the BUILT tree of the exact ref that was just released.
//
// The recipe mirrors the manual 0.1.176→0.1.177→0.1.178 canary: the released
// code is packed TWICE with identical content but versions N-1 (the machine
// that is behind) and N (the just-published number), both pushed to a local
// verdaccio (loopback, zero secrets — registry-fixture.ts). Identical content
// means this verifies the PIPE (version discovery, semver compare, tarball
// download, staged in-place flip, stamps, dsh profile convergence) — payload
// quality is the regular CI's job.
//
// One scenario walks every channel through a single shared global tree, the
// way a real machine is laid out:
//   1. boot the N-1 install as a live proxy (1s check interval)
//   2. pre-update convergence (#1804): a dsh profile copy left at N-2 is
//      pulled to the GLOBAL version by the up-to-date branch alone
//   3. publish N → the LIVE proxy flips its own disk in place and keeps
//      serving on the old in-memory code; case-3 refresh pulls the profile
//   4. a profile that goes stale only AFTER the flip converges on a later
//      up-to-date cycle, then the checker goes silent (in-step skip)
//   5. restart from the updated tree: version is N, and the ACP smoke passes
//      (model turn → plugin compress fold → model turn)
//   6. post-update opencode plugin entry stays valid
//
// Gated like ACP_TEST_E2E/ACP_TEST_REGISTRY so plain `npm test` stays free.
// Driven by .github/workflows/ci-release-canary.yml on release publication.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as tar from "tar";
import { startRegistry } from "./registry-fixture.js";
import { rmrf } from "../tmp-rm.ts";

const run = process.env.ACP_TEST_CANARY === "1";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string; version: string; files: string[] };

const NEW_VERSION = PKG.version; // the just-published number
const OLD_VERSION = patchMinus(NEW_VERSION); // the machine that is behind
const STALE_VERSION = patchMinus(OLD_VERSION); // a dsh profile copy left far behind (#1803)

// Stable-only by design (#1811): prerelease / dev tags have no meaningful
// N-1/N-2 to synthesize, so the lane skips (loudly) instead of going red.
// Patch must be ≥ 2 because the scenario synthesizes both N-1 and N-2.
const stableVersion = /^\d+\.\d+\.\d+$/.test(PKG.version) && Number(PKG.version.split(".")[2]) >= 2;
const skipReason = !run
    ? "set ACP_TEST_CANARY=1 (release canary; hermetic loopback)"
    : !stableVersion
      ? `release canary needs a stable version with patch ≥ 2 (got ${PKG.version}); prerelease/dev tags skip`
      : undefined;

function patchMinus(v: string): string {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m || Number(m[3]) === 0) throw new Error(`cannot step version down: ${v}`);
    return `${m[1]}.${m[2]}.${Number(m[3]) - 1}`;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isolatedEnv(work: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, dir] of [
        ["HOME", "home"],
        ["XDG_CONFIG_HOME", "config"],
        ["XDG_CACHE_HOME", "cache"],
        ["XDG_STATE_HOME", "state"],
        ["XDG_DATA_HOME", "data"],
    ] as const) {
        const p = path.join(work, dir);
        fs.mkdirSync(p, { recursive: true });
        env[key] = p;
    }
    return env;
}

// Stage a publishable tarball of THIS package at a synthetic version: same
// files field, same dist build, rewritten package.json version (no-op
// content between the two tarballs — that is the point of the canary).
async function makeFixtureTarball(work: string, version: string): Promise<string> {
    const packs = path.join(work, "packs");
    fs.mkdirSync(packs, { recursive: true });
    const stage = path.join(work, "fixtures", version);
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({ ...PKG, version }, null, 2)}\n`);
    for (const entry of PKG.files) {
        const src = path.join(REPO_ROOT, entry);
        if (fs.existsSync(src)) await fs.promises.cp(src, path.join(stage, entry), { recursive: true });
    }
    const home = path.join(work, "home-pkg");
    fs.mkdirSync(home, { recursive: true });
    const listing = execNpm(["pack", "--silent", "--pack-destination", packs], stage, { HOME: home }).trim().split("\n").pop()?.trim();
    assert.ok(listing?.endsWith(".tgz"), `npm pack produced no tarball for ${version}: ${listing}`);
    return path.join(packs, listing!);
}

function execNpm(args: string[], cwd: string, env: Record<string, string>): string {
    const res = spawnSync("npm", args, { cwd, encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "", ...env } });
    assert.equal(res.status, 0, `npm ${args.join(" ")} failed:\n${res.stderr}${res.stdout}`);
    return res.stdout;
}

// The fake install MUST sit under a node_modules directory: isNpmInstallForm
// (plugin-install.ts) keys off that path shape, and the updater's git-tree
// guard needs no .git anywhere in the install (npm pack output has none).
async function extractInstall(work: string, tgz: string): Promise<string> {
    const installDir = path.join(work, "global", "node_modules", PKG.name);
    fs.mkdirSync(installDir, { recursive: true });
    await tar.x({ file: tgz, cwd: installDir, strip: 1 });
    return installDir;
}

async function readPkgVersion(dir: string): Promise<string> {
    return (JSON.parse(await fs.promises.readFile(path.join(dir, "package.json"), "utf8")) as { version: string }).version;
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const p = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(p));
        });
        s.on("error", reject);
    });
}

/** Deterministic host-major probe target for the opencode lane: prints a 2.x
 * version so detectOpencodeMajor() lands on key "plugins". */
function fakeOpencodeBin(work: string): string {
    const bin = path.join(work, "bin", "fake-opencode");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\necho 2.4.0\n");
    fs.chmodSync(bin, 0o755);
    return bin;
}

/** Fake dsh CLI: records every invocation to $FAKE_DSH_LOG and, for
 * `plugin --profile NAME add billion-context@V`, installs the copy the way
 * the real dsh plugin channel would (writes the profile's
 * node_modules/billion-context/package.json). The canary asserts on the log
 * AND on the resulting profile versions, so the in-step skip and converge
 * silence assertions are observationally real. */
function fakeDshBin(work: string, env: Record<string, string>): { bin: string; logPath: string } {
    const bin = path.join(work, "bin", "fake-dsh");
    const logPath = path.join(work, "bin", "fake-dsh.log");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, [
        "#!/bin/sh",
        `echo "$*" >> "${logPath}"`,
        `if [ "$1" = "plugin" ] && [ "$2" = "--profile" ] && [ "$4" = "add" ]; then`,
        `  name="$3"; ver="\`printf '%s' "$5" | sed 's/^.*@//' \`"`,
        `  d="${env.DSH_HOME}/profiles/$name/node_modules/billion-context"`,
        `  mkdir -p "$d"`,
        `  printf '{"name":"billion-context","version":"%s"}\\n' "$ver" > "$d/package.json"`,
        "fi",
        "exit 0",
        "",
    ].join("\n"));
    fs.chmodSync(bin, 0o755);
    return { bin, logPath };
}

function dshLogLines(logPath: string): string[] {
    try {
        return fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
    } catch {
        return [];
    }
}

/** Seed a dsh profile dir the way `dsh plugin add` leaves it: registry-pinned
 * manifest dep + an installed billion-context copy at `version`. */
function seedDshProfile(env: Record<string, string>, name: string, version: string): string {
    const profileDir = path.join(env.DSH_HOME!, "profiles", name);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
        path.join(profileDir, "package.json"),
        `${JSON.stringify({ dependencies: { "billion-context": "^0.1.0" }, dsh: { profile: { bundles: ["billion-context"] } } }, null, 2)}\n`,
    );
    const copyDir = path.join(profileDir, "node_modules", "billion-context");
    fs.mkdirSync(copyDir, { recursive: true });
    fs.writeFileSync(path.join(copyDir, "package.json"), `${JSON.stringify({ name: "billion-context", version }, null, 2)}\n`);
    return copyDir;
}

/** Plain-JSON chat upstream (non-stream). Every request gets a short reply. */
function startRelay(): { server: http.Server; port: Promise<number> } {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            id: "r1",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "canary reply" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: 5 },
        }));
    });
    const port = new Promise<number>((resolve, reject) => {
        server.once("listening", () => resolve((server.address() as net.AddressInfo).port));
        server.once("error", reject);
    });
    server.listen(0, "127.0.0.1");
    return { server, port };
}

type Proxy = {
    child: ChildProcess;
    output: () => string;
    stop: () => Promise<void>;
};

function spawnProxy(installDir: string, port: number, env: Record<string, string>): Proxy {
    const child = spawn(process.execPath, [path.join(installDir, "dist", "index.js"), "start", "--port", String(port)], {
        env: { PATH: process.env.PATH ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    return {
        child,
        output: () => out,
        stop: async () => {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    resolve();
                }, 5_000);
                child.on("exit", () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        },
    };
}

async function waitFor(what: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await what()) return;
        if (Date.now() > deadline) throw new Error(`canary timed out after ${timeoutMs}ms waiting for: ${label}`);
        await new Promise((r) => setTimeout(r, 250));
    }
}

async function healthOk(port: number): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/__bili/health`);
        if (!res.ok) return false;
        return ((await res.json()) as { ok?: boolean }).ok === true;
    } catch {
        return false;
    }
}

async function modelTurn(port: number, relayPort: number, conversation: string, userText: string): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "pi",
            "x-bili-plugin-conversation": conversation,
            "x-bili-plugin-model": "gpt-test",
        },
        body: JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: userText }] }),
    });
    assert.equal(res.status, 200, `model turn for ${conversation} must succeed`);
    await res.json();
}

async function toolPost(port: number, body: Record<string, unknown>): Promise<{ status: number; json: any }> {
    const res = await fetch(`http://127.0.0.1:${port}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
}

test("release canary: no-op self-update keeps every channel healthy (#1811)", { skip: skipReason }, async () => {
    assert.ok(fs.existsSync(DIST_ENTRY), "dist/index.js missing — run `npm run build` first");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-canary-"));
    const relay = startRelay();
    const relayPort = await relay.port;
    const registry = await startRegistry(path.join(work, "registry"));
    let proxy: Proxy | undefined;
    let failed = false;
    try {

        // ── machine setup: global tree one version behind, a dsh profile two behind ──
        const oldTgz = await makeFixtureTarball(work, OLD_VERSION);
        const newTgz = await makeFixtureTarball(work, NEW_VERSION);
        await registry.publish(oldTgz);
        const installDir = await extractInstall(work, oldTgz);
        assert.equal(await readPkgVersion(installDir), OLD_VERSION);

        const envBase = isolatedEnv(work);
        envBase.DSH_HOME = path.join(work, "dsh-home");
        fs.mkdirSync(path.join(envBase.DSH_HOME, "profiles"), { recursive: true });
        const dsh = fakeDshBin(work, envBase);
        envBase.BILI_DSH_BIN = dsh.bin;
        envBase.FAKE_DSH_LOG = dsh.logPath;
        const webCopyDir = seedDshProfile(envBase, "web", STALE_VERSION);
        envBase.BILI_UPDATE_REGISTRY = registry.url;
        envBase.BILI_UPDATE_CHECK_INTERVAL_MS = "1000";

        // ── phase 1: boot the behind-machine as a live proxy ──
        const port = await freePort();
        proxy = spawnProxy(installDir, port, envBase);
        await waitFor(() => healthOk(port), 30_000, "proxy healthy after boot");

        // ── phase 2: pre-update convergence (#1804) — the up-to-date branch alone
        // pulls a dsh profile copy that is behind the GLOBAL version ──
        await waitFor(async () => (await readPkgVersion(webCopyDir)) === OLD_VERSION, 40_000, `dsh profile web converged to ${OLD_VERSION} before any update`);
        assert.ok(
            dshLogLines(dsh.logPath).some((l) => l.includes(`plugin --profile web add billion-context@${OLD_VERSION}`)),
            `fake dsh log must show the web converge spawn: ${JSON.stringify(dshLogLines(dsh.logPath))}`,
        );

        // ── phase 3: publish N — the LIVE proxy flips its own disk in place ──
        await registry.publish(newTgz);
        await waitFor(async () => (await readPkgVersion(installDir)) === NEW_VERSION, 60_000, `global tree flipped to ${NEW_VERSION} by the live proxy`);
        await waitFor(
            () => new RegExp(`installed ${escapeRe(OLD_VERSION)} → ${escapeRe(NEW_VERSION)}\\. Restart to finish\\.`).test(proxy!.output()),
            30_000,
            "proxy must log the in-place install",
        );
        // case-3 refresh pulls the profile along with the update
        await waitFor(async () => (await readPkgVersion(webCopyDir)) === NEW_VERSION, 40_000, `dsh profile web refreshed to ${NEW_VERSION} by case-3`);
        // the live proxy keeps serving on the old in-memory code across the flip
        await modelTurn(port, relayPort, "canary-live", "turn during the flip window");

        // ── phase 4: a profile that goes stale only AFTER the flip converges on a
        // later up-to-date cycle, then the checker goes silent (in-step skip) ──
        const headlessCopyDir = seedDshProfile(envBase, "headless", STALE_VERSION);
        await waitFor(async () => (await readPkgVersion(headlessCopyDir)) === NEW_VERSION, 40_000, `dsh profile headless converged to ${NEW_VERSION} without any update event`);
        const linesAfterConverge = dshLogLines(dsh.logPath).length;
        await new Promise((r) => setTimeout(r, 3_500)); // ≥3 check cycles at 1s
        assert.equal(dshLogLines(dsh.logPath).length, linesAfterConverge, "in-step profiles must never re-spawn dsh (silent convergence)");

        // ── phase 5: restart from the updated tree — version N and the ACP smoke ──
        await proxy.stop();
        const versionRes = spawnSync(process.execPath, [path.join(installDir, "dist", "index.js"), "--version"], {
            encoding: "utf8",
            timeout: 30_000,
            env: { PATH: process.env.PATH ?? "", ...envBase },
        });
        assert.match(`${versionRes.stdout}${versionRes.stderr}`, new RegExp(escapeRe(NEW_VERSION)), "restarted tree must report the new version");

        proxy = spawnProxy(installDir, port, envBase);
        await waitFor(() => healthOk(port), 30_000, "proxy healthy after restart on the updated tree");
        const bigText = `canary fold material. ${"The quick brown fox jumps over the lazy dog while the proxy counts tokens. ".repeat(220)}`;
        await modelTurn(port, relayPort, "canary-smoke", bigText);
        const fold = await toolPost(port, { tool: "compress", conversationId: "canary-smoke", args: {} });
        assert.equal(fold.status, 200, `plugin compress must answer 200: ${JSON.stringify(fold.json)}`);
        assert.equal(fold.json?.ok, true, `plugin compress must succeed: ${JSON.stringify(fold.json)}`);
        assert.ok(typeof fold.json?.result === "string" && fold.json.result.length > 0, "fold must return a summary");
        await modelTurn(port, relayPort, "canary-smoke", "post-fold turn");

        // ── phase 6: post-update opencode plugin entry stays valid ──
        const ocCfg = path.join(envBase.XDG_CONFIG_HOME!, "opencode", "opencode.jsonc");
        fs.mkdirSync(path.dirname(ocCfg), { recursive: true });
        fs.writeFileSync(ocCfg, `${JSON.stringify({ plugins: ["billion-context"], compaction: { auto: false } }, null, 2)}\n`);
        const pluginRes = spawnSync(process.execPath, [path.join(installDir, "dist", "index.js"), "plugin", "install", "opencode"], {
            encoding: "utf8",
            timeout: 120_000,
            env: { PATH: process.env.PATH ?? "", ...envBase, BILI_CLIENT_BIN: fakeOpencodeBin(work) },
        });
        assert.equal(pluginRes.status, 0, `post-update plugin install failed:\n${pluginRes.stdout}${pluginRes.stderr}`);
        assert.ok(fs.readFileSync(ocCfg, "utf8").includes("billion-context"), "opencode entry must survive the update");
    } catch (err) {
        failed = true;
        throw err;
    } finally {
        await proxy?.stop();
        await new Promise<void>((resolve) => relay.server.close(() => resolve()));
        await registry.stop().catch(() => {});
        if (failed) {
            // Keep the whole work dir (proxy output, verdaccio logs, fake-dsh
            // call log, both packs, the global tree) for the workflow's
            // failure artifacts — rmrf only on success.
            fs.writeFileSync(path.join(work, "diagnostics.txt"), proxy?.output() ?? "(no proxy output)");
            console.error(`[canary] failure — keeping work dir for artifacts: ${work}`);
        } else {
            rmrf(work);
        }
    }
});
