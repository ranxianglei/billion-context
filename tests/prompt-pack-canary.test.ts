import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ACP_TOOLS_OPENAI, defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { resolveCompressSurface } from "../src/compress-settings.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions, CompressSettings } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { promptPackCanaryPct, isEligibleForLeanPack, resolveStickyPackAssignment, PROMPT_PACK_CANARY_PCT_DEFAULT } from "../src/pack-canary.ts";

// #1408: sticky prompt-pack canary. Unit section pins the pure policy
// (knob parsing, deterministic eligibility, once-only assignment); the
// harness section drives real requests through startServer with NO explicit
// compress.promptPack anywhere and asserts the builtin lean surface reaches
// the outbound OpenAI wire for hash-eligible sessions — and never does for
// ineligible ones, explicit settings, or pct=0. Stickiness is pinned twice:
// env-knob moves mid-process (no re-roll) and a disk round-trip (restart).

type Captured = { urlPath: string; body: Record<string, unknown> };
type Harness = { proxyUrl: string; captured: Captured[]; close(): Promise<void> };

function listen(server: http.Server): Promise<void> {
    if (server.listening) return Promise.resolve();
    return once(server, "listening").then(() => undefined);
}

async function startHarness(routeCompress?: CompressSettings, store?: SessionStore): Promise<Harness> {
    _setStoreForTest(store ?? new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const captured: Captured[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            captured.push({ urlPath: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "r1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listen(upstream);
    const upstreamPort = (upstream.address() as { port: number }).port;

    const opts: ProxyOptions = {
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: {
            [`http://127.0.0.1:${upstreamPort}`]: routeCompress ? { compress: routeCompress } : {},
        },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts);
    await listen(proxy);
    const proxyPort = (proxy.address() as { port: number }).port;

    return {
        proxyUrl: `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}`,
        captured,
        close: async () => {
            await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
            await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
        },
    };
}

async function sendChat(h: Harness, sessionId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${h.proxyUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sessionId },
        body: JSON.stringify({ model: "gpt-test", stream: false, messages: [{ role: "user", content: "hello canary" }] }),
    });
    assert.equal(res.status, 200);
    await res.text();
    return h.captured[h.captured.length - 1].body;
}

function compressDescription(body: Record<string, unknown>): string {
    const tools = body.tools as Array<{ function: { name: string; description: string } }>;
    const compress = tools.find((t) => t.function.name === "compress");
    assert.ok(compress, "compress tool injected");
    return compress.function.description;
}

function leanCompressDescription(): string {
    const tp = resolveCompressSurface({ promptPack: "lean" }).toolPrompts;
    assert.ok(tp?.compress?.description, "builtin lean pack exposes compress description");
    return tp.compress.description;
}

function kernelDefaultCompressDescription(): string {
    return ACP_TOOLS_OPENAI.find((t) => t.function.name === "compress")!.function.description;
}

function withPct(value: string | undefined, fn: () => Promise<void>): Promise<void> {
    const prev = process.env.BILI_PROMPT_PACK_CANARY_PCT;
    if (value === undefined) delete process.env.BILI_PROMPT_PACK_CANARY_PCT;
    else process.env.BILI_PROMPT_PACK_CANARY_PCT = value;
    return Promise.resolve(fn()).finally(() => {
        if (prev === undefined) delete process.env.BILI_PROMPT_PACK_CANARY_PCT;
        else process.env.BILI_PROMPT_PACK_CANARY_PCT = prev;
    });
}

function findIds(prefix: string, pct: number, n = 1): { eligible: string[]; ineligible: string[] } {
    const eligible: string[] = [];
    const ineligible: string[] = [];
    for (let i = 0; i < 2000 && (eligible.length < n || ineligible.length < n); i++) {
        const id = `${prefix}-${i}`;
        (isEligibleForLeanPack(id, pct) ? eligible : ineligible).push(id);
    }
    assert.ok(eligible.length >= n && ineligible.length >= n, `found ids for ${prefix}`);
    return { eligible, ineligible };
}

test("canary knob parsing: BILI_PROMPT_PACK_CANARY_PCT", () => {
    const cases: Array<[string | undefined, number]> = [
        [undefined, 10],
        ["10", 10],
        ["0", 0],
        ["100", 100],
        [" 42 ", 42],
        ["abc", 10],
        ["", 10],
        ["-1", 10],
        ["101", 10],
        ["4.5", 10],
    ];
    for (const [raw, expected] of cases) {
        const env: NodeJS.ProcessEnv = {};
        if (raw !== undefined) env.BILI_PROMPT_PACK_CANARY_PCT = raw;
        assert.equal(promptPackCanaryPct(env), expected, `pct=${JSON.stringify(raw)}`);
    }
    assert.equal(PROMPT_PACK_CANARY_PCT_DEFAULT, 10);
});

test("eligibility: deterministic, monotonic in pct, well-distributed", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `dist-id-${i}`);
    for (const id of ids) {
        assert.equal(isEligibleForLeanPack(id, 10), isEligibleForLeanPack(id, 10), "deterministic");
        for (let lo = 0; lo <= 100; lo += 10) {
            for (let hi = lo; hi <= 100; hi += 10) {
                if (isEligibleForLeanPack(id, lo)) assert.ok(isEligibleForLeanPack(id, hi), `monotonic ${lo}<=${hi}`);
            }
        }
    }
    assert.equal(isEligibleForLeanPack("anything", 0), false, "pct=0 disables");
    assert.equal(isEligibleForLeanPack("anything", 100), true, "pct=100 full lean");
    const big = Array.from({ length: 2000 }, (_, i) => `bucket-${i}`);
    const hit = big.filter((id) => isEligibleForLeanPack(id, 10)).length / big.length;
    assert.ok(hit > 0.05 && hit < 0.15, `pct=10 split landed at ${hit.toFixed(3)}`);
});

test("sticky assignment: stamps once, never re-rolls on knob moves, logs once", () => {
    const logs: string[] = [];
    const log = (_level: string, msg: string) => logs.push(msg);
    const sess = { id: "sticky-unit-session", meta: {} as Record<string, unknown> };
    return withPct("100", async () => {
        assert.equal(resolveStickyPackAssignment(sess, log), "lean");
        assert.equal(sess.meta.packCanary, "lean");
        assert.equal(logs.length, 1);
        assert.match(logs[0], /^prompt-pack canary: lean \(pct=100, session=sticky-unit-session\)$/);
        await withPct("0", async () => {
            assert.equal(resolveStickyPackAssignment(sess, log), "lean", "knob drop must not flip an assigned session");
        });
        assert.equal(logs.length, 1, "no second log for a stamped session");
    });
});

test("#1408: unset pack + hash-eligible session -> lean surface on the wire", async () => {
    const { eligible } = findIds("canary-t4", 10);
    const h = await startHarness();
    try {
        await withPct("10", async () => {
            const body = await sendChat(h, eligible[0]);
            assert.equal(compressDescription(body), leanCompressDescription());
            assert.notEqual(compressDescription(body), kernelDefaultCompressDescription());
        });
    } finally {
        await h.close();
    }
});

test("#1408: unset pack + hash-ineligible session -> kernel-default surface", async () => {
    const { ineligible } = findIds("canary-t5", 10);
    const h = await startHarness();
    try {
        await withPct("10", async () => {
            const body = await sendChat(h, ineligible[0]);
            assert.equal(compressDescription(body), kernelDefaultCompressDescription());
        });
    } finally {
        await h.close();
    }
});

test("#1408: explicit promptPack (route level) is never canaried, even \"default\"", async () => {
    const { eligible } = findIds("canary-t6", 10);
    const h = await startHarness({ promptPack: "default" });
    try {
        await withPct("100", async () => {
            const body = await sendChat(h, eligible[0]);
            assert.equal(compressDescription(body), kernelDefaultCompressDescription(), "explicit default wins over canary");
        });
    } finally {
        await h.close();
    }
});

test("#1408: pct=0 disables the canary (unset -> default)", async () => {
    const { eligible } = findIds("canary-t7", 10);
    const h = await startHarness();
    try {
        await withPct("0", async () => {
            const body = await sendChat(h, eligible[0]);
            assert.equal(compressDescription(body), kernelDefaultCompressDescription());
        });
    } finally {
        await h.close();
    }
});

test("#1408: pct=100 makes every unassigned session lean", async () => {
    const { ineligible } = findIds("canary-t8", 10);
    const h = await startHarness();
    try {
        await withPct("100", async () => {
            const body = await sendChat(h, ineligible[0]);
            assert.equal(compressDescription(body), leanCompressDescription());
        });
    } finally {
        await h.close();
    }
});

test("#1408: invalid pct falls back to the default 10", async () => {
    const { eligible, ineligible } = findIds("canary-t9", 10);
    const h = await startHarness();
    try {
        await withPct("banana", async () => {
            assert.equal(compressDescription(await sendChat(h, eligible[0])), leanCompressDescription(), "eligible id behaves as under pct=10");
            assert.equal(compressDescription(await sendChat(h, ineligible[0])), kernelDefaultCompressDescription(), "ineligible id behaves as under pct=10");
        });
    } finally {
        await h.close();
    }
});

test("#1408: assignment is sticky across knob moves mid-process (no re-roll)", async () => {
    const h = await startHarness();
    try {
        // Session A assigned default under pct=0, then the knob jumps to 100: stays default.
        await withPct("0", async () => {
            assert.equal(compressDescription(await sendChat(h, "canary-sticky-a")), kernelDefaultCompressDescription());
        });
        await withPct("100", async () => {
            assert.equal(compressDescription(await sendChat(h, "canary-sticky-a")), kernelDefaultCompressDescription(), "A was assigned default and must not flip to lean");
        });
        // Session B assigned lean under pct=100, then the knob drops to 0: stays lean.
        await withPct("100", async () => {
            assert.equal(compressDescription(await sendChat(h, "canary-sticky-b")), leanCompressDescription());
        });
        await withPct("0", async () => {
            assert.equal(compressDescription(await sendChat(h, "canary-sticky-b")), leanCompressDescription(), "B was assigned lean and must not flip to default");
        });
    } finally {
        await h.close();
    }
});

function findSessionFile(dir: string, id: string): string | undefined {
    const stack = [dir];
    while (stack.length > 0) {
        const d = stack.pop()!;
        for (const entry of readdirSync(d)) {
            const p = path.join(d, entry);
            if (statSync(p).isDirectory()) {
                stack.push(p);
                continue;
            }
            if (!entry.endsWith(".json")) continue;
            try {
                const envelope = JSON.parse(readFileSync(p, "utf8"));
                if (envelope?.id === id) return p;
            } catch {
                /* not a session file */
            }
        }
    }
    return undefined;
}

test("#1408: assignment survives a restart (disk round-trip)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bili-canary-store-"));
    const store = new SessionStore({ dir, enabled: true, debounceMs: 0 });
    const { eligible } = findIds("canary-t11", 10);
    const h = await startHarness(undefined, store);
    try {
        await withPct("10", async () => {
            const body = await sendChat(h, eligible[0]);
            assert.equal(compressDescription(body), leanCompressDescription());
        });
        await store.flushAll();
        const file = findSessionFile(dir, eligible[0]);
        assert.ok(file, "session file written");
        const envelope = JSON.parse(readFileSync(file, "utf8"));
        assert.equal(envelope.payload.meta.packCanary, "lean", "assignment persisted on disk");
        // Simulated restart: a fresh store loading the same directory sees the stamp.
        const reloader = new SessionStore({ dir, enabled: true, debounceMs: 0 });
        const reloadedMap = await reloader.loadAll();
        const reloaded = reloadedMap.get(eligible[0]);
        assert.ok(reloaded, "reloaded session");
        assert.equal(reloaded.meta.packCanary, "lean", "reloaded session keeps its assignment");
    } finally {
        await h.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
