// #927: the opencode install target must be ONE effective config file written
// under the host-generation's canonical plugin key, without duplicating facts
// the user already wrote. Covers: version-aware key, jsonc preference, comment
// preservation, compaction.auto single-source, broken-target refusal, and
// remove/status across key spellings.
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pluginInstall, pluginRemove, pluginStatusAll, pickPluginKey, detectOpencodeMajor } from "../src/plugin-install.ts";
import { parse as jsoncParse, type ParseError } from "jsonc-parser";
import { rmrf } from "./tmp-rm.ts";

function readJsonc(file: string): Record<string, unknown> {
    const errors: ParseError[] = [];
    const data = jsoncParse(fs.readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
    assert.equal(errors.length, 0, "written config must stay valid JSONC");
    return data as Record<string, unknown>;
}

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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc927-"));
    const cfgDir = path.join(home, ".config-x/opencode");
    return {
        home,
        cfgDir,
        env: {
            HOME: home,
            XDG_CONFIG_HOME: path.join(home, ".config-x"),
            XDG_DATA_HOME: path.join(home, ".data-x"),
            XDG_STATE_HOME: path.join(home, ".state-x"),
            XDG_CACHE_HOME: path.join(home, ".cache-x"),
            OPENCODE_CONFIG: undefined,
            BILI_CLIENT_BIN: undefined,
            BILI_MCP_PROXY: "http://127.0.0.1:8787",
        },
    };
}

function ocKeys(): { ocKey: "plugin" | "plugins"; otherKey: "plugin" | "plugins" } {
    const ocKey = pickPluginKey(detectOpencodeMajor());
    return { ocKey, otherKey: ocKey === "plugin" ? "plugins" : "plugin" };
}

test("pickPluginKey: 2.x writes plugins, 1.x and unknowns write plugin (#927)", () => {
    assert.equal(pickPluginKey(1), "plugin");
    assert.equal(pickPluginKey(2), "plugins");
    assert.equal(pickPluginKey(3), "plugins");
});

test("detectOpencodeMajor: honors BILI_CLIENT_BIN, fails soft to 1 (#927)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-oc927-ver-"));
    const isWin = process.platform === "win32";
    try {
        // Windows: execFileSync cannot spawn shebang scripts — fake the npm
        // global shim shape (.cmd) there, matching what BILI_CLIENT_BIN points
        // at in the wild.
        const ext = isWin ? ".cmd" : "";
        const v2bin = path.join(home, `fake-opencode-v2${ext}`);
        fs.writeFileSync(v2bin, isWin ? "@echo opencode 2.0.3\r\n" : "#!/bin/sh\necho \"opencode 2.0.3\"\n");
        if (!isWin) fs.chmodSync(v2bin, 0o755);
        await withEnv({ BILI_CLIENT_BIN: v2bin }, async () => {
            assert.equal(detectOpencodeMajor(), 2);
        });
        const deadBin = path.join(home, `fake-opencode-dead${ext}`);
        fs.writeFileSync(deadBin, isWin ? "@exit /b 3\r\n" : "#!/bin/sh\nexit 3\n");
        if (!isWin) fs.chmodSync(deadBin, 0o755);
        await withEnv({ BILI_CLIENT_BIN: deadBin }, async () => {
            assert.equal(detectOpencodeMajor(), 1);
        });
        await withEnv({ BILI_CLIENT_BIN: path.join(home, "does-not-exist") }, async () => {
            assert.equal(detectOpencodeMajor(), 1);
        });
    } finally {
        rmrf(home);
    }
});

test("install targets existing opencode.jsonc, preserves comments, keeps compaction.auto single-sourced (#927)", async () => {
    const { home, cfgDir, env } = isolatedHome();
    const { ocKey } = ocKeys();
    const file = path.join(cfgDir, "opencode.jsonc");
    fs.mkdirSync(cfgDir, { recursive: true });
    const original = [
        "{",
        '  // user comment that must survive',
        '  "$schema": "https://opencode.ai/config.json",',
        '  "compaction": {',
        "    /* hand-tuned */",
        '    "auto": false,',
        '    "reserve": 5000',
        "  },",
        '  "provider": { "myprov": {} }',
        "}",
        "",
    ].join("\n");
    fs.writeFileSync(file, original);
    try {
        await withEnv(env, async () => {
            const msg = pluginInstall("opencode");
            assert.match(msg, /installed -> .*opencode\.jsonc/);
            assert.match(msg, /mcp\.bili not written/);
            assert.match(msg, /compaction\.auto already disabled/);
            assert.doesNotMatch(msg, /set to false/);
            const dir = path.join(cfgDir, "plugins/billion-context");
            let text = fs.readFileSync(file, "utf8");
            assert.ok(text.includes("// user comment that must survive"), "line comment survived");
            assert.ok(text.includes("/* hand-tuned */"), "block comment survived");
            const data = readJsonc(file);
            assert.deepEqual(data.compaction, { auto: false, reserve: 5000 });
            assert.ok(Array.isArray(data[ocKey]) && (data[ocKey] as string[]).includes(dir));
            assert.equal(fs.existsSync(path.join(cfgDir, "opencode.json")), false, "no second file spawned");
            assert.equal(fs.existsSync(path.join(cfgDir, "config.json")), false);

            // idempotent re-run: byte-identical file, presence notes only
            const again = pluginInstall("opencode");
            assert.match(again, /mcp\.bili not written/);
            assert.match(again, new RegExp(`${ocKey} present`));
            assert.match(again, /compaction\.auto already disabled/);
            assert.equal(fs.readFileSync(file, "utf8"), text, "re-run leaves the file byte-identical");

            // remove: entries gone, compaction restored from backup, comments intact
            assert.match(pluginRemove("opencode"), /removed/);
            text = fs.readFileSync(file, "utf8");
            assert.ok(text.includes("// user comment that must survive"));
            const after = readJsonc(file);
            assert.equal(after.mcp, undefined);
            assert.equal(after[ocKey], undefined);
            assert.deepEqual(after.compaction, { auto: false, reserve: 5000 });
            assert.equal(fs.existsSync(dir), false);
            assert.equal(pluginStatusAll().find((r) => r.agent === "opencode")?.status, "not installed");
        });
    } finally {
        rmrf(home);
    }
});

test("fresh config dir: creates plain opencode.json, remove restores pre-install state (#927)", async () => {
    const { home, cfgDir, env } = isolatedHome();
    const { ocKey } = ocKeys();
    const file = path.join(cfgDir, "opencode.json");
    try {
        await withEnv(env, async () => {
            const msg = pluginInstall("opencode");
            // plain includes(): `file` on win32 is a backslash path that must
            // not be fed to a regex
            assert.ok(msg.includes(`installed -> ${file} (`), msg);
            assert.match(msg, /compaction\.auto set to false/);
            const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
            assert.deepEqual(data.compaction, { auto: false });
            assert.deepEqual(data[ocKey], [path.join(cfgDir, "plugins/billion-context")]);
            assert.equal(fs.existsSync(`${file}.bili-bak`), false, "nothing existed to back up");

            assert.match(pluginRemove("opencode"), /removed/);
            assert.match(pluginRemove("opencode"), /not installed/);
            const after = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
            assert.equal(after.mcp, undefined);
            assert.equal(after[ocKey], undefined);
            assert.equal(after.compaction, undefined);
        });
    } finally {
        rmrf(home);
    }
});

test("only config.json present: installer edits it, does not spawn opencode.json (#927)", async () => {
    const { home, cfgDir, env } = isolatedHome();
    const { ocKey } = ocKeys();
    const file = path.join(cfgDir, "config.json");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ marker: "keep" }, null, 2));
    try {
        await withEnv(env, async () => {
            const msg = pluginInstall("opencode");
            // plain includes(): `file` on win32 is a backslash path that must
            // not be fed to a regex
            assert.ok(msg.includes(`installed -> ${file} (`), msg);
            const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
            assert.equal(data.marker, "keep");
            assert.ok(Array.isArray(data[ocKey]));
            assert.equal(fs.existsSync(path.join(cfgDir, "opencode.json")), false);
            assert.equal(fs.existsSync(path.join(cfgDir, "opencode.jsonc")), false);
        });
    } finally {
        rmrf(home);
    }
});

test("jsonc + json both present: jsonc wins, sibling json stays byte-identical (#927)", async () => {
    const { home, cfgDir, env } = isolatedHome();
    const { ocKey } = ocKeys();
    fs.mkdirSync(cfgDir, { recursive: true });
    const jsoncFile = path.join(cfgDir, "opencode.jsonc");
    const jsonFile = path.join(cfgDir, "opencode.json");
    fs.writeFileSync(jsoncFile, "{\n  // top comment\n  \"compaction\": { \"auto\": false }\n}\n");
    const siblingBytes = '{\n  "marker": "json"\n}\n';
    fs.writeFileSync(jsonFile, siblingBytes);
    try {
        await withEnv(env, async () => {
            const msg = pluginInstall("opencode");
            assert.ok(msg.includes(`installed -> ${jsoncFile} (`), msg);
            const data = readJsonc(jsoncFile);
            assert.ok(Array.isArray(data[ocKey]));
            assert.equal(fs.readFileSync(jsonFile, "utf8"), siblingBytes, "sibling opencode.json untouched");
        });
    } finally {
        rmrf(home);
    }
});

test("broken target config: refuses to overwrite, writes nothing (#927)", async () => {
    const { home, cfgDir, env } = isolatedHome();
    const file = path.join(cfgDir, "opencode.jsonc");
    fs.mkdirSync(cfgDir, { recursive: true });
    const broken = "nope{";
    fs.writeFileSync(file, broken);
    try {
        await withEnv(env, async () => {
            assert.throws(() => pluginInstall("opencode"), /refusing to overwrite/);
            assert.equal(fs.readFileSync(file, "utf8"), broken, "broken config left byte-identical");
            assert.equal(fs.existsSync(`${file}.bili-bak`), false);
            assert.equal(fs.existsSync(path.join(cfgDir, "plugins/billion-context/index.js")), false);
        });
    } finally {
        rmrf(home);
    }
});

test("status/remove recognize our entry under either key spelling (#927)", async () => {
    const { home, cfgDir, env } = isolatedHome();
    const { otherKey } = ocKeys();
    const file = path.join(cfgDir, "opencode.json");
    const dir = path.join(cfgDir, "plugins/billion-context");
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ [otherKey]: [dir] }));
    try {
        await withEnv(env, async () => {
            assert.equal(pluginStatusAll().find((r) => r.agent === "opencode")?.status, "installed");
            assert.match(pluginRemove("opencode"), /removed/);
            const after = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
            assert.equal(after[otherKey], undefined);
            assert.equal(fs.existsSync(dir), false);
            assert.equal(pluginStatusAll().find((r) => r.agent === "opencode")?.status, "not installed");
        });
    } finally {
        rmrf(home);
    }
});
