// Mode-upgrade boundary proof (#1426 / #2202 class): a session that grew and
// folded in PROXY mode (plain client, no plugin header — proxy executes
// compress server-side, acp_summary carrier on the wire) then upgrades to
// PLUGIN mode (x-bili-plugin header — the ACP-native agent owns compression).
//
// The binding is sticky-by-design (session.metadata.pluginAgent, #1426): the
// headerless proxy era must NOT fork a second session, the flip must keep ONE
// session with the proxy-era fold alive (preflight blocks keep their
// acp_summary carrier in any mode), tool injection must stop exactly at the
// flip, a plugin-era fold via /__bili/plugin/tool must coexist with the
// proxy-era block, and later:
//   - removing the header must NOT downgrade back to proxy mode (sticky);
//   - a DIFFERENT agent header (dsh after pi) must override the recorded
//     agent value (header wins over the sticky metadata) without touching
//     compression state.
// Escalation/reap misdiagnosis teeth: none of these sanctioned flips may
// latch foldDriftEscalated or emit an orphan-reap conflict event.
//
// Scope note: the mode binding (header -> session.metadata.pluginAgent ->
// prepare()'s pluginMode) is wire-agnostic server logic; this proof runs the
// chat lane as the representative, exactly like the original #1 plugin-mode
// harness. Per-wire plugin-fold shapes are covered by cache-friendly-plugin.
//
// Harness: hermetic judge upstream (records every request body, emits the
// proxy's own compress tool_call once the body crosses the size threshold),
// startServer with injectTool so the proxy intercepts its injected tool,
// SessionStore disabled + fresh XDG so getSession() sees the live session.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { startServer } from "../src/server.ts";
import { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getSession } from "../src/session.ts";
import { conflictEventsOf } from "../src/conflict-watch.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { defaultConfig } from "acp-kernel";

type Item = Record<string, unknown>;

const SUMMARY_MARKER = "[Compressed conversation section]";
const THRESHOLD = 64 * 1024;
const MODEL_A = "gpt-proof-a";
const MIN_FOLD_T = 8;
const MAX_TURNS = 30;
const CONV = "mode-upgrade-proof-conv";

const FILLER = (seed: number, kb: number): string => {
    const para = `Paragraph ${seed}: the build pipeline ran cleanly and the integration suite reported no regressions across all four regions. `;
    const unit = Math.ceil((kb * 1024) / para.length);
    return Array.from({ length: unit }, (_, i) => para.replace(String(seed), `${seed}-${i}`)).join("");
};
const TOOL_RESULT_OK = (t: number): string =>
    `total 8\n` + Array.from({ length: 64 }, (_, i) => `-rw-r--r-- 1 u g 4096 Sep 27 10:0${i % 10} file-${t}-row-${i}.ts`).join("\n") + `\n# tail: module ${t} inspected\n`;

function parseRefIds(body: string): string[] {
    const ids: string[] = [];
    const re = /<(?:acp|dcp-message-id)[^>]*>\s*(m\d+)\s*<\/(?:acp|dcp-message-id)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) ids.push(m[1]!);
    return ids;
}

function replyLabel(body: string): string {
    const re = /Turn (\d+):/g;
    let m: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((m = re.exec(body)) !== null) last = m;
    return last ? last[1]! : "0";
}

function rmrf(p: string): void {
    fs.rmSync(p, { recursive: true, force: true });
}

function bodyInjectsCompress(body: string): boolean {
    const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
    return (parsed.tools ?? []).some((t) => t.function?.name === "compress");
}

function wireHasPair(body: string, pairId: string): boolean {
    return body.includes(pairId) && body.includes("\"compress\"");
}

test("mode-upgrade proof (chat wire): proxy->plugin flip keeps one session, one carrier, sticky binding (#1426)", { timeout: 180_000 }, async () => {
    const bodies: string[] = [];
    let turnNo = 0;
    let suppressTrigger = false;
    let triggerCalls = 0;
    let lastDemandBytes = Infinity;
    let sinceDemand = 99;
    const triggerShould = (body: string, turn: number): boolean => {
        if (turn < MIN_FOLD_T || suppressTrigger) return false;
        const bytes = Buffer.byteLength(body);
        const refs = parseRefIds(body);
        const noShrinkAfterDemand = sinceDemand <= 2 && bytes >= lastDemandBytes * 0.9;
        if (bytes > THRESHOLD && refs.length >= 12 && !noShrinkAfterDemand) {
            lastDemandBytes = bytes;
            sinceDemand = 0;
            triggerCalls++;
            return true;
        }
        sinceDemand++;
        return false;
    };

    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            bodies.push(body);
            const idx = bodies.length;
            const prompt = Math.max(1, Math.ceil(body.length / 4));
            const label = replyLabel(body);
            const reply = `Reply Turn ${label}: done. ` + FILLER(Number(label), 0.2);
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const line = (o: unknown): void => { res.write(`data: ${JSON.stringify(o)}\n\n`); };
            const usage = { prompt_tokens: prompt, completion_tokens: 5, total_tokens: prompt + 5 };
            if (triggerShould(body, turnNo)) {
                const refs = parseRefIds(body);
                const args = JSON.stringify({ content: [{ startId: refs[2]!, endId: refs[refs.length - 6]!, topic: "mode-upgrade proxy fold", summary: "Proxy-era fold summary covering the early build-analysis turns: pipelines green, ids stable, no regressions observed anywhere." }] });
                line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_cmp_${idx}`, type: "function", function: { name: "compress", arguments: args } }] } }] });
                line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage });
            } else {
                line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply } }] });
                line({ id: `c_${idx}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
            }
            res.write("data: [DONE]\n\n");
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-upgrade-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [MODEL_A]: { context: 200_000 } } } },
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;

    const hist: Item[] = [];
    const sendTurn = async (t: number, headers: Record<string, string>): Promise<string> => {
        turnNo = t;
        hist.push({ role: "user", content: `Turn ${t}: please analyze module ${t}. ` + FILLER(t, 6) });
        const resp = await fetch(base, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ model: MODEL_A, stream: true, messages: [...hist] }) });
        if (resp.status !== 200) assert.fail(`turn ${t}: proxy status ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
        const raw = await resp.text();
        let reply = "";
        for (const block of raw.split("\n\n")) {
            const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
            if (!dataLine || dataLine.includes("[DONE]")) continue;
            const d = JSON.parse(dataLine.slice(5).trim()) as { choices?: Array<{ delta?: { content?: string } }> };
            const c = d.choices?.[0]?.delta?.content;
            if (typeof c === "string") reply += c;
        }
        assert.ok(reply.length > 0, `turn ${t}: empty reply`);
        hist.push({ role: "assistant", content: reply });
        if (t % 2 === 0) {
            hist.push({ role: "assistant", content: null, tool_calls: [{ id: `call_t${t}`, type: "function", function: { name: "shell", arguments: JSON.stringify({ command: `ls -la mod-${t}`, cwd: `/ws/${t}` }) } }] });
            hist.push({ role: "tool", tool_call_id: `call_t${t}`, content: TOOL_RESULT_OK(t) });
        }
        return reply;
    };
    const proxyHeaders = { "x-acp-session": CONV };
    const pluginHeaders = { "x-acp-session": CONV, "x-bili-plugin": "pi-plugin/0.0.1", "x-bili-plugin-conversation": CONV };

    try {
        // ---- Phase 1: proxy era. Grow until one fold fires and settles.
        let foldIdx = -1;
        let sinceFold = 0;
        for (let t = 0; t < MAX_TURNS; t++) {
            const before = triggerCalls;
            await sendTurn(t, proxyHeaders);
            if (triggerCalls > before) { foldIdx = bodies.length - 1; sinceFold = 0; } else sinceFold++;
            if (foldIdx >= 0 && sinceFold >= 2) break;
        }
        assert.ok(foldIdx >= 0, "proxy era: no fold fired");
        assert.ok(bodies[foldIdx]!.includes(SUMMARY_MARKER), "proxy era: fold round-2 lacks the summary carrier");
        assert.ok(bodies[bodies.length - 1]!.includes(SUMMARY_MARKER), "proxy era: summary carrier dropped before the flip");
        assert.ok(bodyInjectsCompress(bodies[bodies.length - 1]!), "proxy era: compress tool not injected on the wire");
        assert.ok(!bodies[bodies.length - 1]!.includes("file-2-row-"), "proxy era: covered tool result re-billed before the flip");
        const requestsBefore = getSession(CONV).stats.requests;
        const blocksBefore = getSession(CONV).state.blocks.length;
        assert.ok(blocksBefore >= 1, "proxy era: no active fold block");
        suppressTrigger = true; // plugin era: the agent owns compression

        // ---- Phase 2: flip to plugin mode on the SAME conversation.
        const flipBodyIdx = bodies.length;
        await sendTurn(101, pluginHeaders);
        await sendTurn(102, pluginHeaders);
        const sess2 = getSession(CONV);
        assert.equal(sess2.metadata.pluginAgent, "pi-plugin/0.0.1", "flip: pluginAgent did not latch");
        assert.ok(sess2.stats.requests >= requestsBefore + 2, "flip: request accounting broke across the mode upgrade");
        assert.equal(sess2.state.blocks.length, blocksBefore, "flip: fold blocks changed on a sanctioned mode upgrade");
        assert.ok(!bodyInjectsCompress(bodies[flipBodyIdx]!), "flip: tool injection did not stop at the plugin header");
        assert.ok(bodies[flipBodyIdx]!.includes(SUMMARY_MARKER), "flip: proxy-era summary carrier lost at the mode upgrade");
        assert.ok(!bodies[flipBodyIdx]!.includes("file-2-row-"), "flip: proxy-era coverage re-billed at the mode upgrade");
        assert.ok(sess2.metadata.foldDriftEscalated !== true, "flip: destroy-escalation latched on a sanctioned mode upgrade");
        assert.equal(conflictEventsOf(sess2).length, 0, "flip: conflict events emitted on a sanctioned mode upgrade");

        // ---- Phase 3: plugin-era fold via the plugin tool endpoint.
        const lastBody = bodies[bodies.length - 1]!;
        const refs = parseRefIds(lastBody);
        assert.ok(refs.length >= 12, "plugin era: too few refs to fold");
        const foldSpec = {
            startId: refs[2]!, endId: refs[refs.length - 6]!, topic: "mode-upgrade plugin fold",
            summary: "Plugin-era fold summary covering the post-flip analysis turns: coverage carried across the mode upgrade, carriers stable, no regressions observed.",
        };
        const foldArgs = JSON.stringify({ content: [foldSpec] });
        const r = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ conversationId: CONV, tool: "compress", args: { content: [foldSpec] } }),
        });
        const j = (await r.json()) as { ok: boolean; result?: string; error?: string };
        assert.ok(j.ok, `plugin fold rejected: ${r.status} ${j.error ?? ""}`);
        assert.ok(!j.result?.includes("[Compression FAILED"), `plugin fold failed: ${j.result?.slice(0, 200)}`);
        hist.push({ role: "assistant", content: null, tool_calls: [{ id: "mup_pair", type: "function", function: { name: "compress", arguments: foldArgs } }] });
        hist.push({ role: "tool", tool_call_id: "mup_pair", content: j.result! });
        const pairIdx = bodies.length;
        await sendTurn(103, pluginHeaders);
        const pairBody = bodies[pairIdx]!;
        assert.ok(wireHasPair(pairBody, "mup_pair"), "plugin fold: the compress pair did not ride the agent's own history");
        assert.ok(pairBody.includes(SUMMARY_MARKER), "plugin fold: proxy-era carrier lost after the plugin-era fold");
        const sess3 = getSession(CONV);
        assert.ok(sess3.state.blocks.length >= blocksBefore + 1, "plugin fold: no new block recorded");
        const coverage = sess3.metadata.foldCoverageByBlock as Record<string, { t?: number }> | undefined;
        assert.ok(coverage !== undefined && Object.keys(coverage).length >= 2, "plugin fold: coverage ledger does not span both eras");
        assert.ok(sess3.metadata.foldDriftEscalated !== true, "plugin fold: escalation latched across the era boundary");
        assert.equal(conflictEventsOf(sess3).length, 0, "plugin fold: conflict events across the era boundary");

        // ---- Phase 4: header removed — the binding is sticky, no downgrade.
        const stickyIdx = bodies.length;
        await sendTurn(104, proxyHeaders);
        const sess4 = getSession(CONV);
        assert.equal(sess4.metadata.pluginAgent, "pi-plugin/0.0.1", "sticky: pluginAgent lost when the header disappeared");
        assert.ok(!bodyInjectsCompress(bodies[stickyIdx]!), "sticky: tool injection resumed on a plugin-bound session");
        assert.ok(bodies[stickyIdx]!.includes(SUMMARY_MARKER), "sticky: carrier lost on the headerless turn");

        // ---- Phase 5: a different agent header overrides the recorded agent.
        const overrideIdx = bodies.length;
        await sendTurn(105, { "x-acp-session": CONV, "x-bili-plugin": "dsh", "x-bili-plugin-conversation": CONV });
        const sess5 = getSession(CONV);
        assert.equal(sess5.metadata.pluginAgent, "dsh", "override: a different agent header did not win over the sticky value");
        assert.ok(!bodyInjectsCompress(bodies[overrideIdx]!), "override: tool injection resumed under the new agent");
        assert.ok(bodies[overrideIdx]!.includes(SUMMARY_MARKER), "override: carrier lost under the new agent");
        assert.ok(sess5.state.blocks.length >= blocksBefore + 1, "override: fold blocks lost under the new agent");
        assert.equal(conflictEventsOf(sess5).length, 0, "override: conflict events under the new agent");
        console.log(`proof[mode-upgrade] VERDICT bodies=${bodies.length} proxyFold=#${foldIdx} flip=#${flipBodyIdx} pair=#${pairIdx} blocks=${sess5.state.blocks.length} sticky=1 override=1`);
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        upstream.close();
        upstream.closeIdleConnections?.();
        await once(upstream, "close");
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        rmrf(stateDir);
    }
});
