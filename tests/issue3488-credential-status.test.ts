import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    SummaryCredentialStore,
    describeCredentialState,
    auditExternalSummaryCredentials,
    auditStartupSummaryCredentials,
} from "../src/external-summary-credentials.ts";
import type { NamedProviderRecipe } from "../src/config.ts";
import { handleConfigGet } from "../src/web/api.ts";
import { rmrf } from "./tmp-rm.ts";

// #3488: the credential tri-state used to collapse to one boolean, so the UI
// could not tell "env var unset" from "value full of whitespace" from "store
// unreadable". These pin each state, the startup audit, and the additive
// config-GET field.

const root = path.join(tmpdir(), `bili-issue3488-${process.pid}-${Date.now()}`);
const biliConfig = path.join(root, "billion-context.json");
const storePath = `${biliConfig}.summary-credentials.json`;
const savedConfigFile = process.env.BILI_CONFIG_FILE;

mkdirSync(root, { recursive: true });
process.env.BILI_CONFIG_FILE = biliConfig;
writeFileSync(biliConfig, "{}\n", "utf8");

test.after(() => {
    if (savedConfigFile === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = savedConfigFile;
    rmrf(root);
});

test("credential status: env references distinguish missing, invalid value and configured", () => {
    const store = new SummaryCredentialStore();
    assert.equal(store.status("env:ISSUE3488_NOPE", {}), "missing");
    assert.equal(store.status("env:ISSUE3488_NOPE", { ISSUE3488_NOPE: "sk-real" }), "configured");
    assert.equal(store.status("env:ISSUE3488_NOPE", { ISSUE3488_NOPE: "a b" }), "invalid_value");
    assert.equal(store.status("env:ISSUE3488_NOPE", { ISSUE3488_NOPE: "\t" }), "invalid_value");
    assert.equal(store.status("env:ISSUE3488_NOPE", { ISSUE3488_NOPE: "" }), "invalid_value");
    assert.equal(store.status("env:ISSUE3488_NOPE", { ISSUE3488_NOPE: "x".repeat(8193) }), "invalid_value");
});

test("credential status: malformed references are reported as such, not as missing", () => {
    const store = new SummaryCredentialStore();
    assert.equal(store.status("bogus"), "invalid_reference");
    assert.equal(store.status("env:9BAD"), "invalid_reference");
    assert.equal(store.status("secret:bad name!"), "invalid_reference");
});

test("credential status: secret store lifecycle incl. corrupt and world-readable stores", () => {
    const store = new SummaryCredentialStore();
    assert.equal(store.status("secret:nexus", {}), "missing");
    store.set("nexus", "sk-test-3488");
    assert.equal(new SummaryCredentialStore().status("secret:nexus", {}), "configured");
    store.set("nexus", null);
    assert.equal(store.status("secret:nexus", {}), "missing");

    store.set("nexus", "sk-test-3488");
    writeFileSync(storePath, "{not json\n", "utf8");
    assert.equal(store.status("secret:nexus", {}), "store_unreadable");

    if (process.platform !== "win32") {
        // A corrupt store must NOT be silently overwritten by set() (fail-fast);
        // restore valid contents first, then loosen perms to hit the mode gate.
        assert.throws(() => store.set("nexus", "sk-test-3488"), /unavailable|repair/);
        writeFileSync(storePath, JSON.stringify({ nexus: "sk-test-3488" }) + "\n", "utf8");
        chmodSync(storePath, 0o644);
        assert.equal(store.status("secret:nexus", {}), "store_unreadable");
    }
});

test("describeCredentialState names the exact broken thing", () => {
    assert.match(describeCredentialState("env:NEXUS_API_KEY", "missing"), /NEXUS_API_KEY is not set/);
    assert.match(describeCredentialState("env:NEXUS_API_KEY", "invalid_value"), /unusable value/);
    assert.match(describeCredentialState("secret:nexus", "missing"), /not in the private store/);
    assert.match(describeCredentialState("secret:nexus", "store_unreadable"), /unreadable/);
    assert.match(describeCredentialState("bogus", "invalid_reference"), /not a valid credential reference/);
});

const recipes: Record<string, NamedProviderRecipe> = {
    nexus: { baseUrl: "http://127.0.0.1:9/v1", api: "openai", apiKeyEnv: "NEXUS_API_KEY", models: { free: {} } },
};

test("chain audit: reports broken refs per target, silent when everything resolves", () => {
    const chain = { enabled: true, targets: ["nexus/free"] };
    let problems = auditExternalSummaryCredentials(chain, recipes, {});
    assert.equal(problems.length, 1);
    assert.match(problems[0], /target nexus--free|target nexus\/free/);
    assert.match(problems[0], /NEXUS_API_KEY is not set/);

    problems = auditExternalSummaryCredentials(chain, recipes, { NEXUS_API_KEY: "a b" });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /unusable value/);

    assert.deepEqual(auditExternalSummaryCredentials(chain, recipes, { NEXUS_API_KEY: "sk-x" }), []);
    assert.deepEqual(auditExternalSummaryCredentials({ enabled: false, targets: ["nexus/free"] }, recipes, {}), []);
    assert.deepEqual(auditExternalSummaryCredentials({ enabled: true }, recipes, {}), []);

    // Unresolvable references are silent here on purpose: web save (400) and
    // the request-path one-shot warn own that surface, and boot cannot see
    // agent-registered recipes (#2336), so reporting would false-alarm.
    assert.deepEqual(auditExternalSummaryCredentials({ enabled: true, targets: ["ghost/model"] }, recipes, {}), []);
});

test("startup audit walks the global/route/model cascade and reports each effective broken chain once", () => {
    writeFileSync(biliConfig, JSON.stringify({
        providers: {
            nexus: { baseUrl: "http://127.0.0.1:9/v1", api: "openai", apiKeyEnv: "AUDIT_A", models: { free: {} } },
            other: { baseUrl: "http://127.0.0.1:10/v1", api: "openai", apiKeyEnv: "AUDIT_B", models: { small: {} } },
            "http://127.0.0.1:4000": { models: { free: { compress: { externalSummary: { enabled: true, targets: ["other/small"] } } } } },
        },
        compress: { externalSummary: { enabled: true, targets: ["nexus/free"] } },
    }, null, 2) + "\n", "utf8");

    let problems = auditStartupSummaryCredentials({});
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.includes("AUDIT_A is not set")));
    assert.ok(problems.some((p) => p.includes("AUDIT_B is not set")));

    problems = auditStartupSummaryCredentials({ AUDIT_A: "key-a" });
    assert.equal(problems.length, 1);
    assert.ok(problems[0].includes("AUDIT_B is not set"));

    assert.deepEqual(auditStartupSummaryCredentials({ AUDIT_A: "key-a", AUDIT_B: "key-b" }), []);
});

// #3572/#3488: the startup audit reads the GLOBAL block through
// loadConfigFile()'s tolerant JSONC parser. Pre-fix it used strict safeReadJson,
// so a commented config evaluated to null and every global externalSummary
// chain silently skipped the boot audit (route chains still audited — the
// asymmetry masked the bug).
test("startup audit still walks the global chain when the config file is JSONC", () => {
    writeFileSync(biliConfig, [
        "{ // commented config — valid JSONC, valid at runtime (#3572)",
        "  \"providers\": {",
        "    \"nexus\": { \"baseUrl\": \"http://127.0.0.1:9/v1\", \"api\": \"openai\", \"apiKeyEnv\": \"AUDIT_A\", \"models\": { \"free\": {} } },",
        "  },",
        "  \"compress\": { \"externalSummary\": { \"enabled\": true, \"targets\": [\"nexus/free\"] }, }, // trailing comma",
        "}",
    ].join("\n") + "\n", "utf8");

    const problems = auditStartupSummaryCredentials({});
    assert.equal(problems.length, 1, `the global chain must still be audited (got: ${JSON.stringify(problems)})`);
    assert.ok(problems[0].includes("AUDIT_A is not set"));

    assert.deepEqual(auditStartupSummaryCredentials({ AUDIT_A: "key-a" }), []);
});

function captureConfigGet(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const res = {
            writeHead(_code: number, _headers?: Record<string, string>): void { },
            end(data?: string): void {
                try { resolve(JSON.parse(data ?? "{}") as Record<string, unknown>); } catch (error) { reject(error); }
            },
        };
        handleConfigGet(res as unknown as Parameters<typeof handleConfigGet>[0]).catch(reject);
    });
}

test("config GET exposes the five-state map additively next to the legacy boolean record", async () => {
    writeFileSync(biliConfig, JSON.stringify({
        providers: {
            nexus: { baseUrl: "http://127.0.0.1:9/v1", api: "openai", apiKeyEnv: "WEB_KEY_3488", models: { free: {} } },
        },
        compress: { externalSummary: { enabled: true, targets: ["nexus/free"] } },
    }, null, 2) + "\n", "utf8");
    delete process.env.WEB_KEY_3488;
    try {
        let body = await captureConfigGet();
        assert.deepEqual(body.externalSummaryCredentials, { "env:WEB_KEY_3488": false });
        assert.deepEqual(body.externalSummaryCredentialStatus, { "env:WEB_KEY_3488": "missing" });

        process.env.WEB_KEY_3488 = "a b";
        body = await captureConfigGet();
        assert.deepEqual(body.externalSummaryCredentials, { "env:WEB_KEY_3488": false });
        assert.deepEqual(body.externalSummaryCredentialStatus, { "env:WEB_KEY_3488": "invalid_value" });

        process.env.WEB_KEY_3488 = "good-key";
        body = await captureConfigGet();
        assert.deepEqual(body.externalSummaryCredentials, { "env:WEB_KEY_3488": true });
        assert.deepEqual(body.externalSummaryCredentialStatus, { "env:WEB_KEY_3488": "configured" });
    } finally {
        delete process.env.WEB_KEY_3488;
        writeFileSync(biliConfig, "{}\n", "utf8");
    }
});
