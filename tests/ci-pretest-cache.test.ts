import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cache from "../scripts/ci-pretest-cache.mjs";

// #4360 lever 1: the pretest dist content-hash cache. kernel/ and
// pi-subagents/ dist are pure functions of (src tree, build config,
// manifests, lockfiles); scripts/ci-pretest-cache.mjs stamps each dist with
// a marker of that hash after a REAL build and skips the rebuild only on a
// byte-exact marker match. These tests pin the correctness contract from the
// issue: never trust the cache — absent/stale/tampered markers are MISSes
// (real rebuild), only a byte-exact match is a HIT, the two components
// invalidate independently, and build failures propagate (exit non-zero).

function makeMiniRepo(): { root: string; write: (rel: string, v?: string) => void } {
    const root = mkdtempSync(join(tmpdir(), "bili-pretest-cache-"));
    const write = (rel: string, v = "x"): void => {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), v);
    };
    // The exact input surface of cache.COMPONENTS, mirrored as a fake tree.
    write("package-lock.json", "root-lock-v1");
    for (const [dir, extraLock] of [
        ["kernel", true],
        ["pi-subagents", false],
    ] as const) {
        write(`${dir}/src/index.ts`, `export const v = "${dir}";\n`);
        write(`${dir}/src/deep/util.ts`, `export const u = 1;\n`);
        write(`${dir}/tsup.config.ts`, "export default {};\n");
        write(`${dir}/tsconfig.json`, "{}\n");
        write(`${dir}/package.json`, `{"name":"${dir}"}\n`);
        if (extraLock) write(`${dir}/package-lock.json`, "component-lock-v1\n");
    }
    return { root, write };
}

/** Fake build: records invocations and materializes the dist it "built". */
function fakeBuild(seen: string[]) {
    return (comp: { dir: string }, root: string): void => {
        seen.push(comp.dir);
        mkdirSync(join(root, comp.dir, "dist"), { recursive: true });
        writeFileSync(join(root, comp.dir, "dist/index.js"), "built-bytes");
    };
}

test("cold → warm → tamper lifecycle (the #4360 CI sequence)", () => {
    const { root, write } = makeMiniRepo();
    const lines: string[] = [];
    const log = (l: string): void => {
        lines.push(l);
    };

    // COLD: no dist at all → both MISS, both really built, markers stamped.
    const seen1: string[] = [];
    const r1 = cache.runPretestCache({ root, build: fakeBuild(seen1), log });
    assert.deepEqual(
        r1.map((r) => [r.name, r.hit]),
        [
            ["kernel", false],
            ["pi-subagents", false],
        ],
    );
    assert.deepEqual(seen1, ["kernel", "pi-subagents"]);

    // WARM: nothing changed → both HIT, zero builds.
    const seen2: string[] = [];
    const r2 = cache.runPretestCache({ root, build: fakeBuild(seen2), log });
    assert.deepEqual(r2.map((r) => r.hit), [true, true]);
    assert.equal(seen2.length, 0);

    // TAMPER: one kernel source byte changes → ONLY kernel rebuilds; the
    // untouched component stays a HIT (independent invalidation).
    write("kernel/src/index.ts", "export const v = 'kernel-tampered';\n");
    const seen3: string[] = [];
    const r3 = cache.runPretestCache({ root, build: fakeBuild(seen3), log });
    assert.deepEqual(
        r3.map((r) => [r.name, r.hit]),
        [
            ["kernel", false],
            ["pi-subagents", true],
        ],
    );
    assert.deepEqual(seen3, ["kernel"]);

    // The exact log lines CI greps for (#4360).
    assert.ok(lines.some((l) => l.startsWith("pretest-cache: HIT (kernel)")));
    assert.ok(lines.some((l) => l.startsWith("pretest-cache: MISS (kernel) → rebuilding")));
});

test("marker must match byte-exactly — absent, stale, tampered, CRLF are decided by content", () => {
    const { root } = makeMiniRepo();
    const kernel = cache.COMPONENTS[0];
    const hash = cache.hashComponent(root, kernel);
    const dist = join(root, kernel.dir, "dist");

    mkdirSync(dist, { recursive: true });
    // absent marker
    assert.equal(cache.markerIsFresh(dist, hash), false);
    // wrong hash (e.g. restored from a stale cache entry)
    writeFileSync(join(dist, cache.MARKER_NAME), `${"0".repeat(64)}\n`);
    assert.equal(cache.markerIsFresh(dist, hash), false);
    // tampered: right hash plus trailing garbage
    writeFileSync(join(dist, cache.MARKER_NAME), `${hash}-extra`);
    assert.equal(cache.markerIsFresh(dist, hash), false);
    // byte-exact match (the trailing newline the stamper writes)
    writeFileSync(join(dist, cache.MARKER_NAME), `${hash}\n`);
    assert.equal(cache.markerIsFresh(dist, hash), true);
    // line-ending tolerance only: same hash, CRLF transport artifact
    writeFileSync(join(dist, cache.MARKER_NAME), `${hash}\r\n`);
    assert.equal(cache.markerIsFresh(dist, hash), true);
});

test("hash covers every input class: source, config, manifests, both lockfiles", () => {
    const { root, write } = makeMiniRepo();
    const kernel = cache.COMPONENTS[0];
    const pisub = cache.COMPONENTS[1];
    const base = cache.hashComponent(root, kernel);

    for (const rel of [
        "kernel/src/deep/util.ts", // nested source
        "kernel/tsup.config.ts", // build config
        "kernel/tsconfig.json",
        "kernel/package.json", // manifest (build script chain)
        "kernel/package-lock.json", // component lockfile
        "package-lock.json", // ROOT lockfile (toolchain pins)
    ]) {
        const orig = readFileSync(join(root, rel), "utf-8");
        write(rel, `${orig} #mut`);
        assert.notEqual(cache.hashComponent(root, kernel), base, `${rel} must change the kernel hash`);
        write(rel, orig);
    }

    // NEW file in the tree also invalidates (not just edits).
    write("kernel/src/new-file.ts", "export {};\n");
    assert.notEqual(cache.hashComponent(root, kernel), base);

    // A kernel change never moves the pi-subagents hash (independence).
    const pisubBase = cache.hashComponent(root, pisub);
    assert.equal(cache.hashComponent(root, pisub), pisubBase);
});

test("hash is deterministic and platform-seeded", () => {
    const { root } = makeMiniRepo();
    const kernel = cache.COMPONENTS[0];
    assert.equal(cache.hashComponent(root, kernel), cache.hashComponent(root, kernel));
    assert.notEqual(cache.hashComponent(root, kernel, "linux"), cache.hashComponent(root, kernel, "win32"));
});

test("root-lockfile bump invalidates BOTH components (shared toolchain pins)", () => {
    const { root, write } = makeMiniRepo();
    const before = cache.COMPONENTS.map((c) => cache.hashComponent(root, c));
    write("package-lock.json", "root-lock-v2");
    cache.COMPONENTS.forEach((c, i) => {
        assert.notEqual(cache.hashComponent(root, c), before[i], `${c.name} must invalidate on toolchain bump`);
    });
});

test("a missing input is a hard error, never a silent HIT", () => {
    const { root } = makeMiniRepo();
    const broken = { name: "kernel", dir: "kernel", inputs: ["src", "does-not-exist.ts"] };
    assert.throws(() => cache.hashComponent(root, broken), /does-not-exist\.ts/);
});

test("build failure propagates (CLI exit path) and stamps no marker", () => {
    const { root } = makeMiniRepo();
    const boom = (): void => {
        throw new Error("tsc exploded");
    };
    assert.throws(() => cache.runPretestCache({ root, build: boom }), /tsc exploded/);
    // no marker for a failed component → next run is an honest MISS
    assert.equal(cache.markerIsFresh(join(root, "kernel/dist"), "anything"), false);
});

// #4497 CI storm: an actions/cache restore brings kernel/dist back byte-exact
// (marker matches) but with the SAVED mtimes — older than the freshly
// checked-out sources. The mtime-based #3325 guard (kernelDistStale in
// tests/golden-storage-drive.ts) then fails the first drive of every golden
// leg with 'Rebuild first' on perfectly correct bytes. A verified HIT must
// present its dist as fresh: refresh mtimes, still without rebuilding.
test("HIT refreshes restored dist mtimes so mtime guards read it fresh (#4497)", () => {
    const { root } = makeMiniRepo();
    const kernel = cache.COMPONENTS[0];
    const hash = cache.hashComponent(root, kernel);
    const dist = join(root, kernel.dir, "dist");

    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.js"), "restored-bytes");
    writeFileSync(join(dist, cache.MARKER_NAME), `${hash}\n`);
    // Simulate the restore: correct bytes + marker, hour-old timestamps.
    const saved = new Date(Date.now() - 3600_000);
    utimesSync(join(dist, "index.js"), saved, saved);
    utimesSync(join(dist, cache.MARKER_NAME), saved, saved);
    assert.ok(statSync(join(dist, "index.js")).mtimeMs < Date.now() - 3500_000, "premise: restore looks stale");

    const seen: string[] = [];
    const before = Date.now();
    const r = cache.runPretestCache({ root, build: fakeBuild(seen), log: () => {} });
    assert.equal(r.find((x) => x.name === "kernel")?.hit, true);
    assert.ok(!seen.includes("kernel"), "a verified HIT never rebuilds");
    assert.ok(statSync(join(dist, "index.js")).mtimeMs >= before, "HIT refreshes dist mtimes to now");
});
