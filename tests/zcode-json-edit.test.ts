import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    applyZcodeRouting,
    detectZcodeStore,
    inspectZcodeRouting,
    resolveZcodeDataDir,
    stampZcodePluginHeader,
    unrouteZcodeText,
    zcodeStoreCandidates,
    ZCODE_BIGMODEL_ANTHROPIC_UPSTREAM,
} from "../src/zcode/json-edit.ts";
import { rmrf } from "./tmp-rm.ts";

import type { ZcodeRoutePolicy } from "../src/zcode/json-edit.ts";

// #1145: the provider-store surgery is the user-facing safety surface — every
// store generation, every refusal path, and the wrap/stamp/unroute roundtrip
// get direct coverage. Pure functions only; no proxy involved.

const ORIGIN_A = "http://127.0.0.1:18787";
const ORIGIN_B = "http://127.0.0.1:28787";
const UPSTREAM = ZCODE_BIGMODEL_ANTHROPIC_UPSTREAM;
// #1622 made route:"all" the default; these tests pin the explicitly-selected
// pre-#1622 whitelist behavior (still available via BILI_ZCODE_ROUTE=plans).
const PLANS_POLICY: ZcodeRoutePolicy = { route: "plans", directPrefixes: [], assumeSigningFixed: false };

function dataDir(): string {
    return mkdtempSync(path.join(tmpdir(), "zcode-json-edit-"));
}

test("resolveZcodeDataDir derives the .zcode root upstream-style (base dir, not the root itself)", () => {
    assert.equal(resolveZcodeDataDir({ ZCODE_DATA_BASE_DIR: "/data" }), path.join("/data", ".zcode"));
    assert.equal(path.basename(resolveZcodeDataDir({})), ".zcode");
});

test("zcodeStoreCandidates maps kinds to v2 paths; explicit personal override ranks first (#1151)", () => {
    assert.deepEqual(zcodeStoreCandidates("/d", "legacy"), [path.join("/d", "v2", "config.json")]);
    assert.deepEqual(zcodeStoreCandidates("/d", "new"), [path.join("/d", "v2", "provider_config.json")]);
    assert.deepEqual(zcodeStoreCandidates("/d", "new", { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/alt/p.json" }), [
        "/alt/p.json",
        path.join("/d", "v2", "provider_config.json"),
    ]);
    assert.deepEqual(zcodeStoreCandidates("/d", "legacy", { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/alt/p.json" }), [
        path.join("/d", "v2", "config.json"),
    ]);
});

test("detectZcodeStore honors an explicit personal-file override outside the v2 dir (#1151)", () => {
    const dir = dataDir();
    try {
        mkdirSync(path.join(dir, "v2"), { recursive: true });
        writeFileSync(zcodeStoreCandidates(dir, "legacy")[0], JSON.stringify({ provider: {} }));
        assert.equal(detectZcodeStore(dir).kind, "legacy");
        const alt = path.join(dir, "alt-personal.json");
        writeFileSync(alt, JSON.stringify({ schemaVersion: 1, config: { providerConfigRules: { providerRules: [] } } }));
        const env = { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: alt };
        assert.deepEqual(detectZcodeStore(dir, env), { kind: "new", file: alt });
    } finally {
        rmrf(dir);
    }
});

test("detectZcodeStore prefers a valid new store and falls back to legacy", () => {
    const dir = dataDir();
    try {
        mkdirSync(path.join(dir, "v2"), { recursive: true });
        const legacy = zcodeStoreCandidates(dir, "legacy")[0];
        const fresh = zcodeStoreCandidates(dir, "new")[0];

        assert.deepEqual(detectZcodeStore(dir), { kind: "legacy", file: legacy });

        writeFileSync(fresh, JSON.stringify({ schemaVersion: 2, config: {} }));
        assert.equal(detectZcodeStore(dir).kind, "legacy");

        writeFileSync(fresh, "{oops");
        assert.equal(detectZcodeStore(dir).kind, "legacy");

        writeFileSync(legacy, "{}\n");
        writeFileSync(fresh, JSON.stringify({ schemaVersion: 1, config: {} }) + "\n");
        assert.deepEqual(detectZcodeStore(dir), { kind: "new", file: fresh });
    } finally {
        rmrf(dir);
    }
});

test("applyZcodeRouting legacy wraps plan entries and preserves everything else — route:\"plans\"", () => {
    const doc = {
        theme: "dark",
        provider: {
            "builtin:bigmodel-coding-plan": { options: { baseURL: UPSTREAM }, name: "bigmodel" },
            "custom:mine": { options: { baseURL: "https://example.com/v1" } },
        },
    };
    const out = applyZcodeRouting(JSON.stringify(doc), "legacy", ORIGIN_A, PLANS_POLICY);
    assert.equal(out.wrapped.length, 1);
    assert.deepEqual(out.wrapped[0], { id: "builtin:bigmodel-coding-plan", upstream: UPSTREAM });
    const parsed = JSON.parse(out.text) as typeof doc;
    assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].options.baseURL, `${ORIGIN_A}/bili/${UPSTREAM}`);
    assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].name, "bigmodel");
    assert.equal(parsed.provider["custom:mine"].options.baseURL, "https://example.com/v1");
    assert.equal(parsed.theme, "dark");
});

test("applyZcodeRouting legacy re-wraps across sessions with different ports", () => {
    const doc = { provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: UPSTREAM } } } };
    const once = applyZcodeRouting(JSON.stringify(doc), "legacy", ORIGIN_A);
    const twice = applyZcodeRouting(once.text, "legacy", ORIGIN_B);
    assert.equal(twice.wrapped.length, 1);
    assert.equal(twice.wrapped[0].upstream, UPSTREAM);
    const parsed = JSON.parse(twice.text) as { provider: Record<string, { options: { baseURL: string } }> };
    assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].options.baseURL, `${ORIGIN_B}/bili/${UPSTREAM}`);
});

test("applyZcodeRouting legacy keeps a user-custom upstream and defaults invalid ones — route:\"plans\"", () => {
    const custom = applyZcodeRouting(
        JSON.stringify({ provider: { "builtin:zai-coding-plan": { options: { baseURL: "https://my.upstream.example/api" } } } }),
        "legacy",
        ORIGIN_A,
        PLANS_POLICY,
    );
    assert.equal(custom.wrapped[0].upstream, "https://my.upstream.example/api");

    const invalid = applyZcodeRouting(
        JSON.stringify({ provider: { "builtin:bigmodel": { options: { baseURL: "not-a-url" } } } }),
        "legacy",
        ORIGIN_A,
        PLANS_POLICY,
    );
    assert.equal(invalid.wrapped[0].upstream, UPSTREAM);
});

test("applyZcodeRouting legacy creates the canonical bigmodel set when nothing exists — route:\"plans\"", () => {
    const out = applyZcodeRouting("{}", "legacy", ORIGIN_A, PLANS_POLICY);
    assert.deepEqual(
        out.wrapped.map((w) => w.id),
        ["builtin:bigmodel-coding-plan", "builtin:bigmodel-start-plan"],
    );
    const parsed = JSON.parse(out.text) as { provider: Record<string, { options: { baseURL: string } }> };
    for (const id of ["builtin:bigmodel-coding-plan", "builtin:bigmodel-start-plan"]) {
        assert.equal(parsed.provider[id].options.baseURL, `${ORIGIN_A}/bili/${UPSTREAM}`);
    }
});

test("applyZcodeRouting new wraps account:* rules and leaves others alone — route:\"plans\"", () => {
    const doc = {
        schemaVersion: 1,
        config: {
            providerConfigRules: {
                providerRules: [
                    { providerId: "account:bigmodel-individual-coding-plan", config: { api: { baseUrl: UPSTREAM } } },
                    { providerId: "account:zai-team-coding-plan", config: { api: { type: "openai-chat-completions", baseUrl: "https://z.z.ai/api" } } },
                    { providerId: "custom:x", config: { api: { baseUrl: "https://example.com" } } },
                ],
            },
        },
    };
    const out = applyZcodeRouting(JSON.stringify(doc), "new", ORIGIN_A, PLANS_POLICY);
    assert.deepEqual(
        out.wrapped.map((w) => w.id),
        ["account:bigmodel-individual-coding-plan", "account:zai-team-coding-plan"],
    );
    const parsed = JSON.parse(out.text) as typeof doc;
    const rules = parsed.config.providerConfigRules.providerRules as Array<{ providerId: string; config: { api: Record<string, unknown> } }>;
    assert.equal(rules[0].config.api.baseUrl, `${ORIGIN_A}/bili/${UPSTREAM}`);
    assert.equal(rules[1].config.api.type, "openai-chat-completions");
    assert.equal(rules[1].config.api.baseUrl, `${ORIGIN_A}/bili/https://z.z.ai/api`);
    assert.equal(rules[2].config.api.baseUrl, "https://example.com");
});

test("applyZcodeRouting new creates the canonical bigmodel rules when empty — route:\"plans\"", () => {
    const out = applyZcodeRouting(JSON.stringify({ schemaVersion: 1, config: {} }), "new", ORIGIN_A, PLANS_POLICY);
    assert.deepEqual(
        out.wrapped.map((w) => w.id),
        ["account:bigmodel-individual-coding-plan", "account:bigmodel-team-coding-plan", "account:bigmodel-start-plan"],
    );
});

test("applyZcodeRouting default route all wraps every usable entry and reports skips (#1622)", () => {
    const doc = {
        provider: {
            "builtin:bigmodel-coding-plan": { options: { baseURL: UPSTREAM } },
            "custom:mine": { options: { baseURL: "https://example.com/v1" } },
            "local:relay": { options: { baseURL: "http://127.0.0.1:9090/v1" } },
            "no:url": {},
        },
    };
    const out = applyZcodeRouting(JSON.stringify(doc), "legacy", ORIGIN_A);
    assert.deepEqual(out.wrapped.map((w) => w.id), ["builtin:bigmodel-coding-plan", "custom:mine"]);
    assert.deepEqual(out.skipped.map((s) => s.id), ["local:relay", "no:url"]);
    assert.ok(out.skipped.every((s) => s.reason.length > 0));
});

test("applyZcodeRouting default route all skips v3.14+ signing accounts per entry (#1621)", () => {
    const doc = {
        schemaVersion: 1,
        config: {
            providerConfigRules: {
                providerRules: [
                    { providerId: "account:bigmodel-individual-coding-plan", config: { api: { baseUrl: UPSTREAM } } },
                    { providerId: "custom:x", config: { api: { baseUrl: "https://example.com" } } },
                ],
            },
        },
    };
    const out = applyZcodeRouting(JSON.stringify(doc), "new", ORIGIN_A);
    assert.deepEqual(out.wrapped.map((w) => w.id), ["custom:x"]);
    assert.deepEqual(out.skipped.map((s) => s.id), ["account:bigmodel-individual-coding-plan"]);
});

test("applyZcodeRouting refuses malformed or wrong-shaped input loudly", () => {
    assert.throws(() => applyZcodeRouting("{oops", "legacy", ORIGIN_A), /not valid JSON/);
    assert.throws(() => applyZcodeRouting("[]", "legacy", ORIGIN_A), /must be a JSON object/);
    assert.throws(() => applyZcodeRouting(JSON.stringify({ schemaVersion: 1 }), "new", ORIGIN_A), /missing its config object/);
});

test("stampZcodePluginHeader stamps wrapped entries only and is byte-stable", () => {
    const doc = {
        provider: {
            "builtin:bigmodel-coding-plan": { options: { baseURL: `${ORIGIN_A}/bili/${UPSTREAM}`, headers: { "x-foo": "bar" } } },
            "custom:mine": { options: { baseURL: "https://example.com/v1", headers: { "x-foo": "bar" } } },
        },
    };
    const text = JSON.stringify(doc);
    const stamped = stampZcodePluginHeader(text, "legacy");
    assert.notEqual(stamped, text);
    const parsed = JSON.parse(stamped) as typeof doc;
    assert.deepEqual(parsed.provider["builtin:bigmodel-coding-plan"].options.headers, { "x-foo": "bar", "x-bili-plugin": "zcode" });
    assert.deepEqual(parsed.provider["custom:mine"].options.headers, { "x-foo": "bar" });
    assert.equal(stampZcodePluginHeader(stamped, "legacy"), stamped);
    const unwrapped = JSON.stringify({ provider: { "custom:mine": { options: { baseURL: "https://example.com/v1" } } } });
    assert.equal(stampZcodePluginHeader(unwrapped, "legacy"), unwrapped);
});

test("unrouteZcodeText strips wrapper and header in place", () => {
    const doc = { provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: `${ORIGIN_A}/bili/${UPSTREAM}`, headers: { "x-bili-plugin": "zcode", keep: "1" } } } } };
    const once = unrouteZcodeText(JSON.stringify(doc), "legacy");
    assert.equal(once.changed, true);
    const parsed = JSON.parse(once.text) as typeof doc;
    assert.equal(parsed.provider["builtin:bigmodel-coding-plan"].options.baseURL, UPSTREAM);
    assert.deepEqual(parsed.provider["builtin:bigmodel-coding-plan"].options.headers, { keep: "1" });
    const twice = unrouteZcodeText(once.text, "legacy");
    assert.equal(twice.changed, false);
    assert.equal(twice.text, once.text);
});

test("inspectZcodeRouting reports the routed entries per store kind", () => {
    const dir = dataDir();
    try {
        mkdirSync(path.join(dir, "v2"), { recursive: true });

        assert.equal(inspectZcodeRouting(dir), undefined);

        const legacyDoc = { provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: `${ORIGIN_A}/bili/${UPSTREAM}` } } } };
        writeFileSync(zcodeStoreCandidates(dir, "legacy")[0], JSON.stringify(legacyDoc));
        assert.deepEqual(inspectZcodeRouting(dir), {
            kind: "legacy",
            file: zcodeStoreCandidates(dir, "legacy")[0],
            wrapped: [{ id: "builtin:bigmodel-coding-plan", upstream: UPSTREAM }],
        });

        const newDoc = {
            schemaVersion: 1,
            config: {
                providerConfigRules: {
                    providerRules: [{ providerId: "account:bigmodel-individual-coding-plan", config: { api: { baseUrl: `${ORIGIN_B}/bili/${UPSTREAM}` } } }],
                },
            },
        };
        writeFileSync(zcodeStoreCandidates(dir, "new")[0], JSON.stringify(newDoc));
        const fresh = inspectZcodeRouting(dir);
        assert.equal(fresh?.kind, "new");
        assert.deepEqual(fresh?.wrapped, [{ id: "account:bigmodel-individual-coding-plan", upstream: UPSTREAM }]);
        assert.equal(readFileSync(zcodeStoreCandidates(dir, "new")[0], "utf8").includes("schemaVersion"), true);
    } finally {
        rmrf(dir);
    }
});
