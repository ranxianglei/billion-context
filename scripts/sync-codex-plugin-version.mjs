#!/usr/bin/env node
/**
 * 同步 Codex 插件相关的版本号。
 *
 * 背景：Codex 的 marketplace 更新检测靠的是「marketplace 清单里宣告的版本」
 * 与「已安装缓存目录的版本」之间的差异。上游仓库的版本号散落在多处
 * （package.json、.claude-plugin/marketplace.json、.claude-plugin/plugin.json），
 * 历史上已经出现过 package.json 是 0.1.204 而 .claude-plugin 里还写着
 * 0.1.188 的漂移 —— 这会让 Codex 侧看到过期的版本号。
 *
 * 本脚本把 package.json 的 version 作为唯一真相源，写回：
 *   1. .agents/plugins/marketplace.json          → Codex marketplace 清单
 *   2. plugins/codex/.codex-plugin/plugin.json   → Codex 插件清单
 *   3. .claude-plugin/marketplace.json           → Claude marketplace 清单
 *   4. .claude-plugin/plugin.json                → Claude 插件清单
 *
 * 用法：
 *   node scripts/sync-codex-plugin-version.mjs          # 校验 + 写入
 *   node scripts/sync-codex-plugin-version.mjs --check  # 只校验，有漂移则退出码 1
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");

function readJson(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return null;
    try {
        return JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch (err) {
        console.error(`[sync-codex-plugin-version] ${rel} 不是合法 JSON：${err.message}`);
        process.exit(1);
    }
}

function writeJson(rel, data) {
    const abs = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const pkg = readJson("package.json");
if (!pkg) {
    console.error("[sync-codex-plugin-version] 找不到 package.json");
    process.exit(1);
}
const version = pkg.version;
if (typeof version !== "string" || !version.trim()) {
    console.error("[sync-codex-plugin-version] package.json 的 version 缺失");
    process.exit(1);
}

const targets = [
    { rel: ".agents/plugins/marketplace.json", apply: (d) => {
        for (const p of d.plugins ?? []) {
            if (p.name === "billion-context") p.version = version;
        }
    } },
    { rel: "plugins/codex/.codex-plugin/plugin.json", apply: (d) => {
        d.version = version;
    } },
    { rel: ".claude-plugin/marketplace.json", apply: (d) => {
        for (const p of d.plugins ?? []) {
            if (p.name === "billion-context") p.version = version;
        }
    } },
    { rel: ".claude-plugin/plugin.json", apply: (d) => {
        d.version = version;
    } },
];

const drifted = [];

for (const t of targets) {
    const data = readJson(t.rel);
    if (!data) {
        // 缺文件不是可跳过状态：四个 manifest 是固定契约，少一个说明仓库
        // 树被破坏或 targets 列表过期。写入模式跳过会静默产出一个缺文件
        // 的“已同步”；--check 模式跳过等于把发版守卫钻了个洞（缺失照样绿）。
        // 例外：预 #4449 的老 lane（release-bugfix.yml 的存在性守卫）本来
        // 就没有这个脚本，不会走到这里。
        console.error(`[sync-codex-plugin-version] 缺少 manifest：${t.rel} — 不允许跳过，请修复仓库树或更新 targets 列表`);
        process.exit(1);
    }
    const before = JSON.stringify(data);
    t.apply(data);
    const after = JSON.stringify(data);
    if (before === after) {
        console.log(`[sync-codex-plugin-version] OK   ${t.rel} 已是 ${version}`);
        continue;
    }
    drifted.push(t.rel);
    if (CHECK_ONLY) {
        console.log(`[sync-codex-plugin-version] 漂移 ${t.rel} 需要同步到 ${version}`);
    } else {
        writeJson(t.rel, data);
        console.log(`[sync-codex-plugin-version] 同步 ${t.rel} → ${version}`);
    }
}

if (CHECK_ONLY && drifted.length > 0) {
    console.error(`[sync-codex-plugin-version] ${drifted.length} 个文件的版本号与 package.json 不一致`);
    process.exit(1);
}

console.log(`[sync-codex-plugin-version] 完成，唯一真相源版本 = ${version}`);
