import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    disableCodexTakeover,
    enableCodexTakeover,
    getCodexTakeoverStatus,
    recoverStaleCodexTakeover,
} from "../src/codex-takeover.ts";
import { resolveActiveCodexProvider } from "../src/codex-provider.ts";

function fixture(): { root: string; configPath: string; statePath: string; authPath: string } {
    const root = path.join(tmpdir(), `bili-codex-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codex = path.join(root, ".codex");
    mkdirSync(codex, { recursive: true });
    return {
        root,
        configPath: path.join(codex, "config.toml"),
        statePath: path.join(root, "data", "codex-route-state.json"),
        authPath: path.join(codex, "auth.json"),
    };
}

test("Codex route patches the active provider in place and restores byte-for-byte", () => {
    const files = fixture();
    const original = "\uFEFF" + [
        'model = "gpt-5.4"',
        'model_provider = "openai_http"',
        "",
        "[model_providers.openai_http]",
        'name = "OpenAI HTTP"',
        "base_url = 'https://chatgpt.com/backend-api/codex' # keep comment",
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "supports_websockets = false",
        "",
        "[mcp_servers.keep]",
        'command = "keep"',
        "",
    ].join("\r\n");
    const auth = '{"tokens":{"access_token":"secret"}}\n';
    writeFileSync(files.configPath, original, "utf8");
    writeFileSync(files.authPath, auth, "utf8");
    try {
        const provider = resolveActiveCodexProvider(files.configPath);
        assert.equal(provider.id, "openai_http");
        assert.equal(provider.baseUrl, "https://chatgpt.com/backend-api/codex");
        const enabled = enableCodexTakeover(8787, files);
        assert.equal(enabled.state, "enabled");
        assert.equal(enabled.providerId, "openai_http");
        const active = readFileSync(files.configPath, "utf8");
        assert.match(active, /model_provider = "openai_http"/);
        assert.match(active, /base_url = "http:\/\/127\.0\.0\.1:8787\/codex" # keep comment/);
        assert.doesNotMatch(active, /billion-context-codex/);
        assert.equal(readFileSync(files.authPath, "utf8"), auth);
        disableCodexTakeover(files);
        assert.equal(readFileSync(files.configPath, "utf8"), original);
        assert.equal(readFileSync(files.authPath, "utf8"), auth);
        assert.equal(existsSync(files.statePath), false);
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("built-in openai provider uses top-level openai_base_url instead of creating [model_providers.openai]", () => {
    const files = fixture();
    const original = 'model = "gpt-5.4"\n[mcp_servers.keep]\ncommand = "keep"';
    writeFileSync(files.configPath, original, "utf8");
    try {
        const enabled = enableCodexTakeover(9123, files);
        assert.equal(enabled.providerId, "openai");
        const active = readFileSync(files.configPath, "utf8");
        assert.doesNotMatch(active, /\[model_providers\.openai\]/);
        assert.match(active, /^openai_base_url = "http:\/\/127\.0\.0\.1:9123\/codex"$/m);
        disableCodexTakeover(files);
        assert.equal(readFileSync(files.configPath, "utf8"), original);
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("restore uses a three-way comparison and preserves user endpoint edits", () => {
    const files = fixture();
    writeFileSync(files.configPath, [
        'model_provider = "relay"',
        "[model_providers.relay]",
        'name = "Relay"',
        'base_url = "https://relay.example/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "supports_websockets = true",
        "",
    ].join("\n"), "utf8");
    try {
        enableCodexTakeover(8787, files);
        const edited = readFileSync(files.configPath, "utf8").replace(
            'base_url = "http://127.0.0.1:8787/codex"',
            'base_url = "https://user-new.example/v1"',
        );
        writeFileSync(files.configPath, edited, "utf8");
        const restored = disableCodexTakeover(files);
        assert.match(restored.detail ?? "", /检测到用户修改，已保留：base_url/);
        const final = readFileSync(files.configPath, "utf8");
        assert.match(final, /base_url = "https:\/\/user-new\.example\/v1"/);
        assert.match(final, /supports_websockets = true/);
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("takeover refuses an unresolved custom active provider", () => {
    const files = fixture();
    writeFileSync(files.configPath, 'model_provider = "missing"\n', "utf8");
    try {
        assert.throws(() => enableCodexTakeover(8787, files), /cannot safely resolve active Codex provider/);
        assert.equal(getCodexTakeoverStatus(files).state, "disabled");
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("stale process ownership is recovered on the next bili start", () => {
    const files = fixture();
    const original = "";
    writeFileSync(files.configPath, original, "utf8");
    try {
        enableCodexTakeover(8787, { ...files, ownerPid: 2_000_000_000 });
        const recovered = recoverStaleCodexTakeover(files);
        assert.equal(recovered.state, "disabled");
        assert.equal(readFileSync(files.configPath, "utf8"), original);
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("a running bili owner cannot be displaced by another process", () => {
    const files = fixture();
    writeFileSync(files.configPath, "", "utf8");
    try {
        enableCodexTakeover(8787, { ...files, ownerPid: process.pid });
        assert.throws(
            () => enableCodexTakeover(9999, { ...files, ownerPid: process.pid + 1 }),
            /owned by running bili process/,
        );
        assert.equal(getCodexTakeoverStatus(files).port, 8787);
    } finally {
        disableCodexTakeover(files);
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("disable restores original openai_base_url when built-in provider had a pre-existing value", () => {
    const files = fixture();
    const original = 'openai_base_url = "https://user-existing.example/v1"\nmodel = "gpt-5.4"\n';
    writeFileSync(files.configPath, original, "utf8");
    try {
        enableCodexTakeover(8787, files);
        const active = readFileSync(files.configPath, "utf8");
        assert.match(active, /^openai_base_url = "http:\/\/127\.0\.0\.1:8787\/codex"$/m);
        assert.doesNotMatch(active, /\[model_providers\.openai\]/);
        disableCodexTakeover(files);
        const restored = readFileSync(files.configPath, "utf8");
        assert.match(restored, /^openai_base_url = "https:\/\/user-existing\.example\/v1"$/m);
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("takeover rejects a provider base URL with query or fragment routing ambiguity", () => {
    const files = fixture();
    writeFileSync(files.configPath, [
        'model_provider = "relay"',
        "[model_providers.relay]",
        'base_url = "https://relay.example/v1?tenant=unsafe"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "supports_websockets = false",
    ].join("\n"), "utf8");
    try {
        assert.throws(() => enableCodexTakeover(8787, files), /cannot contain a query string or fragment/);
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("custom provider without optional auth/websocket fields resolves with safe defaults", () => {
    const files = fixture();
    writeFileSync(files.configPath, [
        'model_provider = "my-relay"',
        "[model_providers.my-relay]",
        'name = "my-relay"',
        'base_url = "http://127.0.0.1:8787/bili/https://relay.example/v1"',
        'wire_api = "responses"',
        'env_key = "OPENAI_API_KEY"',
    ].join("\n"), "utf8");
    try {
        const provider = resolveActiveCodexProvider(files.configPath);
        assert.equal(provider.id, "my-relay");
        assert.equal(provider.requiresOpenaiAuth, false, "defaults to false when unspecified");
        assert.equal(provider.supportsWebsockets, false, "defaults to false when unspecified");
        assert.equal(provider.baseUrl, "http://127.0.0.1:8787/bili/https://relay.example/v1");
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("corrupted state file degrades gracefully instead of throwing", () => {
    const files = fixture();
    const configContent = '[model_providers.openai]\nname = "OpenAI"\nbase_url = "https://api.openai.com/v1"\n';
    writeFileSync(files.configPath, configContent, "utf8");
    mkdirSync(path.dirname(files.statePath), { recursive: true });
    writeFileSync(files.statePath, "{garbage not valid json", "utf8");
    try {
        assert.doesNotThrow(() => getCodexTakeoverStatus(files), "corrupt state must not throw");
        assert.equal(getCodexTakeoverStatus(files).state, "disabled");
        assert.equal(readFileSync(files.configPath, "utf8"), configContent, "config.toml left intact");
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("non-numeric sectionPrefixLength in state is rejected without wiping config.toml", () => {
    const files = fixture();
    const configContent = '[model_providers.openai]\nname = "OpenAI"\nbase_url = "https://api.openai.com/v1"\n';
    writeFileSync(files.configPath, configContent, "utf8");
    mkdirSync(path.dirname(files.statePath), { recursive: true });
    writeFileSync(files.statePath, JSON.stringify({
        version: 1,
        active: true,
        providerId: "openai",
        configPath: files.configPath,
        sectionAdded: false,
        sectionPrefixLength: "not-a-number",
        insertedFields: ["base_url"],
        originalFields: { base_url: "https://api.openai.com/v1" },
        original: { baseUrl: "https://api.openai.com/v1", supportsWebsockets: false },
        installed: { baseUrl: "http://127.0.0.1:8787", supportsWebsockets: false },
        configHashBefore: "abc",
        startedAt: new Date().toISOString(),
    }), "utf8");
    try {
        assert.doesNotThrow(() => getCodexTakeoverStatus(files));
        assert.equal(getCodexTakeoverStatus(files).state, "disabled", "invalid sectionPrefixLength rejects state");
        assert.equal(readFileSync(files.configPath, "utf8"), configContent, "config.toml not wiped");
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("migration: old-format v1 state with openai sectionAdded is cleaned up on disable", () => {
    const files = fixture();
    const routedConfig = [
        "[model_providers.openai]",
        'name = "OpenAI"',
        'base_url = "http://127.0.0.1:8787/codex"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "supports_websockets = false",
        "",
    ].join("\n");
    writeFileSync(files.configPath, routedConfig, "utf8");
    mkdirSync(path.dirname(files.statePath), { recursive: true });
    writeFileSync(files.statePath, JSON.stringify({
        version: 1,
        active: true,
        providerId: "openai",
        configPath: files.configPath,
        sectionAdded: true,
        sectionPrefixLength: 0,
        insertedFields: ["name", "base_url", "wire_api", "requires_openai_auth", "supports_websockets"],
        originalFields: {
            base_url: { present: false },
            supports_websockets: { present: false },
        },
        original: { baseUrl: "https://chatgpt.com/backend-api/codex", supportsWebsockets: true },
        installed: { baseUrl: "http://127.0.0.1:8787/codex", supportsWebsockets: false },
        configHashBefore: "abc",
        startedAt: new Date().toISOString(),
    }), "utf8");
    try {
        const status = getCodexTakeoverStatus(files);
        assert.equal(status.state, "enabled", "migrated v1 state is recognized as enabled");
        disableCodexTakeover(files);
        const restored = readFileSync(files.configPath, "utf8");
        assert.doesNotMatch(restored, /\[model_providers\.openai\]/);
        assert.doesNotMatch(restored, /base_url|supports_websockets|requires_openai_auth/);
        assert.equal(existsSync(files.statePath), false);
    } finally {
        rmSync(files.root, { recursive: true, force: true });
    }
});
