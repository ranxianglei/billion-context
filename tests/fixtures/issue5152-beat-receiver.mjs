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
    // Publish atomically: the parent polls for existence, so a create-then-fill
    // sequence lets it read an EMPTY file (port 0). Write a temp name, then
    // rename — rename is atomic on POSIX, so the parent sees either nothing or
    // the full port string, never a half-written one.
    const portFile = `${out}.port`;
    writeFileSync(`${portFile}.tmp`, String(server.address().port));
    renameSync(`${portFile}.tmp`, portFile);
});
