// #2462: known high-cost third-party plugin detection (dsh auto-review) + the
// web notice that surfaces it. Distinct from the compression-conflict ledger —
// these plugins are not compressors; they burn prefix-cache hits host-side and
// bili already isolates them into a sub-session.
// Detection keys off ENABLEMENT, not installation: the advisory fires only when
// the dsh loader id (`auto-review`) appears as a top-level, NOT-disabled entry in
// cordis.patch.yml (#3838) — mere presence in package.json deps must NOT trigger
// it (installed-but-off / bundled), and neither must an explicitly disabled entry.
// And the id match must be confirmed by PACKAGE IDENTITY (#7068, the second
// false positive — a community plugin whose id collides): the entry's `name`
// line must name the official package (full or unscoped), or — for entries
// predating the name convention — the package must be installed in a profile
// bundle. A present-but-different name is a verdict: no advisory.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";

import { detectCostAdvisories, _clearCostAdvisoryCache } from "../src/plugin-advisory.js";
import { WEB_CLIENT } from "../src/web/client.ts";

const PLUGIN = "@deepseek-ai/dsh-experimental-auto-review";
const PATCH_ID = "auto-review";
const ISSUE_URL = "https://github.com/ranxianglei/billion-context/issues/2462";

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function hermeticEnv(root: string): NodeJS.ProcessEnv {
    return { HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), DSH_HOME: path.join(root, "dsh") };
}
function assertTestOwned(file: string, root: string): void {
    const rel = path.relative(root, file);
    assert.ok(!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`),
        `refusing to write outside test-owned root ${root}: ${file}`);
}
function writeProfilePatch(root: string, profile: string, ids: string[]): void {
    // The official plugin's entry carries its package name (#7068 identity
    // rule) — model the real shape for the auto-review id.
    writeProfilePatchLines(root, profile, ids.flatMap((id) =>
        id === PATCH_ID ? [`- id: ${id}`, `  name: ${PLUGIN}`] : [`- id: ${id}`]));
}
function writeProfilePatchLines(root: string, profile: string, lines: string[]): void {
    const file = path.join(root, "dsh", "profiles", profile, "cordis.patch.yml");
    assertTestOwned(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [...lines, ""].join("\n"));
}
function writeProfilePkg(root: string, pkg: Record<string, unknown>): void {
    const file = path.join(root, "dsh", "profiles", "main", "package.json");
    assertTestOwned(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pkg));
}
function writeProfilePluginPkg(root: string, profile: string, pkg: string): void {
    const file = path.join(root, "dsh", "profiles", profile, "node_modules", ...pkg.split("/"), "package.json");
    assertTestOwned(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name: pkg, version: "0.2.0-rc.2" }));
}

test("#2462: enabling auto-review in cordis.patch.yml yields exactly one cost advisory", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-hit-");
    writeProfilePatch(root, "main", ["llm-pi-ai", "agent-default-model", PATCH_ID]);
    const res = detectCostAdvisories(hermeticEnv(root));
    assert.equal(res.length, 1);
    assert.equal(res[0]?.id, PLUGIN);
    assert.equal(res[0]?.client, "dsh");
    assert.equal(res[0]?.issueUrl, ISSUE_URL);
});

test("#2462: installed-but-NOT-enabled yields no advisory (the core gate)", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-installed-off-");
    writeProfilePkg(root, { dependencies: { [PLUGIN]: "0.2.0-rc.2", "billion-context": "^0.1.0" } });
    writeProfilePatch(root, "main", ["llm-pi-ai", "agent-default-model"]);
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), []);
});

test("#2462: enabled via a bundle (no direct dep in package.json) still reports", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-bundle-");
    writeProfilePkg(root, { dependencies: { "billion-context": "^0.1.0" }, dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } } });
    writeProfilePatch(root, "main", [PATCH_ID]);
    const res = detectCostAdvisories(hermeticEnv(root));
    assert.equal(res.length, 1);
    assert.equal(res[0]?.id, PLUGIN);
});

test("#2462: other loader ids without auto-review yield no advisory", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-miss-");
    writeProfilePatch(root, "main", ["llm-pi-ai", "agent-default-model"]);
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), []);
});

test("#2462: missing profiles root / missing patch file yield empty without throwing", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-empty-");
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), []);
    const root2 = tmp("bili-2462-nopatch-");
    writeProfilePkg(root2, { dependencies: {} });
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root2)), []);
});

test("#2462: quoted and commented patch ids are recognised", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-quoted-");
    const file = path.join(root, "dsh", "profiles", "main", "cordis.patch.yml");
    assertTestOwned(file, root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '- id: "auto-review"   # turned on\n  name: @deepseek-ai/dsh-experimental-auto-review\n');
    const res = detectCostAdvisories(hermeticEnv(root));
    assert.equal(res.length, 1);
    assert.equal(res[0]?.id, PLUGIN);
});

test("#2462: multiple profiles enabling the same plugin report once", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-multi-");
    writeProfilePatch(root, "a", [PATCH_ID]);
    writeProfilePatch(root, "b", [PATCH_ID]);
    assert.equal(detectCostAdvisories(hermeticEnv(root)).length, 1);
});

test("#3838: entry present but disabled:true yields NO advisory (explicitly off plugins must not warn)", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-3838-disabled-");
    writeProfilePatchLines(root, "main", ["- id: llm-pi-ai", `- id: ${PATCH_ID}`, "  disabled: true"]);
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), []);
});

test("#3838: disabled:false is NOT disabling — explicitly enabled still reports", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-3838-enabled-flag-");
    writeProfilePatchLines(root, "main", [`- id: ${PATCH_ID}`, "  disabled: false", `  name: ${PLUGIN}`]);
    assert.equal(detectCostAdvisories(hermeticEnv(root)).length, 1);
});

test("#3838: disabled:true on an UNRELATED entry does not silence the advisory", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-3838-other-disabled-");
    writeProfilePatchLines(root, "main", ["- id: other-plugin", "  disabled: true", `- id: ${PATCH_ID}`, `  name: ${PLUGIN}`]);
    assert.equal(detectCostAdvisories(hermeticEnv(root)).length, 1);
});

test("#3838: disabled in one profile but enabled in another still reports once", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-3838-cross-profile-");
    writeProfilePatchLines(root, "a", [`- id: ${PATCH_ID}`, "  disabled: true"]);
    writeProfilePatch(root, "b", [PATCH_ID]);
    assert.equal(detectCostAdvisories(hermeticEnv(root)).length, 1);
});

test("#7068: community plugin with the same loader id but a different name yields NO advisory (the id-collision false positive)", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-7068-community-");
    writeProfilePatchLines(root, "main", [`- id: ${PATCH_ID}`, "  name: dsh-auto-review"]);
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), []);
});

test("#7068: a different name is a verdict — even with the official package installed on disk, NO advisory", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-7068-name-verdict-");
    writeProfilePatchLines(root, "main", [`- id: ${PATCH_ID}`, "  name: dsh-auto-review"]);
    writeProfilePluginPkg(root, "main", PLUGIN);
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), []);
});

test("#7068: nameless enabled entry + official package installed in a profile bundle reports (old-format fallback)", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-7068-noname-disk-");
    writeProfilePatchLines(root, "main", [`- id: ${PATCH_ID}`]);
    writeProfilePluginPkg(root, "main", PLUGIN);
    assert.equal(detectCostAdvisories(hermeticEnv(root)).length, 1);
});

test("#7068: nameless enabled entry + official package NOT installed yields NO advisory", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-7068-noname-nodisk-");
    writeProfilePatchLines(root, "main", [`- id: ${PATCH_ID}`]);
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), []);
});

test("#7068: unscoped official name (without the @scope/ prefix) still reports", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-7068-unscoped-");
    writeProfilePatchLines(root, "main", [`- id: ${PATCH_ID}`, "  name: dsh-experimental-auto-review"]);
    assert.equal(detectCostAdvisories(hermeticEnv(root)).length, 1);
});

test("#2462: result cached within TTL, invalidated by _clearCostAdvisoryCache", () => {
    _clearCostAdvisoryCache();
    const root = tmp("bili-2462-cache-");
    writeProfilePatch(root, "main", [PATCH_ID]);
    assert.equal(detectCostAdvisories(hermeticEnv(root)).length, 1);
    fs.rmSync(path.join(root, "dsh", "profiles", "main", "cordis.patch.yml"));
    assert.equal(detectCostAdvisories(hermeticEnv(root)).length, 1, "cached result returned before TTL expires");
    _clearCostAdvisoryCache();
    assert.deepEqual(detectCostAdvisories(hermeticEnv(root)), [], "after clearing the cache the re-scan sees the removal");
});

type Adv = { id?: string; name?: string; client?: string; issueUrl?: string };
type Strs = { on: string; desc: string; hint: string };
function bannerHtml(): (advs: Adv[], s: Strs) => string {
    const src = WEB_CLIENT;
    const s = src.indexOf("function escapeHtml");
    const e = src.indexOf("window.bili_pluginAdvisoryBanner = bili_pluginAdvisoryBanner;");
    assert.ok(s >= 0 && e > s, "plugin-advisory banner helpers missing from WEB_CLIENT");
    (globalThis as { window?: Record<string, unknown> }).window = {};
    const fn = new Function(src.slice(s, e) + "\nreturn bili_pluginAdvisoryBanner;");
    return fn() as (advs: Adv[], s: Strs) => string;
}

test("#2462: banner names the plugin, links the issue, shows title/desc/hint", () => {
    const f = bannerHtml();
    const out = f([{ name: PLUGIN, issueUrl: ISSUE_URL }], { on: "High-cost plugin detected", desc: "desc text", hint: "hint text" });
    assert.ok(out.includes('<div class="banner-title">High-cost plugin detected</div>'));
    assert.ok(out.includes("<strong>" + PLUGIN + "</strong>"));
    assert.ok(out.includes('href="' + ISSUE_URL + '" target="_blank" rel="noopener"'));
    assert.ok(out.includes("desc text"));
    assert.ok(out.includes("hint text"));
});

test("#2462: banner escapes HTML in plugin name and url", () => {
    const f = bannerHtml();
    const out = f([{ name: "a<b&c", issueUrl: "https://e.com/?a=1&b=2" }], { on: "T", desc: "D", hint: "H" });
    assert.ok(out.includes("&lt;b&amp;c"), "name escaped");
    assert.ok(out.includes("https://e.com/?a=1&amp;b=2"), "url escaped in href");
    assert.ok(!out.includes("<b&c"), "raw < never leaks unescaped");
});

test("#2462: wiring drift guards (seam export, banner branch, i18n refs, payload field)", () => {
    assert.ok(WEB_CLIENT.includes("window.bili_pluginAdvisoryBanner = bili_pluginAdvisoryBanner;"), "seam export present");
    assert.ok(WEB_CLIENT.includes('$("plugin-advisory-banner")'), "renderBanners reads the banner slot");
    for (const k of ['t("pluginadv.on")', 't("pluginadv.desc")', 't("pluginadv.hint")']) {
        assert.ok(WEB_CLIENT.includes(k), `i18n key ${k} referenced literally (dead-key lint)`);
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const adminSrc = fs.readFileSync(join(here, "..", "src", "server", "admin.ts"), "utf8");
    assert.ok(adminSrc.includes("pluginAdvisories: detectCostAdvisories(process.env)"), "overview/status payload carries the field");
});
