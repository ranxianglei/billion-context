// Self-update state survival e2e: proves the property the version-flip
// proofs (e2e-registry) and the release canary (e2e-release-canary) never
// assert — that live compression state written by build A (folds, ref maps,
// counters) SURVIVES the self-update hop into build B and keeps working:
//   1. boot OLD as a live proxy, create real fold state ×2 through the plugin
//      tool lane (model turn → compress → model turn → compress)
//   2. publish NEW; the LIVE proxy flips its own disk in place
//   3. restart from the flipped tree
//   4. the post-upgrade turn must run on RESTORED state, not a reset one:
//      same session file (identity hash stable), block list append-only,
//      max ref number never re-issued, counters monotonic, and the wire no
//      longer carries the folded raw material — the pre-upgrade folds stay
//      ACTIVE on the rebuilt outbound, and metadata.biliVersion flips
//      OLD → NEW proving the file was adopted (not rewritten from scratch).
// The persistence contract under proof is format stability (PERSIST_VERSION /
// mergeState forward-compat), not payload differences between builds — both
// tarballs share this repo's dist, versions differ only in package.json,
// exactly like the canary's no-op packs.
// Gated with the registry e2e suite: same hermetic loopback world (local
// verdaccio + isolated HOME), so plain `npm test` stays free.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as tar from "tar";
import { startRegistry } from "./registry-fixture.js";
import { isolatedEnv, npmHomeEnv, npmRunSync } from "./crossplat.ts";
import { rmrf } from "../tmp-rm.ts";

const run = process.env.ACP_TEST_REGISTRY === "1";
const skipReason = !run ? "set ACP_TEST_REGISTRY=1 (hermetic local-registry e2e; loopback only)" : undefined;

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "index.js");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string; version: string; files: string[]; scripts?: Record<string, string> };
const OLD_VERSION = PKG.version;
const NEW_VERSION = bumpPatch(OLD_VERSION);

const CONVERSATION = "update-survival";
const FOLD_MATERIAL = "UPDATE-SURVIVAL-FOLD-MATERIAL";
const POST_TURN = "post-upgrade small turn";

function bumpPatch(v: string): string {
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) throw new Error(`unexpected version format: ${v}`);
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

async function makeFixtureTarball(work: string, version: string): Promise<string> {
    const packs = path.join(work, "packs");
    fs.mkdirSync(packs, { recursive: true });
    const stage = path.join(work, "fixtures", version);
    fs.mkdirSync(stage, { recursive: true });
    // Same staging discipline as the registry/canary suites: model a
    // PUBLISHED artifact (no prepare hook, #2471), identical dist content,
    // only the version rewritten.
    fs.writeFileSync(
        path.join(stage, "package.json"),
        `${JSON.stringify({ ...PKG, version, scripts: Object.fromEntries(Object.entries(PKG.scripts ?? {}).filter(([name]) => name !== "prepare")) }, null, 2)}\n`,
    );
    for (const entry of PKG.files) {
        const src = path.join(REPO_ROOT, entry);
        if (fs.existsSync(src)) await fs.promises.cp(src, path.join(stage, entry), { recursive: true });
    }
    const home = path.join(work, "home-pkg");
    fs.mkdirSync(home, { recursive: true });
    const listing = npmRunSync(["pack", "--silent", "--pack-destination", packs], { cwd: stage, env: { PATH: process.env.PATH ?? "", ...npmHomeEnv(home) } })
        .trim()
        .split("\n")
        .pop()
        ?.trim();
    assert.ok(listing?.endsWith(".tgz"), `npm pack produced no tarball for ${version}: ${listing}`);
    return path.join(packs, listing!);
}

async function extractInstall(work: string, tgz: string): Promise<string> {
    const installDir = path.join(work, "global", "node_modules", PKG.name);
    fs.mkdirSync(installDir, { recursive: true });
    await tar.x({ file: tgz, cwd: installDir, strip: 1 });
    return installDir;
}

async function readPkgVersion(dir: string): Promise<string> {
    return (JSON.parse(await fs.promises.readFile(path.join(dir, "package.json"), "utf8")) as { version: string }).version;
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.listen(0, "127.0.0.1", () => {
            const p = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(p));
        });
        s.on("error", reject);
    });
}

/** Plain-JSON chat upstream that RECORDS every request body — the wire-level
 * proof channel (what the proxy actually rebuilt and sent upstream). */
function startRecordingRelay(): { server: http.Server; port: Promise<number>; bodies: string[] } {
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
        req.on("end", () => {
            bodies.push(raw);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "r1",
                object: "chat.completion",
                choices: [{ index: 0, message: { role: "assistant", content: "state-survival reply" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5 },
            }));
        });
    });
    const port = new Promise<number>((resolve, reject) => {
        server.once("listening", () => resolve((server.address() as net.AddressInfo).port));
        server.once("error", reject);
    });
    server.listen(0, "127.0.0.1");
    return { server, port, bodies };
}

type Proxy = { output: () => string; stop: () => Promise<void> };

function spawnProxy(installDir: string, port: number, env: Record<string, string>): Proxy {
    const child: ChildProcess = spawn(process.execPath, [path.join(installDir, "dist", "index.js"), "start", "--port", String(port)], {
        env: { PATH: process.env.PATH ?? "", ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    return {
        output: () => out,
        stop: async () => {
            if (child.exitCode !== null) return;
            child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    resolve();
                }, 5_000);
                child.on("exit", () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        },
    };
}

async function waitFor(what: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (await what()) return;
        if (Date.now() > deadline) throw new Error(`state-survival e2e timed out after ${timeoutMs}ms waiting for: ${label}`);
        await new Promise((r) => setTimeout(r, 250));
    }
}

async function healthOk(port: number): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/__bili/health`);
        if (!res.ok) return false;
        return ((await res.json()) as { ok?: boolean }).ok === true;
    } catch {
        return false;
    }
}

async function modelTurn(port: number, relayPort: number, conversation: string, messages: Array<{ role: string; content: string }>): Promise<void> {
    // Stateful ACP-native agent: the full history is resent every turn (the
    // plugin-lane contract — a stateless one-message client makes the proxy
    // rebase its view to each request, which is a different lane entirely).
    const res = await fetch(`http://127.0.0.1:${port}/bili/http://127.0.0.1:${relayPort}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-bili-plugin": "pi",
            "x-bili-plugin-conversation": conversation,
            "x-bili-plugin-model": "gpt-test",
        },
        body: JSON.stringify({ model: "gpt-test", stream: false, messages }),
    });
    assert.equal(res.status, 200, `model turn for ${conversation} must succeed`);
    await res.json();
}

async function toolCompress(port: number, conversation: string, fold: { startId: string; endId: string; topic: string; summary: string }): Promise<void> {
    // Plugin-lane contract (mirror of cache-friendly-plugin's driveWire): the
    // AGENT supplies explicit ranges ({startId,endId,topic,summary}) — args:{}
    // is a refusal receipt (parse:missing-content), not an auto-range pick.
    const res = await fetch(`http://127.0.0.1:${port}/__bili/plugin/tool`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: "compress", conversationId: conversation, args: { content: [fold] } }),
    });
    assert.equal(res.status, 200, `plugin compress must answer 200`);
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: string } | null;
    assert.equal(json?.ok, true, `plugin compress must succeed: ${JSON.stringify(json)}`);
    assert.ok(typeof json?.result === "string" && json.result.length > 0, "fold must return a summary");
}

/** On-disk session snapshot: the persisted envelope for our conversation id.
 * Reads the plain-JSON codec directly (no BILI_ENCRYPTION_KEY in this test),
 * skipping the content-store sidecars. */
type SessionSnapshot = {
    relPath: string;
    blockIds: string[];
    maxRef: number;
    tokensCompressed: number;
    biliVersion: string | undefined;
    messageCount: number;
};

function findSessionFile(sessionsDir: string, conversation: string): string | undefined {
    const walk = (dir: string): string[] => {
        const found: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) found.push(...walk(p));
            else if (entry.name.endsWith(".json") && !entry.name.endsWith(".content-store.json")) found.push(p);
        }
        return found;
    };
    return walk(sessionsDir).find((p) => {
        try {
            const payload = (JSON.parse(fs.readFileSync(p, "utf8")) as { payload?: { id?: string } }).payload;
            return payload?.id === conversation;
        } catch {
            return false;
        }
    });
}

function snapshotSession(sessionsDir: string, conversation: string): SessionSnapshot {
    const file = findSessionFile(sessionsDir, conversation);
    assert.ok(file, `no persisted session file for ${conversation} under ${sessionsDir}`);
    const payload = (JSON.parse(fs.readFileSync(file, "utf8")) as {
        payload?: {
            state?: { blocks?: Array<{ blockId?: string }>; messageRefs?: { byRaw?: Record<string, unknown>; byRef?: Record<string, unknown> } };
            stats?: { tokensCompressed?: number };
            metadata?: { biliVersion?: string };
            messages?: unknown[];
        };
    }).payload!;
    const blocks = payload.state?.blocks ?? [];
    const refNum = (s: string): number => {
        const m = s.match(/^m(\d+)$/);
        return m ? Number(m[1]) : 0;
    };
    const maxRef = Math.max(
        0,
        ...Object.keys(payload.state?.messageRefs?.byRaw ?? {}).map(refNum),
        ...Object.keys(payload.state?.messageRefs?.byRef ?? {}).map(refNum),
    );
    return {
        relPath: path.relative(sessionsDir, file),
        blockIds: blocks.map((b) => b.blockId ?? ""),
        maxRef,
        tokensCompressed: payload.stats?.tokensCompressed ?? 0,
        biliVersion: payload.metadata?.biliVersion,
        messageCount: payload.messages?.length ?? 0,
    };
}

test("self-update keeps live compression state: folds survive the OLD→NEW hop and stay active (#update-state-survival)", { skip: skipReason, timeout: 240_000 }, async () => {
    assert.ok(fs.existsSync(DIST_ENTRY), "dist/index.js missing — run `npm run build` first");
    const workRoot = path.join(process.cwd(), "tmp");
    fs.mkdirSync(workRoot, { recursive: true });
    const work = fs.mkdtempSync(path.join(workRoot, "e2e-update-state-"));
    const relay = startRecordingRelay();
    const relayPort = await relay.port;
    const registry = await startRegistry(path.join(work, "registry"));
    const sessionsDir = path.join(work, "sessions");
    let proxy: Proxy | undefined;
    let failed = false;
    try {
        // ── machine setup: one live OLD install pinned at the test registry ──
        const oldTgz = await makeFixtureTarball(work, OLD_VERSION);
        const newTgz = await makeFixtureTarball(work, NEW_VERSION);
        await registry.publish(oldTgz);
        const installDir = await extractInstall(work, oldTgz);
        assert.equal(await readPkgVersion(installDir), OLD_VERSION);

        const envBase = isolatedEnv(work);
        envBase.BILI_UPDATE_REGISTRY = registry.url;
        envBase.BILI_UPDATE_CHECK_INTERVAL_MS = "1000";
        // #3619 pins: this suite asserts PERIODIC update mechanics, not stagger
        // timing — pin the rollout knobs to legacy immediate and point the
        // policy fetch at an unroutable URL so the remote policy can never
        // inject a delay/hold into the observed upgrade.
        envBase.BILI_UPDATE_STAGGER_MIN_MS = "0";
        envBase.BILI_UPDATE_STAGGER_MAX_MS = "0";
        envBase.BILI_UPDATE_POLICY_URL = "http://127.0.0.1:1/no-policy.json";
        envBase.BILI_PERSIST_DEBOUNCE_MS = "200";
        envBase.BILI_SESSIONS_DIR = sessionsDir;

        const port = await freePort();
        proxy = spawnProxy(installDir, port, envBase);
        await waitFor(() => healthOk(port), 30_000, "proxy healthy after boot");

        // ── phase 1: build real fold state on the OLD build ──
        // The harness plays the STATEFUL ACP-native agent: full history resent
        // every turn (so refs are stable: u1=m00001 a1=m00002 u2=m00003
        // a2=m00004), then issues agent-driven compress calls with explicit
        // ref ranges — the plugin-lane contract.
        const REPLY = "state-survival reply";
        const hist: Array<{ role: string; content: string }> = [];
        const turn = async (text: string) => {
            hist.push({ role: "user", content: text });
            await modelTurn(port, relayPort, CONVERSATION, hist);
            hist.push({ role: "assistant", content: REPLY });
            // Plugin-lane contract: the AGENT owns the history, so the reply
            // only enters the proxy's view once resent. Without this resync
            // the refs a1/a2 map to, do not exist yet and the fold ranges
            // refuse with gate:none-resolved.
            await modelTurn(port, relayPort, CONVERSATION, hist);
        };
        const bigText = `${FOLD_MATERIAL}. ${"The quick brown fox jumps over the lazy dog while the proxy counts tokens. ".repeat(220)}`;
        const bigText2 = `${FOLD_MATERIAL} second chapter. ${"A second block of fold material so the ref cursor advances past the first fold. ".repeat(220)}`;
        // The kernel's protection window is preserveRecentMessages=5 PLUS
        // preserveRecentTokens=5000 expanding backward from the tail — small
        // filler plus the big chapters all fit inside 5K tokens, so the fold
        // ranges need ~6K+ tokens of tail filler after them to age out.
        const filler = (i: number) => `Filler turn ${i}: ${"Persistent filler prose so the five-thousand-token preservation window saturates well before the fold chapters. ".repeat(70)}`;
        // The kernel protects the last 5 messages from folding, so the two
        // fold ranges (m00003..m00006) need tail filler turns to leave the
        // protected zone. The tiny opener stays pinned on the wire by design
        // (first-user-message pin, kernel prune.ts) — cheap to keep, and it
        // keeps the foldable material OFF the pinned slot.
        await turn("Conversation opener: a tiny first user message so the first-user pin has something cheap to keep.");
        await turn(bigText);
        await turn(bigText2);
        for (let i = 3; i <= 8; i++) await turn(filler(i));
        await toolCompress(port, CONVERSATION, { startId: "m00003", endId: "m00004", topic: "update-survival-chapter-1", summary: "Agent folded chapter 1: one large user message about fold material plus the assistant reply." });
        await toolCompress(port, CONVERSATION, { startId: "m00005", endId: "m00006", topic: "update-survival-chapter-2", summary: "Agent folded chapter 2: a second large user message plus the assistant reply, ref cursor past the first fold." });
        await waitFor(() => {
            const file = findSessionFile(sessionsDir, CONVERSATION);
            if (!file) return false;
            const snap = snapshotSession(sessionsDir, CONVERSATION);
            return snap.blockIds.length >= 2;
        }, 10_000, "two folds persisted by the OLD build");
        const pre = snapshotSession(sessionsDir, CONVERSATION);
        assert.ok(pre.blockIds.length >= 2, `expected ≥2 fold blocks, got ${pre.blockIds.length}`);
        assert.equal(pre.biliVersion, OLD_VERSION, "the persisted state must carry the OLD build stamp — this is what the NEW build has to adopt");
        const preFoldTurnBody = relay.bodies[relay.bodies.length - 1]!;
        assert.ok(preFoldTurnBody.includes(FOLD_MATERIAL), "sanity: the raw fold material was on the wire before folding");

        // ── phase 2: publish NEW — the LIVE proxy flips its own disk ──
        await registry.publish(newTgz);
        await waitFor(async () => (await readPkgVersion(installDir)) === NEW_VERSION, 60_000, `global tree flipped to ${NEW_VERSION} by the live proxy`);

        // ── phase 3: restart from the updated tree ──
        await proxy.stop();
        const versionRes = spawnSync(process.execPath, [path.join(installDir, "dist", "index.js"), "--version"], {
            encoding: "utf8",
            timeout: 30_000,
            env: { PATH: process.env.PATH ?? "", ...envBase },
        });
        assert.match(`${versionRes.stdout}${versionRes.stderr}`, new RegExp(NEW_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "restarted tree must report the new version");
        proxy = spawnProxy(installDir, port, envBase);
        await waitFor(() => healthOk(port), 30_000, "proxy healthy after restart on the updated tree");

        // ── phase 4: the post-upgrade turn runs on RESTORED state ──
        const bodiesBefore = relay.bodies.length;
        hist.push({ role: "user", content: POST_TURN });
        await modelTurn(port, relayPort, CONVERSATION, hist);
        const postBody = relay.bodies[relay.bodies.length - 1]!;
        assert.ok(relay.bodies.length === bodiesBefore + 1, "exactly one upstream request for the post-upgrade turn");
        assert.ok(postBody.includes(POST_TURN), "the new turn must reach the upstream");
        assert.ok(!postBody.includes(FOLD_MATERIAL), "the pre-upgrade folds must still be ACTIVE: folded raw material must not re-enter the wire after the update hop");

        // status endpoint binds the conversation to the restored session
        const status = (await (await fetch(`http://127.0.0.1:${port}/__bili/plugin/status?conversationId=${CONVERSATION}`)).json()) as { ok?: boolean; sessionId?: string | null };
        assert.equal(status.ok, true, "plugin status must answer ok for the restored conversation");
        assert.ok(status.sessionId, "plugin status must bind to a live (restored) session, not 404 into a fresh one");

        // persisted envelope: same file, append-only blocks, monotonic refs
        await waitFor(() => {
            const snap = snapshotSession(sessionsDir, CONVERSATION);
            return snap.biliVersion === NEW_VERSION;
        }, 10_000, "the NEW build re-stamps the adopted session file");
        const post = snapshotSession(sessionsDir, CONVERSATION);
        assert.equal(post.relPath, pre.relPath, "same session file path — the new build derived the same identity from the same conversation id");
        assert.deepEqual(post.blockIds.slice(0, pre.blockIds.length), pre.blockIds, "fold blocks must be append-only across the update hop");
        assert.ok(post.blockIds.length >= pre.blockIds.length, "no fold blocks may be dropped by the update hop");
        assert.ok(post.maxRef >= pre.maxRef, `max ref number must never decrease (kernel id contract): ${pre.maxRef} → ${post.maxRef}`);
        assert.ok(post.tokensCompressed >= pre.tokensCompressed, `tokensCompressed must be monotonic: ${pre.tokensCompressed} → ${post.tokensCompressed}`);
        assert.ok(post.messageCount >= pre.messageCount, "persisted live messages must not shrink across the hop");
    } catch (err) {
        failed = true;
        throw err;
    } finally {
        await proxy?.stop();
        await new Promise<void>((resolve) => relay.server.close(() => resolve()));
        await registry.stop().catch(() => {});
        if (failed) {
            fs.writeFileSync(path.join(work, "diagnostics.txt"), `${proxy?.output() ?? "(no proxy output)"}\n\n=== upstream bodies ===\n${relay.bodies.join("\n---\n")}`);
            console.error(`[update-state] failure — keeping work dir for artifacts: ${work}`);
        } else {
            rmrf(work);
        }
    }
});
