// #5548 P3: CI gate for announcements/remote.json — the SAME validator the
// client runs (src/remote-notices.ts parseRemoteDoc), so a bad push is
// rejected pre-merge instead of silently failing open on every client.
// Usage: node --import tsx scripts/validate-remote-announcements.ts [path]
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseRemoteDoc, DEFAULT_ANNOUNCEMENTS_URL } from "../src/remote-notices.js";

const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(import.meta.dirname, "..", "announcements", "remote.json");
const failures: string[] = [];
let docText: string;
try {
    docText = readFileSync(target, "utf8");
} catch {
    console.error(`[validate-announcements] cannot read ${target}`);
    console.error("[validate-announcements] the client fetches " + DEFAULT_ANNOUNCEMENTS_URL);
    console.error("[validate-announcements] — commit announcements/remote.json ({v:1, entries:[...]}) to master.");
    process.exit(1);
}
if (docText.length > 512 * 1024) failures.push(`document exceeds the ${512 * 1024}-byte client cap (${docText.length} bytes)`);
let raw: unknown;
try {
    raw = JSON.parse(docText);
} catch (e) {
    failures.push(`not valid JSON: ${String(e)}`);
    raw = {};
}
const parsed = parseRemoteDoc(raw);
if (parsed.error) failures.push(`parse: ${parsed.error}`);
for (const rec of parsed.entries) {
    if (!rec.ctaUrl && !rec.desc) failures.push(`entry ${rec.id}: empty notice (neither desc nor a CTA) — useless on purpose, remove it`);
}
if (failures.length > 0) {
    for (const f of failures) console.error(`[validate-announcements] ✗ ${f}`);
    process.exit(1);
}
console.log(`[validate-announcements] OK — ${parsed.entries.length} entr${parsed.entries.length === 1 ? "y" : "ies"} valid in ${path.relative(path.join(import.meta.dirname, ".."), target)}`);
