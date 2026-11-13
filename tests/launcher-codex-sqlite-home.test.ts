import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    parseCodexVersion,
    resolveCodexStateMode,
    codexSupportsSqliteHome,
    refreshOverlayHome,
    prepareCodexMcpInjection,
} from "../src/launcher.js";

function mkRoot(): string {
    return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "bili-codex-sqlite-home-"));
}

function capturedErrors(fn: () => void): string[] {
    const orig = console.error;
    const out: string[] = [];
    console.error = (...args: unknown[]): void => {
        out.push(args.map(String).join(" "));
    };
    try {
        fn();
    } finally {
        console.error = orig;
    }
    return out;
}

/** Cross-platform fake codex binary: a node script the probe spawns as
 *  `node <script> --version`. */
function writeFakeCodex(root: string, versionLine: string): string {
    const script = path.join(root, `fake-codex-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(script, `if (process.argv.includes("--version")) console.log(${JSON.stringify(versionLine)});\n`);
    return script;
}

test("parseCodexVersion reads the codex-cli X.Y.Z line", () => {
    assert.deepEqual(parseCodexVersion("codex-cli 0.147.0"), [0, 147, 0]);
    assert.deepEqual(parseCodexVersion("codex-cli 0.160.1\n"), [0, 160, 1]);
    assert.equal(parseCodexVersion("some other output"), undefined);
    assert.equal(parseCodexVersion("codex-cli 0.147"), undefined);
    assert.equal(parseCodexVersion(""), undefined);
});

test("resolveCodexStateMode: auto follows capability, explicit values win", () => {
    assert.equal(resolveCodexStateMode(undefined, true), "shared");
    assert.equal(resolveCodexStateMode("auto", true), "shared");
    assert.equal(resolveCodexStateMode("", true), "shared");
    assert.equal(resolveCodexStateMode(undefined, false), "legacy");
    assert.equal(resolveCodexStateMode("legacy", true), "legacy");
    assert.equal(resolveCodexStateMode("LEGACY", false), "legacy");
    assert.equal(resolveCodexStateMode("shared", true), "shared");
    // Explicit shared on a too-old binary degrades loudly instead of silently.
    const errs = capturedErrors(() => {
        assert.equal(resolveCodexStateMode("shared", false), "legacy");
    });
    assert.ok(errs.some((e) => e.includes("degrades to legacy")), errs.join("; "));
    // Unrecognized values warn and behave as auto.
    const errs2 = capturedErrors(() => {
        assert.equal(resolveCodexStateMode("bogus", true), "shared");
    });
    assert.ok(errs2.some((e) => e.includes('unrecognized BILI_CODEX_STATE_MODE')), errs2.join("; "));
});

test("codexSupportsSqliteHome gates on the probed version", () => {
    const root = mkRoot();
    const atFloor = writeFakeCodex(root, "codex-cli 0.147.0");
    const above = writeFakeCodex(root, "codex-cli 0.160.1");
    const below = writeFakeCodex(root, "codex-cli 0.146.9");
    const garbage = writeFakeCodex(root, "not a version");
    assert.equal(codexSupportsSqliteHome(process.execPath, [atFloor]), true);
    assert.equal(codexSupportsSqliteHome(process.execPath, [above]), true);
    assert.equal(codexSupportsSqliteHome(process.execPath, [below]), false);
    assert.equal(codexSupportsSqliteHome(process.execPath, [garbage]), false);
    assert.equal(codexSupportsSqliteHome(path.join(root, "does-not-exist"), []), false);
});

const GENERATED = [".env", "config.toml"];

function sqliteFree(dir: string): string[] {
    return fs.readdirSync(dir).filter((n) => /(\.db|\.sqlite|\.sqlite3)$/.test(n) || /-(wal|shm|journal)$/.test(n));
}

test("#2222 shared mode: real-home dbs are neither copied into nor linked into the overlay", () => {
    const root = mkRoot();
    const realHome = path.join(root, "home");
    const overlay = `${realHome}-bili`;
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(path.join(realHome, "state_5.sqlite"), "REAL-A");
    fs.writeFileSync(path.join(realHome, "state_5.sqlite-wal"), "WAL-A");
    fs.writeFileSync(path.join(realHome, "auth.json"), "{}");
    const before: Record<string, string> = {};
    for (const n of ["state_5.sqlite", "state_5.sqlite-wal", "auth.json"]) before[n] = fs.readFileSync(path.join(realHome, n), "utf8");

    assert.equal(refreshOverlayHome(realHome, overlay, GENERATED, { sharedSqlite: true }), true);

    assert.deepEqual(sqliteFree(overlay), [], "the overlay must hold no sqlite files in shared mode");
    for (const n of Object.keys(before)) {
        assert.equal(fs.readFileSync(path.join(realHome, n), "utf8"), before[n], "real home entry must be untouched: " + n);
    }
    assert.ok(fs.lstatSync(path.join(overlay, "auth.json")), "non-db entries keep their ordinary mirror");
});

test("#2222 shared mode: legacy leftover sets migrate back exactly once, winner by provenance", () => {
    const root = mkRoot();
    const realHome = path.join(root, "home");
    const overlay = `${realHome}-bili`;
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(path.join(realHome, "state_5.sqlite"), "REAL-A");

    // Phase 1 — a LEGACY launch copies the set into the overlay and records
    // its origin snapshot (the exact state an upgrade finds on disk).
    assert.equal(refreshOverlayHome(realHome, overlay, GENERATED), true);
    assert.ok(fs.existsSync(path.join(overlay, "state_5.sqlite")), "legacy refresh must have copied the db in");

    // Phase 2 — this launch's codex advanced the OVERLAY copy only (a commit
    // the real home never saw). The first SHARED-mode launch must merge that
    // generation back into the real home and leave no sqlite behind.
    fs.writeFileSync(path.join(overlay, "state_5.sqlite"), "REAL-B");
    assert.equal(refreshOverlayHome(realHome, overlay, GENERATED, { sharedSqlite: true }), true);
    assert.equal(fs.readFileSync(path.join(realHome, "state_5.sqlite"), "utf8"), "REAL-B", "the advanced generation must win the migration back to the real home");
    assert.deepEqual(sqliteFree(overlay), [], "migration must leave no sqlite files in the overlay");
    for (const dir of [realHome, overlay]) {
        for (const n of fs.readdirSync(dir)) assert.ok(!n.includes("bili-conflict"), `no quarantined generation in ${dir}: ${n}`);
    }

    // Phase 3 — steady state: a second shared refresh is a no-op for sqlite.
    const before = fs.readFileSync(path.join(realHome, "state_5.sqlite"), "utf8");
    const mtimeBefore = fs.statSync(path.join(realHome, "state_5.sqlite")).mtimeMs;
    assert.equal(refreshOverlayHome(realHome, overlay, GENERATED, { sharedSqlite: true }), true);
    assert.equal(fs.readFileSync(path.join(realHome, "state_5.sqlite"), "utf8"), before, "steady-state shared refresh must not touch the real db");
    assert.equal(fs.statSync(path.join(realHome, "state_5.sqlite")).mtimeMs, mtimeBefore);
    assert.deepEqual(sqliteFree(overlay), []);
});

test("#2222 shared mode: unchanged leftovers fold back without conflicts or re-import", () => {
    const root = mkRoot();
    const realHome = path.join(root, "home");
    const overlay = `${realHome}-bili`;
    fs.mkdirSync(realHome, { recursive: true });
    fs.writeFileSync(path.join(realHome, "state_5.sqlite"), "SAME");

    assert.equal(refreshOverlayHome(realHome, overlay, GENERATED), true);
    // No launch ever ran between the copy and the upgrade: both sides still
    // byte-identical to the origin snapshot → the real side wins, the overlay
    // copy drops silently, nothing is re-copied.
    assert.equal(refreshOverlayHome(realHome, overlay, GENERATED, { sharedSqlite: true }), true);
    assert.equal(fs.readFileSync(path.join(realHome, "state_5.sqlite"), "utf8"), "SAME");
    assert.deepEqual(sqliteFree(overlay), []);
    for (const dir of [realHome, overlay]) {
        for (const n of fs.readdirSync(dir)) assert.ok(!n.includes("bili-conflict"), `no conflict file in ${dir}: ${n}`);
    }
});

test("#2222 prepareCodexMcpInjection: CODEX_SQLITE_HOME rides with CODEX_HOME only in shared mode", () => {
    const root = mkRoot();
    const codexHome = path.join(root, "home");
    fs.mkdirSync(codexHome, { recursive: true });

    const shared = prepareCodexMcpInjection({
        codexHome,
        origin: "http://127.0.0.1:1",
        caPath: "/ca.pem",
        manageRouting: true,
        sharedSqlite: true,
        sqliteHome: codexHome,
    });
    // #3203: shared mode takes a per-session slot from the bounded pool, not
    // the pre-#3203 fixed-name overlay.
    assert.match(shared.envPatch.CODEX_HOME, /-bili-s(1[0-6]|[1-9])$/, "shared mode must use a per-session slot");
    assert.equal(shared.envPatch.CODEX_SQLITE_HOME, codexHome);

    const legacy = prepareCodexMcpInjection({
        codexHome,
        origin: "http://127.0.0.1:1",
        caPath: "/ca.pem",
        manageRouting: true,
        sharedSqlite: false,
        sqliteHome: codexHome,
    });
    assert.equal(legacy.envPatch.CODEX_HOME, `${codexHome}-bili`);
    assert.equal(legacy.envPatch.CODEX_SQLITE_HOME, undefined, "legacy mode must never set CODEX_SQLITE_HOME");
});
