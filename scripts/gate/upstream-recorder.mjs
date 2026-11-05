#!/usr/bin/env node
// upstream-recorder.mjs — logging reverse proxy between bili and the real
// model API. Every request is appended (JSONL) to RECORDER_OUT before being
// forwarded verbatim to RECORDER_TARGET. This gives the plugin lanes
// wire-level truth: which tools were declared, whether the nudge/compress
// system prompt actually reached the model (#3401 broke exactly this and no
// internal log caught it), and how context size evolves across turns.
//
//   node upstream-recorder.mjs &
//   env RECORDER_PORT=18099 RECORDER_TARGET=http://127.0.0.1:8199 \
//       RECORDER_OUT=/work/plugin-lanes/upstream.jsonl
//
// Records one line per request:
//   {t, method, path, headers, body}   // body parsed when JSON, else string
// Response timing/size is recorded as {t, status, ms, bytes} lines with
// tag:"resp" and the matching request seq.

import http from "node:http";
import { appendFileSync } from "node:fs";

const PORT = Number(process.env.RECORDER_PORT || 18099);
const TARGET = process.env.RECORDER_TARGET || "http://127.0.0.1:8199";
const OUT = process.env.RECORDER_OUT || "/dev/stdout";
const target = new URL(TARGET);

let seq = 0;
// auth headers must never reach the JSONL artifact — bili forwards the model
// API key into this hop on every request.
const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"]);
let writeWarned = false;
function recordLine(obj) {
  try { appendFileSync(OUT, JSON.stringify(obj) + "\n"); }
  catch (err) {
    if (!writeWarned) { writeWarned = true; process.stderr.write(`upstream-recorder: cannot write ${OUT}: ${String(err)}\n`); }
  }
}
function maskHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? "***" : v;
  return out;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const my = ++seq;
    const body = Buffer.concat(chunks);
    let parsed = null;
    try { parsed = JSON.parse(body.toString("utf8")); } catch { parsed = null; }
    const rec = {
      seq: my,
      tag: "req",
      t: new Date().toISOString(),
      method: req.method,
      path: req.url,
      headers: maskHeaders(req.headers),
      body: parsed !== null ? parsed : body.toString("utf8").slice(0, 4000),
    };
    recordLine(rec);

    const upstreamHeaders = { ...req.headers };
    delete upstreamHeaders.host;
    delete upstreamHeaders["content-length"];
    const upReq = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        method: req.method,
        path: (target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "")) + req.url,
        headers: { ...upstreamHeaders, host: target.host },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        let bytes = 0;
        upRes.on("data", (c) => { bytes += c.length; res.write(c); });
        upRes.on("end", () => {
          res.end();
          recordLine({ seq: my, tag: "resp", t: new Date().toISOString(), status: upRes.statusCode, bytes });
        });
      },
    );
    upReq.on("error", (err) => {
      recordLine({ seq: my, tag: "error", err: String(err) });
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("recorder upstream error: " + String(err));
    });
    upReq.end(body);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`upstream-recorder listening on 127.0.0.1:${PORT} -> ${TARGET} (log ${OUT})\n`);
});
