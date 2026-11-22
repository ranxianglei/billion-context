// #7456 WorkBuddy Desktop lane: managed settings block (pure merge/strip),
// config-home/origin/upstream resolution, and the installer round-trip
// against a sandboxed WORKBUDDY_CONFIG_DIR.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    WORKBUDDY_DEFAULT_UPSTREAM,
    applyWorkbuddyManagedSettings,
    isBiliWorkbuddyBaseUrl,
    pluginInstall,
    pluginRemove,
    pluginStatusAll,
    stripWorkbuddyManagedSettings,
    workbuddyConfigDir,
    workbuddyInstallUpstream,
    workbuddyNativeOrigin,
    workbuddySettingsFile,
    inspectLanePresence,
} from "../src/plugin-install.ts";
import { rmrf } from "./tmp-rm.ts";

const ORIGIN = "http://127.0.0.1:8787";
const WRAPPED = `${ORIGIN}/bili/${WORKBUDDY_DEFAULT_UPSTREAM}`;

function apply(settings: Record<string, unknown>, opts: { origin?: string; upstream?: string; relay?: string } = {}): { data: Record<string, unknown>; notes: string[] } {
    return applyWorkbuddyManagedSettings(settings, { origin: opts.origin ?? ORIGIN, upstream: opts.upstream ?? WORKBUDDY_DEFAULT_UPSTREAM, ...(opts.relay !== undefined ? { relay: opts.relay } : {}) });
}

function envOf(data: Record<string, unknown>): Record<string, unknown> {
    return (data.env as Record<string, unknown> | undefined) ?? {};
}

// — pure merge ———————————————————————————————————————————————————————

test("applyWorkbuddyManagedSettings: wraps the product endpoint and gates auto-compact into empty settings", () => {
    const { data, notes } = apply({});
    assert.equal(envOf(data).CODEBUDDY_BASE_URL, WRAPPED);
    assert.equal(data.autoCompactEnabled, false);
    assert.ok(notes.some((n) => n.includes("pinned to the bili proxy")));
    assert.ok(notes.some((n) => n.includes("autoCompactEnabled=false")));
});

test("applyWorkbuddyManagedSettings: idempotent — a second apply changes nothing", () => {
    const first = apply({});
    const second = apply(first.data);
    assert.deepEqual(second.data, first.data);
    assert.ok(!second.notes.some((n) => n.includes("pinned") || n.includes("autoCompactEnabled=false (")));
});

test("applyWorkbuddyManagedSettings: rewrites an older bili URL (different port) to the current origin", () => {
    const old = { env: { CODEBUDDY_BASE_URL: "http://127.0.0.1:9999/bili/https://www.workbuddy.ai" } };
    const { data } = apply(old);
    assert.equal(envOf(data).CODEBUDDY_BASE_URL, WRAPPED);
});

test("applyWorkbuddyManagedSettings: preserves the relay a previous install wrapped", () => {
    const relay = "https://relay.example.com/gw";
    const old = { env: { CODEBUDDY_BASE_URL: "http://127.0.0.1:8801/bili/" + relay } };
    const { data } = apply(old, { upstream: workbuddyInstallUpstream(old.env.CODEBUDDY_BASE_URL) });
    assert.equal(envOf(data).CODEBUDDY_BASE_URL, `${ORIGIN}/bili/${relay}`);
});

test("applyWorkbuddyManagedSettings: never clobbers a foreign CODEBUDDY_BASE_URL and skips the gate", () => {
    const foreign = { env: { CODEBUDDY_BASE_URL: "https://my-relay.example.com" }, theme: "dark" };
    const { data, notes } = apply(foreign);
    assert.equal(envOf(data).CODEBUDDY_BASE_URL, "https://my-relay.example.com");
    assert.equal(data.theme, "dark");
    assert.equal(data.autoCompactEnabled, undefined);
    assert.ok(notes.some((n) => n.includes("foreign value") && n.includes("BILI_WORKBUDDY_UPSTREAM")));
});

test("applyWorkbuddyManagedSettings: a foreign relay named by BILI_WORKBUDDY_UPSTREAM gets wrapped (#5369 claude parity)", () => {
    const relay = "https://my-relay.example.com";
    const { data } = apply({ env: { CODEBUDDY_BASE_URL: relay } }, { upstream: relay, relay });
    assert.equal(envOf(data).CODEBUDDY_BASE_URL, `${ORIGIN}/bili/${relay}`);
    assert.equal(data.autoCompactEnabled, false);
});

test("applyWorkbuddyManagedSettings: an explicit autoCompactEnabled=true is honored", () => {
    const { data, notes } = apply({ autoCompactEnabled: true });
    assert.equal(data.autoCompactEnabled, true);
    assert.equal(envOf(data).CODEBUDDY_BASE_URL, WRAPPED);
    assert.ok(notes.some((n) => n.includes("explicit true")));
});

test("applyWorkbuddyManagedSettings: a non-boolean autoCompactEnabled is reported, not clobbered", () => {
    const { data, notes } = apply({ autoCompactEnabled: "maybe" });
    assert.equal(data.autoCompactEnabled, "maybe");
    assert.ok(notes.some((n) => n.includes("foreign value \"maybe\"")));
});

// — pure strip —————————————————————————————————————————————————————

test("stripWorkbuddyManagedSettings: removes exactly the bili-owned values", () => {
    const { data, removed } = stripWorkbuddyManagedSettings({
        env: { CODEBUDDY_BASE_URL: WRAPPED, CODEBUDDY_OTHER: "keep" },
        autoCompactEnabled: false,
        model: "keep-me",
    });
    assert.deepEqual(removed, ["env.CODEBUDDY_BASE_URL", "autoCompactEnabled"]);
    assert.equal(envOf(data).CODEBUDDY_BASE_URL, undefined);
    assert.equal(envOf(data).CODEBUDDY_OTHER, "keep");
    assert.equal(data.model, "keep-me");
    assert.equal(data.autoCompactEnabled, undefined);
});

test("stripWorkbuddyManagedSettings: a foreign base URL stays, an empty env object is dropped", () => {
    const { data, removed } = stripWorkbuddyManagedSettings({ env: { CODEBUDDY_BASE_URL: "https://mine.example.com" } });
    assert.deepEqual(removed, []);
    assert.equal(envOf(data).CODEBUDDY_BASE_URL, "https://mine.example.com");
    const empty = stripWorkbuddyManagedSettings({ env: { CODEBUDDY_BASE_URL: WRAPPED } });
    assert.equal(empty.data.env, undefined);
});

// — resolution helpers —————————————————————————————————————————————

test("isBiliWorkbuddyBaseUrl: only loopback /bili/ wrappers count as ours", () => {
    assert.equal(isBiliWorkbuddyBaseUrl(WRAPPED), true);
    assert.equal(isBiliWorkbuddyBaseUrl("http://localhost:9999/bili/https://www.workbuddy.ai"), true);
    assert.equal(isBiliWorkbuddyBaseUrl("https://www.workbuddy.ai"), false);
    assert.equal(isBiliWorkbuddyBaseUrl("http://10.0.0.5:8787/bili/https://www.workbuddy.ai"), false);
    assert.equal(isBiliWorkbuddyBaseUrl(undefined), false);
    assert.equal(isBiliWorkbuddyBaseUrl(42), false);
});

test("workbuddyConfigDir: WORKBUDDY_CONFIG_DIR > CODEBUDDY_CONFIG_DIR > ~/.workbuddy", () => {
    assert.equal(workbuddyConfigDir({ WORKBUDDY_CONFIG_DIR: "/a" }), "/a");
    assert.equal(workbuddyConfigDir({ CODEBUDDY_CONFIG_DIR: "/b" }), "/b");
    assert.equal(workbuddyConfigDir({ WORKBUDDY_CONFIG_DIR: "/a", CODEBUDDY_CONFIG_DIR: "/b" }), "/a");
    assert.equal(workbuddyConfigDir({ WORKBUDDY_CONFIG_DIR: "  " }), workbuddyConfigDir({}));
    assert.equal(workbuddyConfigDir({ WORKBUDDY_CONFIG_DIR: "", CODEBUDDY_CONFIG_DIR: "/b" }), "/b");
    assert.equal(workbuddyConfigDir({}), path.join(os.homedir(), ".workbuddy"));
    assert.equal(path.basename(workbuddySettingsFile({})), "settings.json");
});

test("workbuddyNativeOrigin: resident default, BILI_WORKBUDDY_PROXY override", () => {
    assert.equal(workbuddyNativeOrigin({}), ORIGIN);
    assert.equal(workbuddyNativeOrigin({ BILI_WORKBUDDY_PROXY: "http://127.0.0.1:9901/" }), "http://127.0.0.1:9901");
});

test("workbuddyInstallUpstream: relay override > preserved wrapped relay > product endpoint", () => {
    assert.equal(workbuddyInstallUpstream(undefined, { BILI_WORKBUDDY_UPSTREAM: "https://r.example/x" }), "https://r.example/x");
    assert.equal(workbuddyInstallUpstream(`http://127.0.0.1:1/bili/https://keep.example/y`, {}), "https://keep.example/y");
    assert.equal(workbuddyInstallUpstream(undefined, {}), WORKBUDDY_DEFAULT_UPSTREAM);
    assert.equal(workbuddyInstallUpstream("https://foreign.example", {}), WORKBUDDY_DEFAULT_UPSTREAM);
});

// — installer round-trip —————————————————————————————————————————————

test("pluginInstall/pluginRemove workbuddy: round-trip in a sandboxed config home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-lane-"));
    const saved: Record<string, string | undefined> = {};
    for (const k of ["WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "BILI_WORKBUDDY_PROXY", "BILI_WORKBUDDY_UPSTREAM"]) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    try {
        process.env.WORKBUDDY_CONFIG_DIR = home;
        process.env.BILI_WORKBUDDY_PROXY = "http://127.0.0.1:1";
        fs.writeFileSync(workbuddySettingsFile(), JSON.stringify({ env: { OTHER: "user-key" }, model: "wb-model" }, null, 2) + "\n");

        const out = pluginInstall("workbuddy");
        assert.match(out, /wrote the billion-context WorkBuddy routing/);
        assert.match(out, /no bili proxy reachable at http:\/\/127\.0\.0\.1:1/);
        const doc = JSON.parse(fs.readFileSync(workbuddySettingsFile(), "utf8")) as Record<string, unknown>;
        assert.equal((doc.env as Record<string, unknown>).CODEBUDDY_BASE_URL, "http://127.0.0.1:1/bili/https://www.workbuddy.ai");
        assert.equal((doc.env as Record<string, unknown>).OTHER, "user-key");
        assert.equal(doc.model, "wb-model");
        assert.equal(doc.autoCompactEnabled, false);

        const row = pluginStatusAll().find((r) => r.agent === "workbuddy");
        assert.equal(row?.status, "installed (routing http://127.0.0.1:1) (auto-compact gated)");
        assert.equal(inspectLanePresence("workbuddy").installed, true);

        assert.match(pluginRemove("workbuddy"), /removed env\.CODEBUDDY_BASE_URL/);
        const after = JSON.parse(fs.readFileSync(workbuddySettingsFile(), "utf8")) as Record<string, unknown>;
        assert.equal((after.env as Record<string, unknown>).CODEBUDDY_BASE_URL, undefined);
        assert.equal((after.env as Record<string, unknown>).OTHER, "user-key");
        assert.equal(after.autoCompactEnabled, undefined);
        assert.equal(after.model, "wb-model");
        assert.equal(pluginStatusAll().find((r) => r.agent === "workbuddy")?.status, "not installed");
        assert.equal(inspectLanePresence("workbuddy").installed, false);
        assert.match(pluginRemove("workbuddy"), /not installed/);
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        rmrf(home);
    }
});
