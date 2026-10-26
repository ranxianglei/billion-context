import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    extractCodexProfile,
    parseCodexCliOverrides,
    mergeCodexViews,
    codexTomlProblem,
    resolveCodexEffectiveView,
    type CodexConfig,
} from "../src/client-config.js";

// #2197: the effective-view layer (base config.toml + -p profile file + CLI
// -c/-m overrides) that launcher route discovery must use. Precedence facts
// were verified empirically against codex-cli 0.147.0 with marker upstreams.

test("extractCodexProfile: -p / --profile / --profile= forms, last wins, flags skipped", () => {
    assert.equal(extractCodexProfile(["-p", "review", "exec"]), "review");
    assert.equal(extractCodexProfile(["--profile", "fast", "exec"]), "fast");
    assert.equal(extractCodexProfile(["--profile=fast", "exec"]), "fast");
    assert.equal(extractCodexProfile(["-p", "a", "-p", "b"]), "b");
    assert.equal(extractCodexProfile(["-p", "--skip-git-repo-check"]), undefined);
    assert.equal(extractCodexProfile(["--profile="]), undefined);
    assert.equal(extractCodexProfile(["exec", "--skip-git-repo-check"]), undefined);
});

test("parseCodexCliOverrides: scalar keys, quoted values, nested provider, numbers", () => {
    const out = parseCodexCliOverrides([
        "-c", 'model="gpt-x"',
        "-c", "model_provider=p1",
        "-c", "openai_base_url='http://up.local/v1'",
        "-c", "model_context_window=200000",
        "-c", "model_auto_compact_token_limit=150000",
        "-c", "model_max_output_tokens=8192",
        "-c", "model_providers.e2e.base_url=http://127.0.0.1:9999/v1",
        "-c", "some.other.key=ignored",
    ]);
    assert.equal(out.model, "gpt-x");
    assert.equal(out.modelProvider, "p1");
    assert.equal(out.openaiBaseUrl, "http://up.local/v1");
    assert.equal(out.contextWindow, 200000);
    assert.equal(out.autoCompactLimit, 150000);
    assert.equal(out.maxOutput, 8192);
    assert.deepEqual(out.providers, { e2e: { baseUrl: "http://127.0.0.1:9999/v1" } });
});

test("parseCodexCliOverrides: repeated keys — last wins (codex verified)", () => {
    const out = parseCodexCliOverrides(["-c", "model=a", "-c", "model=b"]);
    assert.equal(out.model, "b");
    const prov = parseCodexCliOverrides([
        "-c", "model_providers.x.base_url=http://one/",
        "-c", "model_providers.x.base_url=http://two/",
    ]);
    assert.equal(prov.providers.x?.baseUrl, "http://two/");
});

test("parseCodexCliOverrides: -m / --model forms, last wins", () => {
    assert.equal(parseCodexCliOverrides(["-m", "m1"]).model, "m1");
    assert.equal(parseCodexCliOverrides(["--model=m2"]).model, "m2");
    assert.equal(parseCodexCliOverrides(["-m", "m1", "--model", "m3"]).model, "m3");
});

test("parseCodexCliOverrides: positional prompt words are never swallowed by -c", () => {
    // `-c` whose next arg lacks '=' is left alone; nothing parsed.
    const out = parseCodexCliOverrides(["-c", "just a prompt word", "more"]);
    assert.deepEqual(out, { providers: {} });
    // A real pair after the stray one still parses.
    const out2 = parseCodexCliOverrides(["-c", "nope", "-c", "model=y"]);
    assert.equal(out2.model, "y");
});

test("parseCodexCliOverrides: non-numeric / zero budget values are dropped", () => {
    const out = parseCodexCliOverrides([
        "-c", "model_context_window=abc",
        "-c", "model_max_output_tokens=0",
        "-c", "model_auto_compact_token_limit=-5",
    ]);
    assert.equal(out.contextWindow, undefined);
    assert.equal(out.maxOutput, undefined);
    assert.equal(out.autoCompactLimit, undefined);
});

test("mergeCodexViews: overlay wins per key, providers merge by name", () => {
    const base: CodexConfig = {
        model: "m-base",
        modelProvider: "pb",
        openaiBaseUrl: "http://base/",
        contextWindow: 100000,
        autoCompactLimit: 80000,
        maxOutput: 4096,
        providers: { a: { baseUrl: "http://a/" }, b: { baseUrl: "http://b1/" } },
    };
    const overlay: CodexConfig = {
        model: "m-ovr",
        contextWindow: 200000,
        providers: { b: { baseUrl: "http://b2/" }, c: { baseUrl: "http://c/" } },
    };
    const merged = mergeCodexViews(base, overlay);
    assert.equal(merged.model, "m-ovr");
    assert.equal(merged.modelProvider, "pb");
    assert.equal(merged.openaiBaseUrl, "http://base/");
    assert.equal(merged.contextWindow, 200000);
    assert.equal(merged.autoCompactLimit, 80000);
    assert.equal(merged.maxOutput, 4096);
    assert.deepEqual(merged.providers, {
        a: { baseUrl: "http://a/" },
        b: { baseUrl: "http://b2/" },
        c: { baseUrl: "http://c/" },
    });
    assert.deepEqual(merged.modelWindows, [{ id: "m-ovr", contextWindow: 200000, maxOutput: 4096 }]);
});

test("mergeCodexViews: no model id → no modelWindows entry", () => {
    const merged = mergeCodexViews({ providers: {} }, { contextWindow: 123, providers: {} });
    assert.equal(merged.modelWindows, undefined);
});

test("codexTomlProblem: valid structures pass silently", () => {
    const ok = [
        "# comment\nmodel = \"x\"\n[model_providers.a]\nbase_url = \"http://a/\"\n[[mcp_servers.s]]\ncommand = \"c\"\n",
        'instructions = """\nnot a key line at all\n"""\nmodel = "y"\n',
        "instructions = '''\nstill fine [unclosed\n'''\n",
        '"dotted.key" = 1\n[a.b]\nc = 2\n',
        // #2260(E): quoted keys with spaces / non-ASCII are VALID TOML — the
        // pre-fix regex false-fataled these and bili refused the launch.
        '"my key" = 1\n',
        '"ключ" = 2\n',
        "'lit-eral' = 3\n",
        'a."b c".d = 4\n',
        '"esc\\"aped" = 5\n',
        // bracket-opened values spanning lines are value context, not key lines
        "arr = [\n  \"a\",\n  \"b\",\n]\nmodel = \"y\"\n",
        "t = {\n  a = 1,\n}\nmodel = \"y\"\n",
        // brackets inside values / strings / comments must not skew the depth
        "s = \"a]b[c\" # note ]\nmodel = \"y\"\n",
    ];
    for (const t of ok) assert.equal(codexTomlProblem(t), null, JSON.stringify(t));
});

test("codexTomlProblem: structural breakage is reported with its line", () => {
    const bad = "model = \"x\"\n[model_providers.a\nbase_url = \"http://a/\"\n";
    const p = codexTomlProblem(bad);
    assert.ok(typeof p === "string" && p.startsWith("line 2:"), String(p));
    const garbage = "model = \"x\"\nthis is not toml\n";
    assert.ok(codexTomlProblem(garbage)?.startsWith("line 2:"));
    // #2260(E): unbalanced brackets are structurally broken (codex hard-fails)
    assert.match(String(codexTomlProblem("arr = [\n  \"a\"\n")), /never closed/);
    assert.ok(codexTomlProblem("model = \"x\"\n]\n")?.startsWith("line 2:"));
});

function writeHome(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-eff-"));
    for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), content, "utf8");
    }
    return dir;
}

test("resolveCodexEffectiveView: profile-only provider takes over routing (#2197 core case)", () => {
    const home = writeHome({
        "config.toml": 'model = "m-base"\nmodel_provider = "baseprov"\n[model_providers.baseprov]\nbase_url = "http://base.local/v1"\n',
        "review.config.toml": 'model_provider = "revprov"\n[model_providers.revprov]\nbase_url = "http://rev.local/v1"\n',
    });
    try {
        const base = { model: "m-base", modelProvider: "baseprov", providers: { baseprov: { baseUrl: "http://base.local/v1" } } };
        const view = resolveCodexEffectiveView(home, base, ["-p", "review", "exec"]);
        assert.equal(view.fatal, undefined);
        assert.equal(view.profileMissing, undefined);
        assert.equal(view.profile, "review");
        assert.equal(view.config.modelProvider, "revprov");
        assert.equal(view.config.providers.revprov?.baseUrl, "http://rev.local/v1");
        assert.equal(view.config.providers.baseprov?.baseUrl, "http://base.local/v1");
        assert.equal(view.config.model, "m-base");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("resolveCodexEffectiveView: precedence CLI > profile > base", () => {
    const home = writeHome({
        "config.toml": 'model_provider = "baseprov"\n[model_providers.baseprov]\nbase_url = "http://base.local/v1"\n',
        "review.config.toml": 'model_provider = "revprov"\n[model_providers.revprov]\nbase_url = "http://rev.local/v1"\n',
    });
    try {
        const base = { modelProvider: "baseprov", providers: { baseprov: { baseUrl: "http://base.local/v1" } } };
        const v1 = resolveCodexEffectiveView(home, base, ["-p", "review"]);
        assert.equal(v1.config.modelProvider, "revprov");
        const v2 = resolveCodexEffectiveView(home, base, ["-p", "review", "-c", "model_provider=baseprov"]);
        assert.equal(v2.config.modelProvider, "baseprov");
        const v3 = resolveCodexEffectiveView(home, base, ["-p", "review", "-c", "model_provider=cli"]);
        assert.equal(v3.config.modelProvider, "cli");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("resolveCodexEffectiveView: missing profile → base view + visible notice flag (codex continues base-only)", () => {
    const home = writeHome({
        "config.toml": 'model = "m"\n[model_providers.b]\nbase_url = "http://b.local/v1"\n',
    });
    try {
        const base = { model: "m", providers: { b: { baseUrl: "http://b.local/v1" } } };
        const view = resolveCodexEffectiveView(home, base, ["-p", "nosuch", "exec"]);
        assert.equal(view.fatal, undefined);
        assert.equal(view.profileMissing, true);
        assert.deepEqual(view.config.providers, { b: { baseUrl: "http://b.local/v1" } });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("resolveCodexEffectiveView: malformed profile TOML → fatal naming the file", () => {
    const home = writeHome({
        "config.toml": "model = \"m\"\n",
        "broken.config.toml": "[model_providers.a\nbase_url = \"http://a/\"\n",
    });
    try {
        const view = resolveCodexEffectiveView(home, { providers: {} }, ["-p", "broken"]);
        assert.ok(view.fatal, "expected fatal");
        assert.match(view.fatal!, /broken\.config\.toml/);
        assert.match(view.fatal!, /line 1/);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("resolveCodexEffectiveView: profile name with separators → fatal (no path escape)", () => {
    for (const bad of ["../etc", "..\\win", "/abs", "a/b"]) {
        const view = resolveCodexEffectiveView("/nonexistent-home", { providers: {} }, ["-p", bad]);
        assert.ok(view.fatal, `expected fatal for ${bad}`);
        assert.match(view.fatal!, /invalid codex profile name/);
    }
});

test("resolveCodexEffectiveView: no -p/-c → base view passes through unchanged", () => {
    const base: CodexConfig = {
        model: "m",
        contextWindow: 100000,
        maxOutput: 4096,
        providers: { b: { baseUrl: "http://b.local/v1" } },
    };
    const view = resolveCodexEffectiveView("/nonexistent-home", base, ["exec", "--skip-git-repo-check"]);
    assert.equal(view.fatal, undefined);
    assert.equal(view.profileMissing, undefined);
    // Same shape parseCodexToml produces for these scalars (derived modelWindows included).
    assert.deepEqual(view.config, { ...base, modelWindows: [{ id: "m", contextWindow: 100000, maxOutput: 4096 }] });
});
