import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBackendName, backendSelectionNotice, selectedBackendRaw, resolveMysqlDsn, openBackend } from "../src/storage/backend.ts";


/**
 * #3931 (step 1): the `storage.backend` selection surface.
 *
 *   env BILI_STORAGE_BACKEND  >  file storage.backend  >  "sqlite"
 *
 * `mysql` is IMPLEMENTED (#3388 step 2): openBackend("mysql", dsn) opens the
 * real MysqlBackend (lazily importing mysql2 — boots that never select it
 * never load it). The DSN precedence mirrors the backend name:
 *
 *   env BILI_MYSQL_DSN  >  file storage.mysql.dsn  >  "" (documented error)
 *
 * The selection notice still keeps the proxy hot path on sqlite — the
 * shadow ingest rides the step-3 async swap instead of crashing boots.
 */

test("resolveBackendName: env > file > default sqlite", () => {
    assert.equal(resolveBackendName({ BILI_STORAGE_BACKEND: "mysql" }, "sqlite"), "mysql");
    assert.equal(resolveBackendName({ BILI_STORAGE_BACKEND: "sqlite" }, undefined), "sqlite");
    assert.equal(resolveBackendName(undefined, "mysql"), "mysql");
    assert.equal(resolveBackendName(undefined, undefined), "sqlite");
    assert.equal(resolveBackendName({ BILI_STORAGE_BACKEND: "" }, ""), "sqlite");
    // Unknown names fall back to the default with the notice carrying the
    // complaint (validated at open time where the full error is thrown).
    assert.equal(resolveBackendName({ BILI_STORAGE_BACKEND: "oracle" }, undefined), "sqlite");
});

test("backendSelectionNotice: silent on sqlite, explicit everywhere else", () => {
    assert.equal(backendSelectionNotice("sqlite"), undefined);
    const notice = backendSelectionNotice("mysql");
    assert.ok(notice && notice.includes("mysql") && notice.includes("#3388"), "notice names the backend and the tracking issue");
    assert.ok(backendSelectionNotice("oracle")!.includes("oracle"), "unknown names also produce a notice");
});

test("openBackend: sqlite opens; mysql needs a DSN; unknown lists valid names", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-backend-knob-"));
    try {
        const b = await openBackend("sqlite", path.join(dir, "index.db"));
        await b.close();

        await assert.rejects(() => openBackend("mysql", ""), (err: unknown) => {
            const msg = String((err as Error).message);
            return msg.includes("mysql") && msg.includes("DSN") && msg.includes("BILI_MYSQL_DSN");
        }, "mysql without a DSN names both knobs and the working default");

        await assert.rejects(() => openBackend("oracle", path.join(dir, "index.db")), (err: unknown) => {
            const msg = String((err as Error).message);
            return msg.includes("oracle") && msg.includes("sqlite") && msg.includes("mysql");
        }, "unknown backend error lists the valid names");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("lane-boot notice composition: the RAW selection decides — typo'd names are NOT silent (#3932 review)", () => {
    const unknown = backendSelectionNotice(selectedBackendRaw({ BILI_STORAGE_BACKEND: "oracle" }, undefined));
    assert.ok(unknown && unknown.includes("oracle") && unknown.includes("valid"), "an unknown env selection surfaces the unknown-name notice");
    const stub = backendSelectionNotice(selectedBackendRaw(undefined, "MySQL"));
    assert.ok(stub && stub.includes("mysql") && stub.includes("#3388"), "file 'MySQL' normalizes into the registered-stub notice");
    assert.equal(backendSelectionNotice(selectedBackendRaw(undefined, undefined)), undefined, "no selection stays silent");
    assert.equal(backendSelectionNotice(selectedBackendRaw({ BILI_STORAGE_BACKEND: "  SQLITE  " }, "mysql")), undefined, "env wins over file; normalized sqlite stays silent");
});

test("resolveMysqlDsn: env > file > empty; whitespace trims", () => {
    assert.equal(resolveMysqlDsn({ BILI_MYSQL_DSN: "mysql://e/db" }, "mysql://f/db"), "mysql://e/db", "env wins");
    assert.equal(resolveMysqlDsn(undefined, "mysql://f/db"), "mysql://f/db", "file fills in");
    assert.equal(resolveMysqlDsn({ BILI_MYSQL_DSN: "  mysql://e/db  " }, undefined), "mysql://e/db", "env trims");
    assert.equal(resolveMysqlDsn(undefined, undefined), "", "empty when neither is set");
});
