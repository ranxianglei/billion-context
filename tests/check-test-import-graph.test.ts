// Regression tests for scripts/check-test-import-graph.mjs (#6831): on
// Windows, path.relative() emits backslash-shaped paths while git ls-files
// (the SRC_FILES source) is always slash-shaped, so resolveSpec() matched
// nothing, the BFS stopped at the entries, and the gate reported "ok" for
// every test import. Runs the REAL script as a child process against a
// throwaway git fixture; the win32 shape is simulated with a --import preload
// that rewrites path.relative's output to backslashes, so the fix is pinned
// on every CI leg, not just the Windows one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rmrf } from "./tmp-rm.ts";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/check-test-import-graph.mjs");

const WIN_REL_PRELOAD =
    'import path from "node:path";\n' +
    "const rel = path.relative;\n" +
    'path.relative = (a, b) => rel(a, b).split("/").join("\\\\");\n';

type GateRun = { code: number; stdout: string; stderr: string };

function makeFixture(dir: string, withViolation: boolean): void {
    // src/index.ts is one of the script's hardcoded production entries, so
    // ./live is reachable and ./dead is not.
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "tests"), { recursive: true });
    writeFileSync(path.join(dir, "preload.mjs"), WIN_REL_PRELOAD);
    writeFileSync(path.join(dir, "src/index.ts"), 'import "./live";\nexport const entry = 1;\n');
    writeFileSync(path.join(dir, "src/live.ts"), "export const live = 1;\n");
    writeFileSync(path.join(dir, "src/dead.ts"), "export const dead = 1;\n");
    writeFileSync(path.join(dir, "tests/clean.test.ts"), 'import "../src/live";\n');
    writeFileSync(path.join(dir, "tests/pin.test.ts"), '// retired-module pin: dead\nimport "../src/dead";\n');
    if (withViolation) {
        writeFileSync(path.join(dir, "tests/bad.test.ts"), 'import "../src/dead";\n');
    }
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
}

function runGate(dir: string, simulateWinRel: boolean): GateRun {
    // --import takes a module specifier, not a path: on Windows a raw absolute
    // path is parsed as a URL with protocol "c:" (ERR_UNSUPPORTED_ESM_URL_SCHEME).
    // A file:// URL is accepted on every platform, so hand the loader one.
    const preload = pathToFileURL(path.join(dir, "preload.mjs")).href;
    const args = simulateWinRel
        ? ["--import", preload, SCRIPT]
        : [SCRIPT];
    try {
        const stdout = execFileSync(process.execPath, args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
        return { code: 0, stdout, stderr: "" };
    } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
}

function withFixture(withViolation: boolean, fn: (dir: string) => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), "bc-import-graph-"));
    try {
        makeFixture(dir, withViolation);
        fn(dir);
    } finally {
        rmrf(dir);
    }
}

test("fails an unlabeled test import of an unreachable module (native separators)", () => {
    withFixture(true, (dir) => {
        const run = runGate(dir, false);
        assert.equal(run.code, 1);
        assert.ok(run.stderr.includes("tests/bad.test.ts → src/dead.ts"), run.stderr);
        assert.ok(run.stdout.includes("reachable: 2"), run.stdout);
    });
});

test("passes a clean fixture (native separators)", () => {
    withFixture(false, (dir) => {
        const run = runGate(dir, false);
        assert.equal(run.code, 0, run.stdout + run.stderr);
        assert.ok(run.stdout.includes("ok: every test import of an unreachable module is whitelisted or labeled."), run.stdout);
    });
});

test("fails an unlabeled test import of an unreachable module (win32-shaped relative, #6831)", () => {
    withFixture(true, (dir) => {
        const run = runGate(dir, true);
        assert.equal(run.code, 1, `gate must trip under the win32 shape, got:\n${run.stdout}\n${run.stderr}`);
        assert.ok(run.stderr.includes("tests/bad.test.ts → src/dead.ts"), run.stderr);
        assert.ok(run.stdout.includes("reachable: 2"), run.stdout);
    });
});

test("passes a clean fixture and honors the pin label (win32-shaped relative, #6831)", () => {
    withFixture(false, (dir) => {
        const run = runGate(dir, true);
        assert.equal(run.code, 0, run.stdout + run.stderr);
        assert.ok(run.stdout.includes("retired-module pin labeled"), run.stdout);
    });
});
