import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

import { opencodeForkParent, _resetOpencodeForkLineageForTest } from "../src/opencode-fork-lineage.ts";

/**
 * Explicit opencode fork lineage (session_v2.fork_session_id).
 *
 * The live failure (#7421): an opencode V2 fork of a long session inherits an
 * UNRELATED session's history because the host never reports the fork parent
 * (session.created's parentID is absent on some builds), so the proxy's
 * byte-exact resume match misses and the similarity weak-adopt picks a
 * globally-closest chain. opencode records the true parent in its local
 * SQLite DB; this module reads it. These tests pin the lookup's contract:
 * hit, the distinct misses, the env-driven DB discovery, and graceful
 * degradation when the DB or node:sqlite is unavailable.
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { exec(sql: string): void; prepare(sql: string): { run(...p: unknown[]): void }; close(): void } };

interface Fixture {
    dataDir: string;
    setEnv(): void;
    restoreEnv(): void;
}

/** Create a temp opencode data dir with a session_v2 table and the given rows.
 *  `dbName` defaults to opencode.db; pass opencode-<channel>.db to exercise
 *  the channel-variant discovery. */
function mkFixture(rows: Array<[id: string, forkParent: string | null]>, dbName = "opencode.db"): Fixture {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-opencode-lineage-"));
    // opencode's data dir is $XDG_DATA_HOME/opencode (see opencodeDataDir).
    const dbPath = path.join(dataDir, "opencode", dbName);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, fork_session_id TEXT)");
    const ins = db.prepare("INSERT INTO session_v2 (id, fork_session_id) VALUES (?, ?)");
    for (const [id, forkParent] of rows) ins.run(id, forkParent);
    db.close();
    const prevXdg = process.env.XDG_DATA_HOME;
    const prevOpen = process.env.OPENCODE_DB;
    return {
        dataDir,
        setEnv() {
            process.env.XDG_DATA_HOME = dataDir;
            delete process.env.OPENCODE_DB;
        },
        restoreEnv() {
            if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = prevXdg;
            if (prevOpen === undefined) delete process.env.OPENCODE_DB;
            else process.env.OPENCODE_DB = prevOpen;
        },
    };
}

function withFixture(fixture: Fixture, fn: () => void): void {
    fixture.setEnv();
    _resetOpencodeForkLineageForTest();
    try {
        fn();
    } finally {
        fixture.restoreEnv();
        _resetOpencodeForkLineageForTest();
        fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    }
}

test("lookup: a fork row names its parent", () => {
    const parent = "ses_parent_1";
    const child = "ses_child_1";
    withFixture(mkFixture([[child, parent]]), () => {
        assert.equal(opencodeForkParent(child), parent);
    });
});

test("lookup: a non-fork session (fork_session_id NULL) has no parent", () => {
    const plain = "ses_plain_1";
    withFixture(mkFixture([[plain, null]]), () => {
        assert.equal(opencodeForkParent(plain), undefined);
    });
});

test("lookup: an id absent from the DB has no parent", () => {
    const parent = "ses_parent_2";
    withFixture(mkFixture([["ses_child_2", parent]]), () => {
        assert.equal(opencodeForkParent("ses_unknown_2"), undefined);
    });
});

test("lookup: a self-referencing fork_session_id is rejected", () => {
    const self = "ses_self_1";
    withFixture(mkFixture([[self, self]]), () => {
        assert.equal(opencodeForkParent(self), undefined);
    });
});

test("lookup: the data dir absent degrades to no lineage", () => {
    const fixture = mkFixture([["ses_child_3", "ses_parent_3"]]);
    // Point XDG_DATA_HOME at an EMPTY dir (no opencode data dir at all).
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bili-opencode-empty-"));
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = empty;
    _resetOpencodeForkLineageForTest();
    try {
        assert.equal(opencodeForkParent("ses_child_3"), undefined);
    } finally {
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdg;
        _resetOpencodeForkLineageForTest();
        fs.rmSync(empty, { recursive: true, force: true });
        fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    }
});

test("discovery: a channel-variant DB (opencode-beta.db) is found", () => {
    const parent = "ses_parent_4";
    const child = "ses_child_4";
    withFixture(mkFixture([[child, parent]], "opencode-beta.db"), () => {
        assert.equal(opencodeForkParent(child), parent);
    });
});

test("discovery: OPENCODE_DB overrides the data-dir scan", () => {
    const parent = "ses_parent_5";
    const child = "ses_child_5";
    // The data dir has a decoy DB with a WRONG parent; OPENCODE_DB points at
    // the real one, so the explicit path must win.
    const fixture = mkFixture([[child, "ses_decoy_5"]]);
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-opencode-real-"));
    const realDb = path.join(realDir, "real.db");
    const db = new DatabaseSync(realDb);
    db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, fork_session_id TEXT)");
    db.prepare("INSERT INTO session_v2 (id, fork_session_id) VALUES (?, ?)").run(child, parent);
    db.close();
    fixture.setEnv();
    process.env.OPENCODE_DB = realDb;
    _resetOpencodeForkLineageForTest();
    try {
        assert.equal(opencodeForkParent(child), parent);
    } finally {
        fixture.restoreEnv();
        _resetOpencodeForkLineageForTest();
        fs.rmSync(realDir, { recursive: true, force: true });
        fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    }
});

test("discovery: OPENCODE_DB=:memory: is ignored (falls back to the data dir)", () => {
    const parent = "ses_parent_6";
    const child = "ses_child_6";
    const fixture = mkFixture([[child, parent]]);
    fixture.setEnv();
    process.env.OPENCODE_DB = ":memory:";
    _resetOpencodeForkLineageForTest();
    try {
        assert.equal(opencodeForkParent(child), parent);
    } finally {
        fixture.restoreEnv();
        _resetOpencodeForkLineageForTest();
        fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    }
});

test("discovery: an empty scan is re-probed when the DB appears later (fresh machine)", () => {
    const parent = "ses_parent_9";
    const child = "ses_child_9";
    // The data dir does not exist yet (proxy started before opencode's first run).
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bili-opencode-late-"));
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = empty;
    _resetOpencodeForkLineageForTest();
    try {
        // First probe: no DB yet → no lineage.
        assert.equal(opencodeForkParent("ses_probe_9"), undefined);
        // opencode starts up and creates the data dir + DB.
        const dbPath = path.join(empty, "opencode", "opencode.db");
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const db = new DatabaseSync(dbPath);
        db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, fork_session_id TEXT)");
        db.prepare("INSERT INTO session_v2 (id, fork_session_id) VALUES (?, ?)").run(child, parent);
        db.close();
        // A later session must re-probe: an empty candidate list must not be
        // cached, or the lineage fix would silently never apply this process.
        assert.equal(opencodeForkParent(child), parent);
    } finally {
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdg;
        _resetOpencodeForkLineageForTest();
        fs.rmSync(empty, { recursive: true, force: true });
    }
});

test("degradation: a corrupt DB file degrades to no lineage (never throws)", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-opencode-corrupt-"));
    fs.writeFileSync(path.join(dataDir, "opencode.db"), "this is not a sqlite database");
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    _resetOpencodeForkLineageForTest();
    try {
        assert.equal(opencodeForkParent("ses_child_7"), undefined);
    } finally {
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdg;
        _resetOpencodeForkLineageForTest();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});

test("degradation: a DB without the session_v2 table degrades to no lineage", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-opencode-notable-"));
    const dbPath = path.join(dataDir, "opencode.db");
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE other (id TEXT)");
    db.close();
    const prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataDir;
    _resetOpencodeForkLineageForTest();
    try {
        assert.equal(opencodeForkParent("ses_child_8"), undefined);
    } finally {
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = prevXdg;
        _resetOpencodeForkLineageForTest();
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
