// #5548 §五.4: CI gate for announcements/remote.json — runs the SAME validator
// module the client uses, so a bad push is blocked before merge instead of
// silently degrading on every install after push.
import fs from "node:fs";
import { applyRemoteDoc, REMOTE_DOC_CAP_BYTES } from "../src/notices.js";

const file = new URL("../announcements/remote.json", import.meta.url);
let raw: string;
try {
    raw = fs.readFileSync(file, "utf8");
} catch {
    console.log("announcements/remote.json absent — nothing to validate");
    process.exit(0);
}
if (Buffer.byteLength(raw) > REMOTE_DOC_CAP_BYTES) {
    console.error(`FAIL: announcements/remote.json exceeds ${REMOTE_DOC_CAP_BYTES} bytes`);
    process.exit(1);
}
let doc: unknown;
try {
    doc = JSON.parse(raw);
} catch (e) {
    console.error(`FAIL: announcements/remote.json is not valid JSON: ${String(e)}`);
    process.exit(1);
}
const res = applyRemoteDoc(doc);
for (const w of res.warnings ?? []) console.warn(`WARN: ${w}`);
if (!res.ok) {
    console.error(`FAIL: ${res.reason}`);
    process.exit(1);
}
console.log(`OK: ${res.entries.length} entr${res.entries.length === 1 ? "y" : "ies"} validated (v${(doc as { v: number }).v})`);
