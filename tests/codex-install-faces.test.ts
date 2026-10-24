import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function withEnv(
    vars: Record<string, string | undefined>,
    fn: () => void | Promise<void>,
): Promise<void> {
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(vars)) {
        saved.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    const restore = (): void => {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    };
    try {
        const result = fn();
        if (result instanceof Promise) return result.finally(restore);
        restore();
        return Promise.resolve();
    } catch (error) {
        restore();
        return Promise.reject(error);
    }
}

// Ticket 08 regression: the Codex install flow must land ALL four faces —
// MCP block, model route, SessionStart hook, ACP skill — and remove must take
// them all back out. The user's report was exactly this gap: the desktop Codex
// saw the MCP plugin but neither a hook nor an ACP skill.
test("plugin install codex writes MCP + route + hook + skill, and remove reverts all four", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-faces-"));
    const { pluginInstall, pluginRemove, pluginStatusAll } = await import(
        "../src/plugin-install.ts"
    );
    // `dist/` must exist on disk: the installer refuses to register a hook
    // whose script is not built. CI's test lanes run the TS sources without
    // bundling, so materialize the single file the installer checks for and
    // remove exactly what we created.
    const root = path.dirname(path.dirname(path.resolve("src/plugin-install.ts")));
    const distDir = path.join(root, "dist");
    const codexDir = path.join(distDir, "codex");
    const hookScript = path.join(codexDir, "bootstrap-hook.js");
    const createdDist = !fs.existsSync(distDir);
    const createdCodex = !fs.existsSync(codexDir);
    const createdHook = !fs.existsSync(hookScript);
    if (createdHook) {
        fs.mkdirSync(codexDir, { recursive: true });
        fs.writeFileSync(hookScript, "// test stub: presence only\n");
    }
    try {
        await withEnv({ CODEX_HOME: home }, () => {
            const message = pluginInstall("codex");
            assert.match(message, /^codex: installed/);
            assert.match(message, /mcp: installed \[mcp_servers\.bili\]/);
            assert.match(message, /model route:/);
            assert.match(message, /hook: SessionStart hook added/);
            assert.match(message, /skill: ACP skill installed/);

            const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
            assert.match(toml, /\[mcp_servers\.bili\]\ncommand = /);
            // Array-of-tables is required by Codex (`hooks` is a sequence); the
            // map form is rejected at load time and breaks the whole host.
            assert.match(toml, /\[\[hooks\.SessionStart\]\]\n/);
            // ...and the handler must be NESTED in the `hooks = [...]` array.
            // Fields set directly on the entry are silently dropped by Codex, so
            // this asserts the exact shape its `hooks/list` RPC registers.
            assert.match(
                toml,
                /\[\[hooks\.SessionStart\]\]\nhooks = \[\{ type = "command", command = /,
            );
            assert.doesNotMatch(toml, /\[hooks\.SessionStart\]\n/);
            assert.doesNotMatch(toml, /\[\[hooks\.SessionStart\]\]\ntype = /);
            assert.match(toml, /codex[\\/]bootstrap-hook\.js/);
            assert.match(
                toml,
                /openai_base_url = "http:\/\/127\.0\.0\.1:\d+\/bili\/https:\/\/api\.openai\.com\/v1"/,
            );

            const skillFile = path.join(home, "skills", "bili", "SKILL.md");
            assert.equal(fs.existsSync(skillFile), true);
            assert.match(fs.readFileSync(skillFile, "utf8"), /^---\nname: bili\n/);
            assert.match(fs.readFileSync(skillFile, "utf8"), /acp_cache/);

            // A rerun is a no-op that still reports every face.
            const second = pluginInstall("codex");
            assert.match(second, /^codex: already installed/);
            assert.match(second, /hook: SessionStart hook already installed/);
            assert.match(second, /skill: ACP skill already installed/);

            // Lane status surfaces the faces separately (doctor reads this).
            const lane = pluginStatusAll().find((entry) => entry.agent === "codex");
            assert.ok(lane, "codex lane must be reported");
            assert.match(lane!.status, /mcp installed/);
            assert.match(lane!.status, /route installed/);
            assert.match(lane!.status, /hook installed/);
            assert.match(lane!.status, /skill installed/);

            const removed = pluginRemove("codex");
            assert.match(removed, /^codex: removed/);
            assert.match(removed, /hook removed/);
            const tomlAfter = fs.readFileSync(path.join(home, "config.toml"), "utf8");
            assert.doesNotMatch(tomlAfter, /mcp_servers\.bili/);
            assert.doesNotMatch(tomlAfter, /hooks\.SessionStart/);
            assert.doesNotMatch(tomlAfter, /bootstrap-hook\.js/);
            assert.doesNotMatch(tomlAfter, /openai_base_url/);
            assert.equal(fs.existsSync(skillFile), false);
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
        if (createdHook) fs.rmSync(hookScript, { force: true });
        if (createdCodex) fs.rmSync(codexDir, { recursive: true, force: true });
        if (createdDist) fs.rmSync(distDir, { recursive: true, force: true });
    }
});

// The hook face must never be claimed when it was not written: an unbuilt
// checkout installs the MCP + route faces and SAYS the hook was skipped.
test("plugin install codex reports a skipped hook when dist is not built", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-nohook-"));
    const { pluginInstall } = await import("../src/plugin-install.ts");
    try {
        await withEnv({ CODEX_HOME: home }, () => {
            const root = path.dirname(
                path.dirname(path.resolve("src/plugin-install.ts")),
            );
            const hookScript = path.join(root, "dist", "codex", "bootstrap-hook.js");
            if (!fs.existsSync(hookScript)) {
                const message = pluginInstall("codex");
                assert.match(
                    message,
                    /hook: skipped \(dist\/codex\/bootstrap-hook\.js missing\)/,
                );
                assert.match(message, /! codex: hook script missing/);
                assert.doesNotMatch(
                    fs.readFileSync(path.join(home, "config.toml"), "utf8"),
                    /\[hooks\.SessionStart\]/,
                );
            }
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
