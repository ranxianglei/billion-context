// Empirical repro matrix for #1908 (fold-state invalidation on the anthropic wire).
//
// The reporter's chain is Claude Code → cc-switch → bili → upstream, and the
// reported death was: wire re-inflated to raw scale while the fold ledger still
// said "covered / 0 compressible ranges". The open question this file answers
// empirically: WHAT invalidates the fold records — and specifically whether
// switching models mid-conversation (what cc-switch does) loses the folds.
//
// Scenarios, each against a REAL proxy + fake anthropic upstream that demands
// one compress mid-conversation (same harness family as
// tests/tight-fold-summaries.test.ts):
//
//   M      — model switch on an identified session (x-acp-session header):
//            expectation from code reading: fold RETAINED (session id is the
//            client's own conversation id; model/origin/credentials are
//            deliberately NOT part of it — #286).
//   M-ANON — model switch on an anonymous session (no header, no pck —
//            prefix-affinity path): expectation: fold RETAINED (the content
//            chain is the only anchor; model is not hashed).
//   E      — one-byte edit of a COVERED old message (CC resume re-serialization
//            in the wild): expectation: fold LOST — the summary stays AND the
//            edited original re-enters the wire unfolded (double-count), with
//            no pressure to ever re-fold it. This is the #1908 death mechanism.
//            Under #1921 reconciliation this STAYS lost by design: a real edit
//            (normalized text differs) is never claimed — the honest path is
//            re-entry until the next fold pass covers it.
//   R      — whitespace churn of a COVERED old message (the benign half of the
//            same mechanism: client re-serialization that normalizes equal —
//            double spaces, tabs, trailing blanks). Pre-#1921 this lost the
//            fold exactly like E (byte identity is all the kernel had). With
//            fold reconciliation (repair default) the block re-anchors onto
//            the new id and the fold is RETAINED: summary on the wire, churned
//            original stripped, no re-inflation (#1921).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { rmrf } from "./tmp-rm.ts";

// F — fork the trailing history wholesale: keep the covered prefix
// byte-identical, replace everything after the first third with fresh branch
// content (a fork tool's divergence). Covered ids inside the replaced region
// go permanently missing (dead roster entries); the block must survive via
// the present prefix, the fork tail rides the wire as fresh unfolded
// material, and no ghost of the dropped region re-enters (#1921 fork
// semantics — inherited prefix block + independent branch tail).
const FORK_MARKER = "Fork branch: redesigned module plan for the independent continuation";

type Item = Record<string, unknown>;

const SUMMARY_MARKER = "[Compressed conversation section]";
const THRESHOLD = 20 * 1024;
const MAX_TURNS = 16;
const COVERED_MARKER = "please analyze module 2"; // early-turn user text, inside the folded range
const EDITED_MARKER = "please analyze module 2X";
// normalization-equivalent churn: double space between the last two words —
// different bytes (new kernel id), identical normalized identity (#1921)
const CHURNED_MARKER = "please analyze module  2";
const CHURN_RE = /please\s+analyze\s+module\s+2/;

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};

const asArr = (x: unknown): Item[] => (Array.isArray(x) ? (x as Item[]) : []);

function hasCompressCall(p: Item): boolean {
    return asArr(p.messages).flatMap((m) => (typeof m.content === "string" ? [] : asArr(m.content))).some((b) => b.type === "tool_use" && b.name === "compress");
}

function countSummaries(body: string): number {
    return body.split(SUMMARY_MARKER).length - 1;
}

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

function listen(server: http.Server): Promise<void> {
    return once(server, "listening").then(() => undefined);
}

function closeServer(s: http.Server | undefined): Promise<void> {
    return s ? new Promise<void>((resolve, reject) => {
        s.closeAllConnections?.();
        s.close((e) => (e ? reject(e) : resolve()));
    }) : Promise.resolve();
}

function extractReply(raw: string): string {
    let out = "";
    for (const block of raw.split("\n\n")) {
        let event = "";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (event !== "content_block_delta" || dataLines.length === 0) continue;
        try {
            const d = JSON.parse(dataLines.join("\n")) as { delta?: { type?: string; text?: string } };
            if (d.delta?.type === "text_delta" && d.delta?.text) out += d.delta.text;
        } catch { /* ignore */ }
    }
    return out;
}

interface Scenario {
    label: string;
    identified: boolean; // send x-acp-session header
    editCoveredMessage: boolean; // one-byte edit of a covered old message before the probe turn
    churnCoveredMessage: boolean; // normalization-equivalent re-serialization of a covered message (#1921 R)
    switchModel: boolean; // send the probe turn under the second model
    forkTail: boolean; // wholesale-replace the trailing history with fresh branch content (#1921 F)
}

interface ProbeResult {
    pinnedBody: string; // last normal body after the fold materialized (pre-probe baseline)
    probeBody: string; // outbound body of the probe turn (model switch / edit applied)
    pinnedBytes: number;
    probeBytes: number;
}

async function runScenario(sc: Scenario): Promise<ProbeResult> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `probe1908-${sc.label}-`));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = tmp;
    const captured: string[] = [];
    let upstream: http.Server | undefined;
    let proxy: http.Server | undefined;
    try {
        let demanded = false;
        const upstream0 = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                captured.push(body);
                const idx = captured.length;
                const parsed = JSON.parse(body) as Item;
                const model = String(parsed.model ?? "");
                const turnRe = /Turn (\d+):/g;
                let m: RegExpExecArray | null;
                while ((m = turnRe.exec(body)) !== null) { /* keep last */ }
                const label = m ? m[1]! : "0";
                const reply = `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.2);
                const msgRefs = parseRefIds(JSON.stringify(asArr(parsed.messages)));
                const wantCompress = !demanded && body.length > THRESHOLD && msgRefs.length >= 12;
                if (wantCompress) demanded = true;
                res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                const ev = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
                ev("message_start", { type: "message_start", message: { id: `msg_a_${idx}`, role: "assistant", usage: { input_tokens: 100 } } });
                if (wantCompress) {
                    // Fold everything except the last 6 refs (keep the protected
                    // recent zone visible so the kernel accepts the range).
                    const end = msgRefs[msgRefs.length - 6]!;
                    const args = JSON.stringify({ content: [{ startId: msgRefs[0]!, endId: end, topic: "probe-fold", summary: "Fold summary: single probe fold covering the early conversation for the #1908 repro matrix." }] });
                    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_cmp_${idx}`, name: "compress", input: {} } });
                    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(0, 20) } });
                    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args.slice(20) } });
                    ev("content_block_stop", { type: "content_block_stop", index: 0 });
                    ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 12 } });
                } else {
                    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
                    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply } });
                    ev("content_block_stop", { type: "content_block_stop", index: 0 });
                    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } });
                }
                ev("message_stop", { type: "message_stop" });
                res.end();
                void model;
            });
        });
        upstream = upstream0;
        upstream.listen(0, "127.0.0.1");
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;

        _setStoreForTest(new SessionStore({ enabled: false }));
        setRegistryForTest({});
        const ctx = 400_000;
        const opts: ProxyOptions = {
            port: 0,
            host: "127.0.0.1",
            upstream: "http://127.0.0.1",
            routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "claude-test": { context: ctx }, "claude-other": { context: ctx } } } },
            modelContextLimit: ctx,
            kernelConfig: defaultConfig(ctx),
            compress: { injectTool: true, injectNudge: true },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: process.env.PROBE1908_LOUD === "1",
            debug: false,
            passthrough: false,
            passthroughSource: null,
            autoUpdate: false,
            autoRestartOnUpdate: false,
            updateTag: "latest",
            advisoryCheck: false,
            releaseNotesCheck: false,
            compat: { roles: {} },
            streamErrorShape: "protocol",
            mitm: { enabled: false, domains: [] },
        };
        proxy = await startServer(opts);
        await listen(proxy);
        const proxyPort = (proxy.address() as { port: number }).port;
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/messages`;

        const sessionId = `probe1908-${sc.label}`;
        const hist: Item[] = [];
        const sendTurn = async (t: number, model: string): Promise<void> => {
            hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
            const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": "test" };
            if (sc.identified) headers["x-acp-session"] = sessionId;
            const res = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify({ model, max_tokens: 1024, stream: true, system: "You are a test assistant.", messages: [...hist] }),
            });
            if (!res.ok) throw new Error(`turn ${t}: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
            const reply = extractReply(await res.text());
            assert.ok(reply.length > 0, `turn ${t}: empty reply`);
            hist.push({ role: "assistant", content: reply });
        };

        // Drive until one fold has materialized AND a subsequent normal client
        // turn pins it (the pinned body = pre-probe baseline).
        let pinnedBody: string | undefined;
        let t = 0;
        for (; t < MAX_TURNS; t++) {
            await sendTurn(t, "claude-test");
            const last = captured[captured.length - 1]!;
            const foldedEarlier = captured.slice(0, -1).some((b) => countSummaries(b) > 0);
            if (foldedEarlier && countSummaries(last) > 0 && !hasCompressCall(JSON.parse(last) as Item)) {
                pinnedBody = last;
                break;
            }
        }
        assert.ok(pinnedBody !== undefined, "scenario never reached a pinned fold — trigger did not fire");
        const pinned = pinnedBody!;

        // Baseline sanity: the fold is live — summary present, covered early
        // turn text stripped from the wire.
        assert.equal(countSummaries(pinned), 1, `${sc.label}: baseline must carry exactly one summary`);
        assert.ok(!pinned.includes(COVERED_MARKER), `${sc.label}: baseline must have the covered original stripped`);

        // Apply the mutation under test, then send ONE probe turn.
        if (sc.editCoveredMessage) {
            const target = hist.find((m) => typeof m.content === "string" && (m.content as string).includes(COVERED_MARKER));
            assert.ok(target, `${sc.label}: covered user message not found in client history`);
            target!.content = (target!.content as string).replace(COVERED_MARKER, EDITED_MARKER);
        }
        if (sc.churnCoveredMessage) {
            const target = hist.find((m) => typeof m.content === "string" && (m.content as string).includes(COVERED_MARKER));
            assert.ok(target, `${sc.label}: covered user message not found in client history`);
            target!.content = (target!.content as string).replace(COVERED_MARKER, CHURNED_MARKER);
        }
        if (sc.forkTail) {
            // Fork point sits inside the covered range (first user message
            // after the first third of the resent history): the covered ids
            // beyond it die with the branch, the ones before it stay present.
            let forkAt = -1;
            for (let i = Math.floor(hist.length / 3); i < hist.length; i++) {
                if (hist[i]!.role === "user") { forkAt = i; break; }
            }
            assert.ok(forkAt >= 0, `${sc.label}: no user message found in the fork window`);
            hist.splice(forkAt);
            hist.push({ role: "user", content: `${FORK_MARKER}. ` + FILLER(90, 3) });
            hist.push({ role: "assistant", content: "Fork reply: acknowledged the redesigned plan for the branch. " + FILLER(91, 0.2) });
        }
        const probeModel = sc.switchModel ? "claude-other" : "claude-test";
        await sendTurn(t, probeModel);
        const probe = captured[captured.length - 1]!;
        if (process.env.PROBE1908_DUMP !== undefined) fs.writeFileSync(process.env.PROBE1908_DUMP, probe);
        return { pinnedBody: pinned, probeBody: probe, pinnedBytes: pinned.length, probeBytes: probe.length };
    } finally {
        await closeServer(proxy);
        await closeServer(upstream);
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(tmp);
    }
}

function assertFoldRetained(label: string, probe: ProbeResult): void {
    assert.equal(countSummaries(probe.probeBody), 1, `${label}: summary must survive (got ${countSummaries(probe.probeBody)})`);
    assert.ok(!probe.probeBody.includes(COVERED_MARKER), `${label}: covered original must stay stripped — fold retained`);
    assert.ok(!probe.probeBody.includes(EDITED_MARKER), `${label}: no edited text in this scenario`);
}

test("#1908 M: model switch on an identified session RETAINS the fold (session id is model-independent)", { timeout: 120_000 }, async () => {
    const probe = await runScenario({ label: "M", identified: true, editCoveredMessage: false, churnCoveredMessage: false, switchModel: true, forkTail: false });
    assertFoldRetained("M", probe);
});

test("#1908 M-ANON: model switch on an anonymous (prefix-affinity) session RETAINS the fold", { timeout: 120_000 }, async () => {
    const probe = await runScenario({ label: "M-ANON", identified: false, editCoveredMessage: false, churnCoveredMessage: false, switchModel: true, forkTail: false });
    assertFoldRetained("M-ANON", probe);
});

test("#1908 E: a one-byte edit of a covered message silently LOSES the fold — summary AND original both on the wire", { timeout: 120_000 }, async () => {
    const probe = await runScenario({ label: "E", identified: true, editCoveredMessage: true, churnCoveredMessage: false, switchModel: false, forkTail: false });
    // The summary stays (block still active — other ids still match)...
    assert.equal(countSummaries(probe.probeBody), 1, "E: summary must still be present (partial-match block stays active)");
    // ...AND the edited original re-enters the wire unfolded: double-count.
    assert.ok(probe.probeBody.includes(EDITED_MARKER), "E: the edited original must re-enter the wire — fold silently lost (#1908 death mechanism)");
    // And nothing re-folds it without pressure: no new summary appears.
    assert.equal(countSummaries(probe.probeBody), 1, "E: no re-fold happened (silent loss)");
    // #1921: a REAL edit is never claimed — repair keeps the honest re-entry.
    assert.ok(probe.probeBytes > probe.pinnedBytes + 6_000, "E: wire re-inflated by the unfolded original");
});

test("#1921 R: whitespace churn of a covered message is re-anchored — fold RETAINED under repair", { timeout: 120_000 }, async () => {
    const probe = await runScenario({ label: "R", identified: true, editCoveredMessage: false, churnCoveredMessage: true, switchModel: false, forkTail: false });
    // The block re-anchored onto the churned id: summary survives...
    assert.equal(countSummaries(probe.probeBody), 1, "R: summary must survive the churn (block re-anchored)");
    // ...and the churned original stays STRIPPED — no re-entry in any spacing form.
    assert.ok(!CHURN_RE.test(probe.probeBody), "R: the churned covered original must stay stripped — fold retained via re-anchor (#1921)");
    // No re-inflation: the probe grew only by the new turn itself (~6 KB),
    // not by the ~6 KB churned original re-entering on top of it.
    assert.ok(probe.probeBytes <= probe.pinnedBytes + 8_000, `R: probe must not re-inflate (pinned ${probe.pinnedBytes}, probe ${probe.probeBytes})`);
});

test("#1921 F: wholesale fork of the trailing history — prefix fold inherited, branch tail unfolded, no ghost re-entry", { timeout: 120_000 }, async () => {
    const probe = await runScenario({ label: "F", identified: true, editCoveredMessage: false, churnCoveredMessage: false, switchModel: false, forkTail: true });
    // The block survives via the still-present prefix ids: summary stays.
    assert.equal(countSummaries(probe.probeBody), 1, "F: summary must survive the fork (block alive via prefix ids)");
    // The resent covered prefix stays stripped — the inherited fold is live.
    assert.ok(!probe.probeBody.includes(COVERED_MARKER), "F: the resent covered prefix must stay stripped — inherited fold retained");
    // The fork tail rides the wire as fresh unfolded material.
    assert.ok(probe.probeBody.includes(FORK_MARKER), "F: the branch content must be on the wire (unfolded new material)");
    // No ghost of the dropped region re-enters and no re-inflation: the wire
    // lost the forked-away turns, so the probe must be SMALLER than the
    // pinned baseline plus the new turn's ~6 KB.
    assert.ok(probe.probeBytes <= probe.pinnedBytes + 8_000, `F: probe must not re-inflate (pinned ${probe.pinnedBytes}, probe ${probe.probeBytes})`);
    assert.ok(probe.probeBytes < probe.pinnedBytes, "F: the forked-away tail must actually leave the wire (probe < pinned)");
});
