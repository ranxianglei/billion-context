// e2e: `bili update` CLI against the hermetic local registry — REAL npm
// global layout (#6643).
//
// Why this suite exists next to e2e-advisory-rollback:
//  - the advisory suite's fake install is a `tar.x` extract — it never goes
//    through npm, so the package's `node_modules/.bin` shim tree (RELATIVE
//    symlinks on POSIX) is absent from its install dir. #6643's EINVAL was
//    invisible to every layer of CI for exactly that reason: unit tests
//    mock fetch + hand-build dirs, and no e2e ever materialized an
//    npm-produced global install.
//  - this suite does the one thing none of them do: `npm install -g
//    --prefix <isolated>` of a fixture tarball (the layout npm actually
//    ships), then a real `bili update` against the fixture registry and a
//    version-advance assertion. The update itself runs the
//    installViaTarball path (fetch + on-disk swap), so any regression in
//    the backup/atomic-swap/merge-copy logic surfaces in minutes on a PR —
//    not at the next real-model gate.
//
// Lane: ACP_TEST_REGISTRY=1 (same hermetic lane as e2e-advisory-rollback /
// e2e-registry; loopback-only, offline, secret-free).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { test } from "node:test";
import { startRegistry } from "./registry-fixture.js";
import { biliSpawnEnv, isolatedEnv, npmHomeEnv, npmRunSync, windowsSystemEnv } from "./crossplat.ts";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
    name: string;
    files?: string[];
    scripts?: Record<string, string>;
};

const run = process.env.ACP_TEST_REGISTRY === "1";
const skipReason = !run ? "set ACP_TEST_REGISTRY=1 (hermetic local-registry e2e; loopback only)" : undefined;

// Synthetic ascending pair — plain semver (the fixture registry is
// isolated, nothing can collide), and the fixture's `npm publish` has no
// --tag, which refuses prerelease versions.
const START = "0.1.210";
const NEXT = "0.1.211";

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(what: string, deadlineMs: number, fn: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        if (await fn()) return;
        await sleep(300);
    }
    assert.fail(`timed out waiting for ${what}`);
}

function packTarball(stage: string, packs: string, home: string): string {
    const listing = npmRunSync(["pack", "--silent", "--pack-destination", packs], { cwd: stage, env: { PATH: process.env.PATH ?? "", ...npmHomeEnv(home) } })
        .trim()
        .split("\n")
        .pop()
        ?.trim();
    return listing ?? "";
}

// Stage a publishable tarball of THIS package at a synthetic version (same
// shape as e2e-advisory-rollback's helper). The real dependency set is
// replaced by a single fixture dep (mime below): the hermetic registry has
// no uplinks, so every resolvable package must be published into it — and
// one bin-bearing dep is exactly what materializes the npm .bin shim tree
// inside the install dir (#6643 trap layout).
async function makeFixtureTarball(work: string, version: string): Promise<string> {
    const packs = path.join(work, "packs");
    fs.mkdirSync(packs, { recursive: true });
    const stage = path.join(work, "fixtures", version);
    fs.mkdirSync(stage, { recursive: true });
    // The staged copy models a PUBLISHED artifact: registry installs never
    // run prepare, so drop the hook referencing the non-shipped guard script.
    fs.writeFileSync(
        path.join(stage, "package.json"),
        `${JSON.stringify({ ...PKG, version, dependencies: { mime: "4.0.7" }, optionalDependencies: {}, scripts: Object.fromEntries(Object.entries(PKG.scripts ?? {}).filter(([name]) => name !== "prepare")) }, null, 2)}\n`,
    );
    for (const entry of PKG.files) {
        const src = path.join(REPO_ROOT, entry);
        if (fs.existsSync(src)) await fs.promises.cp(src, path.join(stage, entry), { recursive: true });
    }
    const home = path.join(work, "home-pkg");
    fs.mkdirSync(home, { recursive: true });
    const listing = packTarball(stage, packs, home);
    assert.ok(listing.endsWith(".tgz"), `npm pack produced no tarball for ${version}: ${listing}`);
    return path.join(packs, listing);
}

// The minimal bin-bearing fixture dep ("mime") — published into the same
// isolated registry so `npm install -g` of the fixture package resolves a
// real (closed-world) dependency tree and lays out the authentic .bin
// shims inside the install dir.
async function makeMimeFixture(work: string): Promise<string> {
    const packs = path.join(work, "packs");
    fs.mkdirSync(packs, { recursive: true });
    const stage = path.join(work, "fixtures", "mime-4.0.7");
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({ name: "mime", version: "4.0.7", description: "e2e fixture dep (hermetic registry)", main: "cli.js", bin: { mime: "cli.js" } }, null, 2)}\n`);
    fs.writeFileSync(path.join(stage, "cli.js"), "console.log(\"fixture mime\");\n");
    const home = path.join(work, "home-pkg");
    fs.mkdirSync(home, { recursive: true });
    const listing = packTarball(stage, packs, home);
    assert.ok(listing.endsWith(".tgz"), `npm pack produced no mime fixture: ${listing}`);
    return path.join(packs, listing);
}

/** Run the installed CLI as a one-shot: resolves exit code + combined output. */
function runCli(installDir: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
    const child: ChildProcess = spawn(process.execPath, [path.join(installDir, "dist", "index.js"), ...args], { env: biliSpawnEnv(env) });
    let out = "";
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (out += String(d)));
    return new Promise((resolve) => {
        child.on("error", (e) => resolve({ code: -1, out: out + String(e) }));
        child.on("exit", (code) => resolve({ code, out }));
    });
}

test("e2e: `bili update` advances a REAL npm global install (hermetic registry)", { skip: skipReason }, async (t) => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, "dist", "index.js")), "dist/index.js missing — run `npm run build` first");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-selfupdate-"));
    let reg: Awaited<ReturnType<typeof startRegistry>> | undefined;
    t.after(async () => {
        await reg?.stop();
        await fs.promises.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    });

    const envBase = isolatedEnv(work);
    const cliEnv = {
        ...envBase,
        BILI_UPDATE_REGISTRY: "", // filled after the registry is up
        BILI_UPDATE_POLICY_URL: "http://127.0.0.1:1/no-policy.json",
    };

    reg = await startRegistry(path.join(work, "registry"));
    cliEnv.BILI_UPDATE_REGISTRY = reg.url;

    // Publish the fixture dep first, then both versions ascending so
    // `latest` ends on NEXT.
    await reg.publish(await makeMimeFixture(work));
    await reg.publish(await makeFixtureTarball(work, START));
    await reg.publish(await makeFixtureTarball(work, NEXT));

    // --- the piece no other suite has: an npm-produced global install
    const prefix = path.join(work, "npm-prefix");
    fs.mkdirSync(prefix, { recursive: true });
    const installRes = await reg.npm(["install", "-g", `${PKG.name}@${START}`, `--prefix`, prefix]);
    const rootRes = await reg.npm(["root", "-g", `--prefix`, prefix]);
    const globalRoot = rootRes.stdout.trim().split("\n").pop()?.trim() ?? "";
    const installDir = path.join(globalRoot || path.join(prefix, "node_modules"), PKG.name);
    assert.ok(fs.existsSync(path.join(installDir, "package.json")), `npm install -g landed nothing at ${installDir}: ${installRes.stdout} ${installRes.stderr}`);
    assert.ok(installDir.includes(`${path.sep}node_modules${path.sep}`), `install is not in npm global form: ${installDir}`);
    assert.equal((JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8")) as { version: string }).version, START, "npm installed the wrong starting version");

    // #6643 trap layout: on POSIX, npm lays the package's deps out under
    // installDir/node_modules with RELATIVE .bin symlinks — the exact shape
    // the self-copy guard (EINVAL) needs. Verify we are on it when the
    // platform produces it; Windows ships .cmd shims instead, where the
    // hazard class is file locking (covered by the same update runs).
    const binLink = path.join(installDir, "node_modules", ".bin", "mime");
    if (process.platform !== "win32") {
        assert.ok(fs.existsSync(binLink), "npm global layout missing node_modules/.bin/mime — the #6643 EINVAL shape is not materialized; layout assertion would be vacuous");
        const linkTarget = fs.readlinkSync(binLink);
        if (!linkTarget.startsWith("..") && !path.isAbsolute(linkTarget)) {
            // Absolute-ish or odd form: the trap layout is not present on
            // this npm version (e.g. node 25 / npm 11 writes absolute
            // links) — the update assertions below still run, they just
            // cannot red-pin #6643 on THIS host.
            console.log(`[selfupdate] note: .bin/mime link target is "${linkTarget}" (not the relative npm-10 shape) — #6643 red-pin active only on relative-link npm`);
        }
    }

    // --- 1) `bili update` must move START → NEXT on disk AND report it
    const upd = await runCli(installDir, ["update"], cliEnv);
    assert.equal(upd.code, 0, `bili update exited ${upd.code}: ${upd.out.slice(0, 2000)}`);
    const installedRe = new RegExp(`\\[update\\] installed ${escapeRe(START)} → ${escapeRe(NEXT)}\\. Restart to finish\\.`);
    assert.match(upd.out, installedRe, `update did not install the newer version:\n${upd.out.slice(-2000)}`);
    await waitFor(`disk version ${NEXT}`, 15_000, async () => {
        try {
            return (JSON.parse(await fs.promises.readFile(path.join(installDir, "package.json"), "utf8")) as { version: string }).version === NEXT;
        } catch {
            return false; // the swap can be momentarily mid-rename — retry, don't crash
        }
    });
    const ver = await runCli(installDir, ["--version"], cliEnv);
    assert.equal(ver.code, 0, `bili --version exited ${ver.code}: ${ver.out}`);
    assert.match(ver.out, new RegExp(`^${escapeRe(NEXT)}(\\s.*)?$`, "m"), `version report after update (expected ${NEXT} prefix): ${JSON.stringify(ver.out.trim())}`);

    // --- 2) a second `bili update` is a clean no-op — no re-install churn,
    //     no leftover backup/state, exit 0.
    const upd2 = await runCli(installDir, ["update"], cliEnv);
    assert.equal(upd2.code, 0, `second bili update exited ${upd2.code}: ${upd2.out.slice(0, 2000)}`);
    assert.doesNotMatch(upd2.out, new RegExp(`\\[update\\] installed ${escapeRe(NEXT)} →`), "second update must not re-install over itself:\n" + upd2.out.slice(-1000));
    assert.equal((JSON.parse(fs.readFileSync(path.join(installDir, "package.json"), "utf8")) as { version: string }).version, NEXT, "second update changed the disk");
});
