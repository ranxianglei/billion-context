import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    assertCodexConfigLoads,
    codexHookTable,
    codexHooksEnabledNote,
    codexHooksFeature,
    findBiliCodexHook,
    isBiliCodexHookCommand,
    planCodexHook,
    readCodexHookCommands,
    stripCodexHook,
} from "../src/codex-integration/hooks.ts";
import {
    CODEX_SKILL_MARKDOWN,
    codexSkillDir,
    codexSkillFile,
    codexSkillStatus,
    installCodexSkill,
    readSkillName,
    removeCodexSkill,
} from "../src/codex-integration/skill.ts";
import {
    insertTableRaw,
    tableRegions,
} from "../src/codex-integration/toml-field.ts";

const hookCommand = 'node "C:/bili/dist/codex/bootstrap-hook.js"';

function tempHome(): { env: NodeJS.ProcessEnv; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-skill-"));
    return { env: { ...process.env, CODEX_HOME: dir }, dir };
}

test("hook command matching recognizes our script across install roots", () => {
    assert.equal(isBiliCodexHookCommand(hookCommand), true);
    assert.equal(
        isBiliCodexHookCommand(
            'node "C:/Users/x/AppData/Roaming/npm/node_modules/billion-context/dist/codex/bootstrap-hook.js"',
        ),
        true,
    );
    assert.equal(
        isBiliCodexHookCommand("lean-ctx.exe hook codex-session-start"),
        false,
    );
    assert.equal(
        isBiliCodexHookCommand('node "C:/other/dist/claude-native-bootstrap.js"'),
        false,
    );
});

test("hook install keeps user tables byte-for-byte and is idempotent", () => {
    const original = 'model = "gpt-5"\n\n[features]\nhooks = true\n';
    const first = planCodexHook(original, hookCommand);
    assert.equal(first.action, "install");
    assert.match(first.text, /\[\[hooks\.SessionStart\]\]/);
    assert.match(first.text, /\[features\]\nhooks = true/);
    assert.equal(findBiliCodexHook(first.text), hookCommand);
    assert.equal(codexHooksEnabledNote(first.text), "");

    const again = planCodexHook(first.text, hookCommand);
    assert.equal(again.action, "keep");
    assert.equal(again.text, first.text);

    const moved = planCodexHook(
        first.text,
        'node "D:/new/dist/codex/bootstrap-hook.js"',
    );
    assert.equal(moved.action, "refresh");
    assert.equal(
        findBiliCodexHook(moved.text),
        'node "D:/new/dist/codex/bootstrap-hook.js"',
    );
});

test("a foreign SessionStart entry is preserved and ours is appended", () => {
    // `[[hooks.SessionStart]]` is an array: a foreign entry is a SIBLING, so
    // bili adds its own instead of giving up. This is the real-machine case
    // (lean-ctx already owns a SessionStart entry).
    const foreign = `model = "gpt-5"\n\n[[hooks.SessionStart]]\nmatcher = "startup|resume|clear"\nhooks = [{ type = "command", command = "lean-ctx.exe hook codex-session-start", timeout = 10 }]\n`;
    const plan = planCodexHook(foreign, hookCommand);
    assert.equal(plan.action, "install");
    assert.match(plan.text, /lean-ctx\.exe hook codex-session-start/);
    assert.equal(findBiliCodexHook(plan.text), hookCommand);
    // Both entries survive as SEPARATE array-of-tables entries.
    assert.equal(plan.text.match(/\[\[hooks\.SessionStart\]\]/g)?.length, 2);
    assert.equal(assertCodexConfigLoads(plan.text), undefined);

    // Re-running is a no-op, and removal takes back only ours.
    const again = planCodexHook(plan.text, hookCommand);
    assert.equal(again.action, "keep");
    const stripped = stripCodexHook(plan.text);
    assert.equal(stripped.removed, true);
    assert.match(stripped.text, /lean-ctx\.exe hook codex-session-start/);
    assert.doesNotMatch(stripped.text, /bootstrap-hook\.js/);
});

test("our entry is always the nested MatcherGroup shape Codex registers", () => {
    // THE regression the user hit. Codex deserializes each entry as a
    // `MatcherGroup` = `{ matcher?, hooks = [ {type, command, timeout} ] }`.
    // Handler fields set DIRECTLY on the entry are unknown keys, so serde drops
    // them silently: the config loads, `codex mcp list` succeeds, and the hook
    // never registers. Only Codex's app-server `hooks/list` RPC sees this, so a
    // load probe can never cover it — this shape assertion is the guard.
    const rendered = codexHookTable(hookCommand);
    assert.match(
        rendered,
        /^\[\[hooks\.SessionStart\]\]\nhooks = \[\{ type = "command", command = .*, timeout = 15 \}\]\n$/,
    );
    // The flat shape must never be emitted.
    assert.doesNotMatch(rendered, /^type = "command"$/m);

    // And the guard must reject the flat shape when it is OURS...
    const flatOurs = `[[hooks.SessionStart]]\ntype = "command"\ncommand = ${JSON.stringify(hookCommand)}\ntimeout = 15\n`;
    const reason = assertCodexConfigLoads(flatOurs);
    assert.notEqual(reason, undefined);
    assert.match(String(reason), /must nest its handler/);

    // ...while a FOREIGN flat entry is not bili's to police: it must not block
    // installing our own correct entry (that would strand exactly the users who
    // already run another hook tool).
    const foreignFlat = `model = "gpt-5"\n\n[[hooks.SessionStart]]\ntype = "command"\ncommand = "lean-ctx.exe hook codex-session-start"\ntimeout = 10\n`;
    assert.equal(assertCodexConfigLoads(foreignFlat), undefined);
    const plan = planCodexHook(foreignFlat, hookCommand);
    assert.equal(plan.action, "install");
    assert.equal(assertCodexConfigLoads(plan.text), undefined);
});

test("an existing flat bili entry is upgraded in place, not left invisible", () => {
    // Self-heal: bili's own older output carried the flat shape. Detecting it as
    // "owned" and merely rewriting the command string would leave it silently
    // ignored forever, so the whole entry must be replaced.
    const flatOurs = `model = "gpt-5"\n\n[[hooks.SessionStart]]\ntype = "command"\ncommand = ${JSON.stringify(hookCommand)}\ntimeout = 15\n`;
    const plan = planCodexHook(flatOurs, hookCommand);
    assert.equal(plan.action, "refresh");
    assert.match(plan.note, /upgraded to the shape Codex registers/);
    assert.equal(assertCodexConfigLoads(plan.text), undefined);
    assert.doesNotMatch(plan.text, /^type = "command"$/m);
    // Still exactly one entry, still ours, and the user's other tables survive.
    assert.equal(plan.text.match(/\[\[hooks\.SessionStart\]\]/g)?.length, 1);
    assert.equal(findBiliCodexHook(plan.text), hookCommand);
    assert.match(plan.text, /model = "gpt-5"/);
});

test("strip removes only our entry and drops the table when it was ours alone", () => {
    const original = 'model = "gpt-5"\n';
    const installed = planCodexHook(original, hookCommand).text;
    const stripped = stripCodexHook(installed);
    assert.equal(stripped.removed, true);
    assert.equal(findBiliCodexHook(stripped.text), undefined);
    assert.doesNotMatch(stripped.text, /hooks\.SessionStart/);
    assert.match(stripped.text, /model = "gpt-5"/);
    assert.equal(stripCodexHook(original).removed, false);
});

test("strip keeps foreign entries in a shared SessionStart table", () => {
    const shared = `model = "gpt-5"\n\n[[hooks.SessionStart]]\nmatcher = "startup|resume|clear"\nhooks = [{ type = "command", command = "lean-ctx.exe hook codex-session-start", timeout = 10 }]\n`;
    const withOurs = `${shared.trimEnd()}\n\n${codexHookTable(hookCommand).trimEnd()}\n`;
    // Two separate tables: ours is dropped, theirs survives untouched.
    const stripped = stripCodexHook(withOurs);
    assert.equal(stripped.removed, true);
    assert.match(stripped.text, /lean-ctx\.exe hook codex-session-start/);
    assert.doesNotMatch(stripped.text, /bootstrap-hook\.js/);
});

test("hooks feature note reports a disabled or missing switch", () => {
    assert.match(codexHooksEnabledNote('model = "gpt-5"\n'), /hooks = true/);
    assert.match(
        codexHooksEnabledNote("[features]\nhooks = false\n"),
        /disables hooks/,
    );
    assert.equal(codexHooksEnabledNote("[features]\nhooks = true\n"), "");
});

test("the feature switch is read on CRLF configs (Windows)", () => {
    // Codex keeps CRLF on Windows. An anchored `$` that does not admit the
    // trailing `\r` silently missed the switch, so the installer claimed hook
    // execution was off on a config that plainly had `hooks = true`.
    const crlf =
        'model = "gpt-5"\r\n\r\n[features]\r\nhooks = true\r\n\r\n[[hooks.SessionStart]]\r\nhooks = [{ type = "command", command = "node C:/x/codex/bootstrap-hook.js", timeout = 15 }]\r\n';
    assert.deepEqual(codexHooksFeature(crlf), { value: true, raw: "true" });
    assert.equal(codexHooksEnabledNote(crlf), "");
    assert.equal(findBiliCodexHook(crlf), "node C:/x/codex/bootstrap-hook.js");
    assert.equal(assertCodexConfigLoads(crlf), undefined);

    // And a CRLF config with the switch explicitly off still reports it.
    const off = crlf.replace("hooks = true", "hooks = false");
    assert.equal(codexHooksFeature(off)?.value, false);
    assert.match(codexHooksEnabledNote(off), /disables hooks/);
});

test("an appended entry follows the file's existing line endings", () => {
    // The repo convention (src/kimi/toml-edit.ts:21, src/launcher.ts:2466) is to
    // never convert a user's file nor mix endings into it. Appending with a bare
    // "\n" left a CRLF config with a mixed-ending block.
    const crlfBase =
        'model = "gpt-5"\r\n\r\n[features]\r\nhooks = true\r\n\r\n[[hooks.SessionStart]]\r\nmatcher = "startup"\r\nhooks = [{ type = "command", command = "lean-ctx.exe hook codex-session-start", timeout = 10 }]\r\n';
    const crlfPlan = planCodexHook(crlfBase, hookCommand);
    assert.equal(crlfPlan.action, "install");
    // No lone LF anywhere in the CRLF file after the append.
    assert.equal(/[^\r]\n/.test(crlfPlan.text), false);
    assert.equal(crlfPlan.text.match(/\[\[hooks\.SessionStart\]\]/g)?.length, 2);
    assert.equal(findBiliCodexHook(crlfPlan.text), hookCommand);

    // An LF file stays LF.
    const lfBase = 'model = "gpt-5"\n';
    const lfPlan = planCodexHook(lfBase, hookCommand);
    assert.equal(lfPlan.text.includes("\r"), false);
});

test("hook table rendering and region detection agree", () => {
    // codexHookTable already emits the header; the region finder must see an
    // ARRAY-of-tables header, not just a plain one.
    const text = codexHookTable(hookCommand);
    assert.match(text, /^\[\[hooks\.SessionStart\]\]\n/);
    const regions = tableRegions(text, "hooks.SessionStart");
    assert.equal(regions.length, 1);
    assert.deepEqual(readCodexHookCommands(regions[0]!), [hookCommand]);
});

test("the pre-write guard rejects every shape Codex refuses to load", () => {
    // The regression that broke Codex Desktop: a map-valued `hooks`. This exact
    // shape is what bili used to write.
    const rejected = `[hooks.SessionStart]\nhooks = [{ type = "command", command = ${JSON.stringify(hookCommand)}, timeout = 15 }]\n`;
    const reason = assertCodexConfigLoads(rejected);
    assert.notEqual(reason, undefined);
    assert.match(String(reason), /\[\[hooks\.SessionStart\]\]/);

    // A top-level `hooks = ...` collapses the sequence too.
    assert.notEqual(assertCodexConfigLoads("hooks = []\n"), undefined);

    // The flat-sequence shape Codex also refuses (`expected struct HooksToml`).
    assert.notEqual(
        assertCodexConfigLoads(
            `[[hooks]]\nevent = "SessionStart"\ncommand = ${JSON.stringify(hookCommand)}\n`,
        ),
        undefined,
    );

    // An entry with no command at all — the stub a buggy strip once left behind.
    assert.notEqual(
        assertCodexConfigLoads('[[hooks.SessionStart]]\ntype = "command"\n'),
        undefined,
    );

    // What bili actually writes must pass.
    assert.equal(assertCodexConfigLoads(codexHookTable(hookCommand)), undefined);
    assert.equal(
        assertCodexConfigLoads(
            `model = "gpt-5"\n\n[features]\nhooks = true\n\n${codexHookTable(hookCommand)}`,
        ),
        undefined,
    );
});

test("Codex's own hooks.state trust ledger is not mistaken for our stage table", () => {
    // Codex records hook approval in `[hooks.state.'<config>:<stage>:<i>:<j>']`,
    // a SINGLE-bracket table holding key/value pairs. A guard that treated every
    // `hooks`-prefixed header as bili's malformed stage table rejected the whole
    // config, so `plugin install codex` skipped the hook face on any config where
    // a hook had ever been trusted — with no error, just "hook: skipped".
    const trustLedger = `[hooks.state.'C:\\Users\\me\\.codex\\config.toml:session_start:0:0']\ntrusted_hash = "sha256:d89b106f182af9d93c0e2d7611ce5a43b270367c15ec4b3fa8dfeb53768ce2fe"\n`;
    assert.equal(assertCodexConfigLoads(trustLedger), undefined);

    // And together with our own entry, which is what a real config looks like.
    const withLedger = `${codexHookTable(hookCommand)}\n${trustLedger}`;
    assert.equal(assertCodexConfigLoads(withLedger), undefined);

    // The plan still installs into such a file rather than bailing out.
    const plan = planCodexHook(trustLedger, hookCommand);
    assert.equal(plan.action, "install");
    assert.match(plan.text, /\[\[hooks\.SessionStart\]\]/);
    assert.match(plan.text, /hooks\.state/);
    assert.equal(assertCodexConfigLoads(plan.text), undefined);
});

test("insertTableRaw lands inside the table, before trailing comments", () => {
    const text = "[features]\na = 1\n\n# next section follows\n[other]\nb = 2\n";
    const next = insertTableRaw(text, "features", "hooks = true");
    assert.match(
        next,
        /\[features\]\na = 1\nhooks = true\n\n# next section follows/,
    );
    assert.match(next, /\[other\]\nb = 2/);
});

test("skill install writes our document and is idempotent", () => {
    const { env, dir } = tempHome();
    try {
        assert.equal(codexSkillStatus(env), "missing");
        const first = installCodexSkill(env);
        assert.equal(first.written, true);
        assert.equal(codexSkillStatus(env), "installed");
        assert.equal(
            fs.readFileSync(codexSkillFile(env), "utf8"),
            CODEX_SKILL_MARKDOWN,
        );
        assert.equal(readSkillName(CODEX_SKILL_MARKDOWN), "bili");
        assert.equal(path.dirname(codexSkillFile(env)), codexSkillDir(env));

        const again = installCodexSkill(env);
        assert.equal(again.written, false);
        assert.equal(again.note, "ACP skill already installed");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a foreign same-named skill is never overwritten or deleted", () => {
    const { env, dir } = tempHome();
    try {
        fs.mkdirSync(codexSkillDir(env), { recursive: true });
        const mine =
            "---\nname: bili\ndescription: user's own skill\n---\n\nkeep me\n";
        fs.writeFileSync(codexSkillFile(env), mine);
        assert.equal(codexSkillStatus(env), "foreign");
        const install = installCodexSkill(env);
        assert.equal(install.written, false);
        assert.match(install.note, /left untouched/);

        fs.writeFileSync(
            codexSkillFile(env),
            "---\nname: someone-else\n---\nbody\n",
        );
        assert.equal(codexSkillStatus(env), "foreign");
        const removal = removeCodexSkill(env);
        assert.equal(removal.removed, false);
        assert.equal(
            fs.readFileSync(codexSkillFile(env), "utf8"),
            "---\nname: someone-else\n---\nbody\n",
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("an owned-but-edited skill is marked outdated and refreshed", () => {
    const { env, dir } = tempHome();
    try {
        installCodexSkill(env);
        fs.writeFileSync(
            codexSkillFile(env),
            `${CODEX_SKILL_MARKDOWN}\nlocal note\n`,
        );
        assert.equal(codexSkillStatus(env), "outdated");
        const refreshed = installCodexSkill(env);
        assert.equal(refreshed.written, true);
        assert.equal(codexSkillStatus(env), "installed");
        assert.equal(
            fs.readFileSync(codexSkillFile(env), "utf8"),
            CODEX_SKILL_MARKDOWN,
        );
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("remove deletes only our skill and leaves a non-empty directory", () => {
    const { env, dir } = tempHome();
    try {
        installCodexSkill(env);
        fs.writeFileSync(path.join(codexSkillDir(env), "notes.md"), "user notes\n");
        const removal = removeCodexSkill(env);
        assert.equal(removal.removed, true);
        assert.equal(fs.existsSync(codexSkillFile(env)), false);
        assert.equal(
            fs.existsSync(path.join(codexSkillDir(env), "notes.md")),
            true,
        );
        assert.equal(codexSkillStatus(env), "missing");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
