// #7803: config-file relocation of the sessions directory — `sessions.dir`
// in the bili config file (BILI_CONFIG_FILE / the XDG config default) moves
// index.db + session JSON + CCR stores off a capacity-constrained drive
// (e.g. a Windows C: that cannot hold a growing index.db) without touching
// the shell environment. Pins the resolution contract:
//   BILI_SESSIONS_DIR env (override tier, #2030 precedence)
//     > sessions.dir config key (the new file tier)
//     > XDG data dir default
// plus the failure rails: a value pointing at an existing FILE refuses
// loudly instead of silently falling back (a silent fallback would
// recreate the disk-capacity failure the key exists to work around);
// non-string values are ignored with a warn; relative paths resolve
// against the process CWD; the parse is JSONC-tolerant exactly like
// parseBiliConfig (comments + trailing commas are legal).
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configFile, sessionsDir, sessionsDirRelocated } from "../src/paths.js";
import { rmrf } from "./tmp-rm.js";

process.env.NODE_ENV = "test";

const ROOT = mkdtempSync(path.join(tmpdir(), "bili-sessions-dir-cfg-"));
const CONFIG_HOME = path.join(ROOT, "config");
const DATA_HOME = path.join(ROOT, "data");
const PREV = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    BILI_CONFIG_FILE: process.env.BILI_CONFIG_FILE,
    BILI_SESSIONS_DIR: process.env.BILI_SESSIONS_DIR,
};
process.env.XDG_CONFIG_HOME = CONFIG_HOME;
process.env.XDG_DATA_HOME = DATA_HOME;
process.env.XDG_STATE_HOME = path.join(ROOT, "state");
delete process.env.BILI_CONFIG_FILE;
delete process.env.BILI_SESSIONS_DIR;

const DEFAULT_SESSIONS = path.join(DATA_HOME, "billion-context", "sessions");
// configDir() appends its own "billion-context" subdir (paths.ts header):
// $XDG_CONFIG_HOME/billion-context/billion-context.json.
const CFG = path.join(CONFIG_HOME, "billion-context", "billion-context.json");
const CONFIG_SUBDIR = path.dirname(CFG);

function writeConfig(content: string): void {
    mkdirSync(CONFIG_SUBDIR, { recursive: true });
    writeFileSync(CFG, content, "utf8");
}

beforeEach(() => {
    // Each test may mutate the config file; a fresh env per test keeps the
    // env-override cases isolated from each other.
    delete process.env.BILI_SESSIONS_DIR;
    delete process.env.BILI_CONFIG_FILE;
});

after(() => {
    for (const [k, v] of Object.entries(PREV)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    rmrf(ROOT);
});

test("no config file: XDG default, not relocated", () => {
    assert.equal(sessionsDir(), DEFAULT_SESSIONS);
    assert.equal(sessionsDirRelocated(), false);
});

test("sessions.dir file key relocates the sessions dir", () => {
    const moved = path.join(ROOT, "moved-sessions");
    writeConfig(JSON.stringify({ sessions: { dir: moved } }));
    try {
        assert.equal(sessionsDir(), moved);
        assert.equal(sessionsDirRelocated(), true);
    } finally {
        writeConfig("{}");
    }
});

test("BILI_SESSIONS_DIR env beats the file key (#2030 override tier)", () => {
    const moved = path.join(ROOT, "moved-sessions");
    const envDir = path.join(ROOT, "env-sessions");
    writeConfig(JSON.stringify({ sessions: { dir: moved } }));
    process.env.BILI_SESSIONS_DIR = envDir;
    try {
        assert.equal(sessionsDir(), envDir);
        assert.equal(sessionsDirRelocated(), true);
    } finally {
        writeConfig("{}");
    }
});

test("non-string sessions.dir is ignored (falls back to the default)", () => {
    writeConfig(JSON.stringify({ sessions: { dir: 42 } }));
    try {
        assert.equal(sessionsDir(), DEFAULT_SESSIONS);
        assert.equal(sessionsDirRelocated(), false);
    } finally {
        writeConfig("{}");
    }
});

test("blank sessions.dir is ignored", () => {
    writeConfig(JSON.stringify({ sessions: { dir: "   " } }));
    try {
        assert.equal(sessionsDir(), DEFAULT_SESSIONS);
        assert.equal(sessionsDirRelocated(), false);
    } finally {
        writeConfig("{}");
    }
});

test("sessions.dir pointing at an existing FILE throws loudly (no silent fallback)", () => {
    const aFile = path.join(ROOT, "notadir.txt");
    writeFileSync(aFile, "i am a file\n", "utf8");
    writeConfig(JSON.stringify({ sessions: { dir: aFile } }));
    try {
        assert.throws(() => sessionsDir(), (e: Error) =>
            e.message.includes("sessions.dir") &&
            e.message.includes(aFile) &&
            /not a directory/i.test(e.message),
        );
    } finally {
        writeConfig("{}");
    }
});

test("a not-yet-existing target directory is accepted (the store mkdirs it)", () => {
    const future = path.join(ROOT, "does-not-exist-yet");
    writeConfig(JSON.stringify({ sessions: { dir: future } }));
    try {
        assert.equal(sessionsDir(), future);
        assert.equal(sessionsDirRelocated(), true);
    } finally {
        writeConfig("{}");
    }
});

test("relative sessions.dir resolves against the process CWD", () => {
    writeConfig(JSON.stringify({ sessions: { dir: "relative-sessions" } }));
    try {
        assert.equal(sessionsDir(), path.resolve("relative-sessions"));
    } finally {
        writeConfig("{}");
    }
});

test("JSONC tolerance: comments and trailing commas parse like parseBiliConfig", () => {
    const moved = path.join(ROOT, "jsonc-sessions");
    // JSON-escape the path: on Windows it carries backslashes, and raw
    // backslashes are invalid JSON escapes (jsonc-parser reports an error and
    // the reader drops the value) — comments + trailing commas are the only
    // tolerant syntax this test pins.
    writeConfig(`// relocate off the C: drive\n{\n  "sessions": {\n    "dir": ${JSON.stringify(moved)},\n  },\n}\n`);
    try {
        assert.equal(sessionsDir(), moved);
    } finally {
        writeConfig("{}");
    }
});

test("cache invalidates on content change (same path, new bytes)", () => {
    const v1 = path.join(ROOT, "v1-sessions");
    const v2 = path.join(ROOT, "v2-sessions");
    writeConfig(JSON.stringify({ sessions: { dir: v1 } }));
    assert.equal(sessionsDir(), v1);
    writeConfig(JSON.stringify({ sessions: { dir: v2 } }));
    assert.equal(sessionsDir(), v2);
    // Rewriting identical bytes hits the raw cache — same answer, no drift.
    writeConfig(JSON.stringify({ sessions: { dir: v2 } }));
    assert.equal(sessionsDir(), v2);
    writeConfig("{}");
});

test("BILI_CONFIG_FILE points at a sibling: the key there wins too", () => {
    const sibling = path.join(CONFIG_SUBDIR, "dsh-test.json");
    const moved = path.join(ROOT, "sibling-sessions");
    mkdirSync(CONFIG_SUBDIR, { recursive: true });
    writeFileSync(sibling, JSON.stringify({ sessions: { dir: moved } }), "utf8");
    writeConfig(JSON.stringify({ sessions: { dir: path.join(ROOT, "default-cfg-dir") } }));
    process.env.BILI_CONFIG_FILE = sibling;
    try {
        assert.equal(configFile(), sibling);
        assert.equal(sessionsDir(), moved);
    } finally {
        writeConfig("{}");
    }
});
