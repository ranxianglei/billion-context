// Entry-guard regression: npm hosts (opencode 1.18.x's plugin loader) resolve
// the package through exports ("./server" first; the root "." now points at
// the dsh host half) — but the CLI entry dist/index.js stays importable in
// host processes, so importing it must stay side-effect-free. An unguarded
// main() dispatched a
// CLI against the HOST's argv there: plain `opencode` defaulted to "start" and
// crashed on the occupied 8787 port; `opencode run x` hit unknown-command and
// process.exit(2)'d the host. Importing must stay side-effect-free; direct
// invocation must keep dispatching.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { rmrf } from "./tmp-rm.ts";

const root = path.resolve(import.meta.dirname, "..");

// CI runs `npm test` before `npm run build`; exercise the BUILT entry (the
// file hosts actually import) and build on demand when dist/ is absent.
function ensureDistBuilt(entry: string): void {
    if (!fs.existsSync(entry)) {
        execFileSync(process.execPath, [path.join(root, "node_modules", "tsup", "dist", "cli-default.js")], { cwd: root, stdio: "pipe", timeout: 300_000 });
    }
    assert.ok(fs.existsSync(entry), `build did not produce ${entry}`);
}

function runNode(args: string[], opts: { cwd?: string } = {}): { code: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, args, { cwd: opts.cwd ?? root, encoding: "utf8", timeout: 60_000 });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("package root export points at the dsh host half and stays inert (#1590)", () => {
    // dsh's loader imports the bare package name (scanner requires a package
    // ROOT specifier), so exports["."] must resolve to the dsh plugin, never
    // the CLI entry — and importing it must not run anything. opencode is
    // unaffected either way: both its loaders try exports["./server"] first
    // (1.18.x resolvePackageEntrypoint reads exports[`./server`]; 2.x tries
    // ["server", ""] in order).
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    assert.equal(pkg.exports["."], "./dist/agent/dsh-native.js");
    const entry = path.join(root, "dist", "agent", "dsh-native.js");
    ensureDistBuilt(entry);
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "bili-entry-guard-"));
    try {
        const host = path.join(box, "host.mjs");
        fs.writeFileSync(host, `import(${JSON.stringify(pathToFileURL(entry).href)}).then((m) => { process.stdout.write("name:" + typeof m.name + " apply:" + typeof m.apply + "\\n"); });\n`);
        const r = runNode([host]);
        assert.equal(r.code, 0, `stderr: ${r.stderr}`);
        assert.match(r.stdout, /^name:string apply:function$/m);
        assert.doesNotMatch(r.stdout + r.stderr, /bili:|unknown command|EADDRINUSE/);
    } finally {
        rmrf(box);
    }
});

test("import-only host: awaiting import of the entry runs no CLI", () => {
    const entry = path.join(root, "dist", "index.js");
    ensureDistBuilt(entry);
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "bili-entry-guard-"));
    try {
        // Exactly opencode's posture: a host script whose OWN argv[1] is the
        // host, importing the package entry as a module.
        const host = path.join(box, "host.mjs");
        fs.writeFileSync(host, `import(${JSON.stringify(pathToFileURL(entry).href)}).then(() => { process.stdout.write("HOST-IMPORT-OK\\n"); });\n`);
        const r = runNode([host]);
        assert.equal(r.code, 0, `stderr: ${r.stderr}`);
        assert.match(r.stdout, /HOST-IMPORT-OK/);
        assert.doesNotMatch(r.stdout + r.stderr, /bili:|port 8787|unknown command/);
    } finally {
        rmrf(box);
    }
});

test("import-only host under tsx: src entry equally inert", () => {
    const srcEntry = path.join(root, "src", "index.ts");
    const box = fs.mkdtempSync(path.join(os.tmpdir(), "bili-entry-guard-"));
    try {
        const host = path.join(box, "host.ts");
        // Top-level await would be CJS-incompatible under tsx outside a
        // package scope — the .then() form works in both module flavors.
        fs.writeFileSync(host, `import(${JSON.stringify(pathToFileURL(srcEntry).href)}).then(() => { process.stdout.write("HOST-IMPORT-OK\\n"); });\n`);
        const r = runNode(["--import", "tsx", host]);
        assert.equal(r.code, 0, `stderr: ${r.stderr}`);
        assert.match(r.stdout, /HOST-IMPORT-OK/);
    } finally {
        rmrf(box);
    }
});

test("direct invocation still dispatches the CLI", () => {
    const entry = path.join(root, "dist", "index.js");
    ensureDistBuilt(entry);
    const version = runNode([entry, "--version"]);
    assert.equal(version.code, 0, `stderr: ${version.stderr}`);
    assert.match(version.stdout, /\d+\.\d+\.\d+/);
    // An unknown command is dispatched and rejected BY the CLI (exit 2) —
    // proof the guard did not swallow real invocations.
    const bad = runNode([entry, "definitely-not-a-command"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown command/);
});
