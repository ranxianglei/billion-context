import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createCore, defaultConfig, defaultPrompts } from "acp-kernel";
import { codexAlignedWindow, readCodexModelWindow } from "../src/codex-models.ts";
import { reserveOutputHeadroom } from "../src/util.ts";
import { preflightCompress } from "../src/preflight.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

process.env.NODE_ENV = "test";

const model = "gpt-6.1-sol";
const codex = { "user-agent": "Codex Desktop/0.162.0" };

function fixture(t: { after(fn: () => void): void }): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-live-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    return home;
}

function writeModels(home: string, models: unknown[]): void {
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: models.map(value => value && typeof value === "object" ? { effective_context_window_percent: 100, ...value } : value) }));
}

test("live cache resolves a model absent from the shipped table, with Codex's override ceiling", (t) => {
    const home = fixture(t);
    writeModels(home, [{ slug: model, context_window: 373_000, max_context_window: 872_000 }]);
    assert.equal(readCodexModelWindow(model, home), 373_000);
    fs.writeFileSync(path.join(home, "config.toml"), "model_context_window = 1048576\n");
    assert.equal(readCodexModelWindow(model, home), 872_000);
    fs.writeFileSync(path.join(home, "config.toml"), "model_context_window = 100000\n");
    assert.equal(readCodexModelWindow(model, home), 100_000);
});

test("usable window follows Codex's effective percentage and its default of 95", (t) => {
    const home = fixture(t);
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: model, context_window: 373_000, max_context_window: 872_000 }] }));
    fs.writeFileSync(path.join(home, "config.toml"), "model_context_window = 1048576\n");
    assert.equal(readCodexModelWindow(model, home), 828_400);
    writeModels(home, [{ slug: model, context_window: 100_001, effective_context_window_percent: 50 }]);
    fs.rmSync(path.join(home, "config.toml"));
    assert.equal(readCodexModelWindow(model, home), 50_000);
    for (const percent of [0, -1, 101, 95.5, "95"]) {
        writeModels(home, [{ slug: model, context_window: 800_000, effective_context_window_percent: percent }]);
        assert.equal(readCodexModelWindow(model, home), undefined);
    }
});

test("live cache follows longest-prefix and single namespace matching without borrowing another model", (t) => {
    const home = fixture(t);
    writeModels(home, [{ slug: "gpt-new", context_window: 600_000 }, { slug: "gpt-new-mini", context_window: 120_000 }]);
    assert.equal(readCodexModelWindow("gpt-new-mini-latest", home), 120_000);
    assert.equal(readCodexModelWindow("custom/gpt-new", home), 600_000);
    assert.equal(readCodexModelWindow("other-model", home), undefined);
    assert.equal(readCodexModelWindow("a/b/gpt-new", home), undefined);
});

test("cached metadata refreshes and deletion or malformed replacement never reuses stale entries", (t) => {
    const home = fixture(t);
    writeModels(home, [{ slug: model, context_window: 800_000 }]);
    assert.equal(readCodexModelWindow(model, home), 800_000);
    writeModels(home, [{ slug: model, context_window: 90_000 }]);
    assert.equal(readCodexModelWindow(model, home), 90_000);
    fs.writeFileSync(path.join(home, "models_cache.json"), "{");
    assert.equal(readCodexModelWindow(model, home), undefined);
    fs.writeFileSync(path.join(home, "models_cache.json"), "{}");
    assert.equal(readCodexModelWindow(model, home), undefined);
    fs.rmSync(path.join(home, "models_cache.json"));
    assert.equal(readCodexModelWindow(model, home), undefined);
});

test("invalid cache entries are ignored; max-only metadata and overrides without a max follow Codex", (t) => {
    const home = fixture(t);
    writeModels(home, [null, {}, { slug: "", context_window: 900_000 }, { slug: model, context_window: 1.5 }, { slug: model, context_window: "900000", max_context_window: -1 }]);
    assert.equal(readCodexModelWindow(model, home), undefined);
    writeModels(home, [{ slug: model, max_context_window: 800_000 }]);
    assert.equal(readCodexModelWindow(model, home), 800_000);
    writeModels(home, [{ slug: model, context_window: 300_000 }]);
    fs.writeFileSync(path.join(home, "config.toml"), "model_context_window = 1000000\n");
    assert.equal(readCodexModelWindow(model, home), 1_000_000, "没有 max_context_window 时 Codex 使用显式配置；对齐仍受 bili 原预算的 min 限制");
});

test("CODEX_HOME isolates live metadata; explicit client reports outrank it and preserve min semantics", (t) => {
    const home = fixture(t);
    const other = fixture(t);
    const previous = process.env.CODEX_HOME;
    t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
    writeModels(home, [{ slug: model, context_window: 800_000 }]);
    writeModels(other, [{ slug: model, context_window: 100_000 }]);
    process.env.CODEX_HOME = home;
    assert.deepEqual(codexAlignedWindow(1_050_000, model, codex), { limit: 800_000, clamped: true });
    assert.deepEqual(codexAlignedWindow(200_000, model, codex), { limit: 200_000, clamped: false });
    assert.deepEqual(codexAlignedWindow(1_050_000, model, codex, 900_000), { limit: 900_000, clamped: true });
    assert.deepEqual(codexAlignedWindow(1_050_000, model, codex, 80_000), { limit: 80_000, clamped: true });
    for (const invalid of [0, -1, NaN, Infinity]) assert.equal(codexAlignedWindow(1_050_000, model, codex, invalid).limit, 800_000);
    process.env.CODEX_HOME = other;
    assert.equal(codexAlignedWindow(1_050_000, model, codex).limit, 100_000);
    assert.deepEqual(codexAlignedWindow(1_050_000, model, { "user-agent": "node-fetch" }), { limit: 1_050_000, clamped: false });
    fs.rmSync(path.join(other, "models_cache.json"));
    assert.equal(codexAlignedWindow(1_050_000, model, codex).limit, 272_000, "无当前模型证据时保留既有回退");
});

test("incident-shaped window keeps a 507906-token estimate below the input budget after headroom", (t) => {
    const home = fixture(t);
    const previous = process.env.CODEX_HOME;
    t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
    process.env.CODEX_HOME = home;
    writeModels(home, [{ slug: model, context_window: 373_000, max_context_window: 872_000 }]);
    fs.writeFileSync(path.join(home, "config.toml"), "model_context_window = 1048576\n");
    writeModels(home, [{ slug: model, context_window: 373_000, max_context_window: 872_000, effective_context_window_percent: 95 }]);
    const aligned = codexAlignedWindow(1_050_000, model, codex);
    assert.equal(aligned.limit, 828_400);
    assert.equal(reserveOutputHeadroom(aligned.limit, 128_000, 0.25), 700_400);
    assert.ok(507_906 < reserveOutputHeadroom(aligned.limit, 128_000, 0.25) * 0.9);
    assert.equal(reserveOutputHeadroom(272_000, 128_000, 0.25), 204_000);
});

test("real preflight: live window admits fixed overhead that the stale fallback rejects, without summary calls", async (t) => {
    const home = fixture(t);
    const previous = process.env.CODEX_HOME;
    t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
    process.env.CODEX_HOME = home;
    writeModels(home, [{ slug: model, context_window: 373_000, max_context_window: 872_000 }]);
    fs.writeFileSync(path.join(home, "config.toml"), "model_context_window = 1048576\n");
    _setStoreForTest(new SessionStore({ enabled: false }));
    let summaryCalls = 0;
    const upstream = http.createServer((req, res) => { summaryCalls++; req.resume(); res.writeHead(500); res.end(); });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    try {
        writeModels(home, [{ slug: model, context_window: 373_000, max_context_window: 872_000, effective_context_window_percent: 95 }]);
        const liveLimit = reserveOutputHeadroom(codexAlignedWindow(1_050_000, model, codex).limit, 128_000, 0.25);
        for (const [name, limit, fits] of [["stale", 204_000, false], ["live", liveLimit, true]] as const) {
            const session = getSession(`codex-live-preflight-${name}`);
            session.stats.lastInputTokens = 439_936;
            session.metadata.lastModel = model;
            const result = await preflightCompress({
                core: createCore(), session, config: defaultConfig(limit), prompts: defaultPrompts,
                protocol: "responses", url: `${origin}/responses`, headers: {}, model, upstreamOrigin: origin,
                wireOverhead: 507_900, compressionTarget: limit * 0.9, log: () => {},
            }, [{ id: "latest", role: "user", contentType: "text", text: "Continue." }]);
            assert.equal(result.fitsWindow, fits, name);
            assert.equal(result.compressedRanges, 0, name);
            assert.equal(result.failure?.kind, fits ? undefined : "exhausted", name);
        }
        assert.equal(summaryCalls, 0);
    } finally {
        const closed = once(upstream, "close");
        upstream.close(); upstream.closeAllConnections();
        await closed;
    }
});
