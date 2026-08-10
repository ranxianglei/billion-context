import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { previewLegacyCodexHistory, repairLegacyCodexHistory } from "../src/codex-history.ts";

function fixture(): { root: string; configPath: string; sessionPath: string } {
    const root = path.join(tmpdir(), `bili-history-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codex = path.join(root, "codex");
    const sessions = path.join(codex, "sessions", "2026", "08", "09");
    mkdirSync(sessions, { recursive: true });
    const configPath = path.join(codex, "config.toml");
    writeFileSync(configPath, [
        'model_provider = "openai_http"',
        "[model_providers.openai_http]",
        'name = "OpenAI HTTP"',
        'base_url = "https://chatgpt.com/backend-api/codex"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "supports_websockets = false",
    ].join("\n"), "utf8");
    return { root, configPath, sessionPath: path.join(sessions, "rollout-test.jsonl") };
}

test("legacy Codex history repair is preview-only until explicitly requested and keeps unrelated buckets", async () => {
    const files = fixture();
    const lines = [
        { timestamp: "1", type: "session_meta", payload: { id: "old-1", model_provider: "billion-context-codex", cwd: "C:/work" } },
        { timestamp: "2", type: "response_item", payload: { text: "keep" } },
        { timestamp: "3", type: "session_meta", payload: { id: "custom-1", model_provider: "cc-switch-custom" } },
    ];
    const original = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
    writeFileSync(files.sessionPath, original, "utf8");
    const unrelatedPath = path.join(path.dirname(files.configPath), "unrelated.jsonl");
    const unrelated = JSON.stringify({ type: "session_meta", payload: { model_provider: "bili_chatgpt" } }) + "\n";
    writeFileSync(unrelatedPath, unrelated, "utf8");
    const oldData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(files.root, "data");
    try {
        const preview = await previewLegacyCodexHistory(files.configPath);
        assert.equal(preview.targetProviderId, "openai_http");
        assert.equal(preview.sessions, 1);
        assert.equal(preview.jsonlFiles, 1);
        assert.equal(readFileSync(files.sessionPath, "utf8"), original, "preview must not modify history");

        const result = await repairLegacyCodexHistory(files.configPath);
        assert.equal(result.migratedJsonlFiles, 1);
        assert.ok(existsSync(result.backupPath));
        const repaired = readFileSync(files.sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal((repaired[0].payload as Record<string, unknown>).model_provider, "openai_http");
        assert.equal((repaired[2].payload as Record<string, unknown>).model_provider, "cc-switch-custom");
        assert.equal(readFileSync(unrelatedPath, "utf8"), unrelated);
        const backup = path.join(result.backupPath, "jsonl", path.relative(path.dirname(files.configPath), files.sessionPath));
        assert.equal(readFileSync(backup, "utf8"), original);
    } finally {
        if (oldData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldData;
        rmSync(files.root, { recursive: true, force: true });
    }
});

test("legacy repair updates state_5.sqlite when node:sqlite is available", async (context) => {
    let sqlite: typeof import("node:sqlite");
    try {
        sqlite = await import("node:sqlite");
    } catch {
        context.skip("node:sqlite is unavailable on this Node runtime");
        return;
    }
    const files = fixture();
    const dbPath = path.join(path.dirname(files.configPath), "state_5.sqlite");
    const database = new sqlite.DatabaseSync(dbPath);
    database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)");
    database.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run("old", "bili_chatgpt");
    database.prepare("INSERT INTO threads (id, model_provider) VALUES (?, ?)").run("keep", "other-provider");
    database.close();
    const oldData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(files.root, "data");
    try {
        const preview = await previewLegacyCodexHistory(files.configPath);
        assert.equal(preview.stateRows, 1);
        const result = await repairLegacyCodexHistory(files.configPath);
        assert.equal(result.migratedStateRows, 1);
        const verify = new sqlite.DatabaseSync(dbPath);
        try {
            assert.equal(verify.prepare("SELECT model_provider FROM threads WHERE id = ?").get("old")?.model_provider, "openai_http");
            assert.equal(verify.prepare("SELECT model_provider FROM threads WHERE id = ?").get("keep")?.model_provider, "other-provider");
        } finally {
            verify.close();
        }
    } finally {
        if (oldData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = oldData;
        rmSync(files.root, { recursive: true, force: true });
    }
});
