#!/usr/bin/env node
// Analyze request-dump prefix overlap for cache-hit diagnosis.
//
// Usage:
//   node tools/analyze-dumps.mjs [dump-dir] [session-id?]
//   node tools/analyze-dumps.mjs              # all sessions in default dir
//   node tools/analyze-dumps.mjs -- sid       # filter by session id
//
// Default dump dir: ~/.local/state/billion-context/dumps
//
// For each consecutive pair of dumps (A → B), computes how much of A's
// serialized messages array survives as a PREFIX of B. Without compression
// the ratio is ~100% (B = A + appended messages). Compression, tag
// re-estimation, or message rewrites cause the ratio to drop — pinpointing
// the cache-breaker.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const dir = args[0] || join(homedir(), ".local", "state", "billion-context", "dumps");
const sid = args[1];

let files;
try {
    files = readdirSync(dir)
        .filter((f) => f.endsWith(".json") && (!sid || f.includes(sid)))
        .sort();
} catch {
    console.error(`dump dir not found: ${dir}`);
    process.exit(1);
}

if (files.length === 0) {
    console.error(`No dump files in ${dir}${sid ? ` matching "${sid}"` : ""}`);
    process.exit(1);
}

const sessions = new Map();
for (const f of files) {
    const m = f.match(/req-\d+-(.+)\.json$/);
    const s = m ? m[1] : "?";
    if (!sessions.has(s)) sessions.set(s, []);
    sessions.get(s).push(f);
}

function load(f) {
    return JSON.parse(readFileSync(join(dir, f), "utf8"));
}

function msgKey(body) {
    return JSON.stringify(body.messages ?? []);
}

function prefixLen(a, b) {
    const min = Math.min(a.length, b.length);
    let i = 0;
    while (i < min && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
}

function firstDivergentMsg(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
    }
    return n < a.length ? n : -1;
}

function fmtPct(n) {
    return n >= 99.95 ? "100%" : n.toFixed(1) + "%";
}

for (const [session, sfiles] of sessions) {
    console.log(`\n=== session ${session} (${sfiles.length} dumps) ===`);
    console.log("#  msgs  Δmsgs  prefix_overlap  first_diff  verdict");
    console.log("-".repeat(72));

    let prevBody = null;
    let prevKey = null;
    sfiles.forEach((f, idx) => {
        const body = load(f);
        const key = msgKey(body);
        const msgs = body.messages?.length ?? 0;
        const short = f.replace(/req-\d+-/, "").replace(/\.json$/, "").slice(0, 8);

        if (prevKey === null) {
            console.log(`${String(idx).padStart(2)}  ${String(msgs).padStart(4)}     -              -          ${short}`);
        } else {
            const plen = prefixLen(prevKey, key);
            const overlap = prevKey.length === 0 ? 100 : (plen / prevKey.length) * 100;
            const diff = firstDivergentMsg(prevBody.messages ?? [], body.messages ?? []);
            const verdict =
                overlap >= 99.5 ? "stable" :
                overlap >= 80 ? "partial" :
                "PREFIX CHANGED";
            console.log(
                `${String(idx).padStart(2)}  ${String(msgs).padStart(4)}  ${String(msgs - (prevBody.messages?.length ?? 0)).padStart(5)}  ${fmtPct(overlap).padStart(13)}  ${
                    diff < 0 ? "none" : "msg[" + diff + "]"
                }`.padEnd(58) + verdict,
            );
        }
        prevBody = body;
        prevKey = key;
    });
}

console.log(
    `\nLegend: prefix_overlap = how much of the previous dump's messages survive` +
    `\n  as a prefix of this dump. ~100% = no compression/prefix change (good).` +
    `\n  first_diff = index of the first message that changed (or "none").\n`,
);
