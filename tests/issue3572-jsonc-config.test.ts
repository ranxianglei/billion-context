import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

import { loadConfigFile } from "../src/config.ts";
import { setLogCapture } from "../src/logger.ts";

// #3572: bili's own config file (~/.config/billion-context/billion-context.json)
// is documented as JSONC — CONFIGURATION*.md show ```jsonc blocks whose first line
// is a // comment — but loadConfigFile used bare JSON.parse, so a file copied
// straight from the docs failed on the first // and EVERY key was silently
// dropped (one error log, no other signal; e.g. an update.registry mirror override
// never applied). These pin the fix: JSONC (comments + trailing commas) parses,
// while a genuinely malformed file still fails LOUDLY (logged once + treated as
// empty), exactly as before.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-cfg-jsonc-"));
const savedConfigEnv = process.env.BILI_CONFIG_FILE;

test.after(() => {
    setLogCapture(null);
    if (savedConfigEnv === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = savedConfigEnv;
    fs.rmSync(root, { recursive: true, force: true });
});

function pointAt(name: string): string {
    const f = path.join(root, name);
    process.env.BILI_CONFIG_FILE = f;
    return f;
}

test("#3572: a config copied from the docs (JSONC with // comments) parses fully", () => {
    const f = pointAt("doc-example.json");
    // Mirrors CONFIGURATION.zh-CN.md's quickstart block plus the exact keys the
    // reporter said were silently dropped before the fix.
    const content = [
        "// ~/.config/billion-context/billion-context.json",
        "{",
        "  // server",
        '  "port": 8787,',
        "",
        "  // npm mirror override",
        '  "update": { "registry": "https://registry.npmmirror.com/" },',
        "",
        "  // egress proxy",
        '  "upstreamProxy": "http://127.0.0.1:7890",',
        '  "upstreamProxyMode": "auto",',
        "",
        '  "providers": {',
        '    "https://api.anthropic.com": {',
        '      "models": { "claude-sonnet-4-5": { "context": 200000 } }',
        "    }",
        "  },",
        "",
        '  "compress": { "maxContextLimit": "75%" }',
        "}",
    ].join("\n");
    fs.writeFileSync(f, content);

    const cfg = loadConfigFile();
    assert.equal(cfg.port, 8787);
    assert.equal(cfg.update?.registry, "https://registry.npmmirror.com/");
    assert.equal(cfg.upstreamProxy, "http://127.0.0.1:7890");
    assert.equal(cfg.upstreamProxyMode, "auto");
    assert.equal(cfg.compress?.maxContextLimit, "75%");
    assert.deepEqual(cfg.providers, {
        "https://api.anthropic.com": { models: { "claude-sonnet-4-5": { context: 200000 } } },
    });
});

test("#3572: block comments and trailing commas are accepted too", () => {
    const f = pointAt("block-trailing.json");
    const content = [
        "/* leading block comment */",
        "{",
        '  "port": 9000, /* inline note */',
        '  "autoUpdate": false,',
        "}",
    ].join("\n");
    fs.writeFileSync(f, content);

    const cfg = loadConfigFile();
    assert.equal(cfg.port, 9000);
    assert.equal(cfg.autoUpdate, false);
});

test("#3572: strict JSON (no comments) still parses — no behavior change for valid files", () => {
    const f = pointAt("strict.json");
    fs.writeFileSync(f, JSON.stringify({ port: 8787, update: { registry: "https://x/" } }));
    const cfg = loadConfigFile();
    assert.equal(cfg.port, 8787);
    assert.equal(cfg.update?.registry, "https://x/");
});

test("#3572: a genuinely malformed file still fails loudly (logged once + empty)", () => {
    const f = pointAt("malformed.json");
    const seen: string[] = [];
    setLogCapture((_level, msg) => { if (msg.includes("failed to parse")) seen.push(msg); });
    try {
        // Real data error (not just a comment): jsonc-parser reports it, we
        // rethrow, the caller logs + caches {} exactly as the old JSON.parse did.
        fs.writeFileSync(f, '{ "update": oops\n');
        for (let i = 0; i < 5; i++) assert.deepEqual(loadConfigFile(), {});
        assert.equal(seen.length, 1, `first corruption logs once across 5 calls (got ${seen.length})`);
        assert.match(seen[0], /failed to parse .*invalid JSON\/JSONC at line \d+ column \d+:/);
        // Fixing the file clears the failure without further logging.
        fs.writeFileSync(f, JSON.stringify({ port: 8788 }));
        assert.equal(loadConfigFile().port, 8788);
        loadConfigFile();
        assert.equal(seen.length, 1, "valid rewrite logs nothing more");
    } finally {
        setLogCapture(null);
    }
});
