import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { declareDshCompactionActive, disableBasicCompaction, dshCompactionGateTelemetry, dshCompactionKeepCommandCompact, isDshCompactionActive, registerCompactionDisable, _resetDshCompactionGateTelemetryForTest, _resetDshCompactionVerdictForTest } from "../src/agent/dsh-compaction-disable.ts";
import { dshKeepCommandCompactEnabled } from "../src/knobs.ts";

// #4872: the #3354 load-time overlay scope is knob-gated — with
// dsh.keepCommandCompact ON the transform disables ONLY compaction-basic and
// leaves the explicit /compact command (command-compact) armed so third-party
// plugins bridging through the DSH-official ctx.commands.find(agent, "compact")
// path keep working. Default OFF = the original both-packages rule (zero drift).
// The apply-level wiring (knob → verdict flag) is pinned in
// tests/dsh-native.test.ts ("declares lane ownership").

const VERDICT_KEY = "__BILI_DSH_COMPACTION_VERDICT__";

function resetAll(): void {
    _resetDshCompactionVerdictForTest();
    _resetDshCompactionGateTelemetryForTest();
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

test("#4872 disableBasicCompaction: default scope still disables BOTH packages", () => {
    const rows = [
        { name: "@deepseek-ai/dsh-compaction-basic", config: { auto: true } },
        { name: "@deepseek-ai/dsh-command-compact" },
        { name: "@deepseek-ai/dsh-other" },
    ];
    const out = disableBasicCompaction(rows) as Array<Record<string, unknown>>;
    assert.equal(out[0].disabled, true);
    assert.equal(out[1].disabled, true);
    assert.equal(out[2].disabled, undefined);
});

test("#4872 disableBasicCompaction: keepCommandCompact leaves /compact armed at any depth", () => {
    const nestedCompact = { name: "@deepseek-ai/dsh-command-compact" };
    const deepCompact = { name: "@deepseek-ai/dsh-command-compact" };
    const rows = [
        { name: "@deepseek-ai/dsh-compaction-basic" },
        { name: "@deepseek-ai/dsh-command-compact" },
        { name: "@deepseek-ai/dsh-other" },
        {
            id: "compaction",
            name: "cordis:group",
            group: true,
            config: [
                { name: "@deepseek-ai/dsh-compaction-basic" },
                nestedCompact,
                { group: true, config: [deepCompact] },
            ],
        },
    ];
    const snapshot = JSON.stringify(rows);
    const out = disableBasicCompaction(rows, { keepCommandCompact: true }) as Array<Record<string, unknown>>;
    // input untouched, output detached
    assert.equal(JSON.stringify(rows), snapshot);
    assert.notEqual(out[0], rows[0]);
    // basic disabled at top level and in every nesting depth…
    assert.equal(out[0].disabled, true);
    const inner = (out[3] as Record<string, unknown>).config as Array<Record<string, unknown>>;
    assert.equal(inner[0].disabled, true);
    // …while command-compact rows pass through BY IDENTITY (untouched)
    assert.equal(out[1], rows[1]);
    assert.equal(inner[1], nestedCompact);
    const deep = (inner[2].config as Array<Record<string, unknown>>)[0];
    // Reference equality with the pristine input leaf proves the row passed through
    // untouched (a rewrite would produce a detached copy) — so no `disabled` key exists.
    assert.equal(deep, deepCompact);
    assert.deepEqual(deep, { name: "@deepseek-ai/dsh-command-compact" });
    // non-compaction rows pass through by identity too
    assert.equal(out[2], rows[2]);
});

test("#4872 verdict channel: scope flag rides the declaration, legacy string tolerated", () => {
    resetAll();
    try {
        assert.equal(isDshCompactionActive(), false);
        assert.equal(dshCompactionKeepCommandCompact(), false);
        declareDshCompactionActive();
        assert.equal(isDshCompactionActive(), true);
        assert.equal(dshCompactionKeepCommandCompact(), false, "absent option keeps the both-packages rule");
        declareDshCompactionActive({ keepCommandCompact: false });
        assert.equal(dshCompactionKeepCommandCompact(), false);
        declareDshCompactionActive({ keepCommandCompact: true });
        assert.equal(isDshCompactionActive(), true);
        assert.equal(dshCompactionKeepCommandCompact(), true);
        // pre-#4872 builds declared the bare string "active" — a mixed-version
        // process mid-update must degrade to the original rule, not lose the gate
        (globalThis as Record<string, unknown>)[VERDICT_KEY] = "active";
        assert.equal(isDshCompactionActive(), true);
        assert.equal(dshCompactionKeepCommandCompact(), false);
    } finally {
        resetAll();
    }
});

test("#4872 transform: keepCommandCompact verdict rewrites only compaction-basic", () => {
    type Mw = (raw: unknown, next: () => unknown) => unknown;
    let mw: Mw | undefined;
    resetAll();
    declareDshCompactionActive({ keepCommandCompact: true });
    try {
        registerCompactionDisable({
            on: (_event, listener) => { mw = listener as Mw; },
            reflect: {},
        });
        assert.equal(typeof mw, "function");
        const compact = { name: "@deepseek-ai/dsh-command-compact" };
        const other = { name: "@deepseek-ai/dsh-tool-result-pruner" };
        const cfg: Record<string, unknown> = {
            plugins: [
                { name: "@deepseek-ai/dsh-compaction-basic", config: { auto: true } },
                compact,
                other,
            ],
            isolate: { compaction: true },
        };
        const self = { entry: { options: { name: "@deepseek-ai/dsh-agent-preset" } } };
        const out = mw?.call(self, null, () => cfg) as { plugins?: Array<unknown>; isolate?: Record<string, unknown> };
        assert.deepEqual(out.isolate, { compaction: true });
        assert.notEqual(out, cfg);
        assert.equal((out.plugins?.[0] as Record<string, unknown>).disabled, true);
        assert.equal(out.plugins?.[1], compact, "/compact row must survive by identity");
        assert.equal(out.plugins?.[2], other);
        // telemetry counts only what the rewrite actually marked
        const tel = dshCompactionGateTelemetry();
        assert.ok(tel);
        assert.deepEqual(tel.covered, [{ entry: "@deepseek-ai/dsh-agent-preset", rows: 1 }]);
        assert.equal(tel.sawFactoryPreset, true);
        // a tree carrying ONLY command-compact rows has nothing to rewrite —
        // the resolved config keeps its object identity and records no coverage
        const compactOnly: Record<string, unknown> = { plugins: [{ name: "@deepseek-ai/dsh-command-compact" }] };
        assert.equal(mw?.call(self, null, () => compactOnly), compactOnly);
        assert.deepEqual(dshCompactionGateTelemetry()?.covered, [{ entry: "@deepseek-ai/dsh-agent-preset", rows: 1 }]);
    } finally {
        resetAll();
    }
});

test("#4872 transform: default verdict still rewrites both packages (regression pin)", () => {
    type Mw = (raw: unknown, next: () => unknown) => unknown;
    let mw: Mw | undefined;
    resetAll();
    declareDshCompactionActive();
    try {
        registerCompactionDisable({
            on: (_event, listener) => { mw = listener as Mw; },
            reflect: {},
        });
        const cfg: Record<string, unknown> = {
            plugins: [
                { name: "@deepseek-ai/dsh-compaction-basic" },
                { name: "@deepseek-ai/dsh-command-compact" },
            ],
        };
        const self = { entry: { options: { name: "@deepseek-ai/dsh-agent-preset" } } };
        const out = mw?.call(self, null, () => cfg) as { plugins?: Array<Record<string, unknown>> };
        assert.equal(out.plugins?.[0]?.disabled, true);
        assert.equal(out.plugins?.[1]?.disabled, true);
        assert.deepEqual(dshCompactionGateTelemetry()?.covered, [{ entry: "@deepseek-ai/dsh-agent-preset", rows: 2 }]);
        // an ABSENT declaration (bili-native never ran) passes everything through stock
        _resetDshCompactionVerdictForTest();
        assert.equal(mw?.call(self, null, () => cfg), cfg);
    } finally {
        resetAll();
    }
});

test("#4872 dshKeepCommandCompactEnabled: env > file > default(false)", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-issue4872-knob-"));
    try {
        const onFile = path.join(home, "on.json");
        fs.writeFileSync(onFile, JSON.stringify({ dsh: { keepCommandCompact: true } }));
        const offFile = path.join(home, "off.json");
        fs.writeFileSync(offFile, "{}");
        assert.equal(await withEnv({ BILI_CONFIG_FILE: offFile, BILI_DSH_KEEP_COMMAND_COMPACT: undefined }, () => dshKeepCommandCompactEnabled()), false, "default OFF = today's behavior");
        assert.equal(await withEnv({ BILI_CONFIG_FILE: onFile, BILI_DSH_KEEP_COMMAND_COMPACT: undefined }, () => dshKeepCommandCompactEnabled()), true, "file tier");
        assert.equal(await withEnv({ BILI_CONFIG_FILE: onFile, BILI_DSH_KEEP_COMMAND_COMPACT: "0" }, () => dshKeepCommandCompactEnabled()), false, "env wins over file (off)");
        assert.equal(await withEnv({ BILI_CONFIG_FILE: offFile, BILI_DSH_KEEP_COMMAND_COMPACT: "false" }, () => dshKeepCommandCompactEnabled()), false);
        assert.equal(await withEnv({ BILI_CONFIG_FILE: offFile, BILI_DSH_KEEP_COMMAND_COMPACT: "1" }, () => dshKeepCommandCompactEnabled()), true, "env wins over file (on)");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
