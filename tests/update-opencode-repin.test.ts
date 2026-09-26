import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repinOpencodeLaneIfNewer } from "../src/update.ts";

function tempDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type Lane = { msgs: { level: string; msg: string }[] };

function setup(prefix: string, entry: string): { xdg: string; file: string; readPlugin: () => unknown } {
    const xdg = tempDir(prefix);
    fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
    const file = path.join(xdg, "opencode", "opencode.json");
    fs.writeFileSync(file, JSON.stringify({ plugin: ["other-pkg", entry] }, null, 2));
    return { xdg, file, readPlugin: (): unknown => (JSON.parse(fs.readFileSync(file, "utf8")) as { plugin?: unknown }).plugin };
}

test("repinOpencodeLaneIfNewer: newer registry version re-pins the entry (#1108 auto-update)", async (t) => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevFetch = globalThis.fetch;
    const { xdg, readPlugin } = setup("bili-upd-lane-", "billion-context@0.0.1");
    process.env.XDG_CONFIG_HOME = xdg;
    globalThis.fetch = (async () => new Response(JSON.stringify({ version: "9.9.9" }))) as typeof fetch;
    t.after(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        globalThis.fetch = prevFetch;
    });
    const lane: Lane = { msgs: [] };
    const log = (level: "info" | "warn", msg: string): void => {
        lane.msgs.push({ level, msg });
    };
    await repinOpencodeLaneIfNewer({ packageName: "billion-context", currentVersion: "0.0.1" }, log);
    assert.deepEqual(readPlugin(), ["other-pkg", "billion-context@9.9.9"]);
    assert.equal(lane.msgs.filter((m) => m.level === "info").length, 1);
    assert.match(lane.msgs[0]!.msg, /re-pinned billion-context@0\.0\.1 -> billion-context@9\.9\.9/);
});

test("repinOpencodeLaneIfNewer: same or older version is a no-op", async (t) => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevFetch = globalThis.fetch;
    const { xdg, readPlugin } = setup("bili-upd-same-", "billion-context@0.1.137");
    process.env.XDG_CONFIG_HOME = xdg;
    globalThis.fetch = (async () => new Response(JSON.stringify({ version: "0.1.137" }))) as typeof fetch;
    t.after(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        globalThis.fetch = prevFetch;
    });
    const lane: Lane = { msgs: [] };
    await repinOpencodeLaneIfNewer({ packageName: "billion-context", currentVersion: "0.1.137" }, (level, msg) => lane.msgs.push({ level, msg }));
    assert.deepEqual(readPlugin(), ["other-pkg", "billion-context@0.1.137"]);
    assert.equal(lane.msgs.length, 0);
});

test("repinOpencodeLaneIfNewer: fetch failure warns and never throws, config untouched", async (t) => {
    const prevXdg = process.env.XDG_CONFIG_HOME;
    const prevFetch = globalThis.fetch;
    const { xdg, readPlugin } = setup("bili-upd-err-", "billion-context@0.0.1");
    process.env.XDG_CONFIG_HOME = xdg;
    globalThis.fetch = (async () => {
        throw new Error("network down");
    }) as typeof fetch;
    t.after(() => {
        if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = prevXdg;
        globalThis.fetch = prevFetch;
    });
    const lane: Lane = { msgs: [] };
    await repinOpencodeLaneIfNewer({ packageName: "billion-context", currentVersion: "0.0.1" }, (level, msg) => lane.msgs.push({ level, msg }));
    assert.deepEqual(readPlugin(), ["other-pkg", "billion-context@0.0.1"]);
    assert.equal(lane.msgs.length, 1);
    assert.equal(lane.msgs[0]!.level, "warn");
    assert.match(lane.msgs[0]!.msg, /re-pin failed: network down/);
});
