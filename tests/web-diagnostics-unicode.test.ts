import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordClientUa, _resetClientUaRegistryForTest } from "../src/client-ua-registry.js";
import { recordConflict } from "../src/conflict-watch.js";
import { closeLogger, configureLogger } from "../src/logger.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { startServer } from "../src/server.js";
import { getSession, _resetSessionsForTest } from "../src/session.js";
import { buildDiagnostics } from "../src/web/diagnostics.js";
import { makeOpts } from "./corrupt-index-child.js";

const ENV_KEYS = ["BILI_CONFIG_FILE", "BILI_SESSIONS_DIR", "DSH_HOME", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;
type Report = Awaited<ReturnType<typeof buildDiagnostics>>;
type Source = "storage log" | "conflict log" | "config" | "conflict detail" | "topic" | "user-agent";
type Boundary = "split pair" | "whole pair" | "ASCII";
interface Fixture { config: string; log: string }

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
    const root = mkdtempSync(path.join(tmpdir(), "bili-diag-unicode-"));
    const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
    const config = path.join(root, "config.json");
    const log = path.join(root, "state", "billion-context", "bili.log");
    mkdirSync(path.dirname(log), { recursive: true });
    mkdirSync(path.join(root, "sessions"));
    process.env.BILI_CONFIG_FILE = config;
    process.env.BILI_SESSIONS_DIR = path.join(root, "sessions");
    process.env.DSH_HOME = path.join(root, "dsh");
    process.env.XDG_STATE_HOME = path.join(root, "state");
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.XDG_DATA_HOME = path.join(root, "data");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    writeFileSync(config, "{}");
    writeFileSync(log, "");
    const store = new SessionStore({ enabled: false });
    _setStoreForTest(store);
    _resetSessionsForTest();
    _resetClientUaRegistryForTest();
    try {
        await fn({ config, log });
    } finally {
        await closeLogger();
        configureLogger(undefined);
        _resetSessionsForTest();
        _resetClientUaRegistryForTest();
        store.closeQuietly();
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
    }
}

function boundedValue(prefix: string, cut: number, boundary: Boundary): { input: string; expected: string } {
    const pairWidth = boundary === "split pair" ? 1 : boundary === "whole pair" ? 2 : 0;
    const before = prefix + "a".repeat(cut - prefix.length - pairWidth);
    const pair = boundary === "ASCII" ? "" : "😀";
    return { input: before + pair + "tail", expected: before + (boundary === "whole pair" ? pair : "") };
}

function prepare(fixture: Fixture, source: Source, boundary: Boundary): { topic?: string; expected: string } {
    if (source === "topic") {
        const value = boundedValue("", 64, boundary);
        return { topic: `  ${value.input}  `, expected: `topic: ${value.expected} (no topic-specific section registered)` };
    }
    if (source === "user-agent") {
        const value = boundedValue("Mozilla/5.0 ", 120, boundary);
        recordClientUa({ "user-agent": `  ${value.input}  ` });
        return { expected: `observed client user-agents: other: ${value.expected}` };
    }
    if (source === "config") {
        const prefix = '{"notes":"';
        const value = boundedValue(prefix, 1599, boundary);
        const document = { notes: value.input.slice(prefix.length) };
        const serialized = JSON.stringify(document);
        writeFileSync(fixture.config, serialized);
        return { expected: `${value.expected}… (truncated, ${serialized.length} chars total)` };
    }
    if (source === "conflict detail") {
        const value = boundedValue("", 160, boundary);
        recordConflict(getSession("unicode-event"), "unannounced-rewrite", value.input);
        return { topic: "conflict-banner", expected: `unannounced-rewrite: ${value.expected}` };
    }
    const prefix = source === "storage log" ? "[storage] " : "codex compact intercepted ";
    const value = boundedValue(prefix, 239, boundary);
    writeFileSync(fixture.log, `${value.input}\n`);
    return { topic: source === "storage log" ? "storage-legacy-only" : "conflict-banner", expected: (source === "storage log" ? "  " : "") + value.expected + "…" };
}

function assertReport(report: Report, expected: string, suffix = false): void {
    assert.ok(report.blob.split("\n").some((line) => suffix ? line.endsWith(expected) : line === expected),
        `expected the bounded evidence line ${JSON.stringify(expected)} in ${report.blob}`);
    assert.equal(report.blob.isWellFormed(), true, "truncation preserves valid Unicode");
    const url = new URL(report.url);
    assert.equal(url.searchParams.get("body"), report.blob, "prefilled issue body exactly matches copyable diagnostics");
    assert.equal(url.searchParams.get("title"), report.title);
}

for (const source of ["storage log", "conflict log", "config", "conflict detail", "topic", "user-agent"] as const) {
    for (const boundary of ["split pair", "whole pair", "ASCII"] as const) {
        test(`diagnostics ${source}: ${boundary} at the display boundary`, async () => {
            await withFixture(async (fixture) => {
                const { topic, expected } = prepare(fixture, source, boundary);
                assertReport(await buildDiagnostics(topic), expected, source === "conflict detail");
            });
        });
    }
}

async function close(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

for (const source of ["config", "topic"] as const) {
    test(`GET diagnostics serves a report when ${source} emoji crosses its bound`, async () => {
        await withFixture(async (fixture) => {
            const { topic, expected } = prepare(fixture, source, "split pair");
            // No upstream request is needed for this loopback management route.
            const proxy = await startServer({ ...makeOpts(9), logFile: fixture.log });
            try {
                if (!proxy.listening) await once(proxy, "listening");
                const address = proxy.address();
                assert.ok(address && typeof address === "object");
                const url = new URL(`http://127.0.0.1:${address.port}/__bili/diagnostics`);
                if (topic !== undefined) url.searchParams.set("topic", topic);
                const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
                assert.equal(response.status, 200);
                assertReport(await response.json() as Report, expected);
            } finally {
                await close(proxy);
            }
        });
    });
}
