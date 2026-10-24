// #4126 — snapshot-render evidence gate: rows the client stopped resending must
// never resurrect ahead of the fold anchor.
//
// Mechanism: on the D-lane (snapshot render engaged — non-plugin requests on a
// session with readable unified storage), the outbound prefix renders stored
// transcript rows up to the backward-chain join point. Pre-fix the render was
// WHOLESALE (every row minus covered rows), so content the client's own local
// compaction had consumed — but that still sat in the append-only unified log
// (or in a frozen pluginSnapshot of an older view) — re-materialized into the
// prefix every round, ahead of the synthesized fold anchor: the invariant-judge
// I2 carrier-drift signature, lossless while byte-stable, a latent cache seam
// for the round that stops rendering it.
//
// Pinned both directions (#3617 gate discipline):
//   (A) hole resend — the client drops a middle turn block (boundary-aligned,
//       self-consistent view, like a real local compaction): ZERO violations,
//       and the fold carrier SURVIVES (folded stays true — the block's coverage
//       still resolves even though the client consumed surrounding content);
//   (B) steady full-resend — stays green AND byte-stable across rounds (the
//       gate must not over-suppress rows the client still claims);
//   (C) D-lane engagement proof — metadata.snapshotRenderTurns > 0, otherwise
//       (A)/(B) would pass vacuously through the legacy path.
//
// Deterministic: listen(0) ports, fixed conversation id, linear token growth
// against an 8K window so the preflight fold lands well inside the cap.
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest, peekSession } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { _setInvariantJudgeForTest, type JudgeVerdict } from "../src/invariant-judge.ts";

const root = mkdtempSync(join(tmpdir(), "bili-snap-holes-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;
process.env.NODE_ENV = "test";
// Force the D-lane on regardless of the rollout percent (default 0%): without
// this the scenario below degrades to the closed legacy path and pins nothing.
process.env.BILI_ROLLOUT_SNAPSHOT_RENDER = "1";

const CONV = "snap-holes-4126";
const FILLER = "lorem ipsum dolor sit amet ";

type ToolMsg = { role: "assistant"; content: null; tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> };
type ResMsg = { role: "tool"; tool_call_id: string; content: string };
type TextMsg = { role: "user"; content: string };
type Msg = TextMsg | ToolMsg | ResMsg;

const upstreamBodies: string[] = [];
async function harness() {
  _resetSessionsForTest();
  _resetPluginStateForTest();
  resetToolRingForTest();
  _setForTest({});
  const store = new SessionStore({ dir: join(root, "sessions"), enabled: true, debounceMs: 5 });
  _setStoreForTest(store);
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      // Substantive: preflight compression asks this mock for summaries and the
      // kernel rejects sub-minimum-size summaries.
      res.end(JSON.stringify({ id: "chat_fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: `ok ${FILLER.repeat(18)}` }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const uaddr = upstream.address();
  assert(uaddr && typeof uaddr === "object");
  const upstreamUrl = `http://127.0.0.1:${uaddr.port}`;
  const proxy = await startServer({ port: 0, host: "127.0.0.1", upstream: upstreamUrl, routes: { [upstreamUrl]: { models: { "model-test": { context: 8000 } } } }, modelContextLimit: 8000, kernelConfig: defaultConfig(8000), compress: { injectTool: false, injectNudge: false, preserveRecentMessages: 1, preserveRecentTokens: 0, minCompressRangeChars: 100 }, promptCache: { routing: "auto" }, sessionHeader: "x-acp-session", log: false, debug: false, passthrough: false, autoUpdate: false, mitm: { enabled: false, domains: [] } } as ProxyOptions);
  await once(proxy, "listening");
  const paddr = proxy.address();
  assert(paddr && typeof paddr === "object");
  const origin = `http://127.0.0.1:${paddr.port}`;
  // MAIN lane deliberately: no x-bili-plugin headers, so pluginMode stays false
  // and maybeSnapshotView may engage (sticky pluginAgent would block it).
  const send = async (messages: Msg[]) => {
    const r = await fetch(`${origin}/bili/${upstreamUrl}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": CONV }, body: JSON.stringify({ model: "model-test", messages, max_tokens: 1024, stream: false }) });
    assert.equal(r.status, 200, await r.text());
  };
  return { send, close: async () => { store.cancelAll(); proxy.close(); proxy.closeIdleConnections?.(); upstream.close(); upstream.closeIdleConnections?.(); await Promise.all([once(proxy, "close"), once(upstream, "close")]); } };
}

test("#4126: hole resends never resurrect dropped rows ahead of the fold anchor", async () => {
  const h = await harness();
  const seen: JudgeVerdict[] = [];
  _setInvariantJudgeForTest(true, (v) => seen.push(v));
  try {
    // Phase A: tool-pair growth until the preflight fold lands (3 msgs/turn).
    const history: Msg[] = [];
    let foldStep = -1;
    for (let n = 0; n < 40 && foldStep < 0; n++) {
      history.push({ role: "user", content: `question ${n} ${FILLER.repeat(12)}` });
      history.push({ role: "assistant", content: null, tool_calls: [{ id: `call_${n}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `C:\\Users\\dog\\AppData\\Local\\Programs\\DSH NEXT\\resources\\app\\file_${n}.json` }) } }] });
      history.push({ role: "tool", tool_call_id: `call_${n}`, content: `<path>C:\\Users\\dog\\AppData\\Local\\Programs\\DSH NEXT\\resources\\app\\file_${n}.json</path>\n${FILLER.repeat(24)}` });
      await h.send(history.map((m) => ({ ...m })));
      if (seen.some((v) => v.folded)) foldStep = n;
    }
    assert.ok(foldStep >= 0, `preflight never folded in 40 turns — harness broken (last verdicts: ${JSON.stringify(seen.slice(-2))})`);
    const foldVerdictIdx = seen.findIndex((v) => v.folded);

    // (C) D-lane engaged — otherwise (A)/(B) pass vacuously through the legacy path.
    const s = peekSession(CONV);
    assert.ok(s, "session missing");
    const snapTurns = Number(s.metadata["snapshotRenderTurns"] ?? 0);
    assert.ok(snapTurns > 0, `D-lane never engaged: snapshotRenderTurns=${snapTurns} degrade=${String(s.metadata["snapshotRenderDegradeReason"] ?? "-")}`);

    // (B) Steady full-resend: green AND byte-stable (cache-seam property).
    const bBefore = seen.length;
    const bodyBefore = upstreamBodies.length;
    for (let k = 0; k < 3; k++) await h.send(history.map((m) => ({ ...m })));
    const badSteady = seen.slice(bBefore).filter((v) => !v.ok);
    assert.equal(badSteady.length, 0, JSON.stringify(badSteady.map((v) => ({ matched: v.matched, total: v.total, violations: v.violations }))));
    const steady = upstreamBodies.slice(bodyBefore, bodyBefore + 3);
    assert.equal(steady[1], steady[0], "steady-round egress drifted (byte-stability broken)");
    assert.equal(steady[2], steady[0], "steady-round egress drifted (byte-stability broken)");

    // (A) Client local-compaction consumes a MIDDLE turn block: boundary-aligned
    // (whole 3-msg turns, so the remaining view is internally consistent — no
    // orphaned call/result pairs), head preserved like a pinned first message.
    const TURN = 3;
    const start = Math.ceil((history.length * 0.3) / TURN) * TURN;
    const holed: Msg[] = [history[0]!, ...history.slice(start)];
    assert.ok(holed.length < history.length - 1, "hole did not remove any turns");
    const aBefore = seen.length;
    for (let k = 0; k < 3; k++) await h.send(holed.map((m) => ({ ...m })));
    const postHole = seen.slice(aBefore);
    const badHole = postHole.filter((v) => !v.ok);
    assert.equal(badHole.length, 0, JSON.stringify(badHole.map((v) => ({ matched: v.matched, total: v.total, violations: v.violations }))));
    // The fold carrier must SURVIVE the client's compaction: the block's
    // coverage still resolves (rows keep their ids) even though the client
    // consumed content around it. If the carrier vanished these verdicts would
    // be folded=false and the assertion above would pass vacuously.
    assert.ok(postHole.every((v) => v.folded), `fold carrier lost after client compaction: ${JSON.stringify(postHole.map((v) => v.folded))}`);

    // No carrier-drift anywhere from the fold onward (the #4126 signature).
    const drift = seen.slice(foldVerdictIdx).flatMap((v) => (v.violations ?? []).filter((x) => x.kind === "carrier-drift"));
    assert.equal(drift.length, 0, JSON.stringify(drift));
  } finally {
    _setInvariantJudgeForTest(false);
    await h.close();
  }
});
