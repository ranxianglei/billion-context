import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { apply, planNativeDsh, shouldBootstrapNativeDsh, persistClientEvent, mediaBytesOfWireBody, bodyProvablyOverWindow, _attributionHealthForTest, _resetAttributionHealthForTest, _registerStateForTest, _resetRegisterForTest, _setModelInfoForTest, _setSpawnForTest, _setThrewRetryForTest, _settleNativeForTest, _stateHeadersForTest, _stateRespawnForTest, _stateTakeoverGateForTest, _stateToolsReadyForTest, _stateBeforeSendForTest, _stateOnResponseForTest, _noteRoutedForTest, _resetRoutedForTest, _resetWebProfileWarningForTest, _resetNonWebTraceForTest, _resetTitlesForTest, isDshSessionDeleteEvent, type PluginContext } from "../src/agent/dsh-native.ts";
import { __resetIncrementalClientForTests } from "../src/agent/incremental-client.ts";
import { isDshCompactionActive, _resetDshCompactionVerdictForTest } from "../src/agent/dsh-compaction-disable.ts";
import { once } from "node:events";
import { startServer } from "../src/server.ts";
import { defaultConfig } from "acp-kernel";

// #3370: the incremental-turn conversion must stamp the marker header on the
// SAME init as the body swap (atomic, omp pattern) — the old arms-a-flag /
// consume-in-headersFor split raced concurrent sessions across the awaited
// hook boundary and could ship a delta body with NO marker (silent history
// loss upstream). Also pins the single-flight guard + the ack handshake.
test("#3370: dsh incremental conversion is atomic (marker + body on the same init), single-flighted, ack-driven", async () => {
    const proxy = await startMockProxy([], undefined, undefined, undefined, true);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-inc-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-inc-state-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome, BILI_PROVIDER_REWRITES: undefined, BILI_NATIVE_DSH: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            _resetRegisterForTest(proxy.origin);
            __resetIncrementalClientForTests();
            const ctx = mockCtx();
            ctx.setInitiator({ session: { id: "dsh-inc-1" } });
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration");
            await _stateToolsReadyForTest();
            const beforeSend = _stateBeforeSendForTest();
            const onResponse = _stateOnResponseForTest();
            const headersFor = _stateHeadersForTest();
            assert.ok(beforeSend && onResponse && headersFor, "conversion seams armed");
            const url = `${proxy.origin}/v1/messages`;

            // 1. first turn: seed conversion — marker and body land on init TOGETHER
            const msgs1 = [{ role: "user", content: "hello" }];
            const init1: RequestInit = { method: "POST", body: JSON.stringify({ model: "claude-test", max_tokens: 64, messages: msgs1 }) };
            await beforeSend(url, init1);
            const body1 = JSON.parse(init1.body as string) as { conversationId?: string; sinceSeq?: number; resync?: boolean };
            assert.equal(body1.conversationId, "dsh-inc-1", "seed body swapped in");
            assert.equal(body1.resync, true);
            assert.equal(new Headers(init1.headers).get("x-bili-plugin-turn"), "1", "#3370: marker stamped on the same init as the body");
            const turnId1 = new Headers(init1.headers).get("x-bili-turn-id");
            assert.ok(turnId1, "#3329: per-request turn id stamped alongside the marker");
            const extra = headersFor(url) ?? {};
            assert.equal(extra["x-bili-plugin-turn"], undefined, "headersFor no longer stamps/consumes the marker");
            assert.equal(extra["x-bili-plugin"], "dsh", "plugin identity headers still stamped");

            // 2. single-flight: while the seed awaits its ack, a second request
            //    on the same URL rides the NORMAL pipeline untouched
            const msgs2 = [...msgs1, { role: "assistant", content: "hi" }, { role: "user", content: "again" }];
            const original2 = JSON.stringify({ model: "claude-test", max_tokens: 64, messages: msgs2 });
            const init2: RequestInit = { method: "POST", body: original2 };
            await beforeSend(url, init2);
            assert.equal(init2.body, original2, "single-flight: un-acked pending blocks conversion");
            assert.equal(new Headers(init2.headers ?? {}).get("x-bili-plugin-turn"), null);

            // 2b. that skipped request's plain 200 (no ack header) arrives
            //     BEFORE the marker'd response — it must not consume the
            //     pending entry, or the seed's ack below is lost and turn 3
            //     replans a resync instead of a delta (#3378 review). Under
            //     turn-id keying (#3329) the 2-arg call carries no outgoing
            //     headers at all — a response with no turn-id header is not
            //     an incremental ack and consumes nothing, which is exactly
            //     the no-op this step pins.
            onResponse(url, new Response("{}", { status: 200 }));

            // 3. ack the seed → the next turn plans a DELTA (sinceSeq advanced).
            //    #3329: the ack is attributed via the seed's OWN turn id, read
            //    back from its outgoing headers (what native-intercept threads
            //    into onResponse in production).
            onResponse(url, new Response("{}", { status: 200, headers: { "x-bili-applied-seq": String(msgs1.length) } }), { "x-bili-turn-id": turnId1 });
            const init3: RequestInit = { method: "POST", body: original2 };
            await beforeSend(url, init3);
            const body3 = JSON.parse(init3.body as string) as { sinceSeq?: number; messages?: unknown[]; resync?: boolean };
            assert.equal(body3.sinceSeq, msgs1.length, "delta against the acked base");
            assert.equal(body3.messages?.length, msgs2.length - msgs1.length, "only the new messages");
            assert.equal(body3.resync, undefined);
            assert.equal(new Headers(init3.headers).get("x-bili-plugin-turn"), "1", "delta carries its own marker");
        });
    } finally {
        proxy.close();
    }
});

// #3433: OpenAI wire shapes (assistant.tool_calls / role:"tool") must NOT be
// converted onto the incremental lane — the lane ingests with anthropicToCore
// and would silently drop the tool calls. They stay on full resend, exactly
// like omp/opencode do behind wireMessagesLookAnthropic.
test("#3433: dsh OpenAI tool shapes ride full resend; anthropic shapes still convert", async () => {
    const proxy = await startMockProxy([], undefined, undefined, undefined, true);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-inc3433-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-inc3433-state-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome, BILI_PROVIDER_REWRITES: undefined, BILI_NATIVE_DSH: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            _resetRegisterForTest(proxy.origin);
            __resetIncrementalClientForTests();
            const ctx = mockCtx();
            ctx.setInitiator({ session: { id: "dsh-inc-3433" } });
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration");
            await _stateToolsReadyForTest();
            const beforeSend = _stateBeforeSendForTest();
            assert.ok(beforeSend, "conversion seam armed");
            const url = `${proxy.origin}/v1/chat/completions`;

            // OpenAI chat-completions shape: assistant.tool_calls + role:"tool"
            const openaiMsgs = [
                { role: "user", content: "list the files" },
                { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
                { role: "tool", tool_call_id: "call_1", content: "a.txt b.txt" },
                { role: "user", content: "now read a.txt" },
            ];
            const original = JSON.stringify({ model: "gpt-test", max_tokens: 64, messages: openaiMsgs });
            const init: RequestInit = { method: "POST", body: original };
            await beforeSend(url, init);
            assert.equal(init.body, original, "OpenAI tool shape rides full resend (body untouched)");
            assert.equal(new Headers(init.headers ?? {}).get("x-bili-plugin-turn"), null, "no marker on the untouched body");

            // control: the anthropic wire shape still converts (guard does not over-block)
            const init2: RequestInit = { method: "POST", body: JSON.stringify({ model: "claude-test", max_tokens: 64, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }) };
            await beforeSend(url, init2);
            const body2 = JSON.parse(init2.body as string) as { conversationId?: string };
            assert.equal(body2.conversationId, "dsh-inc-3433", "anthropic shape still converts to a lane turn");
            assert.equal(new Headers(init2.headers).get("x-bili-plugin-turn"), "1", "marker stamped on the anthropic turn");
        });
    } finally {
        proxy.close();
        rmrf(home);
        rmrf(stateHome);
    }
});

import { rmrf } from "./tmp-rm.ts";

// #1797: drain ALL in-flight attach/recovery chains after each test — defense-in-depth
// behind #1798's per-suite settles, which only await the latest apply()'s gate.
afterEach(() => { void _settleNativeForTest(); });

// #1365: legacy dead-attach suites see no routed traffic, so without this pin
// each would sit out the FULL routed-evidence grace window (default 5s,
// native-intercept observeRoutedOrigin) before the spawn fallback — keep the
// grace tiny so the POLL_DEADLINE_MS cap dominates timing. Pinned-path tests
// override per-test.
process.env.BILI_ATTACH_EVIDENCE_GRACE_MS = "30";

// #1365: a dev shell that runs DSH itself exports a live attach target; every
// suite below must start from a clean slate or it silently binds to the real
// proxy instead of the mock it set up. withEnv() only restores the keys it was
// given, so the host values have to go here.
delete process.env.BILLION_CONTEXT_ATTACH;
delete process.env.BILLION_CONTEXT_PROXY;

import { dshNativeInstalled, isNpmInstallForm, pluginInstall, pluginRemove, pluginStatusAll, selfPackageRoot } from "../src/plugin-install.ts";
import { DSH_PATCH_BEGIN, DSH_PATCH_END, dshBundleInstalled, dshProfileDirs, planDshSpawn, stripDshManagedPatch, stripLegacyManagedBlock, _setDshRunnersForTest, type DshPlan } from "../src/dsh-channel.ts";

test("planNativeDsh: kill-switches > attach > spawn precedence (#941)", () => {
    assert.deepEqual(planNativeDsh({}), { mode: "spawn" });
    assert.deepEqual(planNativeDsh({ BILLION_CONTEXT_PLUGIN: "0" }), { mode: "off" });
    assert.deepEqual(planNativeDsh({ BILI_NATIVE_DSH: "0" }), { mode: "off" });
    assert.deepEqual(planNativeDsh({ BILI_PROVIDER_REWRITES: "{}" }), { mode: "off" });
    // a preset BILLION_CONTEXT_PROXY (the `bili dsh` launcher) is an attach
    // target, not a stand-down
    assert.deepEqual(planNativeDsh({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787/" }), { mode: "attach", attachOrigin: "http://127.0.0.1:8787" });
    // explicit BILLION_CONTEXT_ATTACH wins over the preset proxy env
    assert.deepEqual(planNativeDsh({ BILLION_CONTEXT_ATTACH: "http://127.0.0.1:9999", BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), { mode: "attach", attachOrigin: "http://127.0.0.1:9999" });
    assert.deepEqual(planNativeDsh({ BILI_NATIVE_DSH: "0", BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), { mode: "off" });
});

test("shouldBootstrapNativeDsh: spawn-gated by env shape", () => {
    assert.equal(shouldBootstrapNativeDsh({}), true);
    assert.equal(shouldBootstrapNativeDsh({ BILLION_CONTEXT_PROXY: "http://127.0.0.1:8787" }), false);
    assert.equal(shouldBootstrapNativeDsh({ BILI_NATIVE_DSH: "0" }), false);
});

// — legacy managed-block migration (#966) ————————————————————————

const HEADER = "# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n";

// Block as written by pre-#966 installs: the markers are stable constants,
// the body is what the retired managed lane used to append.
const legacyBlockOf = (root: string): string => `${DSH_PATCH_BEGIN}\n- insert:\n    - id: bili-native\n      name: ${pathToFileURL(path.join(root, "dist", "agent", "dsh-native.js")).href}\n- id: compaction-basic\n  config:\n    auto: false\n${DSH_PATCH_END}\n`;

test("planTokens: unpacks the win32 cmd.exe wrap back to argv", () => {
    const plan = planDshSpawn("dsh", ["plugin", "--profile", "x", "add", "billion-context"], {}, "win32");
    assert.deepEqual(planTokens(plan), ["plugin", "--profile", "x", "add", "billion-context"]);
    // posix plans pass through untouched
    assert.deepEqual(planTokens({ command: "dsh", args: ["plugin", "--profile", "x", "add", "billion-context"] }), ["plugin", "--profile", "x", "add", "billion-context"]);
});

test("stripDshManagedPatch: removes only the marked span; no-op without markers", () => {
    const merged = `${HEADER}[]\n${legacyBlockOf("/opt/bili")}`;
    assert.equal(stripDshManagedPatch(merged), `${HEADER}[]\n`);
    assert.equal(stripDshManagedPatch(HEADER), HEADER);
});

test("stripLegacyManagedBlock: restores the placeholder when nothing meaningful remains", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-legacy-"));
    try {
        fs.writeFileSync(path.join(dir, "cordis.patch.yml"), `${HEADER}${legacyBlockOf("/opt/bili")}`);
        assert.equal(stripLegacyManagedBlock(dir), true);
        assert.equal(fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8"), `${HEADER}[]\n`);
        assert.equal(stripLegacyManagedBlock(dir), false);
    } finally {
        rmrf(dir);
    }
});

test("stripLegacyManagedBlock: preserves user entries; leaves non-managed files alone", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-legacy2-"));
    try {
        const userEntry = '- id: my-thing\n  name: "@deepseek-ai/cordis-plugin-timer"\n';
        fs.writeFileSync(path.join(dir, "cordis.patch.yml"), `${HEADER}${userEntry}${legacyBlockOf("/opt/bili")}`);
        assert.equal(stripLegacyManagedBlock(dir), true);
        const out = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
        assert.ok(out.includes(userEntry));
        assert.ok(!out.includes(DSH_PATCH_BEGIN));
        fs.writeFileSync(path.join(dir, "cordis.patch.yml"), `${HEADER}[]\n`);
        assert.equal(stripLegacyManagedBlock(dir), false);
        assert.equal(fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8"), `${HEADER}[]\n`);
    } finally {
        rmrf(dir);
    }
});

test("stripLegacyManagedBlock: preserves user comments when nothing meaningful remains", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-legacy3-"));
    try {
        const notes = "# my note one\n# my note two\n";
        fs.writeFileSync(path.join(dir, "cordis.patch.yml"), `${notes}${legacyBlockOf("/opt/bili")}`);
        assert.equal(stripLegacyManagedBlock(dir), true);
        const out = fs.readFileSync(path.join(dir, "cordis.patch.yml"), "utf8");
        assert.ok(out.startsWith(notes));
        assert.ok(out.includes("[]"));
        assert.ok(!out.includes(DSH_PATCH_BEGIN));
    } finally {
        rmrf(dir);
    }
});

// — channel-driven installer roundtrip under a fake DSH_HOME ——————————

/** Recording stand-in for the real spawn: applies the manifest effect the
 *  dsh pnpm forwarder would leave behind (dep + bundle entry) so status /
 *  remove / dshNativeInstalled assertions see realistic state. On Windows the
 *  plan rides cmd.exe /d /s /c "<line>" — unpack it back to argv tokens so
 *  the same assertions hold on every platform (test tokens carry no spaces). */
function planTokens(plan: DshPlan): string[] {
    const base = path.basename(plan.command).toLowerCase();
    if (base !== "cmd.exe" && base !== "cmd") return [...plan.args];
    const line = plan.args[3] ?? "";
    const tokens = line.replace(/^"|"$/g, "").split(" ").map((t) => t.replace(/^"|"$/g, "")).filter((t) => t.length > 0);
    return tokens.slice(1);
}

function channelRunner(home: string, calls: string[][]): { sync: (p: DshPlan) => { stdout: string; stderr: string }; async: (p: DshPlan) => Promise<{ stdout: string; stderr: string }> } {
    const apply = (plan: DshPlan): { stdout: string; stderr: string } => {
        const tokens = planTokens(plan);
        calls.push(tokens);
        const pi = tokens.indexOf("--profile");
        const name = tokens[pi + 1];
        const action = tokens[pi + 2];
        const dir = path.join(home, "profiles", name);
        if (action === "add") {
            fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `dsh-profile-${name}`, dependencies: { "billion-context": "^0.1.120" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "billion-context"] } } }));
        } else if (action === "remove") {
            const m = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } };
            delete m.dependencies?.["billion-context"];
            if (m.dsh?.profile?.bundles) m.dsh.profile.bundles = m.dsh.profile.bundles.filter((b) => b !== "billion-context");
            fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(m));
        }
        return { stdout: "", stderr: "" };
    };
    return { sync: apply, async: async (p) => apply(p) };
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
        saved[k] = process.env[k];
        const v = env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

const USER_ENTRY = '- id: my-thing\n  name: "@deepseek-ai/cordis-plugin-timer"\n';

// Mirrors the production spec rule (#925): npm-form install → registry name,
// checkout/dev build → absolute path the forwarder turns into a link: dep.
const expectedSpec = (): string => (isNpmInstallForm(selfPackageRoot()) ? "billion-context" : path.resolve(selfPackageRoot()));

test("dsh install drives the dsh plugin channel per profile, no managed blocks written", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-home-"));
    const calls: string[][] = [];
    _setDshRunnersForTest(channelRunner(home, calls));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            assert.throws(() => pluginInstall("dsh"), /run dsh once/);
            assert.equal(dshNativeInstalled(), false);

            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            // headless carries a pre-unification managed block plus a user entry (upgrade path)
            fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), `${HEADER}${USER_ENTRY}${legacyBlockOf("/opt/bili")}`);

            const msg = pluginInstall("dsh");
            assert.match(msg, /2 dsh profile/);
            assert.match(msg, /headless: legacy managed block stripped/);
            assert.ok(msg.includes(`add ${expectedSpec()}`));

            assert.deepEqual(calls.map((c) => c.join(" ")).sort(), [
                `plugin --profile headless add ${expectedSpec()}`,
                `plugin --profile web add ${expectedSpec()}`,
            ].sort());

            const headlessTxt = fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8");
            assert.ok(headlessTxt.includes(USER_ENTRY));
            assert.ok(!headlessTxt.includes(DSH_PATCH_BEGIN));
            // the channel owns profile state — bili wrote no patch file of its own
            assert.ok(!fs.existsSync(path.join(home, "profiles", "web", "cordis.patch.yml")));

            assert.equal(pluginStatusAll().find((r) => r.agent === "dsh")?.status, "installed (dsh bundle in all 2 profiles)");
            assert.equal(dshNativeInstalled(), true);
        });
    } finally {
        _setDshRunnersForTest(undefined);
        rmrf(home);
    }
});

test("dsh remove uninstalls through the same channel and migrates legacy blocks", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-remove-"));
    const calls: string[][] = [];
    _setDshRunnersForTest(channelRunner(home, calls));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            fs.writeFileSync(
                path.join(home, "profiles", "web", "package.json"),
                JSON.stringify({ name: "dsh-profile-web", dependencies: { "billion-context": "^0.1.120" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "billion-context"] } } }),
            );
            fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), `${HEADER}${legacyBlockOf("/opt/bili")}`);

            const removed = pluginRemove("dsh");
            assert.match(removed, /removed bili from 2 dsh profile/);
            assert.match(removed, /web: uninstalled via the dsh plugin channel/);
            assert.match(removed, /headless: legacy managed block stripped/);
            assert.deepEqual(calls.map((c) => c.join(" ")).sort(), [`plugin --profile web remove billion-context`]);

            assert.equal(fs.readFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), "utf8"), `${HEADER}[]\n`);
            const webManifest = JSON.parse(fs.readFileSync(path.join(home, "profiles", "web", "package.json"), "utf8")) as Record<string, unknown>;
            assert.equal((webManifest.dependencies as Record<string, string>)["billion-context"], undefined);
            assert.match(pluginStatusAll().find((r) => r.agent === "dsh")?.status ?? "", /not installed/);
            assert.equal(dshNativeInstalled(), false);

            assert.match(pluginRemove("dsh"), /nothing to remove/);
            assert.equal(calls.length, 1);
        });
    } finally {
        _setDshRunnersForTest(undefined);
        rmrf(home);
    }
});

test("dsh install surfaces channel failures with context", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-fail-"));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            _setDshRunnersForTest({ sync: () => { throw Object.assign(new Error("spawn failed"), { status: 127, stderr: "pnpm not found on PATH (corepack enable pnpm)" }); } });
            assert.throws(() => pluginInstall("dsh"), /pnpm not found on PATH/);
            _setDshRunnersForTest({ sync: () => { throw Object.assign(new Error("spawn failed"), { code: "ENOENT" }); } });
            assert.throws(() => pluginInstall("dsh"), /dsh CLI not found/);
        });
    } finally {
        _setDshRunnersForTest(undefined);
        rmrf(home);
    }
});

test("dsh status: bundle / mixed / legacy / absent", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-status-"));
    try {
        await withEnv({ DSH_HOME: home }, async () => {
            fs.mkdirSync(path.join(home, "profiles", "a"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "b"), { recursive: true });
            const st = (): string => pluginStatusAll().find((r) => r.agent === "dsh")?.status ?? "";
            const bundleManifest = JSON.stringify({ dsh: { profile: { bundles: ["billion-context"] } } });

            assert.match(st(), /not installed/);
            fs.writeFileSync(path.join(home, "profiles", "a", "package.json"), bundleManifest);
            assert.match(st(), /installed as a dsh bundle in 1\/2 profiles/);
            fs.writeFileSync(path.join(home, "profiles", "b", "package.json"), bundleManifest);
            assert.equal(st(), "installed (dsh bundle in all 2 profiles)");

            fs.rmSync(path.join(home, "profiles", "a", "package.json"));
            fs.rmSync(path.join(home, "profiles", "b", "package.json"));
            fs.writeFileSync(path.join(home, "profiles", "a", "cordis.patch.yml"), `${HEADER}${legacyBlockOf("/opt/bili")}`);
            assert.match(st(), /legacy managed block in 1\/2 profiles — rerun/);
            fs.writeFileSync(path.join(home, "profiles", "b", "cordis.patch.yml"), `${HEADER}${legacyBlockOf("/opt/bili")}`);
            assert.match(st(), /legacy managed block — rerun 'bili plugin install dsh' to migrate/);
        });
    } finally {
        rmrf(home);
    }
});

test("dshNativeInstalled: true iff any profile has the bundle or a legacy managed block", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-installed-"));
    try {
        await withEnv({ DSH_HOME: home }, () => {
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "web"), { recursive: true });
            assert.equal(dshNativeInstalled(), false);
            fs.writeFileSync(path.join(home, "profiles", "headless", "cordis.patch.yml"), legacyBlockOf("/opt/bili"));
            assert.equal(dshNativeInstalled(), true);
            fs.rmSync(path.join(home, "profiles", "headless", "cordis.patch.yml"));
            fs.writeFileSync(path.join(home, "profiles", "web", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["billion-context"] } } }));
            assert.equal(dshNativeInstalled(), true);
        });
        // no profiles root at all — nothing can be installed (keep the env
        // pointed at the sandbox: the developer's real ~/.dsh may carry an
        // install, and this must not read it)
        await withEnv({ DSH_HOME: path.join(home, "absent") }, () => {
            assert.equal(dshNativeInstalled(), false);
        });
    } finally {
        rmrf(home);
    }
});

test("dshBundleInstalled: true iff the profile manifest lists billion-context as a bundle", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-bundle-"));
    try {
        fs.mkdirSync(path.join(home, "web"), { recursive: true });
        assert.equal(dshBundleInstalled(path.join(home, "web")), false); // no manifest
        fs.writeFileSync(path.join(home, "web", "package.json"), JSON.stringify({ name: "dsh-profile" }));
        assert.equal(dshBundleInstalled(path.join(home, "web")), false); // no dsh block
        fs.writeFileSync(path.join(home, "web", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["something-else"] } } }));
        assert.equal(dshBundleInstalled(path.join(home, "web")), false);
        fs.writeFileSync(path.join(home, "web", "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["billion-context"] } } }));
        assert.equal(dshBundleInstalled(path.join(home, "web")), true);
    } finally {
        rmrf(home);
    }
});

test("dshProfileDirs: skips node_modules, errors when profiles root is absent", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-dirs-"));
    try {
        await withEnv({ DSH_HOME: home }, () => {
            assert.throws(() => dshProfileDirs(), /run dsh once/);
            fs.mkdirSync(path.join(home, "profiles", "node_modules"), { recursive: true });
            fs.mkdirSync(path.join(home, "profiles", "headless"), { recursive: true });
            const dirs = dshProfileDirs();
            assert.equal(dirs.length, 1);
            assert.ok(dirs[0].endsWith("headless"));
        });
    } finally {
        rmrf(home);
    }
});

// — apply() integration against a mock proxy ——————————————————————————

type MockTool = { name: string; description?: string; inputSchema: unknown };

type NameCall = { conversationId: string; name: string };

type MockAttributionCall = { agent: string; state: string; refusals: number; since: number; error?: string; endpoint?: string };

type DeleteCall = { conversationId: string };

function mockBiliHandler(toolCalls: Array<{ conversationId: string; tool: string; args: unknown; nativeCaller?: boolean }>, statusResponder?: (url: string) => unknown | undefined, nameCalls?: NameCall[], nameStatus?: number, turnEnabled?: boolean, attributionCalls?: MockAttributionCall[], holdManifest?: () => Promise<void> | void, deleteCalls?: DeleteCall[]): (req: http.IncomingMessage, res: http.ServerResponse) => void {
    const manifestTools: MockTool[] = [
        {
            name: "compress",
            description: "Compress a range of messages",
            inputSchema: { type: "object", properties: { summary: { type: "string" }, range: { type: "string" } }, required: ["summary"] },
        },
    ];
    return (req, res) => {
        const url = req.url ?? "";
        if (url === "/__bili/plugin/session-name") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                if (nameCalls !== undefined) {
                    const parsed = JSON.parse(body) as { conversationId?: unknown; name?: unknown };
                    nameCalls.push({ conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : "", name: typeof parsed.name === "string" ? parsed.name : "" });
                }
                res.writeHead(nameStatus ?? 200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }
        if (url === "/__bili/plugin/delete") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                if (deleteCalls !== undefined) {
                    const parsed = JSON.parse(body) as { conversationId?: unknown };
                    deleteCalls.push({ conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : "" });
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, deleted: [], deferred: [] }));
            });
            return;
        }
        if (url === "/__bili/plugin/manifest") {
            // #3616: optional hold — keeps the version probe / registration
            // manifest IN FLIGHT so a suite can suspend one world's recovery
            // across the boundary where another world takes ownership.
            if (holdManifest === undefined) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ version: "0.1.119", tools: { anthropic: manifestTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } }));
                return;
            }
            void (async () => {
                await holdManifest();
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ version: "0.1.119", tools: { anthropic: manifestTools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } }));
            })();
            return;
        }
        if (url.startsWith("/__bili/plugin/tool")) {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const parsed = JSON.parse(body) as { conversationId?: string; tool?: string; args?: unknown; nativeCaller?: unknown };
                toolCalls.push({ conversationId: parsed.conversationId ?? "", tool: parsed.tool ?? "", args: parsed.args, ...(parsed.nativeCaller === true ? { nativeCaller: true } : {}) });
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, result: "compressed 42 tokens" }));
            });
            return;
        }
        if (url === "/__bili/plugin/turn") {
            // #3370: the incremental-turn feature probe (GET) — mocked so
            // suites can drive the conversion seams without a real lane.
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ enabled: turnEnabled === true }));
            return;
        }
        if (url.startsWith("/__bili/plugin/status")) {
            const body = statusResponder === undefined ? { panel: "PANEL-OK" } : statusResponder(url);
            if (body === undefined) {
                res.writeHead(404);
                res.end("{}");
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(body));
            return;
        }
        // #3581: plugin→proxy attribution-health reports — captured for the
        // event-driven visibility tests (first refusal / state change / recovery).
        if (url === "/__bili/plugin/attribution") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                if (attributionCalls !== undefined) {
                    const parsed = JSON.parse(body) as Record<string, unknown>;
                    attributionCalls.push({
                        agent: typeof parsed.agent === "string" ? parsed.agent : "",
                        state: typeof parsed.state === "string" ? parsed.state : "",
                        refusals: typeof parsed.refusals === "number" ? parsed.refusals : -1,
                        since: typeof parsed.since === "number" ? parsed.since : -1,
                        ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
                        ...(typeof parsed.endpoint === "string" ? { endpoint: parsed.endpoint } : {}),
                    });
                }
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }
        res.writeHead(404);
        res.end("{}");
    };
}

function startMockProxy(toolCalls: Array<{ conversationId: string; tool: string; args: unknown; nativeCaller?: boolean }>, statusResponder?: (url: string) => unknown | undefined, nameCalls?: NameCall[], nameStatus?: number, turnEnabled?: boolean, attributionCalls?: MockAttributionCall[], holdManifest?: () => Promise<void> | void, deleteCalls?: DeleteCall[]): Promise<{ origin: string; close: () => void }> {
    const server = http.createServer(mockBiliHandler(toolCalls, statusResponder, nameCalls, nameStatus, turnEnabled, attributionCalls, holdManifest, deleteCalls));
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address() as { port: number };
            resolve({ origin: `http://127.0.0.1:${addr.port}`, close: () => server.close() });
        });
    });
}

/** #1365: a loopback port with nothing listening — connection refused until
 *  the caller binds it, modelling a transiently unreachable attach target. */
async function reserveLoopbackPort(): Promise<number> {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
}

type RegisteredTool = {
    name: string;
    description?: string;
    parameters: unknown;
    output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
    execute: (args: Record<string, unknown>, exec: { agent?: { session?: { id?: unknown } }; signal?: AbortSignal }) => Promise<unknown>;
};

// #1785: poll budget raised 5s→15s so a loaded dev host clears a loopback round-trip (fast CI is sub-second).
const POLL_DEADLINE_MS = 15000;

/** Poll until cond() holds (10ms ticks, POLL_DEADLINE_MS cap) — a fixed sleep
 *  races on slow runners (a loopback fetch can outlast tens of ms). */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (!cond()) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
    }
}

function mockCtx() {
    const tools: RegisteredTool[] = [];
    // #1677: handlers may receive the host-passed invocation (carrying the invoking
    // agent's session id); tests call them with or without it to cover both paths.
    type CmdInvocation = { agent?: { session?: { id?: unknown } } };
    const commands: Array<{ name: string; handler: (invocation?: CmdInvocation) => Promise<{ kind: string; text: string }> }> = [];
    // #2381: the initiator's session may carry the dsh-session requestHeader()
    // surface (the EpochHeader of the request being fetched); mocks omit it to
    // model older hosts and set it to drive session-scoped model targeting.
    let initiator: { session?: { id?: unknown; requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined } } | undefined = undefined;
    // #955 runtime-info sources: tests can attach llm/agentDefaultModel and
    // replay them through the same dynamic ctx.inject path production uses.
    let llm: { resolveModelInfo?: (provider: string, model: string) => Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number } | undefined> } | undefined = undefined;
    let agentDefaultModel: { currentSelection?: () => { provider?: string; model?: string } | undefined } | undefined = undefined;
    // #1772 profile diagnostics: replayed through the same dynamic inject path.
    let profileContext: { startedBundles?: readonly string[] } | undefined = undefined;
    // #2604: host-title channel fakes — session store + folded-title source,
    // replayed through the same dynamic ctx.inject path production uses.
    let dshSessions: Map<string, { id: string }> | undefined = undefined;
    let dshTitleFold: ((id: string) => string | undefined) | undefined = undefined;
    type HostCtx = Parameters<typeof apply>[0];
    type HostListener = Parameters<NonNullable<PluginContext["on"]>>[1];
    const listeners: Record<string, HostListener[]> = {};
    // #3354/#3662: capture registration event order + provided services
    // (the overlay itself now lives in the always-on gate entry).
    const order: string[] = [];
    const providedServices: Array<{ name: string; value: unknown }> = [];
    // Stable service identities (like real cordis services: one facade per
    // process whose state mutates underneath); getters gate exposure on the
    // backing fakes so T4's no-services degradation still reads absent.
    const sessionsService: NonNullable<PluginContext["sessions"]> = {
        get: (id: string) => dshSessions?.get(id),
        list: () => (dshSessions === undefined ? [] : [...dshSessions.values()]),
    };
    const titleService: NonNullable<PluginContext["sessionTitle"]> = {
        get: (session: unknown) => {
            const fold = dshTitleFold;
            if (fold === undefined) return undefined;
            const s = session as { id?: unknown };
            const t = typeof s.id === "string" ? fold(s.id) : undefined;
            return t === undefined ? undefined : { title: t };
        },
    };
    return {
        tools: { register: (t: RegisteredTool) => tools.push(t) },
        commands: { register: (c: { name: string; handler: (invocation?: { agent?: { session?: { id?: unknown } } }) => Promise<{ kind: string; text: string }> }) => commands.push(c) },
        agents: { currentInitiator: () => initiator },
        setInitiator: (i: { session?: { id?: unknown; requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined } } | undefined) => (initiator = i),
        registeredTools: tools,
        registeredCommands: commands,
        on: (event: string, listener: HostListener, _options?: { global?: boolean }) => {
            order.push(`on:${event}`);
            (listeners[event] ??= []).push(listener);
        },
        emit: (event: string, ...args: unknown[]) => { for (const l of listeners[event] ?? []) (l as (...a: unknown[]) => void)(...args); },
        get sessions(): PluginContext["sessions"] { return dshSessions !== undefined ? sessionsService : undefined; },
        get sessionTitle(): PluginContext["sessionTitle"] { return dshTitleFold !== undefined ? titleService : undefined; },
        setDshSessions: (store: Map<string, { id: string }> | undefined, fold: ((id: string) => string | undefined) | undefined) => {
            dshSessions = store;
            dshTitleFold = fold;
        },
        inject: (deps: readonly string[], callback: (sub: HostCtx) => void) => {
            if (deps.includes("llm") && deps.includes("agentDefaultModel") && llm !== undefined && agentDefaultModel !== undefined) {
                callback({ llm, agentDefaultModel } as HostCtx);
            }
            if (deps.includes("profileContext") && profileContext !== undefined) {
                callback({ profileContext } as HostCtx);
            }
            if (deps.includes("sessions") || deps.includes("sessionTitle")) {
                if (dshSessions !== undefined || dshTitleFold !== undefined) {
                    const sub: Partial<HostCtx> = {};
                    if (dshSessions !== undefined) sub.sessions = sessionsService;
                    if (dshTitleFold !== undefined) sub.sessionTitle = titleService;
                    callback(sub as HostCtx);
                }
            }
        },
        setModelServices: (l: typeof llm, a: typeof agentDefaultModel) => {
            llm = l;
            agentDefaultModel = a;
        },
        setProfileContext: (pc: { startedBundles?: readonly string[] } | undefined) => (profileContext = pc),
        reflect: { provide: (name: string, value: unknown) => { order.push(`provide:${name}`); providedServices.push({ name, value }); } },
        providedServices,
        registrationOrder: () => [...order],
    };
}

test("apply() attach mode: registers manifest tools verbatim, gates headers, forwards with the session id", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-apply-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            // under node:test the fetch patch is deliberately NOT installed
            assert.equal(ctx.registeredCommands.length, 2);
            assert.equal(ctx.registeredCommands[0].name, "acp");
            assert.equal(ctx.registeredCommands[1].name, "acp-cache");

            // headers gate on toolsReady — no session, no headers; and before
            // registration completes nothing is stamped
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (ctx)");
            const tool = ctx.registeredTools[0];
            assert.equal(tool.name, "compress");
            // parameters pass through verbatim (the manifest's JSON Schema)
            assert.deepEqual(tool.parameters, {
                type: "object",
                properties: { summary: { type: "string" }, range: { type: "string" } },
                required: ["summary"],
            });
            assert.deepEqual(tool.output.schema, { type: "string" });

            // execute forwards with the owning agent's session id
            const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
            const proxy2 = { origin: "", close: () => {} };
            void proxy2;
            // direct execute path (fresh proxy capturing calls):
            const cap = await startMockProxy(calls);
            try {
                _resetRegisterForTest(cap.origin);
                process.env.BILLION_CONTEXT_PROXY = cap.origin;
                const ctx2 = mockCtx();
                apply(ctx2);
                await waitFor(() => ctx2.registeredTools.length === 1, "manifest tool registration (ctx2)");
                const t2 = ctx2.registeredTools[0];
                const out = await t2.execute({ summary: "s" }, { agent: { session: { id: "session-7" } } });
                assert.equal(out, "compressed 42 tokens");
                assert.deepEqual(calls, [{ conversationId: "session-7", tool: "compress", args: { summary: "s" }, nativeCaller: true }]);
                // agentless execution fails loudly
                await assert.rejects(() => t2.execute({ summary: "s" }, {}), /requires an owning agent session/);
            } finally {
                cap.close();
                _resetRegisterForTest(proxy.origin);
                process.env.BILLION_CONTEXT_PROXY = proxy.origin;
            }

            // /acp prefers the initiator's session, falls back to latest
            ctx.setInitiator({ session: { id: "session-7" } });
            const ok = await ctx.registeredCommands[0].handler();
            assert.equal(ok.kind, "success");
            assert.ok(ok.text.includes("PANEL-OK") || ok.text.includes("billion-context@"));
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

// #3616: a superseded world's verify flight must not land its writes on top of
// the new one — pre-fix, a late healthy-attach probe reverted register.base to
// the stale origin and tool calls followed it there (windows-22 CI: the call
// was answered by the previous test's still-alive mock). The held manifest
// keeps world 1's probe IN FLIGHT across the reset deterministically.
test("#3616 apply() attach mode: a superseded verify landing must not revert the registered origin", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-gen-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            _resetRoutedForTest();
            const callsA: Array<{ conversationId: string; tool: string; args: unknown }> = [];
            let releaseManifest: (() => void) | undefined;
            const manifestGate = new Promise<void>((resolve) => {
                releaseManifest = resolve;
            });
            const proxyA = await startMockProxy(callsA, undefined, undefined, undefined, false, undefined, () => manifestGate);
            try {
                process.env.BILLION_CONTEXT_PROXY = proxyA.origin;
                _resetRegisterForTest(proxyA.origin);
                const ctx1 = mockCtx();
                apply(ctx1);
                // World 1's verify probe is now IN FLIGHT against the held
                // manifest — do NOT wait for ctx1's registration; the held
                // response suspends the whole first-world recovery across the
                // reset below.
                const callsB: Array<{ conversationId: string; tool: string; args: unknown }> = [];
                const proxyB = await startMockProxy(callsB);
                try {
                    _resetRegisterForTest(proxyB.origin);
                    process.env.BILLION_CONTEXT_PROXY = proxyB.origin;
                    const ctx2 = mockCtx();
                    apply(ctx2);
                    await waitFor(() => ctx2.registeredTools.length === 1, "manifest tool registration (ctx2)");
                    const t2 = ctx2.registeredTools[0];

                    // Release A's held manifest: world 1's verify flight lands
                    // NOW, long after world 2 owns the register. Pre-fix it
                    // reverts register.base back to A and the call below
                    // follows it there.
                    releaseManifest?.();
                    await _settleNativeForTest();

                    const out = await t2.execute({ summary: "s" }, { agent: { session: { id: "session-7" } } });
                    assert.equal(out, "compressed 42 tokens");
                    assert.deepEqual(callsB, [{ conversationId: "session-7", tool: "compress", args: { summary: "s" }, nativeCaller: true }]);
                    assert.deepEqual(callsA, [], "nothing may have gone to the superseded mock");
                } finally {
                    proxyB.close();
                }
            } finally {
                releaseManifest?.();
                proxyA.close();
            }
            _resetRegisterForTest(undefined);
        });
    } finally {
        rmrf(home);
    }
});

// #3616 (maybeRetry self-heal): the base-less respawn flight has the same
// supersession rule as bootstrap()'s own guard — pre-fix its .then wrote
// register.base/state.origin unconditionally, so a flight started in world A
// that landed after a re-activation (world B) bound the STALE origin onto the
// new world's register, exactly the bypass #3616 closed everywhere else.
test("#3616 maybeRetry self-heal: a superseded respawn flight must not bind its stale origin", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-selfheal-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined, BILI_DSH_RECOVERY_INTERVAL_MS: "5", BILI_PROVIDER_REWRITES: undefined, BILLION_CONTEXT_PLUGIN: undefined, BILI_NATIVE_DSH: undefined, BILI_MITM_HOSTS: undefined }, async () => {
            _resetRegisterForTest(undefined);
            let started = false;
            let release: (() => void) | undefined;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            _setSpawnForTest(() => {
                started = true;
                return gate.then(() => "http://stale-origin:1");
            });
            try {
                const ctx1 = mockCtx();
                apply(ctx1);
                // World A is base-less: the recovery timer's first tick arms the
                // self-heal respawn (our stub) and leaves it IN FLIGHT on the gate.
                await waitFor(() => started, "self-heal respawn flight started");
                // World switch: a re-activation bumps originGen and owns the
                // register with a fresh base.
                _resetRegisterForTest("http://new-origin:1");
                release?.();
                await _settleNativeForTest();
                // The stale flight landed AFTER the switch — it must write
                // nothing. Pre-fix register.base reverted to http://stale-origin:1.
                assert.equal(_registerStateForTest().base, "http://new-origin:1");
            } finally {
                release?.();
                _setSpawnForTest(undefined);
                _resetRegisterForTest(undefined);
            }
        });
    } finally {
        rmrf(home);
    }
});

test("apply() /acp-cache (#1146): forwards acp_cache bound to the initiator session, falls back to latest", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-cache-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
            const cap = await startMockProxy(calls, (url) =>
                url.includes("fallback=latest") ? { ok: true, conversationId: "conv-latest", panel: "PANEL-OK" } : undefined);
            try {
                _resetRegisterForTest(cap.origin);
                process.env.BILLION_CONTEXT_PROXY = cap.origin;
                const ctx = mockCtx();
                apply(ctx);
                const cacheCmd = ctx.registeredCommands.find((c) => c.name === "acp-cache");
                assert.ok(cacheCmd, "acp-cache registered");

                ctx.setInitiator({ session: { id: "session-9" } });
                const bound = await cacheCmd.handler();
                assert.equal(bound.kind, "success");
                assert.deepEqual(calls, [{ conversationId: "session-9", tool: "acp_cache", args: {}, nativeCaller: true }]);

                ctx.setInitiator(undefined);
                calls.length = 0;
                const latest = await cacheCmd.handler();
                assert.equal(latest.kind, "success");
                assert.deepEqual(calls, [{ conversationId: "conv-latest", tool: "acp_cache", args: {}, nativeCaller: true }]);
                // #1791: settle the attach chain while the mock is still open
                await _stateToolsReadyForTest();
            } finally {
                cap.close();
                _resetRegisterForTest(undefined);
            }
        });
    } finally {
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

// #1677: the command executor hands the invoking agent to the handler via the
// invocation; the command path carries NO AsyncLocalStorage attribution, so the
// old code always fell back to fetchStatusLatest and showed ANOTHER session's panel.
test("apply() /acp (#1677): resolves the invoking agent's session id from the host-passed invocation, not latest", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1677-acp-"));
    const statusUrls: string[] = [];
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            const cap = await startMockProxy([], (url) => {
                statusUrls.push(url);
                if (url.includes("conversationId=session-inv")) return { ok: true, conversationId: "session-inv", panel: "PANEL-SPECIFIC" };
                if (url.includes("fallback=latest")) return { ok: true, conversationId: "conv-latest", panel: "PANEL-LATEST" };
                return undefined;
            });
            try {
                _resetRegisterForTest(cap.origin);
                process.env.BILLION_CONTEXT_PROXY = cap.origin;
                const ctx = mockCtx();
                apply(ctx);
                const acpCmd = ctx.registeredCommands.find((c) => c.name === "acp");
                assert.ok(acpCmd, "acp registered");

                // NO initiator set — only the invocation carries the session id
                const out = await acpCmd.handler({ agent: { session: { id: "session-inv" } } });
                assert.equal(out.kind, "success");
                assert.ok(out.text.includes("PANEL-SPECIFIC"), `expected the invoking session's panel, got: ${out.text}`);
                assert.ok(!out.text.includes("PANEL-LATEST"), "must not fall back to the latest session");
                assert.ok(!out.text.includes("not known to the proxy"), "a resolvable session must not be annotated");
                assert.ok(statusUrls.some((u) => u.includes("conversationId=session-inv")), "status was queried for the invoking session");
                assert.ok(!statusUrls.some((u) => u.includes("fallback=latest")), "no latest-fallback query for a resolvable session");
                // #1791: settle the attach chain while the mock is still open
                await _stateToolsReadyForTest();
            } finally {
                cap.close();
                _resetRegisterForTest(undefined);
            }
        });
    } finally {
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("apply() /acp-cache (#1677): binds acp_cache to the invoking agent's session id from the invocation", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1677-cache-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
            const cap = await startMockProxy(calls, (url) =>
                url.includes("fallback=latest") ? { ok: true, conversationId: "conv-latest", panel: "PANEL-OK" } : undefined);
            try {
                _resetRegisterForTest(cap.origin);
                process.env.BILLION_CONTEXT_PROXY = cap.origin;
                const ctx = mockCtx();
                apply(ctx);
                const cacheCmd = ctx.registeredCommands.find((c) => c.name === "acp-cache");
                assert.ok(cacheCmd, "acp-cache registered");

                // NO initiator set — only the invocation carries the session id
                const out = await cacheCmd.handler({ agent: { session: { id: "session-inv" } } });
                assert.equal(out.kind, "success");
                assert.deepEqual(calls, [{ conversationId: "session-inv", tool: "acp_cache", args: {}, nativeCaller: true }]);
                assert.ok(!out.text.includes("not known to the proxy"), "a resolvable session must not be annotated");
                // #1791: settle the attach chain while the mock is still open
                await _stateToolsReadyForTest();
            } finally {
                cap.close();
                _resetRegisterForTest(undefined);
            }
        });
    } finally {
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("apply() /acp (#1677): invocation wins over ALS attribution; unresolvable sessions are annotated, never silent", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1677-prio-"));
    const statusUrls: string[] = [];
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            const cap = await startMockProxy([], (url) => {
                statusUrls.push(url);
                if (url.includes("conversationId=session-inv")) return { ok: true, conversationId: "session-inv", panel: "PANEL-INVOKE" };
                if (url.includes("conversationId=session-init")) return { ok: true, conversationId: "session-init", panel: "PANEL-INIT" };
                if (url.includes("fallback=latest")) return { ok: true, conversationId: "conv-latest", panel: "PANEL-LATEST" };
                return undefined;
            });
            try {
                _resetRegisterForTest(cap.origin);
                process.env.BILLION_CONTEXT_PROXY = cap.origin;
                const ctx = mockCtx();
                apply(ctx);
                const acpCmd = ctx.registeredCommands.find((c) => c.name === "acp");
                assert.ok(acpCmd, "acp registered");

                // (a) both present → the invocation's session wins over ALS attribution
                ctx.setInitiator({ session: { id: "session-init" } });
                statusUrls.length = 0;
                const win = await acpCmd.handler({ agent: { session: { id: "session-inv" } } });
                assert.equal(win.kind, "success");
                assert.ok(win.text.includes("PANEL-INVOKE"), "invocation session must take priority over ALS attribution");
                assert.ok(statusUrls.some((u) => u.includes("conversationId=session-inv")));
                assert.ok(!statusUrls.some((u) => u.includes("conversationId=session-init")), "ALS session must not be queried when an invocation is present");

                // (b) requested session unknown to the proxy → falls back to latest AND names both sessions
                ctx.setInitiator(undefined);
                statusUrls.length = 0;
                const ghost = await acpCmd.handler({ agent: { session: { id: "session-ghost" } } });
                assert.equal(ghost.kind, "success");
                assert.ok(ghost.text.includes("PANEL-LATEST"), "unknown session falls back to the latest-active panel");
                assert.ok(ghost.text.includes("session-ghost") && ghost.text.includes("conv-latest"), "the fallback note names the requested and the shown session");
                assert.ok(ghost.text.includes("not known to the proxy"), "unknown-session fallback is explicitly flagged");
                assert.ok(statusUrls.some((u) => u.includes("fallback=latest")), "unknown session triggers the latest-fallback query");

                // (c) no session at all (no invocation, no ALS) → latest fallback, flagged as unidentified
                statusUrls.length = 0;
                const none = await acpCmd.handler();
                assert.equal(none.kind, "success");
                assert.ok(none.text.includes("PANEL-LATEST"));
                assert.ok(none.text.includes("could not identify the current session"), "no-session fallback is explicitly flagged");
                // #1791: settle the attach chain while the mock is still open
                await _stateToolsReadyForTest();
            } finally {
                cap.close();
                _resetRegisterForTest(undefined);
            }
        });
    } finally {
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("apply() /acp-cache (#1146): unreachable proxy reports an error", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-cache-down-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: undefined }, async () => {
            // healthy attach first (so register.base is set), then kill the
            // proxy before the handler runs — a dead preset would instead
            // trigger the #983 spawn fallback, which this test does not want
            const proxy = await startMockProxy([]);
            try {
                _resetRegisterForTest(proxy.origin);
                process.env.BILLION_CONTEXT_PROXY = proxy.origin;
                const ctx = mockCtx();
                apply(ctx);
                await waitFor(() => ctx.registeredTools.length === 1, "tool registration");
                const cacheCmd = ctx.registeredCommands.find((c) => c.name === "acp-cache");
                assert.ok(cacheCmd, "acp-cache registered");
                proxy.close();
                const out = await cacheCmd.handler();
                assert.equal(out.kind, "error");
                assert.match(out.text, /proxy not reachable/);
            } finally {
                _resetRegisterForTest(undefined);
            }
        });
    } finally {
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("apply() inactive-context registration failure is silent and terminal (dsh 0.1.5+ teardown)", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-inactive-"));
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
    };
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            // simulate cordis teardown: the plugin context is inactive, so
            // every service access rejects with cordis's inactive-context error
            const inactive = new Error('cannot get required service "tools" in inactive context');
            ctx.tools.register = () => {
                throw inactive;
            };
            apply(ctx);
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(ctx.registeredTools.length, 0);
            // teardown noise is suppressed — no retry log, no wire-mode warning
            assert.equal(errors.length, 0);
            // a later nudge (headersFor) must not resurrect retries either
            const stamp = _stateHeadersForTest();
            stamp?.("http://example.test/v1/messages");
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(ctx.registeredTools.length, 0);
            assert.equal(errors.length, 0);
        });
    } finally {
        console.error = origErr;
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("apply() is a no-op under the kill switches", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-off-"));
    try {
        _resetDshCompactionVerdictForTest();
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PLUGIN: "0" }, () => {
            _resetRegisterForTest(undefined);
            const ctx = mockCtx();
            apply(ctx);
            assert.equal(ctx.registeredTools.length, 0);
            assert.equal(ctx.registeredCommands.length, 0);
            // #3354/#3662: a kill-switched bili must neither register the
            // overlay nor declare the lane owned — the gate entry then leaves
            // every preset row stock while its service keeps them bootable.
            assert.ok(!ctx.registrationOrder().some((e) => e.startsWith("on:internal/config")));
            assert.equal(ctx.providedServices.length, 0);
            assert.ok(!isDshCompactionActive(), "kill switch must not declare the lane owned");
        });
    } finally {
        rmrf(home);
        _resetDshCompactionVerdictForTest();
    }
});

test("#1772 apply(): web-profile compaction caveat warns once in the durable log", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-webwarn-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-webwarn-state-"));
    const logFile = path.join(stateHome, "billion-context", "bili.log");
    // #3651: two durable notes now mention dsh-web-app — the web-profile note
    // ("stays OFF in this profile") and the non-web-profile trace ("do not
    // include …"). Disambiguate on their unique phrases, not the package name.
    const clientLines = (phrase: string): string[] => fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("[dsh-client]") && l.includes(phrase))
        : [];
    const warnLines = (): string[] => clientLines("stays OFF in this profile");
    const nonWebTraceLines = (): string[] => clientLines("do not include @deepseek-ai/dsh-web-app");
    const webBundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "billion-context"];
    // #1791: hermetic fallback seam — a deferred probe must never reach a real
    // bootstrap child process after teardown; undefined keeps it base-less.
    _setSpawnForTest(async () => undefined);
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome, BILI_PROVIDER_REWRITES: undefined, BILI_NATIVE_DSH: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetWebProfileWarningForTest();
            const ctx = mockCtx();
            ctx.setProfileContext({ startedBundles: webBundles });
            apply(ctx);
            assert.equal(warnLines().length, 1);
            assert.match(warnLines()[0], /#1772/);
            // #3354: the note now states bili disables the preset rows at load
            // time (vendored overlay, attribution preserved) and keeps the
            // #2474 full-snapshot recipe as the documented fallback — pin both
            // pointers so either regression is caught.
            assert.match(warnLines()[0], /#3354/);
            assert.match(warnLines()[0], /deshark42\/dsh-compaction-basic-disable/);
            assert.match(warnLines()[0], /#2474/);
            assert.match(warnLines()[0], /cordis\.patch\.yml/);
            // #1791: settle each apply's attach chain while the mock is still
            // open — a deferred probe settling against a closed mock runs the
            // spawn fallback mid-way through a LATER test and clobbers the
            // shared register/state (#1117 pollution class, reds in #956/#983).
            await _stateToolsReadyForTest();

            // once-per-process: a later apply with the same profile adds nothing
            const again = mockCtx();
            again.setProfileContext({ startedBundles: webBundles });
            _resetRegisterForTest(proxy.origin);
            apply(again);
            assert.equal(warnLines().length, 1);
            await _stateToolsReadyForTest();

            // non-web profile → no web-profile note, but ONE durable trace that
            // the #3354 overlay registered anyway (#3651 observability gap)
            fs.rmSync(logFile, { force: true });
            _resetRegisterForTest(proxy.origin);
            _resetWebProfileWarningForTest();
            _resetNonWebTraceForTest();
            const plain = mockCtx();
            plain.setProfileContext({ startedBundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "billion-context"] });
            apply(plain);
            assert.equal(warnLines().length, 0);
            assert.equal(nonWebTraceLines().length, 1);
            assert.match(nonWebTraceLines()[0], /#3354/);
            assert.match(nonWebTraceLines()[0], /#2474/);
            await _stateToolsReadyForTest();

            // once-per-process: a later non-web apply adds no further trace
            const plainAgain = mockCtx();
            plainAgain.setProfileContext({ startedBundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "billion-context"] });
            _resetRegisterForTest(proxy.origin);
            apply(plainAgain);
            assert.equal(nonWebTraceLines().length, 1);
            await _stateToolsReadyForTest();

            // host shape without inject but with a direct profileContext field.
            // #3806: the web-profile note only prints when the overlay can latch
            // (cordis on/reflect present) — supply the minimal hooks so this case
            // still exercises the non-inject bundles path against the passive note
            // (a hook-less host gets the #3806 ARMED alarm instead; see that test).
            _resetWebProfileWarningForTest();
            const bare: Parameters<typeof apply>[0] = {
                tools: { register: () => undefined },
                commands: { register: () => undefined },
                agents: {},
                on: () => undefined,
                reflect: { provide: () => undefined },
                profileContext: { startedBundles: ["@deepseek-ai/dsh-web-app"] },
            };
            _resetRegisterForTest(proxy.origin);
            apply(bare);
            assert.equal(warnLines().length, 1);
            await _stateToolsReadyForTest();
        });
    } finally {
        _setSpawnForTest(undefined);
        proxy.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
        _resetWebProfileWarningForTest();
        _resetNonWebTraceForTest();
    }
});

test("#3806 apply(): a degraded web profile alarms loudly instead of the silent fail-safe note", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-cd-gap-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-cd-gap-state-"));
    const logFile = path.join(stateHome, "billion-context", "bili.log");
    const clientLines = (): string[] => fs.existsSync(logFile)
        ? fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("[dsh-client]"))
        : [];
    _setSpawnForTest(async () => undefined);
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome, BILI_PROVIDER_REWRITES: undefined, BILI_NATIVE_DSH: undefined, BILLION_CONTEXT_PLUGIN: undefined }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetWebProfileWarningForTest();
            const bare: Parameters<typeof apply>[0] = {
                tools: { register: () => undefined },
                commands: { register: () => undefined },
                agents: {},
                profileContext: { startedBundles: ["@deepseek-ai/dsh-web-app"] },
            };
            apply(bare);
            const lines = clientLines();
            assert.equal(lines.length, 1);
            assert.match(lines[0], /@deepseek-ai\/dsh-web-app/);
            assert.match(lines[0], /could not latch/i);
            assert.match(lines[0], /no-config-hook/);
            assert.match(lines[0], /#2474/);
            assert.match(lines[0], /ARMED/i);
            assert.doesNotMatch(lines[0], /deshark42\/dsh-compaction-basic-disable/);
            await _stateToolsReadyForTest();
        });
    } finally {
        _setSpawnForTest(undefined);
        proxy.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
        _resetWebProfileWarningForTest();
    }
});

test("#3354/#3662 apply(): declares lane ownership instead of registering the overlay", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-cd-"));
    try {
        _resetDshCompactionVerdictForTest();
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            // #3662: the overlay + gate service moved to the always-on
            // bili-compaction-gate entry; bili-native only declares the verdict
            // that transform honors (tests/issue3662-dsh-gate-fallback.test.ts
            // pins the transform + service side).
            assert.ok(isDshCompactionActive(), "active plan must declare the lane owned");
            assert.ok(!ctx.registrationOrder().some((e) => e.startsWith("on:internal/config")));
            assert.equal(ctx.providedServices.length, 0);
            await _stateToolsReadyForTest();
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetDshCompactionVerdictForTest();
    }
});

test("apply() runtime-info (#955): model services stamp model/window/max-output headers", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-ri-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            ctx.setModelServices(
                {
                    resolveModelInfo: async (provider, model) => {
                        assert.equal(provider, "deepseek");
                        assert.equal(model, "qwen-ri");
                        return { context: { contextWindow: 262144 }, defaultMaxTokens: 32768 };
                    },
                },
                { currentSelection: () => ({ provider: "deepseek", model: "qwen-ri" }) },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (ri)");
            ctx.setInitiator({ session: { id: "session-ri" } });
            // First stamp may fire before the async resolveModelInfo lands —
            // poll until the window header shows up.
            await waitFor(() => {
                const headers = _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
                return headers?.["x-bili-plugin-context-window"] === "262144";
            }, "model-info refresh stamped headers");
            const headers = _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            assert.equal(headers?.["x-bili-plugin"], "dsh");
            assert.equal(headers?.["x-bili-plugin-conversation"], "session-ri");
            assert.equal(headers?.["x-bili-plugin-model"], "qwen-ri");
            assert.equal(headers?.["x-bili-plugin-context-window"], "262144");
            assert.equal(headers?.["x-bili-plugin-max-output"], "32768");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("apply() runtime-info (#956): a mid-resolve model switch discards the stale resolve", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-race-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            // mutable live selection: A at startup, switched to B mid-resolve
            let selection = { provider: "deepseek", model: "qwen-a" };
            type ModelInfoLike = { context?: { contextWindow?: number }; defaultMaxTokens?: number };
            let releaseA: ((v: ModelInfoLike) => void) | undefined;
            const gateA = new Promise<ModelInfoLike>((r) => {
                releaseA = r;
            });
            ctx.setModelServices(
                {
                    resolveModelInfo: async (_provider, model) =>
                        model === "qwen-a" ? gateA : { context: { contextWindow: 12345 }, defaultMaxTokens: 4096 },
                },
                { currentSelection: () => selection },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (race)");
            ctx.setInitiator({ session: { id: "session-race" } });
            const stamp = () => _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            // apply()'s inject already started A's async resolve (gated, in flight)
            assert.equal(stamp()?.["x-bili-plugin-context-window"], undefined);
            // switch the LIVE selection to B while A is still resolving
            selection = { provider: "deepseek", model: "qwen-b" };
            releaseA?.({ context: { contextWindow: 999999 }, defaultMaxTokens: 8888 });
            await new Promise((r) => setTimeout(r, 20));
            // the stale A result must NOT have been committed or stamped
            assert.equal(stamp()?.["x-bili-plugin-context-window"], undefined);
            assert.notEqual(stamp()?.["x-bili-plugin-model"], "qwen-a");
            // self-heal: the next refresh re-resolves the LIVE selection (B)
            await waitFor(() => stamp()?.["x-bili-plugin-context-window"] === "12345", "post-switch re-resolve stamped B");
            assert.equal(stamp()?.["x-bili-plugin-model"], "qwen-b");
            assert.equal(stamp()?.["x-bili-plugin-max-output"], "4096");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("apply() runtime-info (#1812): a failed window resolve retries after the cooldown instead of latching headerless", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-retry-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, BILI_MODEL_INFO_RETRY_MS: "1" }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            // boot race: the first two resolves fail (catalog still loading);
            // pre-#1812 the failure-shaped cache latched and the process never
            // sent x-bili-plugin-context-window again
            let attempts = 0;
            ctx.setModelServices(
                {
                    resolveModelInfo: async () => {
                        attempts += 1;
                        if (attempts <= 2) throw new Error("catalog not ready");
                        return { context: { contextWindow: 262144 }, defaultMaxTokens: 32768 };
                    },
                },
                { currentSelection: () => ({ provider: "deepseek", model: "qwen-ri" }) },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (retry)");
            ctx.setInitiator({ session: { id: "session-retry" } });
            const stamp = () => _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            // the failed resolve cached {provider, model}: model id still stamped, window absent
            await waitFor(() => stamp()?.["x-bili-plugin-model"] === "qwen-ri", "failure-shaped cache stamped the model id");
            assert.equal(stamp()?.["x-bili-plugin-context-window"], undefined);
            // each further request drives headersFor → refreshModelInfo; the
            // cooldown (1ms here) expires and a retry commits the window
            await waitFor(() => stamp()?.["x-bili-plugin-context-window"] === "262144", "retry after cooldown recovered the window header");
            assert.equal(stamp()?.["x-bili-plugin-max-output"], "32768");
            assert.ok(attempts >= 3, `the resolver was retried past its failures (attempts=${attempts})`);
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});


// #1942: the host's llm service is a class instance, so resolveModelInfo
// needs its receiver. Called detached (pre-fix) every resolve threw
// "Cannot read properties of undefined (reading 'resolveModelInfoFor')"
// and the process never stamped x-bili-plugin-context-window. A plain
// object stub cannot catch this: it does not depend on 	his.
test("apply() runtime-info (#1942): binds resolveModelInfo to its service receiver, so a class-shaped llm service still stamps the window header", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-bind-"));
    let detached: string | undefined = undefined;
    // Shaped like dsh-llm: resolveModelInfo reaches its own state through
    // 	his, so a detached call throws instead of silently working.
    class LlmService {
        async resolveModelInfo(): Promise<{ context?: { contextWindow?: number }; defaultMaxTokens?: number }> {
            try {
                return { context: { contextWindow: this.capacity() }, defaultMaxTokens: 32768 };
            } catch (err) {
                detached = err instanceof Error ? err.message : String(err);
                throw err;
            }
        }
        private capacity(): number {
            return 1_000_000;
        }
    }
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, BILI_MODEL_INFO_RETRY_MS: "1" }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            ctx.setModelServices(new LlmService(), { currentSelection: () => ({ provider: "workbuddy", model: "space-bunny" }) });
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (bind)");
            ctx.setInitiator({ session: { id: "session-bind" } });
            const stamp = () => _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            // the model id is stamped either way (the failure-shaped cache keeps
            // it), so wait on whichever outcome lands first and then assert the
            // receiver survived
            await waitFor(() => stamp()?.["x-bili-plugin-model"] === "space-bunny" || detached !== undefined, "the window resolve settled");
            assert.equal(detached, undefined, `resolveModelInfo lost its service receiver: ${String(detached)}`);
            await waitFor(() => stamp()?.["x-bili-plugin-context-window"] === "1000000", "bound resolve stamped the context-window header");
            assert.equal(stamp()?.["x-bili-plugin-model"], "space-bunny");
            assert.equal(stamp()?.["x-bili-plugin-max-output"], "32768");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

// #2381: the stamped model/window must follow the SESSION's actual routing,
// not the host's GLOBAL default selection. Pre-fix, a session on a non-default
// model stamped the default model's name + window; the proxy's exact-match
// gate then discarded the whole header channel and the session sized itself
// against the unconfigured fallback window. dsh-agent-loop writes each step's
// header into the session log before its fetch, so requestHeader() at fetch
// time IS this request's routing.
test("apply() runtime-info (#2381): stamps the session's own model/window from its live request header, not the global default", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-sess-model-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            const resolved: Array<{ provider: string; model: string }> = [];
            ctx.setModelServices(
                {
                    resolveModelInfo: async (provider, model) => {
                        resolved.push({ provider, model });
                        if (model === "swift-local") return { context: { contextWindow: 240000 }, defaultMaxTokens: 4096 };
                        return { context: { contextWindow: 111111 }, defaultMaxTokens: 8192 };
                    },
                },
                { currentSelection: () => ({ provider: "deepseek", model: "global-default" }) },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (sess-model)");
            // the session routes to a DIFFERENT model than the global default
            ctx.setInitiator({
                session: {
                    id: "session-sess-model",
                    requestHeader: () => ({ config: { provider: "local", model: "swift-local" } }),
                },
            });
            const stamp = () => _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            await waitFor(() => stamp()?.["x-bili-plugin-context-window"] === "240000", "the session model's window was stamped");
            const headers = stamp();
            assert.notEqual(headers, undefined);
            assert.equal(headers?.["x-bili-plugin-conversation"], "session-sess-model");
            assert.equal(headers?.["x-bili-plugin-model"], "swift-local");
            assert.equal(headers?.["x-bili-plugin-context-window"], "240000");
            assert.equal(headers?.["x-bili-plugin-max-output"], "4096");
            assert.ok(resolved.some((r) => r.provider === "local" && r.model === "swift-local"), "the SESSION model was resolved");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("apply() runtime-info (#2381): per-key cache — switching sessions re-stamps each model's own numbers without re-resolving", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-perkey-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            let callsA = 0;
            let callsB = 0;
            ctx.setModelServices(
                {
                    resolveModelInfo: async (_provider, model) => {
                        if (model === "swift-a") {
                            callsA += 1;
                            return { context: { contextWindow: 111111 } };
                        }
                        callsB += 1;
                        return { context: { contextWindow: 222222 }, defaultMaxTokens: 2048 };
                    },
                },
                { currentSelection: () => ({ provider: "deepseek", model: "global-default" }) },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (perkey)");
            const stamp = () => _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            ctx.setInitiator({ session: { id: "sess-a", requestHeader: () => ({ config: { provider: "local", model: "swift-a" } }) } });
            await waitFor(() => stamp()?.["x-bili-plugin-context-window"] === "111111", "A's window stamped");
            assert.equal(stamp()?.["x-bili-plugin-model"], "swift-a");
            // switch to another session on another model — never A's numbers
            ctx.setInitiator({ session: { id: "sess-b", requestHeader: () => ({ config: { provider: "local", model: "swift-b" } }) } });
            await waitFor(() => stamp()?.["x-bili-plugin-context-window"] === "222222", "B's window stamped");
            assert.equal(stamp()?.["x-bili-plugin-model"], "swift-b");
            assert.equal(stamp()?.["x-bili-plugin-max-output"], "2048");
            assert.equal(stamp()?.["x-bili-plugin-conversation"], "sess-b");
            const aCalls = callsA;
            const bCalls = callsB;
            // back to A: re-stamped from its OWN cached key, not re-resolved
            ctx.setInitiator({ session: { id: "sess-a", requestHeader: () => ({ config: { provider: "local", model: "swift-a" } }) } });
            await new Promise((r) => setTimeout(r, 20));
            assert.equal(stamp()?.["x-bili-plugin-model"], "swift-a");
            assert.equal(stamp()?.["x-bili-plugin-context-window"], "111111");
            assert.equal(callsA, aCalls, "switching back did not re-resolve A");
            assert.equal(callsB, bCalls, "switching back did not re-resolve B");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("apply() runtime-info (#2381): a missing or throwing session requestHeader falls back to the global default selection", async () => {
    const proxy = await startMockProxy([]);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-fallback-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            ctx.setModelServices(
                {
                    resolveModelInfo: async () => ({ context: { contextWindow: 111111 }, defaultMaxTokens: 8192 }),
                },
                { currentSelection: () => ({ provider: "deepseek", model: "global-default" }) },
            );
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration (fallback)");
            const stamp = () => _stateHeadersForTest()?.("http://example.test/v1/chat/completions");
            // older host shape: session without requestHeader at all
            ctx.setInitiator({ session: { id: "sess-old" } });
            await waitFor(() => stamp()?.["x-bili-plugin-context-window"] === "111111", "the fallback stamped the global default's window");
            assert.equal(stamp()?.["x-bili-plugin-model"], "global-default");
            assert.equal(stamp()?.["x-bili-plugin-conversation"], "sess-old");
            // disposed/closing scope: requestHeader throws — same fallback, no crash
            ctx.setInitiator({ session: { id: "sess-throws", requestHeader: () => { throw new Error("disposed"); } } });
            assert.equal(stamp()?.["x-bili-plugin-model"], "global-default");
            assert.equal(stamp()?.["x-bili-plugin-context-window"], "111111");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("apply() /acp pre-first-request (#955): renders the runtime-table entry before any model request", async () => {
    const pre = {
        ok: true,
        conversationId: "dsh",
        phase: "pre-first-request",
        model: "qwen-ri",
        contextLimit: 262144,
        runtimeInfo: { agent: "dsh", model: "qwen-ri", contextWindow: 262144, maxOutput: 32768, source: "client-config" },
        panel: null,
    };
    // no initiator session → statusOutcome takes the fetchStatusLatest path
    // (conversationId=dsh&fallback=latest), which the proxy answers from the
    // agent-keyed runtime table pre-first-request
    const proxy = await startMockProxy([], (url) => (url.includes("conversationId=dsh&fallback=latest") ? pre : undefined));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-pre-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            assert.equal(ctx.registeredCommands.length, 2);
            const out = await ctx.registeredCommands[0].handler();
            assert.equal(out.kind, "success");
            assert.match(out.text, /model=qwen-ri/);
            assert.match(out.text, /window=262144/);
            assert.match(out.text, /maxOut=32768/);
            assert.match(out.text, /client-config/);
            // #1791: settle the attach chain while the mock is still open
            await _stateToolsReadyForTest();
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

// — #983: stale attach verification + spawn fallback + self-heal ——————————

test("#983 apply() attach mode: a dead preset falls back to a spawned proxy and unfreezes the env", async () => {
    const live = await startMockProxy([]);
    const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const forward = await startMockProxy(calls);
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return forward.origin;
    });
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
    };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-983a-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-983a-state-"));
    try {
        // port 1 on loopback: connection refused immediately — a stale preset
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: "http://127.0.0.1:1", XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest("http://127.0.0.1:1");
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "fallback tool registration");
            // the dead preset was replaced by the fallback-spawned origin…
            assert.equal(spawnCalls, 1);
            // …and the diagnostic lands in bili.log, off the terminal surface (#2831)
            const logContent = fs.readFileSync(path.join(stateHome, "billion-context", "bili.log"), "utf8");
            assert.match(logContent, /attach target http:\/\/127\.0\.0\.1:1 is not healthy — falling back to a spawned proxy/);
            assert.equal(errors.filter((e) => e.includes("not healthy")).length, 0, "#2831: must not reach the terminal surface");
            // …and the env is unfrozen so a later re-apply plans spawn, not attach
            assert.equal(process.env.BILLION_CONTEXT_PROXY, undefined);
            // tools are live against the fallback origin
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s983" } } });
            assert.equal(out, "compressed 42 tokens");
            assert.deepEqual(calls, [{ conversationId: "s983", tool: "compress", args: { summary: "s" }, nativeCaller: true }]);
        });
    } finally {
        console.error = origErr;
        _setSpawnForTest(undefined);
        live.close();
        forward.close();
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
    }
});

test("#983 apply() attach mode: a healthy preset attaches without any spawn", async () => {
    const proxy = await startMockProxy([]);
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return "http://127.0.0.1:1";
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-983b-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "attach tool registration");
            assert.equal(spawnCalls, 0);
            assert.equal(process.env.BILLION_CONTEXT_PROXY, proxy.origin);
        });
    } finally {
        _setSpawnForTest(undefined);
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#983 maybeRetry self-heals a base-less register after a failed respawn", async () => {
    const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const forward = await startMockProxy(calls);
    const answers: Array<string | undefined> = [undefined, forward.origin];
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return answers.shift();
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-983c-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: "http://127.0.0.1:1" }, async () => {
            _resetRegisterForTest("http://127.0.0.1:1");
            const ctx = mockCtx();
            apply(ctx);
            // first spawn attempt fails → fallback leaves the register base-less
            // (#1791: settle-based — once the stub call is observable the base-less
            // state has drained; a fixed sleep raced under load)
            await waitFor(() => spawnCalls >= 1, "initial failed respawn settled");
            const headersFor = _stateHeadersForTest();
            assert.ok(headersFor !== undefined, "headersFor installed");
            // a later model request drives maybeRetry → respawn (2nd answer) → tools recover
            headersFor("https://api.anthropic.com/v1/messages");
            await waitFor(() => ctx.registeredTools.length === 1, "self-healed tool registration");
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s983c" } } });
            assert.equal(out, "compressed 42 tokens");
            // once tools are ready the stamping path works again
            ctx.setInitiator({ session: { id: "s983c" } });
            headersFor("https://api.anthropic.com/v1/messages");
            // toolsReady is set asynchronously after registration; poll for the stamp
            await waitFor(() => headersFor("https://api.anthropic.com/v1/messages") !== undefined, "plugin headers stamped");
            assert.equal(headersFor("https://api.anthropic.com/v1/messages")?.["x-bili-plugin"], "dsh");
        });
    } finally {
        _setSpawnForTest(undefined);
        forward.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

// #1783: repro of the windows-22 CI deadlock — when the dead-preset probe is
// slow (windows loopback), headersFor#1 fires while register.base still holds
// the stale preset: registerTools burns a manifest fetch on it, and the apply
// chain's late landing (evidence grace + spawn) used to clobber the healed
// register and/or poison retryAt for a full 10s back-off. The landing guard +
// per-base back-off must keep the self-heal alive under any interleaving.
test("#983 slow preset probe: a late landing never clobbers the self-healed register (#1783)", async () => {
    const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const forward = await startMockProxy(calls);
    const answers: Array<string | undefined> = [undefined, forward.origin];
    _setSpawnForTest(async () => answers.shift());
    const realFetch = globalThis.fetch;
    // Emulate the windows runner: loopback fetches to the dead port-1 preset
    // take ~60ms instead of refusing instantly. node --test runs each file in
    // its own process, so a scoped globalThis.fetch swap is safe here.
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const u = typeof input === "string" ? input : String(input);
        if (u.includes("127.0.0.1:1")) {
            return new Promise<Response>((res, rej) => {
                setTimeout(() => { void realFetch(input, init).then(res, rej); }, 60);
            });
        }
        return realFetch(input, init);
    }) as typeof fetch;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1783-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: "http://127.0.0.1:1" }, async () => {
            _resetRegisterForTest("http://127.0.0.1:1");
            const ctx = mockCtx();
            apply(ctx);
            await new Promise((r) => setTimeout(r, 50));
            const headersFor = _stateHeadersForTest();
            headersFor!("https://api.anthropic.com/v1/messages");
            // Self-heal is request-driven in production: each poll below is a
            // "later model request" calling headersFor -> maybeRetry until the
            // unfrozen base-less register heals via the spawn seam.
            await waitFor(() => {
                headersFor!("https://api.anthropic.com/v1/messages");
                return ctx.registeredTools.length === 1;
            }, "self-healed tool registration");
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s1783" } } });
            assert.equal(out, "compressed 42 tokens");
            ctx.setInitiator({ session: { id: "s1783" } });
            await waitFor(() => headersFor!("https://api.anthropic.com/v1/messages") !== undefined, "plugin headers stamped");
        });
    } finally {
        globalThis.fetch = realFetch;
        _setSpawnForTest(undefined);
        forward.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

// #1783 second interleaving: the spawn seam itself is slow (windows process
// spawn), so registerTools fails against the stale preset and arms the 10s
// back-off BEFORE the landing's unfreeze wipe. The wipe must clear that
// back-off together with the stale base, or the first heal after unfreeze is
// still gated behind the wall.
test("#983 late spawn landing clears the back-off armed against the stale preset (#1783)", async () => {
    const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const forward = await startMockProxy(calls);
    const answers: Array<string | undefined> = [undefined, forward.origin];
    _setSpawnForTest(async () => {
        const answer = answers.shift();
        await new Promise((r) => setTimeout(r, 120));
        return answer;
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1783b-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: "http://127.0.0.1:1" }, async () => {
            _resetRegisterForTest("http://127.0.0.1:1");
            const ctx = mockCtx();
            apply(ctx);
            await new Promise((r) => setTimeout(r, 30));
            const headersFor = _stateHeadersForTest();
            await waitFor(() => {
                headersFor!("https://api.anthropic.com/v1/messages");
                return ctx.registeredTools.length === 1;
            }, "self-healed tool registration");
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s1783b" } } });
            assert.equal(out, "compressed 42 tokens");
            ctx.setInitiator({ session: { id: "s1783b" } });
            await waitFor(() => headersFor!("https://api.anthropic.com/v1/messages") !== undefined, "plugin headers stamped");
        });
    } finally {
        _setSpawnForTest(undefined);
        forward.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#1117 apply() installs takeoverGate keyed on currentInitiator attribution", async () => {
    const proxy = await startMockProxy([]);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1117-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1117-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            // Settle the async attach verification before teardown (#983
            // discipline): a deferred probe hitting a closed proxy would run
            // the fallback mid-way through a LATER apply() and clobber
            // state.origin / register.base / the preset env (sequence
            // pollution exposed when #1130's suites follow this one).
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            // unattributed (background chain, third-party in-process plugin) → NOT claimed
            assert.equal(gate("https://api.anthropic.com/v1/messages"), false);
            // attributed (the host's own agent chain) → claimed
            ctx.setInitiator({ session: { id: "s1117" } });
            assert.equal(gate("https://api.anthropic.com/v1/messages"), true);
        });
    } finally {
        proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#1158 apply() gate refusal logs each endpoint once per process with attribution state", async () => {
    const proxy = await startMockProxy([]);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1158-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1158-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            const origErr = console.error;
            const errs: string[] = [];
            console.error = (...args: unknown[]) => {
                errs.push(args.map(String).join(" "));
            };
            // #2831: refusal diagnostics live in bili.log now, off the terminal surface
            const logFile = path.join(stateHome, "billion-context", "bili.log");
            const refusedLines = (): string[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "").split("\n").filter((l) => l.length > 0 && l.includes("takeover gate refused"));
            try {
                const url = "https://api.gate-probe.test/v1/chat/completions";
                assert.equal(gate(url), false, "unattributed → refused");
                assert.equal(gate(url), false, "second refusal of the same endpoint");
                let lines = refusedLines();
                assert.equal(lines.length, 1, `expected one refusal line per endpoint, got: ${lines.join(" | ")}`);
                // #3651 paste-safe sink: non-public hosts are masked in the line; the dedup key
                // still uses the full URL, which the count assertions below verify.
                assert.match(lines[0]!, /https:\/\/<private-host>\/v1\/chat\/completions/);
                assert.match(lines[0]!, /no active initiator attribution/);
                // A query string neither spawns a new line nor leaks into it.
                assert.equal(gate(`${url}?key=sk-do-not-log`), false);
                assert.equal(refusedLines().length, 1);
                assert.ok(!fs.readFileSync(logFile, "utf8").includes("do-not-log"), "query string must not reach the log");
                // A different endpoint earns its own line.
                assert.equal(gate("https://api.other-probe.test/v1/messages"), false);
                assert.equal(refusedLines().length, 2);
                // Attributed traffic claims silently.
                ctx.setInitiator({ session: { id: "s1158" } });
                assert.equal(gate(url), true);
                assert.equal(refusedLines().length, 2);
                assert.equal(errs.filter((e) => e.includes("takeover gate refused")).length, 0, "#2831: must not reach the terminal surface");
            } finally {
                console.error = origErr;
            }
        });
    } finally {
        proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#1158 L2 gate three-state: thrown attribution is a distinct state; counts accumulate; transitions re-print (+bili.log)", async () => {
    const proxy = await startMockProxy([]);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1158e-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1158e-home-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            const origCI = ctx.agents.currentInitiator;
            const origErr = console.error;
            const errs: string[] = [];
            console.error = (...args: unknown[]) => {
                errs.push(args.map(String).join(" "));
            };
            // #2831: refusal diagnostics live in bili.log now, off the terminal surface
            const logFile = path.join(stateHome, "billion-context", "bili.log");
            const refusedLines = (): string[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "").split("\n").filter((l) => l.length > 0 && l.includes("takeover gate refused"));
            try {
                const url = "https://api.gate-l2.test/v1/chat/completions";
                // four same-state (none) refusals → exactly one line; counting continues silently
                assert.equal(gate(url), false);
                assert.equal(gate(url), false);
                assert.equal(gate(url), false);
                assert.equal(gate(url), false);
                let lines = refusedLines();
                assert.equal(lines.length, 1, `expected one line for repeated same-state refusals, got: ${lines.join(" | ")}`);
                assert.match(lines[0]!, /no active initiator attribution/);
                assert.match(lines[0]!, /refusals so far: 1$/);
                // the ALS boundary starts throwing (disposed/closing agent scope) →
                // new category → re-print carrying the accumulated count.
                // #2924: `threw` now goes through the bounded settle-retry
                // (async) before refusing — inject a fast cadence so the suite
                // does not wait wall-clock time, and await the verdict.
                ctx.agents.currentInitiator = () => {
                    throw new Error("agent initiator scope is disposed");
                };
                _setThrewRetryForTest({ attempts: 2, delayMs: 1 });
                assert.equal(await gate(url), false);
                lines = refusedLines();
                assert.equal(lines.length, 2, `expected a state-transition re-print, got: ${lines.join(" | ")}`);
                assert.match(lines[1]!, /currentInitiator\(\) threw \(agent initiator scope is disposed\)/);
                assert.match(lines[1]!, /refusals so far: 5 \(state none→threw\)$/);
                // further thrown refusals stay silent again
                assert.equal(await gate(url), false);
                assert.equal(refusedLines().length, 2);
                // back to plain none → transition the other way, count keeps running
                ctx.agents.currentInitiator = () => undefined;
                assert.equal(gate(url), false);
                lines = refusedLines();
                assert.equal(lines.length, 3);
                assert.match(lines[2]!, /refusals so far: 7 \(state threw→none\)$/);
                // attributed traffic claims silently — no line
                ctx.agents.currentInitiator = origCI;
                ctx.setInitiator({ session: { id: "s1158l2" } });
                assert.equal(gate(url), true);
                assert.equal(refusedLines().length, 3);
                // the durable copy carries the same lines into bili.log, [dsh-client]-marked
                const content = fs.readFileSync(logFile, "utf8");
                // #3651: the durable line masks non-public upstream hosts (paste-safe sink), loopback stays verbatim.
                assert.match(content, /\[warn\] \[v=[^\]]+\] \[dsh-client\] bili-native-dsh: model request sent DIRECT \(uncompressed\) — takeover gate refused https:\/\/<private-host>\/v1\/chat\/completions: currentInitiator\(\) threw \(agent initiator scope is disposed\) — agent scope disposed\/closing mid-request\? — refusals so far: 5 \(state none→threw\)$/m);
                assert.equal(errs.filter((e) => e.includes("takeover gate refused")).length, 0, "#2831: must not reach the terminal surface");
            } finally {
                console.error = origErr;
                _setThrewRetryForTest();
            }
        });
    } finally {
        proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#2924 gate `threw` attribution: bounded settle-retry recovers and CLAIMS the request", async () => {
    const proxy = await startMockProxy([]);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2924a-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2924a-home-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            _setThrewRetryForTest({ attempts: 3, delayMs: 1 });
            const logFile = path.join(stateHome, "billion-context", "bili.log");
            // The ALS boundary throws twice (disposed scope mid-request), then
            // settles — exactly the field-report shape: the request that would
            // have gone DIRECT (uncompressed) is CLAIMED after recovery.
            let throws = 0;
            ctx.agents.currentInitiator = () => {
                throws += 1;
                if (throws <= 2) throw new Error("agent initiator scope is disposed");
                return { session: { id: "s2924a" } };
            };
            assert.equal(await gate("https://api.gate-2924a.test/v1/chat/completions"), true, "recovered attribution claims the request");
            assert.equal(throws, 3, "initial throw + exactly two settle-retries");
            const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
            // #3651: non-public upstream hosts are masked in the durable line (paste-safe sink).
            assert.match(content, /attribution recovered after 2 settle-retries — https:\/\/<private-host>\/v1\/chat\/completions claimed \(#2924\)/);
        });
    } finally {
        _setThrewRetryForTest();
        proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#2924 gate `threw` persists: provably-oversized body refuses LOCALLY, everything else keeps #1117 semantics", async () => {
    const proxy = await startMockProxy([]);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2924b-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-2924b-home-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            // Wire the model services the way a real host would — the gate's
            // oversize arm resolves the window through modelInfo.services
            // (global default fallback) when the session header is unreadable
            // (a `threw` attribution cannot serve requestHeader either).
            class Llm2924 {
                async resolveModelInfo(): Promise<undefined> {
                    return undefined;
                }
            }
            ctx.setModelServices(new Llm2924(), { currentSelection: () => ({ provider: "p2924", model: "m2924" }) });
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            _setThrewRetryForTest({ attempts: 2, delayMs: 1 });
            ctx.agents.currentInitiator = () => {
                throw new Error("agent initiator scope is disposed");
            };
            // The oversize arm needs a resolvable window: seed the model-info
            // cache the same way refreshModelInfo would (production path).
            _setModelInfoForTest({ provider: "p2924", model: "m2924", contextWindow: 1000 });
            const url = "https://api.gate-2924b.test/v1/chat/completions";
            const logFile = path.join(stateHome, "billion-context", "bili.log");
            const localLines = (): string[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "").split("\n").filter((l) => l.length > 0 && l.includes("refused") && l.includes("LOCALLY"));
            // 4,000,004 B / 4 = 1,000,001 tok > the floored bar max(1000
            // declared, 1M assumed, #4079) = 1M → the OPTIMISTIC estimate
            // already overflows: forwarding direct can only 400 upstream.
            assert.equal(await gate(url, { bytes: 4_000_004 }), "refuse-oversized");
            assert.equal(localLines().length, 1, "one durable LOCAL-refusal line");
            assert.match(localLines()[0]!, /≥1000001 tok \(core est 4000004B\/4\) exceeds window 1000000 \(declared 1000; never assumes below 1000000\)/);
            // 4,000,000 B / 4 = 1M tok == floored bar: NOT provably over → direct.
            assert.equal(await gate(url, { bytes: 4_000_000 }), false);
            // #4079 floor both-ways: a body over the DECLARED window (4004B/4
            // = 1001 tok > 1000) but under the assumed minimum must NOT be
            // refused — a mis-sized small window can never false-refuse.
            assert.equal(await gate(url, { bytes: 4004 }), false);
            // Unreadable body / unknown size → #1117 direct semantics.
            assert.equal(await gate(url), false);
            // No window resolvable → the size arm disarms entirely → direct.
            _setModelInfoForTest();
            assert.equal(await gate(url, { bytes: 4004 }), false);
        });
    } finally {
        _setThrewRetryForTest();
        _setModelInfoForTest();
        proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#4068 gate `none` oversize arm: an unattributed body that provably cannot fit any window refuses LOCALLY instead of riding #1117 DIRECT into a guaranteed upstream 4xx", async () => {
    const proxy = await startMockProxy([]);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-4068-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-4068-home-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            // No initiator wired → attributionOf answers `none`: the #1117
            // agentless lane this arm guards. Window resolution needs the
            // global default target (an unattributed call has no session
            // header to read).
            class Llm4068 {
                async resolveModelInfo(): Promise<undefined> {
                    return undefined;
                }
            }
            ctx.setModelServices(new Llm4068(), { currentSelection: () => ({ provider: "p4068", model: "m4068" }) });
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            _setModelInfoForTest({ provider: "p4068", model: "m4068", contextWindow: 1000 });
            const url = "https://api.gate-4068.test/v1/chat/completions";
            const logFile = path.join(stateHome, "billion-context", "bili.log");
            const localLines = (): string[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "").split("\n").filter((l) => l.length > 0 && l.includes("refused") && l.includes("LOCALLY"));
            // 4,000,004 B / 4 = 1,000,001 tok > the floored bar max(1000
            // declared, 1M assumed, #4079) = 1M → provably over: a DIRECT send
            // is a guaranteed upstream 400/413 and the host retries the SAME
            // oversized history every turn (#4068's 6.16M-token send).
            assert.equal(await gate(url, { bytes: 4_000_004 }), "refuse-oversized-unattributed");
            assert.equal(localLines().length, 1, "one durable LOCAL-refusal line");
            assert.match(localLines()[0]!, /unattributed body ≥1000001 tok \(core est 4000004B\/4\) exceeds window 1000000 \(declared 1000; never assumes below 1000000\)/);
            // 4,000,000 B / 4 = 1M tok == floored bar: NOT provably over → direct.
            assert.equal(await gate(url, { bytes: 4_000_000 }), false);
            // #4079 floor both-ways: over the DECLARED window (1001 tok >
            // 1000) but under the assumed minimum → #1117 direct, not a
            // false refusal on a mis-sized declaration.
            assert.equal(await gate(url, { bytes: 4004 }), false);
            // Unreadable body / unknown size → #1117 direct semantics.
            assert.equal(await gate(url), false);
            // No window resolvable → the size arm disarms entirely → direct.
            _setModelInfoForTest();
            assert.equal(await gate(url, { bytes: 4004 }), false);
            // Attributed traffic is untouched by the arm (#3617 both-ways):
            // a claimed oversized body goes to the proxy, where preflight's
            // own doom math decides.
            ctx.setInitiator({ session: { id: "s4068" } });
            assert.equal(await gate(url, { bytes: 4_000_004 }), true);
        });
    } finally {
        _setModelInfoForTest();
        proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#4111 gate oversize arms are media-aware: a base64-heavy body the raw bytes/4 math falsely refused rides #1117 direct; genuinely over-limit TEXT still refuses locally", async () => {
    const proxy = await startMockProxy([]);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-4111-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-4111-home-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            const ctx = mockCtx();
            // Same scaffolding as #4068: no initiator → `none` attribution;
            // window resolution needs the global default target.
            class Llm4111 {
                async resolveModelInfo(): Promise<undefined> {
                    return undefined;
                }
            }
            ctx.setModelServices(new Llm4111(), { currentSelection: () => ({ provider: "p4111", model: "m4111" }) });
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            _setModelInfoForTest({ provider: "p4111", model: "m4111", contextWindow: 1000 });
            const url = "https://api.gate-4111.test/v1/chat/completions";
            // The #4111 field shape: a ~4.2MB screenshot as an inline data-URL
            // (billed upstream at a few thousand resolution tokens) + modest
            // text, on a window floored at 1M (#4079). Raw bytes/4 = >1M
            // "tokens" — the OLD math's false local 422; core text is ~200B.
            const shot = "A".repeat(4_200_000);
            const dataUrl = `data:image/png;base64,${shot}`;
            const mediaBody = JSON.stringify({
                model: "m4111",
                messages: [
                    { role: "user", content: "Fix the overlapping footer button in this screenshot." },
                    { role: "user", content: [
                        { type: "image_url", image_url: { url: dataUrl } },
                        { type: "text", text: "The save button overlaps the footer on narrow viewports." },
                    ] },
                ],
            });
            const mediaBodyBytes = Buffer.byteLength(mediaBody);
            assert.ok(mediaBodyBytes > 4_000_004, "raw body mass is over the old raw-bytes bar (the false-refusal shape)");
            assert.equal(mediaBytesOfWireBody(mediaBody), Buffer.byteLength(dataUrl), "media walker prices exactly the data-URL payload");
            // (a) unattributed arm, #3617 direction 1: media-heavy body is NOT
            // provably over once media is excluded → #1117 direct semantics.
            assert.equal(await gate(url, { bytes: mediaBodyBytes }, { method: "POST", body: mediaBody }), false, "media-heavy unattributed body is no longer falsely refused");
            // (b) unattributed arm, #3617 direction 2: genuinely over-limit
            // TEXT at the same mass still refuses LOCALLY.
            const textBody = JSON.stringify({ model: "m4111", messages: [{ role: "user", content: "x".repeat(4_000_004) }] });
            assert.ok(Buffer.byteLength(textBody) > 4_000_004, "text-only body is over the raw bar too");
            assert.equal(mediaBytesOfWireBody(textBody), 0, "no media in the text body");
            assert.equal(await gate(url, { bytes: Buffer.byteLength(textBody) }, { method: "POST", body: textBody }), "refuse-oversized-unattributed", "genuinely over-limit text still refuses");
            // Both directions on the `threw` arm as well (#4111 fixed both).
            _setThrewRetryForTest({ attempts: 2, delayMs: 1 });
            ctx.agents.currentInitiator = () => {
                throw new Error("agent initiator scope is disposed");
            };
            assert.equal(await gate(url, { bytes: mediaBodyBytes }, { method: "POST", body: mediaBody }), false, "media-heavy threw body keeps #1117 direct semantics");
            assert.equal(await gate(url, { bytes: Buffer.byteLength(textBody) }, { method: "POST", body: textBody }), "refuse-oversized", "over-limit text still refuses on the threw arm");
        });
    } finally {
        _setThrewRetryForTest();
        _setModelInfoForTest();
        proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
    }
});

test("#4111 mediaBytesOfWireBody/bodyProvablyOverWindow: prices the inline-media shapes of every wire family, never treats pasted-text base64 as media, and re-prices the doom math only when media is the mass", () => {
    const b64 = "QUJDREVGR0g=".repeat(32); // 384 chars of pure base64
    // anthropic base64 source blocks (image/document/audio share the shape)
    assert.equal(mediaBytesOfWireBody(JSON.stringify({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }] }] })), Buffer.byteLength(b64));
    // anthropic redacted_thinking opaque payload
    assert.equal(mediaBytesOfWireBody(JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: b64 }] }] })), Buffer.byteLength(b64));
    // google inlineData parts
    assert.equal(mediaBytesOfWireBody(JSON.stringify({ contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: b64 } }] }] })), Buffer.byteLength(b64));
    // openai chat input_audio
    assert.equal(mediaBytesOfWireBody(JSON.stringify({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: b64, format: "wav" } }] }] })), Buffer.byteLength(b64));
    // openai/responses data: URLs (image_url.url and file file_data)
    const dataUrl = `data:image/png;base64,${b64}`;
    assert.equal(mediaBytesOfWireBody(JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] }] })), Buffer.byteLength(dataUrl));
    assert.equal(mediaBytesOfWireBody(JSON.stringify({ messages: [{ role: "user", content: [{ type: "file", file: { file_data: dataUrl } }] }] })), Buffer.byteLength(dataUrl));
    // responses-wire input_image singular form: the whole data URL is a STRING
    // under image_url (not an object with .url) — still media mass.
    assert.equal(mediaBytesOfWireBody(JSON.stringify({ input: [{ role: "user", content: [{ type: "input_image", image_url: dataUrl }] }] })), Buffer.byteLength(dataUrl));
    // remote URLs are references, not media mass
    assert.equal(mediaBytesOfWireBody(JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://cdn.test/shot.png" } }] }] })), 0);
    // base64 pasted AS TEXT is NOT media on any wire — stays billed as text
    // (the genuinely-huge-text direction keeps its teeth, #3617 both-ways).
    assert.equal(mediaBytesOfWireBody(JSON.stringify({ messages: [{ role: "user", content: b64 }] })), 0);
    assert.equal(mediaBytesOfWireBody(JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: b64 }] }] })), 0);
    // non-JSON body → nothing to exclude → the raw floor keeps its old verdict
    assert.equal(mediaBytesOfWireBody("<not-json>"), 0);
    // The predicate's two stages: raw bytes trip the old bar only when the
    // RAW mass exceeds 4× the floored window (1M tok) — so build bodies
    // around a ~4.2MB media payload (media-only: disarmed by the re-price;
    // media + >4MB text: still provably over, numbers carry core bytes).
    const bigB64 = "A".repeat(4_200_000);
    const bigUrl = `data:image/png;base64,${bigB64}`;
    const mediaOnlyInit: RequestInit = { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: bigUrl } }] }] }) };
    assert.equal(bodyProvablyOverWindow({ bytes: Buffer.byteLength(String(mediaOnlyInit.body)) }, mediaOnlyInit, 1000), undefined, "media-heavy body (raw mass over the old bar) is NOT provably over once media is excluded");
    const mixedInit: RequestInit = { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "y".repeat(4_000_004) }, { type: "image_url", image_url: { url: bigUrl } }] }] }) };
    const mixedBytes = Buffer.byteLength(String(mixedInit.body));
    const mixedDoom = bodyProvablyOverWindow({ bytes: mixedBytes }, mixedInit, 1000);
    assert.ok(mixedDoom !== undefined, "same media PLUS >4MB of text stays provably over");
    assert.equal(mixedDoom?.mediaBytes, Buffer.byteLength(bigUrl), "doom numbers carry the excluded media mass");
    assert.equal(mixedDoom?.coreBytes, mixedBytes - Buffer.byteLength(bigUrl), "doom numbers carry media-excluded core bytes");
    assert.equal(mixedDoom?.window, 1_000_000, "#4079 floor never assumes below the 1M common window");
    assert.equal(bodyProvablyOverWindow({ bytes: Buffer.byteLength(String(mediaOnlyInit.body)) }, mediaOnlyInit, 10_000_000), undefined, "media-heavy body under a big declared window never even trips stage 1");
    const textInit: RequestInit = { method: "POST", body: "x".repeat(4_000_004) };
    assert.notEqual(bodyProvablyOverWindow({ bytes: Buffer.byteLength(String(textInit.body)) }, textInit, 1000), undefined, "text-only body stays provably over");
    assert.equal(bodyProvablyOverWindow(undefined, mediaOnlyInit, 1000), undefined, "no body → no size arm");
    assert.equal(bodyProvablyOverWindow({ bytes: mixedBytes }, mixedInit, undefined), undefined, "no window → no size arm");
    assert.notEqual(bodyProvablyOverWindow({ bytes: mixedBytes }, undefined, 1000), undefined, "no init to re-price → media cannot be proven → the raw floor keeps the old (conservative) verdict");
});

test("#3581 gate degradation reports event-driven; give-up latch stops pointless settle-retries on a dead scope", async () => {
    const attrCalls: MockAttributionCall[] = [];
    const proxy = await startMockProxy([], undefined, undefined, undefined, false, attrCalls);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3581a-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3581a-home-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetAttributionHealthForTest();
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            // giveUpStreak stays at its production default (3); fast cadence for the suite.
            _setThrewRetryForTest({ attempts: 2, delayMs: 1 });
            let probes = 0;
            ctx.agents.currentInitiator = () => {
                probes += 1;
                throw new Error("agent initiator scope is disposed");
            };
            const url = "https://api.gate-3581a.test/v1/chat/completions";
            const logFile = path.join(stateHome, "billion-context", "bili.log");
            // #3578 shape: the ALS boundary throws for the host's whole lifetime.
            // Per-request probe cost while settling (attempts: 2): the gate's
            // initial attributionOf, the one settle-retry, the oversize arm's
            // window resolution (sessionModelTargetOf), and the final
            // refuse(attributionOf) re-probe → 4. The latch removes exactly the
            // settle-retry probe → 3.
            assert.equal(await gate(url), false);
            assert.equal(probes, 4, "request 1: four probes while settling");
            assert.equal(await gate(url), false);
            assert.equal(probes, 8, "request 2: still settling");
            assert.equal(await gate(url), false);
            assert.equal(probes, 12, "request 3: streak reaches giveUpStreak → latch arms");
            assert.equal(await gate(url), false);
            assert.equal(probes, 15, "request 4: latch skips the settle loop — one fewer probe");
            assert.equal(await gate(url), false);
            assert.equal(probes, 18, "request 5: reduced cost holds");
            const health = _attributionHealthForTest();
            assert.equal(health.state, "threw");
            assert.equal(health.refusals, 5);
            assert.ok(health.since > 0, "episode start timestamp recorded");
            assert.equal(health.threwStreak, 5);
            assert.equal(health.gaveUp, true);
            // event-driven reporting: first refusal, doubling (2), latch (3) — no per-request flood
            await waitFor(() => attrCalls.length >= 3, "attribution health reports");
            assert.ok(attrCalls.every((c) => c.agent === "bili-native"), "reports carry the agent name");
            assert.deepEqual({ state: attrCalls[0]!.state, refusals: attrCalls[0]!.refusals }, { state: "threw", refusals: 1 });
            assert.ok(attrCalls[0]!.since > 0);
            assert.equal(attrCalls[1]!.refusals, 2, "doubling report");
            assert.ok(attrCalls[attrCalls.length - 1]!.refusals >= 3, "latch carries the latest count");
            const content = fs.readFileSync(logFile, "utf8");
            assert.match(content, /stopped settle-retrying after 3 consecutive thrown request\(s\)/);
        });
    } finally {
        _setThrewRetryForTest();
        proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetAttributionHealthForTest();
    }
});

test("#3581 recovery clears the episode, re-arms settle-retry, and reports ok", async () => {
    const attrCalls: MockAttributionCall[] = [];
    const proxy = await startMockProxy([], undefined, undefined, undefined, false, attrCalls);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3581b-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3581b-home-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetAttributionHealthForTest();
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            _setThrewRetryForTest({ attempts: 2, delayMs: 1 });
            let probes = 0;
            ctx.agents.currentInitiator = () => {
                probes += 1;
                throw new Error("agent initiator scope is disposed");
            };
            const url = "https://api.gate-3581b.test/v1/chat/completions";
            for (let i = 0; i < 3; i++) assert.equal(await gate(url), false);
            assert.equal(_attributionHealthForTest().gaveUp, true, "latch armed by three exhausted throws");
            // a new agent scope lands (host re-created it): the first ok claim heals.
            ctx.agents.currentInitiator = () => ({ session: { id: "s3581b" } });
            assert.equal(await gate(url), true, "recovered attribution claims immediately");
            const healed = _attributionHealthForTest();
            assert.deepEqual({ state: healed.state, refusals: healed.refusals, since: healed.since }, { state: "ok", refusals: 0, since: 0 });
            assert.equal(healed.threwStreak, 0);
            assert.equal(healed.gaveUp, false);
            await waitFor(() => attrCalls.some((c) => c.state === "ok"), "recovery report");
            const okCall = attrCalls.filter((c) => c.state === "ok").pop()!;
            assert.equal(okCall.refusals, 0);
            // break again: settle-retry is RE-ARMED (the latch followed the episode, not the process).
            let probes2 = 0;
            ctx.agents.currentInitiator = () => {
                probes2 += 1;
                throw new Error("agent initiator scope is disposed again");
            };
            assert.equal(await gate(url), false);
            assert.equal(probes2, 4, "settle-retry active again after recovery (full 4-probe cost)");
            const reBroken = _attributionHealthForTest();
            assert.equal(reBroken.state, "threw");
            assert.equal(reBroken.refusals, 1, "fresh episode starts at one refusal");
        });
    } finally {
        _setThrewRetryForTest();
        proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetAttributionHealthForTest();
    }
});

// #3578/#3581 combined contract (#3617-E③): the transition-window shape — old
// injected code whose agent scope is disposed (a version swap left the LIVE
// proxy behind) must fail VISIBLE: the gate refuses to claim model traffic AND
// the plugin's own report bytes must pass the REAL endpoint validation into
// /__bili/status. Side A (gate internals against a mock endpoint, above) and
// side B (endpoint + status wire against hand-crafted POSTs,
// issue3581-attribution-health.test.ts) were covered separately; this pins the
// seam with the real plugin→real proxy chain.
test("#3578 transition contract: disposed-scope refusal lands on the REAL /__bili/status attribution surface", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3578-base-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3578-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3578-home-"));
    const upstream = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;
    let srv: http.Server | undefined;
    try {
        await withEnv({
            BILI_SESSIONS_DIR: path.join(base, "sessions"),
            BILI_CONFIG_FILE: path.join(base, "absent-config.json"),
            XDG_CACHE_HOME: path.join(base, "cache"),
            XDG_STATE_HOME: stateHome,
            BILI_PERSIST_ZSTD: "0",
        }, async () => {
            srv = await startServer({
                port: 0,
                host: "127.0.0.1",
                upstream: `http://127.0.0.1:${upstreamPort}`,
                routes: {},
                modelContextLimit: 400_000,
                kernelConfig: defaultConfig(400_000),
                compress: { injectTool: false, injectNudge: false },
                promptCache: { routing: "auto" },
                sessionHeader: "x-acp-session",
                log: false,
                debug: false,
                passthrough: false,
                autoUpdate: false,
                compat: { roles: {} },
                streamErrorShape: "protocol",
                passthroughSource: null,
                autoRestartOnUpdate: false,
                updateTag: "latest",
                advisoryCheck: false,
                releaseNotesCheck: false,
                mitm: { enabled: false, domains: [] },
            });
            await once(srv, "listening");
            const port = (srv.address() as { port: number }).port;
            const origin = `http://127.0.0.1:${port}`;
            await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: origin, XDG_STATE_HOME: stateHome }, async () => {
                _resetRoutedForTest();
                _resetRegisterForTest(origin);
                _resetAttributionHealthForTest();
                _setThrewRetryForTest({ attempts: 2, delayMs: 1 });
                const ctx = mockCtx();
                apply(ctx);
                await waitFor(() => ctx.registeredTools.length >= 1, "real-manifest tool registration");
                const gate = _stateTakeoverGateForTest();
                assert.ok(gate !== undefined, "takeoverGate installed");
                const statusOf = async (): Promise<Record<string, { state: string; refusals: number; since: number; error?: string; endpoint?: string }>> =>
                    ((await (await fetch(`${origin}/__bili/status`)).json()) as { attribution?: Record<string, { state: string; refusals: number; since: number; error?: string; endpoint?: string }> }).attribution ?? {};
                assert.deepEqual(await statusOf(), {}, "no report yet: empty surface");
                // #3578 shape: the ALS boundary throws for the host's whole lifetime.
                ctx.agents.currentInitiator = () => { throw new Error("agent initiator scope is disposed"); };
                assert.equal(await gate(`${origin}/v1/messages`), false, "disposed scope cannot attribute — request goes direct");
                // The fire-and-forget report must survive the real endpoint's
                // validation and land on the status wire.
                const deadline = Date.now() + 5_000;
                let ep: { state: string; refusals: number; since: number; error?: string; endpoint?: string } | undefined;
                for (;;) {
                    ep = (await statusOf())["bili-native"];
                    if (ep !== undefined && ep.state === "threw" && ep.refusals >= 1 && ep.since > 0) break;
                    if (Date.now() > deadline) throw new Error(`real status surface never showed the episode (last: ${JSON.stringify(await statusOf())})`);
                    await new Promise((r) => setTimeout(r, 25));
                }
                assert.ok(ep.since > 0, "episode start timestamp recorded");
                // #3651 diagnosable-failure contract: the thrown message rides the
                // wire, and the endpoint is masked BUT loopback hosts stay
                // verbatim (this one points at bili itself, not a third party).
                assert.equal(ep.error, "agent initiator scope is disposed");
                assert.match(ep.endpoint ?? "", /^http:\/\/127\.0\.0\.1:\d+\/v1\/messages$/);
            });
        });
    } finally {
        _setThrewRetryForTest();
        _resetAttributionHealthForTest();
        _resetRegisterForTest(undefined);
        const server = srv;
        if (server) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
        await new Promise<void>((resolve, reject) => upstream.close((e) => (e ? reject(e) : resolve())));
        rmrf(base);
        rmrf(stateHome);
        rmrf(home);
    }
});

test("#3651 owner contract: agentless `none` lanes NEVER report; none→threw flip reports immediately with diagnostics", async () => {
    const attrCalls: MockAttributionCall[] = [];
    const proxy = await startMockProxy([], undefined, undefined, undefined, false, attrCalls);
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3651a-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-3651a-home-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetAttributionHealthForTest();
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const gate = _stateTakeoverGateForTest();
            assert.ok(gate !== undefined, "takeoverGate installed");
            // Field shape (#3651): currentInitiator() returns nothing — a by-design
            // agentless sidecar lane (dsh title-gen et al.). Such refusals are
            // NORMAL interceptions: they stay direct and never reach the panel
            // (「正常拦截不报告」) — no matter how many accumulate.
            ctx.agents.currentInitiator = () => undefined;
            const url = "https://api.gate-3651a.test/v1/chat/completions";
            for (let i = 0; i < 6; i++) assert.equal(await gate(url), false, "agentless lane still refused direct");
            assert.deepEqual(_attributionHealthForTest(), { state: "ok", refusals: 0, since: 0, threwStreak: 0, gaveUp: false }, "`none` episodes touch no reported state");
            assert.equal(attrCalls.length, 0, "six agentless refusals report nothing — banner cannot light on them");
            // the durable per-endpoint line still fires (diagnostic record), masked
            const content = fs.readFileSync(path.join(stateHome, "billion-context", "bili.log"), "utf8");
            assert.match(content, /takeover gate refused https:\/\/<private-host>\/v1\/chat\/completions: no active initiator attribution/);
            // 「报告必须可诊断」: flipping to an internal error (`threw`) must
            // report IMMEDIATELY with the thrown message + masked endpoint.
            _setThrewRetryForTest({ attempts: 2, delayMs: 1 });
            ctx.agents.currentInitiator = () => { throw new Error("agent initiator scope is disposed"); };
            assert.equal(await gate(url), false, "thrown attribution still refuses direct");
            await waitFor(() => attrCalls.length === 1, "threw flip reports immediately (no cadence wait)");
            assert.equal(attrCalls[0]!.state, "threw");
            assert.equal(attrCalls[0]!.refusals, 1, "fresh episode starts at one");
            assert.ok(attrCalls[0]!.since > 0, "episode start recorded");
            assert.equal(attrCalls[0]!.error, "agent initiator scope is disposed");
            assert.equal(attrCalls[0]!.endpoint, "https://<private-host>/v1/chat/completions");
            // attributed traffic heals: recovery notice + counters reset
            ctx.agents.currentInitiator = () => ({ session: { id: "s3651a" } });
            assert.equal(await gate(url), true);
            await waitFor(() => attrCalls.some((c) => c.state === "ok"), "recovery report");
            const okCall = attrCalls.filter((c) => c.state === "ok").pop()!;
            assert.equal(okCall.refusals, 0);
            assert.equal(_attributionHealthForTest().refusals, 0, "recovery resets the episode");
        });
    } finally {
        _setThrewRetryForTest();
        proxy.close();
        rmrf(stateHome);
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetAttributionHealthForTest();
    }
});

test("#1158 apply() persists bootstrap failures to bili.log (GUI stderr is invisible)", async () => {
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1158c-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1158c-home-"));
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return undefined;
    });
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
        errs.push(args.map(String).join(" "));
    };
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: "http://127.0.0.1:1", XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest("http://127.0.0.1:1");
            const ctx = mockCtx();
            apply(ctx);
            // port 1 on loopback: connection refused immediately — a stale preset.
            // #2831: the fallback diagnostic lands in bili.log, not the terminal.
            const logFile = path.join(stateHome, "billion-context", "bili.log");
            await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("is not healthy — falling back"), "attach-unhealthy fallback line in bili.log");
            assert.equal(spawnCalls, 1, "fallback spawn attempted");
            // The same fact must exist durably in the shared bili.log in the
            // proxy's own line shape, origin-marked — stderr alone is invisible
            // to GUI hosts, which is exactly how #1158 stayed silent.
            const content = fs.readFileSync(logFile, "utf8");
            assert.match(content, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[warn\] \[v=[^\]]+\] \[dsh-client\] attach target http:\/\/127\.0\.0\.1:1 is not healthy — falling back to a spawned proxy$/m);
            assert.equal(errs.filter((e) => e.includes("not healthy")).length, 0, "#2831: must not reach the terminal surface");
        });
    } finally {
        console.error = origErr;
        _setSpawnForTest(undefined);
        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
    }
});

test("#1158 persistClientEvent: standard line shape into bili.log; broken fs never throws", async () => {
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1158d-state-"));
    try {
        await withEnv({ XDG_STATE_HOME: stateHome }, async () => {
            persistClientEvent("boom-marker-xyz");
            // #3651: paste-safe sink — non-public upstream hosts masked (query
            // dropped), public API hosts and loopback origins stay verbatim.
            persistClientEvent("probe https://relay.internal.example/v1/chat/completions?k=secret http://127.0.0.1:18788/bili/x https://api.deepseek.com/v1/messages");
            const logFile = path.join(stateHome, "billion-context", "bili.log");
            const content = fs.readFileSync(logFile, "utf8");
            assert.match(content, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[warn\] \[v=[^\]]+\] \[dsh-client\] boom-marker-xyz$/m);
            assert.match(content, /probe https:\/\/<private-host>\/v1\/chat\/completions http:\/\/127\.0\.0\.1:18788\/bili\/x https:\/\/api\.deepseek\.com\/v1\/messages$/m);
        });
        // Broken target (state root under a regular file): must swallow, never throw.
        const blocker = path.join(os.tmpdir(), `bili-dsh-1158d-blocker-${Date.now()}`);
        fs.writeFileSync(blocker, "x");
        try {
            await withEnv({ XDG_STATE_HOME: `${blocker}/sub` }, async () => {
                persistClientEvent("must-not-throw");
                assert.ok(!fs.existsSync(`${blocker}/sub`), "no partial dir tree created");
            });
        } finally {
            fs.rmSync(blocker, { force: true });
        }
    } finally {
        rmrf(stateHome);
    }
});

// — #1130: runtime death of a SHARED attach proxy re-probes + falls back ———

test("#1130 apply() attach mode: runtime death of the shared proxy re-probes and falls back to spawn", async () => {
    const shared = await startMockProxy([]);
    const calls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const fallback = await startMockProxy(calls);
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return fallback.origin;
    });
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
    };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1130-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1130-state-"));
    try {
        // terminal B attached to terminal A's launcher proxy at startup —
        // live preset, no spawn
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: shared.origin, XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(shared.origin);
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            assert.equal(spawnCalls, 0);
            // attach mode must arm a runtime respawn seam (the interceptor's
            // death branch drives exactly this call)
            const respawn = _stateRespawnForTest();
            assert.ok(respawn !== undefined, "attach mode armed state.respawn");
            // terminal A's dsh exits → its launcher kills the shared proxy
            shared.close();
            await new Promise((r) => setTimeout(r, 50));
            const recovered = await respawn();
            assert.equal(recovered, fallback.origin);
            assert.equal(spawnCalls, 1);
            // #2831: the fallback diagnostic lands in bili.log, not the terminal
            const logContent = fs.readFileSync(path.join(stateHome, "billion-context", "bili.log"), "utf8");
            assert.match(logContent, /attach target .* is not healthy — falling back to a spawned proxy/);
            assert.equal(errors.filter((e) => e.includes("not healthy")).length, 0, "#2831: must not reach the terminal surface");
            // the preset env is unfrozen so a later re-apply plans spawn, not attach
            assert.equal(process.env.BILLION_CONTEXT_PROXY, undefined);
            // registered tools read the LIVE base — they now forward to the
            // fallback origin without any re-registration
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s1130" } } });
            assert.equal(out, "compressed 42 tokens");
            assert.deepEqual(calls, [{ conversationId: "s1130", tool: "compress", args: { summary: "s" }, nativeCaller: true }]);
            // plugin-mode header stamping keeps working against the fallback
            const headersFor = _stateHeadersForTest();
            assert.ok(headersFor !== undefined, "headersFor installed");
            ctx.setInitiator({ session: { id: "s1130" } });
            await waitFor(() => headersFor("https://api.anthropic.com/v1/messages") !== undefined, "plugin headers stamped");
            assert.equal(headersFor("https://api.anthropic.com/v1/messages")?.["x-bili-plugin"], "dsh");
        });
    } finally {
        console.error = origErr;
        _setSpawnForTest(undefined);
        fallback.close();

        rmrf(home);
        rmrf(stateHome);
        _resetRegisterForTest(undefined);
    }
});

// — #1365: pinned model channel — never spawn over a statically-routed target —

const R1365_UPSTREAM = "https://api.deepseek.com/v1/chat/completions";

test("#1365 apply() attach mode: routed evidence pins the channel — a transiently dead target is waited on, never replaced by a spawn", async () => {
    const toolCalls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const server = http.createServer(mockBiliHandler(toolCalls));
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return "http://127.0.0.1:2";
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1365a-"));
    let upTimer: NodeJS.Timeout | undefined;
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: origin }, async () => {
            _resetRegisterForTest(origin);
            const ctx = mockCtx();
            apply(ctx);
            // the settings overlay baked this origin into the provider baseURL —
            // routed model traffic proves the channel is pinned to it
            _noteRoutedForTest(`${origin}/bili/${R1365_UPSTREAM}`);
            const up = new Promise<void>((resolve) => {
                upTimer = setTimeout(() => server.listen(port, "127.0.0.1", () => resolve()), 120);
            });
            await waitFor(() => ctx.registeredTools.length === 1, "attach-after-recovery tool registration");
            clearTimeout(upTimer);
            await up;
            assert.equal(spawnCalls, 0, "no second instance may be spawned over a pinned channel");
            assert.equal(process.env.BILLION_CONTEXT_PROXY, origin, "the user's target stays frozen");
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s1365a" } } });
            assert.equal(out, "compressed 42 tokens");
            assert.deepEqual(toolCalls, [{ conversationId: "s1365a", tool: "compress", args: { summary: "s" }, nativeCaller: true }]);
        });
    } finally {
        clearTimeout(upTimer);
        server.close();
        _setSpawnForTest(undefined);
        rmrf(home);
        _resetRoutedForTest();
        _resetRegisterForTest(undefined);
    }
});

test("#1365 apply() attach mode: routed evidence + persistently dead target — refuses to spawn, keeps the env, self-heals when the target returns", async () => {
    const toolCalls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const server = http.createServer(mockBiliHandler(toolCalls));
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return "http://127.0.0.1:2";
    });
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
    };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1365b-"));
    const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1365b-state-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: origin, BILI_ATTACH_HEALTH_DEADLINE_MS: "150", XDG_STATE_HOME: stateHome }, async () => {
            _resetRegisterForTest(origin);
            const ctx = mockCtx();
            apply(ctx);
            _noteRoutedForTest(`${origin}/bili/${R1365_UPSTREAM}`);
            // #2831: the loud refusal lands in bili.log, not the terminal
            const logFile = path.join(stateHome, "billion-context", "bili.log");
            const t0 = Date.now();
            while (!(fs.existsSync(logFile) && fs.readFileSync(logFile, "utf8").includes("NOT spawning a second instance"))) {
                if (Date.now() - t0 > POLL_DEADLINE_MS) throw new Error("timed out waiting for the loud refusal");
                await new Promise((r) => setTimeout(r, 10));
            }
            assert.equal(errors.filter((e) => e.includes("second instance")).length, 0, "#2831: must not reach the terminal surface");
            assert.equal(spawnCalls, 0);
            assert.equal(process.env.BILLION_CONTEXT_PROXY, origin, "the pinned target env must survive");
            assert.equal(ctx.registeredTools.length, 0);
            // the external manager restarts the proxy → the next model request re-probes and self-heals
            await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
            const headersFor = _stateHeadersForTest();
            assert.ok(headersFor !== undefined, "headersFor installed");
            headersFor("https://api.anthropic.com/v1/messages");
            await waitFor(() => ctx.registeredTools.length === 1, "self-healed tool registration");
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s1365b" } } });
            assert.equal(out, "compressed 42 tokens");
            assert.deepEqual(toolCalls, [{ conversationId: "s1365b", tool: "compress", args: { summary: "s" }, nativeCaller: true }]);
            assert.equal(spawnCalls, 0, "self-heal re-attaches — it never spawns");
        });
    } finally {
        console.error = origErr;
        server.close();
        _setSpawnForTest(undefined);
        rmrf(home);
        rmrf(stateHome);
        _resetRoutedForTest();
        _resetRegisterForTest(undefined);
    }
});

test("#1365 explicit BILLION_CONTEXT_ATTACH remains the tool endpoint when the routed model origin denies the plugin manifest", async () => {
    const toolCalls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const attach = await startMockProxy(toolCalls);
    let modelManifestRequests = 0;
    const modelServer = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            modelManifestRequests += 1;
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", () => resolve()));
    const modelOrigin = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}`;
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return "http://127.0.0.1:2";
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1365-explicit-attach-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_ATTACH: attach.origin, BILLION_CONTEXT_PROXY: undefined, BILI_ATTACH_HEALTH_DEADLINE_MS: "40" }, async () => {
            _resetRegisterForTest(attach.origin);
            _resetRoutedForTest();
            _noteRoutedForTest(`${modelOrigin}/bili/${R1365_UPSTREAM}`);
            const ctx = mockCtx();
            apply(ctx);
            assert.equal(await _stateRespawnForTest()?.(), attach.origin, "recovery must probe the explicit plugin endpoint, not the model-only origin");
            await waitFor(() => ctx.registeredTools.length === 1, "explicit-attach tool registration");
            assert.equal(spawnCalls, 0, "a second proxy must not be spawned for an API-only model route");
            assert.equal(modelManifestRequests, 0, "pre-existing model-route evidence must not override explicit attach");
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s1365-explicit" } } });
            assert.equal(out, "compressed 42 tokens");
            assert.deepEqual(toolCalls, [{ conversationId: "s1365-explicit", tool: "compress", args: { summary: "s" }, nativeCaller: true }]);
        });
    } finally {
        attach.close();
        modelServer.close();
        _setSpawnForTest(undefined);
        rmrf(home);
        _resetRoutedForTest();
        _resetRegisterForTest(undefined);
    }
});

test("explicit attach keeps the DSH tool base when a late routed model origin denies the manifest", async () => {
    const toolCalls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const attach = await startMockProxy(toolCalls);
    let modelManifestRequests = 0;
    const modelServer = http.createServer((req, res) => {
        if (req.url === "/__bili/plugin/manifest") {
            modelManifestRequests += 1;
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }
        res.writeHead(404);
        res.end("{}");
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", () => resolve()));
    const modelOrigin = `http://127.0.0.1:${(modelServer.address() as { port: number }).port}`;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-explicit-attach-late-route-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_ATTACH: attach.origin, BILLION_CONTEXT_PROXY: undefined }, async () => {
            _resetRegisterForTest(attach.origin);
            _resetRoutedForTest();
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "explicit-attach tools before route observation");
            _noteRoutedForTest(`${modelOrigin}/bili/${R1365_UPSTREAM}`);
            await waitFor(() => modelManifestRequests === 1, "manifest liveness probe of late routed origin");
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s1365-explicit-late" } } });
            assert.equal(out, "compressed 42 tokens");
            assert.deepEqual(toolCalls, [{ conversationId: "s1365-explicit-late", tool: "compress", args: { summary: "s" }, nativeCaller: true }]);
        });
    } finally {
        attach.close();
        modelServer.close();
        rmrf(home);
        _resetRoutedForTest();
        _resetRegisterForTest(undefined);
    }
});

test("#2935: session deletion events co-delete via /__bili/plugin/delete; non-deletion events never do", async () => {
    const names: NameCall[] = [];
    const deletes: DeleteCall[] = [];
    const proxy = await startMockProxy([], undefined, names, undefined, undefined, undefined, undefined, deletes);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-delete-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetTitlesForTest();
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration");

            // nested session/event deletion type -> teardown POST
            ctx.emit("session/event", { id: "s-del" }, { type: "session/deleted" });
            await waitFor(() => deletes.length === 1, "delete POST");
            assert.deepEqual(deletes[0], { conversationId: "s-del" });

            // top-level session/deleted event -> teardown POST
            ctx.emit("session/deleted", { id: "s-top" });
            await waitFor(() => deletes.length === 2, "top-level delete POST");
            assert.deepEqual(deletes[1], { conversationId: "s-top" });

            // non-deletion events must leave the delete lane alone
            ctx.emit("session/event", { id: "s-t" }, { type: "session/title", data: { title: "X", messageSeqs: [1], source: { kind: "user" } } });
            ctx.emit("session/event", { id: "s-t" }, { type: "message/append", data: {} });
            await waitFor(() => names.length === 1, "title POST on its own lane");
            assert.equal(deletes.length, 2, "no spurious delete POST for non-deletion events");
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetTitlesForTest();
    }
});

test("#2935: isDshSessionDeleteEvent matches only explicit per-session destructive types", () => {
    assert.equal(isDshSessionDeleteEvent("session/deleted"), true);
    assert.equal(isDshSessionDeleteEvent("session/removed"), true);
    assert.equal(isDshSessionDeleteEvent("deleted"), true);
    assert.equal(isDshSessionDeleteEvent("session/title"), false);
    assert.equal(isDshSessionDeleteEvent("message/append"), false);
    assert.equal(isDshSessionDeleteEvent(undefined), false);
    assert.equal(isDshSessionDeleteEvent(42), false);
});

// — #2604 host-title channel ————————————————————————————————————————————————

test("#2604: session/title events push the host name to /__bili/plugin/session-name; deduped, rename re-pushes", async () => {
    const names: NameCall[] = [];
    const proxy = await startMockProxy([], undefined, names);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-title-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetTitlesForTest();
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration");

            ctx.emit("session/event", { id: "s-t1" }, { type: "session/title", data: { title: "My Session", messageSeqs: [1], source: { kind: "user" } } });
            await waitFor(() => names.length === 1, "title POST");
            assert.deepEqual(names[0], { conversationId: "s-t1", name: "My Session" });

            // duplicate event for the same name is suppressed
            ctx.emit("session/event", { id: "s-t1" }, { type: "session/title", data: { title: "My Session", messageSeqs: [1], source: { kind: "user" } } });
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(names.length, 1);

            // a rename re-pushes
            ctx.emit("session/event", { id: "s-t1" }, { type: "session/title", data: { title: "Renamed", messageSeqs: [1, 2], source: { kind: "user" } } });
            await waitFor(() => names.length === 2, "rename POST");
            assert.deepEqual(names[1], { conversationId: "s-t1", name: "Renamed" });

            // non-title events and empty titles are ignored
            ctx.emit("session/event", { id: "s-t1" }, { type: "message/append", data: {} });
            ctx.emit("session/event", { id: "s-t1" }, { type: "session/title", data: { title: "" } });
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(names.length, 2);
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetTitlesForTest();
    }
});

test("#2604: a failed title POST re-arms the dedup so the next event retries", async () => {
    const names: NameCall[] = [];
    const proxy = await startMockProxy([], undefined, names, 500);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-title-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetTitlesForTest();
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration");

            ctx.emit("session/event", { id: "s-t2" }, { type: "session/title", data: { title: "A", messageSeqs: [1], source: { kind: "fallback" } } });
            await waitFor(() => names.length === 1, "first POST");
            // the 500 deleted the dedup entry — the same title retries
            ctx.emit("session/event", { id: "s-t2" }, { type: "session/title", data: { title: "A", messageSeqs: [1], source: { kind: "fallback" } } });
            await waitFor(() => names.length === 2, "retry POST");
            assert.deepEqual(names[1], { conversationId: "s-t2", name: "A" });
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetTitlesForTest();
    }
});

test("#2604: live sessions seed their folded title at boot; resumed sids re-label on first stamped traffic", async () => {
    const names: NameCall[] = [];
    const proxy = await startMockProxy([], undefined, names);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-title-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetTitlesForTest();
            const ctx = mockCtx();
            ctx.setDshSessions(new Map([["s-seed", { id: "s-seed" }]]), (id) => (id === "s-seed" ? "Seeded Title" : undefined));
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration");

            // the boot sweep seeds whatever is already live (resume published before us)
            await waitFor(() => names.length === 1, "boot sweep POST");
            assert.deepEqual(names[0], { conversationId: "s-seed", name: "Seeded Title" });

            // a session whose title events all predate this process: no event
            // fires again, so the FIRST stamped request must re-label it lazily
            ctx.setDshSessions(
                new Map([["s-seed", { id: "s-seed" }], ["s-resume", { id: "s-resume" }]]),
                (id) => (id === "s-resume" ? "Resumed Title" : undefined),
            );
            ctx.setInitiator({ session: { id: "s-resume" } });
            const headers = _stateHeadersForTest()!("http://example.invalid/anthropic/v1/messages");
            assert.notEqual(headers, undefined);
            assert.equal(headers?.["x-bili-plugin-conversation"], "s-resume");
            await waitFor(() => names.some((n) => n.conversationId === "s-resume"), "lazy re-label POST");
            assert.deepEqual(names.find((n) => n.conversationId === "s-resume"), { conversationId: "s-resume", name: "Resumed Title" });

            // a second stamped request hits the armed dedup key — no re-POST
            _stateHeadersForTest()!("http://example.invalid/anthropic/v1/messages");
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(names.filter((n) => n.conversationId === "s-resume").length, 1);
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetTitlesForTest();
    }
});

test("#2604: without the dsh-session services the channel degrades silently; event payloads still push", async () => {
    const names: NameCall[] = [];
    const proxy = await startMockProxy([], undefined, names);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-title-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxy.origin }, async () => {
            _resetRegisterForTest(proxy.origin);
            _resetTitlesForTest();
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration");

            // session/created with no folded source: no crash, no POST
            ctx.emit("session/created", { id: "s-none" });
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(names.length, 0);

            // but a session/title event carries its own payload — still pushed
            ctx.emit("session/event", { id: "s-none" }, { type: "session/title", data: { title: "Event Title", messageSeqs: [1], source: { kind: "provider" } } });
            await waitFor(() => names.length === 1, "event POST");
            assert.deepEqual(names[0], { conversationId: "s-none", name: "Event Title" });
        });
    } finally {
        proxy.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetTitlesForTest();
    }
});

test("#2604: a base transition re-arms the dedup — the replacement proxy re-learns titles", async () => {
    const namesA: NameCall[] = [];
    const proxyA = await startMockProxy([], undefined, namesA);
    const namesB: NameCall[] = [];
    const proxyB = await startMockProxy([], undefined, namesB);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-title-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: proxyA.origin }, async () => {
            _resetRegisterForTest(proxyA.origin);
            _resetTitlesForTest();
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "manifest tool registration");

            ctx.emit("session/event", { id: "s-b" }, { type: "session/title", data: { title: "Shared", messageSeqs: [1], source: { kind: "user" } } });
            await waitFor(() => namesA.length === 1, "POST to A");

            // the owning proxy was replaced (respawn/rebind): the fresh base
            // keys a fresh dedup namespace, so the next event lands on B
            _resetRegisterForTest(proxyB.origin);
            process.env.BILLION_CONTEXT_PROXY = proxyB.origin;
            ctx.emit("session/event", { id: "s-b" }, { type: "session/title", data: { title: "Shared", messageSeqs: [1], source: { kind: "user" } } });
            await waitFor(() => namesB.length === 1, "POST to B");
            assert.deepEqual(namesB[0], { conversationId: "s-b", name: "Shared" });
        });
    } finally {
        proxyA.close();
        proxyB.close();
        rmrf(home);
        _resetRegisterForTest(undefined);
        _resetTitlesForTest();
    }
});

test("#1365 apply() attach mode: late routed evidence rebinds the bili tools to where the models actually go", async () => {
    const aCalls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const bCalls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const a = await startMockProxy(aCalls, () => ({ panel: "PANEL-A" }));
    const b = await startMockProxy(bCalls, () => ({ panel: "PANEL-B" }));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1365c-"));
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: a.origin }, async () => {
            _resetRegisterForTest(a.origin);
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "initial attach tool registration");
            const before = await ctx.registeredCommands[0].handler();
            assert.ok(before.text.includes("PANEL-A"), "status reads go to the attached origin first");
            // another launcher's overlay won the race: models are baked against B
            _noteRoutedForTest(`${b.origin}/bili/${R1365_UPSTREAM}`);
            const t0 = Date.now();
            for (;;) {
                const st = await ctx.registeredCommands[0].handler();
                if (st.text.includes("PANEL-B")) break;
                if (Date.now() - t0 > POLL_DEADLINE_MS) throw new Error("timed out waiting for the tool-channel rebind");
                await new Promise((r) => setTimeout(r, 10));
            }
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s1365c" } } });
            assert.equal(out, "compressed 42 tokens");
            assert.deepEqual(bCalls, [{ conversationId: "s1365c", tool: "compress", args: { summary: "s" }, nativeCaller: true }]);
            assert.deepEqual(aCalls, []);
        });
    } finally {
        a.close();
        b.close();
        rmrf(home);
        _resetRoutedForTest();
        _resetRegisterForTest(undefined);
    }
});

test("#1365 apply() attach mode: runtime death with routed evidence — waits the target back, never migrates", async () => {
    const toolCalls: Array<{ conversationId: string; tool: string; args: unknown }> = [];
    const port = await reserveLoopbackPort();
    const origin = `http://127.0.0.1:${port}`;
    const server = http.createServer(mockBiliHandler(toolCalls));
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    let spawnCalls = 0;
    _setSpawnForTest(async () => {
        spawnCalls += 1;
        return "http://127.0.0.1:2";
    });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dsh-1365d-"));
    let upTimer: NodeJS.Timeout | undefined;
    try {
        await withEnv({ DSH_HOME: home, BILLION_CONTEXT_PROXY: origin }, async () => {
            _resetRegisterForTest(origin);
            const ctx = mockCtx();
            apply(ctx);
            await waitFor(() => ctx.registeredTools.length === 1, "attach tool registration");
            const respawn = _stateRespawnForTest();
            assert.ok(respawn !== undefined, "attach mode armed state.respawn");
            // the external manager restarts the proxy: hard down, then back on the same port
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            _noteRoutedForTest(`${origin}/bili/${R1365_UPSTREAM}`);
            const recoveredPromise = respawn();
            const up = new Promise<void>((resolve) => {
                upTimer = setTimeout(() => server.listen(port, "127.0.0.1", () => resolve()), 100);
            });
            const recovered = await recoveredPromise;
            clearTimeout(upTimer);
            await up;
            assert.equal(recovered, origin, "recovery lands back on the pinned origin");
            assert.equal(spawnCalls, 0);
            assert.equal(process.env.BILLION_CONTEXT_PROXY, origin);
            const out = await ctx.registeredTools[0].execute({ summary: "s" }, { agent: { session: { id: "s1365d" } } });
            assert.equal(out, "compressed 42 tokens");
            assert.deepEqual(toolCalls, [{ conversationId: "s1365d", tool: "compress", args: { summary: "s" }, nativeCaller: true }]);
        });
    } finally {
        clearTimeout(upTimer);
        server.close();
        _setSpawnForTest(undefined);
        rmrf(home);
        _resetRoutedForTest();
        _resetRegisterForTest(undefined);
    }
});
