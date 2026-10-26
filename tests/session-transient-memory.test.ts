import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { noteForwardedBody, settleUsageReport } from "../src/cache-ledger.ts";
import { rememberPluginMessages, _rememberedForTest } from "../src/plugin.ts";
import { createSession, getSession, dropSessionForGc, _resetSessionsForTest } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";

test("#2920/#2868 诊断副本保留 UTF-8 内容，结算只转移会话内引用", () => {
    const session = createSession("transient-seam");
    const body = JSON.stringify({ messages: [{ role: "user", content: "中😀" }] });
    noteForwardedBody(session, body);
    const sent = session.transient?.sentBody;
    // #2868: slots retain the UTF-8 ENCODING of the body (bytes, not code
    // units) — byte-equal here because the body is valid UTF-8.
    assert.equal(sent?.head.toString("utf8"), body);
    assert.equal(sent?.full?.toString("utf8"), body);
    settleUsageReport(session, { total: 1000, reportedCached: 0, output: 10, protocol: "openai", upstream: "http://synthetic" });
    assert.equal(session.transient?.sentBody, undefined);
    assert.equal(session.transient?.settledBody, sent);
});

test("#2868 孤立代理项无 UTF-8 形式，保留字节记录 U+FFFD", () => {
    const session = createSession("surrogate-seam");
    // A lone surrogate has no UTF-8 form: retained bytes carry the wire-visible
    // replacement char, never a raw half-surrogate (#2868's unit is bytes).
    noteForwardedBody(session, "a\ud800b");
    const slot = session.transient?.sentBody;
    assert.equal(slot?.head.toString("utf8"), "a\ufffdb");
});

test("#2920 派生缓存不落盘，淘汰后不能重新挂上工具快照", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-transient-persist-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    _resetSessionsForTest(256);
    _setStoreForTest(store);
    try {
        const session = getSession("transient-persist");
        const messages = [{ id: "raw-1", role: "user", contentType: "text", text: "可恢复原文" }] as const;
        session.lastMessages = [...messages];
        rememberPluginMessages(session.id, [...messages], [...messages]);
        noteForwardedBody(session, JSON.stringify(messages));
        await store.writeNow(session);
        const restored = store.loadSync(session.id);
        assert.ok(restored);
        assert.equal(restored.transient, undefined);
        assert.equal(restored.lastMessages?.[0]?.text, "可恢复原文");
        assert.equal(dropSessionForGc(session.id), true);
        rememberPluginMessages(session.id, [...messages], [...messages]);
        assert.equal(_rememberedForTest().has(session.id), false);
    } finally {
        await store.flushAll();
        _resetSessionsForTest(256);
        _setStoreForTest(new SessionStore({ dir, enabled: false }));
        rmSync(dir, { recursive: true, force: true });
    }
});

// 独立进程限制堆大小并隔离状态目录；只生成随机合成内容，不读用户历史。
function probe(code: string): { retained: number; released?: number } {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-transient-heap-"));
    try {
        const result = spawnSync(process.execPath, ["--expose-gc", "--max-old-space-size=192", "--import", "tsx", "--input-type=module", "-e", code], {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            env: { ...process.env, NODE_ENV: "test", BILI_PERSIST: "0", XDG_DATA_HOME: dir, XDG_STATE_HOME: dir, XDG_CONFIG_HOME: dir },
            encoding: "utf8", timeout: 60000,
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test("#2920 512 KiB 诊断截段不保留八个 12 MiB 请求底层字符串", (t) => {
    const result = probe(`
        import { randomBytes } from 'node:crypto';
        import { createSession } from './src/session.ts';
        import { noteForwardedBody } from './src/cache-ledger.ts';
        const collect = () => { for (let i = 0; i < 5; i++) global.gc(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
        const baseline = collect();
        const sessions = [];
        function retain(i) {
            const session = createSession('diagnostic-' + i);
            noteForwardedBody(session, randomBytes(6 * 1024 * 1024).toString('hex'));
            sessions.push(session);
        }
        for (let i = 0; i < 8; i++) retain(i);
        const retained = collect() - baseline;
        sessions.length = 0;
        const released = baseline + retained - collect();
        console.log(JSON.stringify({ retained, released }));
    `);
    t.diagnostic(JSON.stringify(result));
    assert.ok(result.retained < 16 * 1024 * 1024, JSON.stringify(result));
    assert.ok((result.released ?? 0) > 2 * 1024 * 1024, JSON.stringify(result));
});

test("#2920 删除会话立即释放插件原文，无需等待下一次模型请求", (t) => {
    const result = probe(`
        import { randomBytes } from 'node:crypto';
        import { getSession, dropSessionForGc, _resetSessionsForTest } from './src/session.ts';
        import { rememberPluginMessages } from './src/plugin.ts';
        import { SessionStore, _setStoreForTest } from './src/persist.ts';
        _resetSessionsForTest(256);
        _setStoreForTest(new SessionStore({ dir: process.env.XDG_STATE_HOME, enabled: false }));
        const collect = () => { for (let i = 0; i < 5; i++) global.gc(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
        const baseline = collect();
        function retain(i) {
            const session = getSession('plugin-' + i);
            const messages = [{ id: 'raw-' + i, role: 'user', contentType: 'text', text: randomBytes(2 * 1024 * 1024).toString('hex') }];
            rememberPluginMessages(session.id, messages, messages);
        }
        for (let i = 0; i < 8; i++) retain(i);
        const peak = collect();
        for (let i = 0; i < 8; i++) dropSessionForGc('plugin-' + i);
        const after = collect();
        console.log(JSON.stringify({ retained: after - baseline, released: peak - after }));
    `);
    t.diagnostic(JSON.stringify(result));
    assert.ok(result.retained < 12 * 1024 * 1024, JSON.stringify(result));
    assert.ok((result.released ?? 0) > 24 * 1024 * 1024, JSON.stringify(result));
});

test("#2920 完整诊断副本也不保留其截取前的大字符串", (t) => {
    const result = probe(`
        import { randomBytes } from 'node:crypto';
        import { createSession } from './src/session.ts';
        import { noteForwardedBody } from './src/cache-ledger.ts';
        const collect = () => { for (let i = 0; i < 5; i++) global.gc(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
        const baseline = collect();
        const sessions = [];
        function retain(i) {
            const session = createSession('full-diagnostic-' + i);
            const body = randomBytes(6 * 1024 * 1024).toString('hex').slice(0, 2 * 1024 * 1024);
            noteForwardedBody(session, body);
            sessions.push(session);
        }
        for (let i = 0; i < 8; i++) retain(i);
        const retained = collect() - baseline;
        sessions.length = 0;
        const released = baseline + retained - collect();
        console.log(JSON.stringify({ retained, released }));
    `);
    t.diagnostic(JSON.stringify(result));
    // #2868 后完整副本是 UTF-8：ASCII hex 语料每字符一字节（原 UTF-16 为二）；上界仍远低于原始 96 MiB。
    assert.ok(result.retained < 48 * 1024 * 1024, JSON.stringify(result));
    assert.ok((result.released ?? 0) > 12 * 1024 * 1024, JSON.stringify(result));
});
