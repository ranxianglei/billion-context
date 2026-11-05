// #2861: known host-side metering plugin detection (dsh-context) + the web
// notice telling users its context figures are the pre-compression local
// caliber. Conservative triple gate per profile: direct dependency in the
// manifest AND selection in dsh.profile.bundles AND bili's own dsh lane present
// in the same profile; a `disabled: true` patch override suppresses.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";

import {
    detectHostPluginNotices,
    dismissedHostPlugins,
    dismissHostPlugin,
    visibleHostPluginNotices,
    _clearHostPluginNoticeCache,
} from "../src/host-plugin-notice.js";
import { WEB_CLIENT } from "../src/web/client.ts";
import { MESSAGES } from "../src/web/i18n.ts";

const DEP = "dsh-context";
const BILI = "billion-context";

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function hermeticEnv(root: string): NodeJS.ProcessEnv {
    return { HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), XDG_STATE_HOME: path.join(root, "state"), DSH_HOME: path.join(root, "dsh") };
}
function assertTestOwned(file: string, root: string): void {
    const rel = path.relative(root, file);
    assert.ok(!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`),
        `refusing to write outside test-owned root ${root}: ${file}`);
}
function writeProfilePkg(root: string, profile: string, pkg: Record<string, unknown>): void {
    const file = path.join(root, "dsh", "profiles", profile, "package.json");
    assertTestOwned(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pkg));
}
function writeProfilePatch(root: string, profile: string, lines: string[]): void {
    const file = path.join(root, "dsh", "profiles", profile, "cordis.patch.yml");
    assertTestOwned(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [...lines, ""].join("\n"));
}
function fullGatePkg(): Record<string, unknown> {
    return { dependencies: { [DEP]: "^0.69.0", [BILI]: "^0.1.0" }, dsh: { profile: { bundles: [DEP] } } };
}

test("#2861: triple gate satisfied yields exactly one notice with profile attribution", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-hit-");
    writeProfilePkg(root, "main", fullGatePkg());
    const res = detectHostPluginNotices(hermeticEnv(root));
    assert.equal(res.length, 1);
    assert.equal(res[0]?.id, DEP);
    assert.equal(res[0]?.name, DEP);
    assert.equal(res[0]?.client, "dsh");
    assert.equal(res[0]?.profile, "main");
});

test("#2861: missing direct dependency yields no notice (transitive dep alone is not evidence)", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-nodep-");
    writeProfilePkg(root, "main", { dependencies: { [BILI]: "^0.1.0" }, dsh: { profile: { bundles: [DEP] } } });
    assert.deepEqual(detectHostPluginNotices(hermeticEnv(root)), []);
});

test("#2861: dependency installed but NOT selected in dsh.profile.bundles yields no notice", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-unselected-");
    writeProfilePkg(root, "main", { dependencies: { [DEP]: "^0.69.0", [BILI]: "^0.1.0" }, dsh: { profile: { bundles: ["some-other-bundle"] } } });
    assert.deepEqual(detectHostPluginNotices(hermeticEnv(root)), []);
});

test("#2861: gate satisfied but no bili dsh lane in the profile yields no notice (no compression -> figures accurate)", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-nobili-");
    writeProfilePkg(root, "main", { dependencies: { [DEP]: "^0.69.0" }, dsh: { profile: { bundles: [DEP] } } });
    assert.deepEqual(detectHostPluginNotices(hermeticEnv(root)), []);
});

test("#2861: disabled: true override on the loader id suppresses the notice", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-disabled-");
    writeProfilePkg(root, "main", fullGatePkg());
    writeProfilePatch(root, "main", ["- id: llm-pi-ai", `- id: ${DEP}`, "  disabled: true"]);
    assert.deepEqual(detectHostPluginNotices(hermeticEnv(root)), []);
});

test("#2861: disabled: true on an UNRELATED entry does not suppress (attribution reset works)", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-otherdisabled-");
    writeProfilePkg(root, "main", fullGatePkg());
    writeProfilePatch(root, "main", ["- id: other-plugin", "  disabled: true", `- id: ${DEP}`]);
    assert.equal(detectHostPluginNotices(hermeticEnv(root)).length, 1);
});

test("#2861: non-id list items between entries do not leak disabled attribution", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-insert-");
    writeProfilePkg(root, "main", fullGatePkg());
    writeProfilePatch(root, "main", ["- insert:", "  - some-bare-entry", "  disabled: true", `- id: ${DEP}`]);
    assert.equal(detectHostPluginNotices(hermeticEnv(root)).length, 1);
});

test("#2861: malformed package.json / missing profiles root yield empty without throwing", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-malformed-");
    const file = path.join(root, "dsh", "profiles", "main", "package.json");
    assertTestOwned(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    assert.deepEqual(detectHostPluginNotices(hermeticEnv(root)), []);
    const root2 = tmp("bili-2861-empty-");
    assert.deepEqual(detectHostPluginNotices(hermeticEnv(root2)), []);
});

test("#2861: multiple profiles satisfying the gate report once", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-multi-");
    writeProfilePkg(root, "a", fullGatePkg());
    writeProfilePkg(root, "b", fullGatePkg());
    assert.equal(detectHostPluginNotices(hermeticEnv(root)).length, 1);
});

test("#2861: result cached within TTL, invalidated by cache clear", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-cache-");
    writeProfilePkg(root, "main", fullGatePkg());
    assert.equal(detectHostPluginNotices(hermeticEnv(root)).length, 1);
    fs.rmSync(path.join(root, "dsh", "profiles", "main", "package.json"));
    assert.equal(detectHostPluginNotices(hermeticEnv(root)).length, 1, "cached result returned before TTL expires");
    _clearHostPluginNoticeCache();
    assert.deepEqual(detectHostPluginNotices(hermeticEnv(root)), [], "after clearing the cache the re-scan sees the removal");
});

test("#2861: dismissal round-trip — server-side state silences every reader, persists, idempotent", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-dismiss-");
    const env = hermeticEnv(root);
    writeProfilePkg(root, "main", fullGatePkg());
    assert.equal(visibleHostPluginNotices(env).length, 1);
    assert.equal(dismissHostPlugin(DEP, env), true);
    assert.equal(visibleHostPluginNotices(env).length, 0, "dismissed notices are filtered out");
    const file = path.join(root, "state", "billion-context", "host-plugin-notices.json");
    assertTestOwned(file, root);
    const stored: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(stored, { dismissed: [DEP] });
    // fresh process simulation: detection cache gone, dismissal re-read from disk
    _clearHostPluginNoticeCache();
    assert.deepEqual(dismissedHostPlugins(env), new Set([DEP]));
    assert.equal(visibleHostPluginNotices(env).length, 0);
    assert.equal(dismissHostPlugin(DEP, env), true, "idempotent second dismiss");
});

test("#2861: dismissing an unknown id fails loud and leaves the state file untouched", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-unknown-");
    const env = hermeticEnv(root);
    assert.equal(dismissHostPlugin("not-a-known-plugin", env), false);
    assert.equal(fs.existsSync(path.join(root, "state", "billion-context", "host-plugin-notices.json")), false);
});

test("#2861: corrupt dismissal state degrades to empty set (never throws)", () => {
    _clearHostPluginNoticeCache();
    const root = tmp("bili-2861-corrupt-");
    const dir = path.join(root, "state", "billion-context");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "host-plugin-notices.json"), "{ broken");
    assert.deepEqual(dismissedHostPlugins(hermeticEnv(root)), new Set());
});

type Notice = { id?: string; name?: string; client?: string; profile?: string };
type Strs = { on: string; desc: string; hint: string; dismiss: string };
function bannerHtml(): (notices: Notice[], s: Strs) => string {
    const src = WEB_CLIENT;
    const s = src.indexOf("function escapeHtml");
    const e = src.indexOf("window.bili_hostPluginBanner = bili_hostPluginBanner;");
    assert.ok(s >= 0 && e > s, "host-plugin banner helpers missing from WEB_CLIENT");
    (globalThis as { window?: Record<string, unknown> }).window = {};
    const fn = new Function(src.slice(s, e) + "\nreturn bili_hostPluginBanner;");
    return fn() as (notices: Notice[], s: Strs) => string;
}

test("#2861: banner names the plugin, carries title/desc/hint and a dismiss button keyed by notice id", () => {
    const f = bannerHtml();
    const out = f([{ name: DEP, id: DEP }], { on: "Host-side plugin detected", desc: "desc text", hint: "hint text", dismiss: "Dismiss" });
    assert.ok(out.includes('<div class="banner-title">Host-side plugin detected</div>'));
    assert.ok(out.includes("<strong>" + DEP + "</strong>"));
    assert.ok(out.includes('data-hpid="' + DEP + '"'));
    assert.ok(out.includes(">Dismiss</button>"));
    assert.ok(out.includes("desc text"));
    assert.ok(out.includes("hint text"));
});

test("#2861: banner escapes HTML in plugin data", () => {
    const f = bannerHtml();
    const out = f([{ name: "a<b&c", id: 'x"<y' }], { on: "T", desc: "D", hint: "H", dismiss: "D2" });
    assert.ok(out.includes("&lt;b&amp;c"), "name escaped");
    assert.ok(out.includes('data-hpid="x&quot;&lt;y"'), "id escaped in attribute");
    assert.ok(!out.includes("<b&c"), "raw < never leaks unescaped");
});

test("#2861: wiring drift guards (seam export, banner slot, i18n refs, payload field, endpoint)", () => {
    assert.ok(WEB_CLIENT.includes("window.bili_hostPluginBanner = bili_hostPluginBanner;"), "seam export present");
    assert.ok(WEB_CLIENT.includes('$("host-plugin-banner")'), "loadOverview reads the banner slot");
    for (const k of ['t("hostplug.on")', 't("hostplug.desc")', 't("hostplug.hint")', 't("hostplug.dismiss_btn")', 't("hostplug.dismissed")']) {
        assert.ok(WEB_CLIENT.includes(k), `i18n key ${k} referenced literally (dead-key lint)`);
    }
    assert.ok(WEB_CLIENT.includes('API_ROOT + "/host-plugins/dismiss"'), "dismiss POST target present");
    const here = dirname(fileURLToPath(import.meta.url));
    const adminSrc = fs.readFileSync(join(here, "..", "src", "server", "admin.ts"), "utf8");
    assert.ok(adminSrc.includes("hostPluginNotices: visibleHostPluginNotices(process.env)"), "overview payload carries the field");
    assert.ok(adminSrc.includes('"/__bili/host-plugins/dismiss"'), "endpoint route present");
    const pageSrc = fs.readFileSync(join(here, "..", "src", "web", "page.ts"), "utf8");
    assert.ok(pageSrc.includes('id="host-plugin-banner"'), "page renders the banner slot");
});

test("#2861: i18n — hostplug.* key sets are identical across locales and non-empty", () => {
    const zhKeys = Object.keys(MESSAGES["zh-CN"]).filter((k) => k.startsWith("hostplug."));
    const enKeys = Object.keys(MESSAGES["en"]).filter((k) => k.startsWith("hostplug."));
    assert.deepEqual([...enKeys].sort(), [...zhKeys].sort(), "locale key sets match");
    assert.ok(zhKeys.length >= 5, "expected at least on/desc/hint/dismiss_btn/dismissed");
    for (const k of zhKeys) {
        assert.ok(MESSAGES["zh-CN"][k]?.length > 0 && MESSAGES["en"][k]?.length > 0, `${k} non-empty in both locales`);
    }
});

test("#3303: notice scopes the pre-compression claim to segment composition/timeline, not the headline size", () => {
    const zh = MESSAGES["zh-CN"]["hostplug.desc"] ?? "";
    const en = MESSAGES["en"]["hostplug.desc"] ?? "";
    assert.ok(!zh.includes("数值不准确"), "zh desc must not re-assert the headline numbers are inaccurate (the #3303 false alarm)");
    assert.ok(zh.includes("分段") || zh.includes("构成"), "zh desc must scope the pre-compression claim to segment composition");
    assert.ok(!/not\s+accurate|inaccurate/i.test(en), "en desc must not re-assert the headline figures are inaccurate (the #3303 false alarm)");
    assert.ok(/composition|segment|timeline/i.test(en), "en desc must scope the pre-compression claim to segment composition / timeline");
});
