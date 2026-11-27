// #7806: `bili install <ref>` — source-build install from a git ref (branch /
// tag / PR number / PR URL) with an auto-pin. The flow is exercised OFFLINE:
// fake `git` and `npm` PATH shims stand in for the real tools (shimmed
// global root, fixture source tree, recorded argv), so the suite asserts the
// exact command sequence --install-links included without touching the
// network or the machine's real global install.

// bash PATH shims cannot spawn on win32 (extensionless files, shebangs) —
// and the install lane itself is win32-unexercised (childEnv history); the
// pure ref-mapping test below still runs everywhere.
const nodeTest = (await import("node:test")).default;
const test = process.platform === "win32" ? nodeTest.skip.bind(nodeTest) : nodeTest;
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach } from "node:test";
import { childEnv, DEFAULT_INSTALL_PIN_DAYS, installFromRef, installStatus, installSrcDir, resolveInstallRef } from "../src/install-ref.js";
import { pinFilePath, readPin } from "../src/update-pin.js";

const FAKE_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

const GIT_SHIM = `#!/usr/bin/env bash
cmd="$1"; shift || true
case "$cmd" in
  init) mkdir -p "$PWD/.git" ;;
  remote)
    sub="$1"; shift || true
    if [ "$sub" = "remove" ]; then exit 0; fi
    if [ "$sub" = "add" ] || [ "$sub" = "set-url" ]; then
      url="$3"; [ -n "$url" ] && echo "origin $url" > "$GITSTATE/remote-url"
    fi ;;
  fetch)
    ref="$5"
    if [ "$ref" = "pull/9999/head" ]; then
      echo "fatal: couldn't find remote ref pull/9999/head" >&2
      exit 1
    fi
    echo "$ref" > "$GITSTATE/fetched-ref"
    echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" > "$GITSTATE/sha"
    ;;
  rev-parse)
    [ "$1" = "FETCH_HEAD" ] && cat "$GITSTATE/sha"
    ;;
  checkout)
    cp -r "$FIXTURE_SRC/." "$PWD/"
    ;;
  *) exit 0 ;;
esac
exit 0
`;

const NPM_SHIM = `#!/usr/bin/env bash
echo "npm $*" >> "$NPMLOG"
case "$1" in
  root)
    [ "$2" = "-g" ] && echo "$GLOBALROOT"
    exit 0 ;;
  run)
    [ "$2" = "build" ] && { mkdir -p "$PWD/dist"; echo '#!/usr/bin/env node' > "$PWD/dist/index.js"; }
    exit 0 ;;
esac
dir=""
want=""
for a in "$@"; do
  case "$a" in
    install) want=1 ;;
    -*) ;;
    *) if [ "$want" = "1" ]; then dir="$a"; want=""; fi ;;
  esac
done
if [ -n "$dir" ]; then
  n=0; [ -f "$GITSTATE/gi-count" ] && n=$(cat "$GITSTATE/gi-count")
  n=$((n+1)); echo "$n" > "$GITSTATE/gi-count"
  if [ "$n" -gt 1 ] && [ -f "$GITSTATE/brick" ]; then
    echo "npm error ETIMEDOUT (injected) — registry fetch aborted mid-install" >&2
    exit 1
  fi
  rm -rf "$GLOBALROOT/billion-context"
  cp -r "$dir" "$GLOBALROOT/billion-context"
fi
exit 0
`;

interface Harness {
    binDir: string;
    globalRoot: string;
    stateDir: string;
    fixture: string;
    logFile: string;
    env: NodeJS.ProcessEnv;
    npmLog(): string[];
}

function makeHarness(): Harness {
    const root = mkdtemp();
    const binDir = path.join(root, "bin");
    const globalRoot = path.join(root, "global");
    const stateDir = path.join(root, "gitstate");
    const fixture = path.join(root, "fixture-src");
    for (const d of [binDir, globalRoot, stateDir, fixture]) mkdirSync(d, { recursive: true });
    writeFileSync(path.join(binDir, "git"), GIT_SHIM);
    writeFileSync(path.join(binDir, "npm"), NPM_SHIM);
    chmodSync(path.join(binDir, "git"), 0o755);
    chmodSync(path.join(binDir, "npm"), 0o755);
    writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "billion-context", version: "9.9.9" }));
    writeFileSync(path.join(fixture, "src-index.ts"), "// fixture source\n");
    const logFile = path.join(root, "npm.log");
    const env: NodeJS.ProcessEnv = {
        ...childEnv(),
        PATH: binDir + path.delimiter + childEnv().PATH,
        GITSTATE: stateDir,
        GLOBALROOT: globalRoot,
        FIXTURE_SRC: fixture,
        NPMLOG: logFile,
    };
    return {
        binDir, globalRoot, stateDir, fixture, logFile, env,
        npmLog: () => (existsSync(logFile) ? readFileSync(logFile, "utf-8").trim().split("\n") : []),
    };
}

function mkdtemp(): string {
    return mkdtempSync(path.join(os.tmpdir(), "bili-install-ref-"));
}

// The pin file is machine-level (XDG cache dir shared by all tests in this
// process under CI's hermetic preload): clear it between tests so one
// install's auto-pin cannot short-circuit the next test's install.
beforeEach(() => rmSync(pinFilePath(), { force: true }));

function seedCurrentInstall(globalRoot: string, version: string): void {
    const dir = path.join(globalRoot, "billion-context");
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "billion-context", version }));
    writeFileSync(path.join(dir, "dist", "index.js"), "// old build\n");
}

function backupNames(globalRoot: string): string[] {
    return readdirSync(globalRoot).filter((e) => e.startsWith("billion-context.bak-")).sort();
}

 // Pure mapping — no bash shim, so it runs on win32 too (the file-level
 // `test` alias skips the shim-based suite there; #6805 review: the header
 // comment promised this one still runs everywhere).
 nodeTest("#7806 resolveInstallRef: PR number, PR URL, branch, master, tag", () => {
    assert.deepEqual(resolveInstallRef("7738"), { ref: "pull/7738/head", kind: "pr" });
    assert.deepEqual(resolveInstallRef("https://github.com/ranxianglei/billion-context/pull/7738"), { ref: "pull/7738/head", kind: "pr" });
    assert.deepEqual(resolveInstallRef("https://github.com/ranxianglei/billion-context/pull/7738/files#diff-x"), { ref: "pull/7738/head", kind: "pr" });
    assert.deepEqual(resolveInstallRef("master"), { ref: "master", kind: "ref" });
    assert.deepEqual(resolveInstallRef("feat/eg-sweep"), { ref: "feat/eg-sweep", kind: "ref" });
    assert.deepEqual(resolveInstallRef("v0.1.999"), { ref: "v0.1.999", kind: "ref" });
    assert.throws(() => resolveInstallRef("   "), /empty ref/);
});

test("#7806 install from a PR number: fetch → build → backup → install -g --install-links → verify → auto-pin (30d default)", async () => {
    const H = makeHarness();
    seedCurrentInstall(H.globalRoot, "0.1.216");
    const now = Date.now();
    try {
        const r = await installFromRef("7738", { env: H.env, now });
        assert.equal(r.ok, true);
        assert.equal(r.version, "9.9.9");
        assert.equal(r.sha, FAKE_SHA);
        assert.deepEqual(r.spec, { ref: "pull/7738/head", kind: "pr" });
        assert.ok(r.pinUntil !== undefined, "default pin must be time-bound");
        const day = 24 * 3600 * 1000;
        assert.ok(Math.abs((r.pinUntil as number) - (now + DEFAULT_INSTALL_PIN_DAYS * day)) < 60_000, "default pin ≈ now + 30d");

        // The swap: real copy (not a symlink), dist present.
        const installed = path.join(H.globalRoot, "billion-context");
        assert.ok(!lstatSync(installed).isSymbolicLink(), "global install must be a real copy (#1225)");
        assert.ok(existsSync(path.join(installed, "dist", "index.js")));
        assert.equal(readFileSync(path.join(installed, "package.json"), "utf-8").includes("9.9.9"), true);

        // Backup of the previous install exists and was named with its version.
        const baks = backupNames(H.globalRoot);
        assert.equal(baks.length, 1);
        assert.match(baks[0]!, /^billion-context\.bak-0\.1\.216-/);

        // The global install used --install-links (never a symlink).
        const installLine = H.npmLog().find((l) => l.startsWith("npm install -g"));
        assert.ok(installLine, "npm install -g must have run");
        assert.ok(installLine!.includes("--install-links"), `expected --install-links in: ${installLine}`);
        assert.ok(installLine!.includes(installSrcDir()), "installed tree must be the cache src dir");

        // Auto-pin carries the git provenance (#7806).
        const pin = await readPin();
        assert.ok(pin, "pin file must exist");
        assert.equal(pin!.version, "9.9.9");
        assert.deepEqual(pin!.source, { kind: "git", ref: "pull/7738/head", sha: FAKE_SHA });
    } finally {
        rmSync(path.dirname(H.binDir), { recursive: true, force: true });
    }
});

test("#7806 re-install the same ref: skipped (pin provenance matches); --force rebuilds", async () => {
    const H = makeHarness();
    seedCurrentInstall(H.globalRoot, "0.1.216");
    try {
        const r1 = await installFromRef("7738", { env: H.env });
        assert.equal(r1.skipped, undefined);
        const installsAfterFirst = H.npmLog().filter((l) => l.startsWith("npm install")).length;

        // Same ref resolves to the same sha (shim is deterministic) and the
        // pin records that provenance → no rebuild, no backup, pin intact.
        const r2 = await installFromRef("7738", { env: H.env });
        assert.equal(r2.ok, true);
        assert.equal(r2.skipped, true);
        assert.equal(r2.version, "9.9.9");
        assert.equal(H.npmLog().filter((l) => l.startsWith("npm install")).length, installsAfterFirst, "skip must not run npm install");
        assert.equal(backupNames(H.globalRoot).length, 1, "skip must not create a backup");

        // --force rebuilds anyway.
        const r3 = await installFromRef("7738", { env: H.env, force: true });
        assert.equal(r3.ok, true);
        assert.equal(r3.skipped, undefined);
        assert.equal(backupNames(H.globalRoot).length, 2, "the forced rebuild backs up again");
    } finally {
        rmSync(path.dirname(H.binDir), { recursive: true, force: true });
    }
});

test("#7806 backup retention: after install exactly the 2 newest backups survive", async () => {
    const H = makeHarness();
    seedCurrentInstall(H.globalRoot, "1.0.4");
    for (const v of ["1.0.1", "1.0.2", "1.0.3"]) {
        const dir = path.join(H.globalRoot, `billion-context.bak-${v}-2020-01-0${v.slice(-1)}T00-00-00-000Z`);
        mkdirSync(dir, { recursive: true });
        // mtime retention: give the seeds distinct OLD mtimes so "newest" is
        // unambiguous (the fresh backup is touched to now by the lane itself).
        const t = new Date(Date.UTC(2020, 0, Number(v.slice(-1))));
        utimesSync(dir, t, t);
    }
    try {
        await installFromRef("master", { env: H.env });
        const baks = backupNames(H.globalRoot);
        assert.equal(baks.length, 2, `expected 2 backups, got: ${JSON.stringify(baks)}`);
        assert.match(baks[1]!, /^billion-context\.bak-1\.0\.4-/, "the just-replaced install is the newest backup");
        assert.ok(baks[0]!.includes("1.0.3"), "second-newest old backup survives");
    } finally {
        rmSync(path.dirname(H.binDir), { recursive: true, force: true });
    }
});

test("#7806 duration override: 7d bounds the pin; forever leaves it unbounded", async () => {
    const H = makeHarness();
    try {
        const r7 = await installFromRef("master", { env: H.env, pinDurationText: "7d" });
        const day = 24 * 3600 * 1000;
        assert.ok(Math.abs((r7.pinUntil as number) - (Date.now() + 7 * day)) < 60_000, "7d pin ≈ now + 7d");

        // Different ref → different provenance → full install again.
        const rF = await installFromRef("v9.9.9", { env: H.env, pinDurationText: "forever" });
        assert.equal(rF.pinUntil, undefined, "forever = no expiry");
        const pin = await readPin();
        assert.equal(pin?.until, undefined);
        assert.deepEqual(pin?.source, { kind: "git", ref: "v9.9.9", sha: FAKE_SHA });
    } finally {
        rmSync(path.dirname(H.binDir), { recursive: true, force: true });
    }
});

test("#7806 unknown ref: the fetch failure leaves the current install completely untouched", async () => {
    const H = makeHarness();
    seedCurrentInstall(H.globalRoot, "0.1.216");
    try {
        await assert.rejects(() => installFromRef("9999", { env: H.env }), /pull\/9999\/head/);
        const cur = path.join(H.globalRoot, "billion-context");
        assert.ok(existsSync(cur), "current install must survive a failed fetch");
        assert.match(readFileSync(path.join(cur, "package.json"), "utf-8"), /0\.1\.216/);
        assert.equal(backupNames(H.globalRoot).length, 0, "no backup is created before the build succeeds");
        assert.equal(await readPin(), undefined, "no pin is written on failure");
    } finally {
        rmSync(path.dirname(H.binDir), { recursive: true, force: true });
    }
});

test("#7806 swap failure AFTER the backup auto-restores the previous install (no dangling bin)", async () => {
    const H = makeHarness();
    seedCurrentInstall(H.globalRoot, "0.1.216");
    try {
        // First install succeeds (gi-count → 1, no brick file yet).
        await installFromRef("7738", { env: H.env });
        // Arm the brick: the NEXT global install (npm i -g) fails mid-flight —
        // after the backup rename, i.e. in the window where the global root
        // has no working install.
        writeFileSync(path.join(H.stateDir, "brick"), "1");
        // The auto-restore succeeds here, so the error must say
        // "auto-restored" — NOT "kept at <path> (restore manually: mv …)",
        // which would point at a backup path that no longer exists (#6805
        // review: the hint branch was keyed off the original error text and
        // could never see the restore outcome).
        await assert.rejects(
            () => installFromRef("7738", { env: H.env, force: true }),
            /install step failed: npm install .* — previous install auto-restored/,
        );
        const cur = path.join(H.globalRoot, "billion-context");
        assert.ok(existsSync(cur), "the previous install must be BACK (auto-restore)");
        assert.match(readFileSync(path.join(cur, "package.json"), "utf-8"), /9\.9\.9/, "restored content = the install that was on disk before the failed swap");
        // The FIRST install's pin survived (it describes exactly what is on
        // disk again after the restore — auto-upgrade must stay check-only).
        const pin = await readPin();
        assert.equal(pin?.version, "9.9.9");
        assert.deepEqual(pin?.source, { kind: "git", ref: "pull/7738/head", sha: FAKE_SHA });
    } finally {
        rmSync(path.dirname(H.binDir), { recursive: true, force: true });
    }
});

test("#7806 install status reports disk version + git provenance", async () => {
    const H = makeHarness();
    try {
        await installFromRef("7738", { env: H.env });
        const st = await installStatus(H.env);
        assert.equal(st.version, "9.9.9");
        assert.equal(st.pinned, true);
        assert.deepEqual(st.source, { kind: "git", ref: "pull/7738/head", sha: FAKE_SHA });
        assert.match(st.line, /9\.9\.9/);
        assert.match(st.line, /pull\/7738\/head/);
    } finally {
        rmSync(path.dirname(H.binDir), { recursive: true, force: true });
    }
});

test("#7806 pin readPin: keeps a well-shaped source, drops a malformed one, keeps the pin valid", async () => {
    try {
        const now = Date.now();
        // Malformed sha → source dropped, pin still resolves.
        writeFileSync(pinFilePath(), JSON.stringify({ v: 1, version: "9.9.9", setAt: now, source: { kind: "git", ref: "x", sha: "not-a-sha" } }));
        let pin = await readPin();
        assert.equal(pin?.version, "9.9.9");
        assert.equal(pin?.source, undefined);
        // Well-shaped → kept.
        writeFileSync(pinFilePath(), JSON.stringify({ v: 1, version: "9.9.9", setAt: now, source: { kind: "git", ref: "pull/1/head", sha: FAKE_SHA } }));
        pin = await readPin();
        assert.deepEqual(pin?.source, { kind: "git", ref: "pull/1/head", sha: FAKE_SHA });
    } finally {
        rmSync(pinFilePath(), { force: true });
    }
});
