// #5152 test fixture: a HEALTHY receiver in its own process. It answers every
// beat and records the timestamp, so the test can prove the sender kept
// reaching it while the sender's own thread was pinned. An in-process receiver
// would be pinned by the same block and the proof would be vacuous.
import http from "node:http";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) throw new Error("usage: issue5152-beat-receiver.mjs <beat-log-path>");
const T0 = Date.now();
const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
        appendFileSync(out, `${Date.now() - T0}\n`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
});
server.listen(0, "127.0.0.1", () => {
    // Publish the port ATOMICALLY. appendFileSync opens (creates) the file
    // before writing its bytes, so a parent polling existsSync() can observe an
    // empty file and read Number("") === 0 — the #5152 CI flake. rename() is
    // atomic within one filesystem, so every observer sees either no file or
    // the complete port.
    const tmp = `${out}.port.tmp`;
    writeFileSync(tmp, String(server.address().port));
    renameSync(tmp, `${out}.port`);
});
