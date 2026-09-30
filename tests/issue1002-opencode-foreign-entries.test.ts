// #1002: `bili plugin install/remove opencode` must be lossless on foreign
// plugin entries. Covers: object-form entries ({package, options}) and
// map-form `plugins` survive install AND remove verbatim; "plugin present"
// re-runs never rewrite the file; the .bili-bak backup reflects the state
// before the LATEST write, not the first one ever.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pluginInstall, pluginRemove, pickPluginKey, detectOpencodeMajor } from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
        saved.set(k, process.env[k]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        await fn();
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

function isolatedHome(): { home: string; cfgDir: string; env: Record<string, string | undefined> } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc1002-"));
    const cfgDir = path.join(home, ".config/opencode");
    return {
        home,
        cfgDir,
        env: {
            HOME: home,
            XDG_CONFIG_HOME: path.join(home, ".config"),
            XDG_DATA_HOME: path.join(home, ".data"),
            XDG_STATE_HOME: path.join(home, ".state"),
            XDG_CACHE_HOME: path.join(home, ".cache"),
            OPENCODE_CONFIG: undefined,
            BILI_CLIENT_BIN: undefined,
            BILI_MCP_PROXY: "http://127.0.0.1:8787",
        },
    };
}

const OBJ_A = { package: "@org/foreign-a", options: { load: "dist/index.js" } };
const OBJ_B = { package: "foreign-b" };

test("install and remove preserve foreign object entries in the plugins array (#1002)", async () => {
    const { home, cfgDir, env } = isolatedHome();
    const ocKey = pickPluginKey(detectOpencodeMajor());
    const file = path.join(cfgDir, "opencode.json");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", [ocKey]: [OBJ_A, "foreign-str", OBJ_B] }, null, 2));
    try {
        await withEnv(env, async () => {
            const msg = pluginInstall("opencode");
            assert.match(msg, /installed -> /);
            const after = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
            assert.deepEqual(after[ocKey], [OBJ_A, "foreign-str", OBJ_B, path.join(cfgDir, "plugins", "billion-context")]);

            // "plugin present" re-run: byte-identical file
            const bytes = fs.readFileSync(file, "utf8");
            const again = pluginInstall("opencode");
            assert.match(again, new RegExp(`${ocKey} present`));
            assert.equal(fs.readFileSync(file, "utf8"), bytes, "present re-run leaves the file byte-identical");

            // remove: only ours goes, the key SURVIVES with all foreign entries
            assert.match(pluginRemove("opencode"), /plugin removed/);
            const end = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
            assert.deepEqual(end[ocKey], [OBJ_A, "foreign-str", OBJ_B], "foreign entries survive remove");
        });
    } finally {
        rmrf(home);
    }
});

test("remove deletes the key only when NOTHING raw remains, not when only strings would (#1002)", async () => {
    const { home, cfgDir, env } = isolatedHome();
    const ocKey = pickPluginKey(detectOpencodeMajor());
    const file = path.join(cfgDir, "opencode.json");
    fs.mkdirSync(cfgDir, { recursive: true });
    // ours + a lone object entry: the string-only `remaining` of the old code
    // was empty here, which DELETED the key and killed the object with it
    fs.writeFileSync(file, JSON.stringify({ [ocKey]: [OBJ_A] }, null, 2));
    try {
        await withEnv(env, async () => {
            pluginInstall("opencode");
            pluginRemove("opencode");
            const end = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
            assert.deepEqual(end[ocKey], [OBJ_A], "key kept: one raw entry remains");
        });
    } finally {
        rmrf(home);
    }
});

test("map-form plugins survive install and remove with their options (#1002)", async () => {
    const { home, cfgDir, env } = isolatedHome();
    const ocKey = pickPluginKey(detectOpencodeMajor());
    const file = path.join(cfgDir, "opencode.json");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ [ocKey]: { "@org/x": { options: { z: 1 } }, "plain-y": true } }, null, 2));
    try {
        await withEnv({ ...env, BILI_CLIENT_BIN: undefined }, async () => {
            const msg = pluginInstall("opencode");
            assert.match(msg, /installed -> /);
            const shim = path.join(cfgDir, "plugins", "billion-context");
            const after = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
            assert.deepEqual(after[ocKey], { "@org/x": { options: { z: 1 } }, "plain-y": true, [shim]: true });
            assert.ok(!Array.isArray(after[ocKey]), "map form preserved");

            pluginRemove("opencode");
            const end = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
            assert.deepEqual(end[ocKey], { "@org/x": { options: { z: 1 } }, "plain-y": true }, "map survives with options");
        });
    } finally {
        rmrf(home);
    }
});

test(".bili-bak reflects the state before the LATEST write, not the first ever (#1002)", async () => {
    const { home, cfgDir, env } = isolatedHome();
    const file = path.join(cfgDir, "opencode.json");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ marker: "pre-install" }, null, 2));
    try {
        await withEnv(env, async () => {
            pluginInstall("opencode");
            assert.match(fs.readFileSync(`${file}.bili-bak`, "utf8"), /pre-install/);

            // user edit lands on disk, then bili writes again — the backup
            // must advance to the state right before that second write
            const userEdited = JSON.stringify({ marker: "user-edit", extra: 1 }, null, 2) + "\n";
            fs.writeFileSync(file, userEdited);
            pluginInstall("opencode");
            assert.equal(fs.readFileSync(`${file}.bili-bak`, "utf8"), userEdited, "backup refreshed to latest pre-write state");
        });
    } finally {
        rmrf(home);
    }
});
