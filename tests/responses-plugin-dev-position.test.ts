// [#1638] Plugin-mode responses lane: mid-history system/developer items
// (OMP converts custom_message notifications — todo nudges, launch
// completions — into role:"developer" items appended mid-history and
// re-sends them every turn). The kernel's responsesToCore hoists
// system/developer content from ANY position into projection.systemParts,
// and bili re-injects the merged block at input[0] — so every notification
// append rewrote the outbound FIRST item and the upstream prefix cache
// missed the whole input (production sawtooth: cached pinned to the
// instructions-only residual).
//
// Fix under test (src/server.ts prepareResponses): in plugin mode the
// non-head system/developer items are marked with an unknown type for the
// duration of responsesToCore, so they land in the projection layout as
// coreId-less slots; patchResponsesInput re-emits such slots verbatim in
// their original position. The head run keeps the hoist (stable system
// prompt), the front developer block stays byte-identical across turns,
// and the notifications ride in place — the position-preserved semantics
// the openai-chat wire already has (kernel head-only hoist).
//
// Pins:
//   T1 plugin main: front block byte-stable across notification appends;
//       notifications present exactly once, in position, easy-form intact;
//       append-only bodies (previous input is a byte-prefix of the next);
//       no sentinel type ever leaks to the wire;
//   T2 fold interaction: after a /__bili/plugin/tool fold the notification
//       still rides in place exactly once; carrier strip + pair quotes keep
//       the #1567 counts (0 marker, 2 summary quotes); front still stable;
//   T3 head-neutral: a leading additional_tools item does not break the
//       head run — the head developer item is still hoisted, front block
//       injected right after it, stable;
//   T4 proxy pin (negative): native/proxy mode keeps the hoist semantics
//       (#1085 anchor path) — notifications are NOT re-emitted as
//       in-place developer items.

import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";

const SYS = "OMP SYSTEM v18.4.2 You are the host agent, plan carefully.";
const NOTIF1 = "mid-run-todo-nudge: 3 open todos in plan";
const NOTIF2 = "launch-completion: sandbox ready";
const SUM_MARKER = "[Compressed conversation section]";
const SUM_A = "DevPosition fold summary covering m00001..m00002 alpha";
const NUDGE_PREFIX = "This is an efficiency nudge";

interface FoldSpec { startId: string; endId: string; topic: string; summary: string }
interface Pair { id: string; args: FoldSpec; result: string }
type CItem = { role: "user" | "assistant"; text: string } | { dev: string } | { pair: Pair } | { raw: Record<string, unknown> };
interface Step { send: CItem[]; fold?: FoldSpec; pairId?: string }

const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ".repeat(28);
const T = (i: number, pad = false): CItem => ({ role: "user", text: `q${i} devpos question ${i}${pad ? " " + FILLER : ""}` });
const A = (i: number, pad = false): CItem => ({ role: "assistant", text: `a${i} devpos answer ${i}${pad ? " " + FILLER : ""}` });
const D = (text: string): CItem => ({ dev: text });

function buildBody(hist: CItem[]): Record<string, unknown> {
    return {
        model: "gpt-test", stream: true,
        input: hist.flatMap((it): Record<string, unknown>[] => {
            if ("dev" in it) return [{ role: "developer", content: it.dev }];
            if ("raw" in it) return [it.raw];
            if ("pair" in it) return [
                { type: "function_call", name: "compress", call_id: it.pair.id, arguments: JSON.stringify(it.pair.args) },
                { type: "function_call_output", call_id: it.pair.id, output: it.pair.result },
            ];
            return [{ type: "message", role: it.role, content: [{ type: it.role === "user" ? "input_text" : "output_text", text: it.text }] }];
        }),
    };
}

function sseText(text: string): string[] {
    return [
        `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", object: "response", status: "in_progress", output: [] } })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { id: "msg_o_1", type: "message", status: "in_progress", role: "assistant", content: [] } })}\n\n`,
        `event: response.content_part.added\ndata: ${JSON.stringify({ type: "response.content_part.added", item_id: "msg_o_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_o_1", output_index: 0, delta: text })}\n\n`,
        `event: response.output_text.done\ndata: ${JSON.stringify({ type: "response.output_text.done", item_id: "msg_o_1", output_index: 0, content_index: 0, text })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { id: "msg_o_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text }] } })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", object: "response", status: "completed", output: [{ id: "msg_o_1", type: "message", status: "completed", content: [{ type: "output_text", text }] }] } })}\n\n`,
    ];
}

interface Captured { raw: string; input: Record<string, unknown>[] }

async function driveResponses(steps: Step[], mode: "plugin" | "proxy"): Promise<Captured[]> {
    const conv = `devpos-${mode}-${Date.now().toString(36)}`;
    const capturedRaw: string[] = [];

    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            capturedRaw.push(Buffer.concat(chunks).toString());
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const line of sseText(`answer-${capturedRaw.length}`)) res.write(line);
            res.end();
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "devpos-test-"));
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDir;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetPluginStateForTest();
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 400_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true, nudgeGrowthTokens: 500 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    const base = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/responses`;

    const hist: CItem[] = [];
    try {
        for (const step of steps) {
            for (const it of step.send) hist.push(it);
            if (step.fold) {
                const r = await fetch(`http://127.0.0.1:${proxyPort}/__bili/plugin/tool`, {
                    method: "POST", headers: { "content-type": "application/json" },
                    body: JSON.stringify({ conversationId: conv, tool: "compress", args: { content: [step.fold] } }),
                });
                const j = (await r.json()) as { ok: boolean; result?: string; error?: string };
                assert.ok(j.ok, `[${mode}] compress rejected: ${r.status} ${j.error ?? ""}`);
                assert.ok(!j.result?.includes("[Compression FAILED"), `[${mode}] compression failed: ${j.result?.slice(0, 200)}`);
                hist.push({ pair: { args: step.fold, result: j.result!, id: step.pairId ?? "devpos_cmp" } });
            }
            const headers: Record<string, string> = { "content-type": "application/json" };
            if (mode === "plugin") {
                headers["x-bili-plugin"] = "omp-plugin/0.0.1";
                headers["x-bili-plugin-conversation"] = conv;
            } else {
                headers["x-acp-session"] = conv;
            }
            const resp = await fetch(base, { method: "POST", headers, body: JSON.stringify(buildBody(hist)) });
            if (resp.status !== 200) {
                const detail = (await resp.text()).slice(0, 300);
                assert.fail(`[${mode}] request failed: ${resp.status} ${detail}`);
            }
            await resp.arrayBuffer();
        }
    } finally {
        proxy.close();
        await once(proxy, "close");
        upstream.close();
        await once(upstream, "close");
        if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = prevXdg;
        fs.rmSync(stateDir, { recursive: true, force: true });
    }
    return capturedRaw.map((raw) => {
        const parsed = JSON.parse(raw) as { input?: unknown };
        const input = Array.isArray(parsed.input) ? (parsed.input as Record<string, unknown>[]) : [];
        return { raw, input };
    });
}

// Volatile tail items (chain checkpoints carry a per-request digest, nudge
// notes) must not break the append-only prefix comparison — strip a
// contiguous trailing run of them first.
const CHAIN_PREFIX = "<" + "bili-chain v=";
function stripVolatileTail(items: Record<string, unknown>[]): Record<string, unknown>[] {
    const out = [...items];
    while (out.length > 0) {
        const s = JSON.stringify(out[out.length - 1]);
        if (s.includes(NUDGE_PREFIX) || s.includes(CHAIN_PREFIX)) out.pop();
        else break;
    }
    return out;
}

function frontDev(c: Captured): { content: string; index: number } {
    for (let i = 0; i < c.input.length; i++) {
        const it = c.input[i]!;
        if (it.role === "developer" && typeof it.content === "string") return { content: it.content, index: i };
    }
    assert.fail(`no injected developer front block found in ${c.raw.slice(0, 300)}`);
}

function indexOfText(c: Captured, needle: string): number {
    const idx = c.input.findIndex((it) => {
        if (it.type !== "message" || !Array.isArray(it.content)) return false;
        return it.content.some((b) => typeof (b as Record<string, unknown>)?.text === "string" && String((b as Record<string, unknown>).text).includes(needle));
    });
    return idx;
}

function notifItems(c: Captured, needle: string): Record<string, unknown>[] {
    return c.input.filter((it) => it.role === "developer" && it.type === undefined && it.content === needle);
}

test("responses plugin mode: mid-history developer notifications are position-preserved; front block byte-stable (#1638)", async () => {
    const steps: Step[] = [
        { send: [D(SYS), T(1)] },
        { send: [A(1), D(NOTIF1), T(2)] },
        { send: [A(2), D(NOTIF2), T(3)] },
    ];
    const caps = await driveResponses(steps, "plugin");
    assert.equal(caps.length, 3, "expected 3 outbound bodies");
    const L = (i: number) => `devpos/t${i + 1}`;

    // Front developer block: contains the hoisted head system text, never
    // the notification texts, byte-identical across ALL turns.
    const fronts = caps.map((c) => frontDev(c));
    for (const f of fronts) {
        assert.ok(f.content.includes(SYS), `${L(0)}: front block lost the head system text`);
        assert.ok(!f.content.includes(NOTIF1), `front block must not absorb ${JSON.stringify(NOTIF1)}`);
        assert.ok(!f.content.includes(NOTIF2), `front block must not absorb ${JSON.stringify(NOTIF2)}`);
    }
    assert.equal(JSON.stringify(fronts[1]!.content), JSON.stringify(fronts[0]!.content), "t2 front block bytes differ from t1 (prefix cache would miss)");
    assert.equal(JSON.stringify(fronts[2]!.content), JSON.stringify(fronts[0]!.content), "t3 front block bytes differ from t1 (prefix cache would miss)");

    // Notifications ride in place: exactly once, easy-form intact
    // ({role:"developer", content} — no type field), positioned between the
    // prior assistant answer and the next user question.
    const n1 = notifItems(caps[1]!, NOTIF1);
    assert.equal(n1.length, 1, `${L(1)}: NOTIF1 in-place occurrences ${n1.length} != 1`);
    const a1 = indexOfText(caps[1]!, "a1 devpos answer 1");
    const q2 = indexOfText(caps[1]!, "q2 devpos question 2");
    assert.ok(a1 >= 0 && q2 >= 0, `${L(1)}: anchor items missing (a1@${a1}, q2@${q2})`);
    const n1Idx = caps[1]!.input.indexOf(n1[0]!);
    assert.ok(n1Idx > a1 && n1Idx < q2, `${L(1)}: NOTIF1 at index ${n1Idx} not between a1@${a1} and q2@${q2}`);
    assert.equal(notifItems(caps[1]!, NOTIF2).length, 0, `${L(1)}: NOTIF2 must not exist yet`);
    assert.equal(notifItems(caps[2]!, NOTIF1).length, 1, `${L(2)}: NOTIF1 dropped from history`);
    assert.equal(notifItems(caps[2]!, NOTIF2).length, 1, `${L(2)}: NOTIF2 in-place occurrences != 1`);

    // Append-only bodies: after stripping volatile tail items, the previous
    // outbound input is an exact byte-prefix of the next — the upstream
    // prefix cache property.
    for (let i = 1; i < caps.length; i++) {
        const prev = stripVolatileTail(caps[i - 1]!.input);
        const cur = stripVolatileTail(caps[i]!.input);
        assert.equal(JSON.stringify(cur.slice(0, prev.length)), JSON.stringify(prev), `${L(i)}: previous input is not a byte-prefix of the next (mid-history mutation)`);
    }

    // The in-window sentinel must never leak to the wire.
    for (const c of caps) assert.ok(!c.raw.includes("__bili_inplace_sysdev"), "sentinel type leaked into forwarded body");
});

test("responses plugin mode: fold interaction keeps notifications in place, no duplication (#1638)", async () => {
    const fold: FoldSpec = { startId: "m00001", endId: "m00002", topic: "DEVPOS-TOPIC-A", summary: SUM_A };
    const steps: Step[] = [
        { send: [D(SYS), T(1, true), A(1, true), T(2, true), A(2, true)] },
        { send: [T(3, true), A(3, true)] },
        { send: [T(4, true), A(4, true)] },
        { send: [], fold, pairId: "devpos_a" },
        { send: [D(NOTIF1), T(5), A(5)] },
    ];
    const caps = await driveResponses(steps, "plugin");
    assert.equal(caps.length, 5, "expected 5 outbound bodies");
    const t2 = caps[4]!;
    const L = "devpos/fold t2";

    // Front block still byte-stable across the fold.
    assert.equal(JSON.stringify(frontDev(t2).content), JSON.stringify(frontDev(caps[0]!).content), `${L}: front block bytes changed across the fold`);

    // Notification rides in place exactly once (after the pair echo, before q5).
    const n1 = notifItems(t2, NOTIF1);
    assert.equal(n1.length, 1, `${L}: NOTIF1 occurrences ${n1.length} != 1`);
    const q5 = indexOfText(t2, "q5 devpos question 5");
    const n1Idx = t2.input.indexOf(n1[0]!);
    assert.ok(q5 >= 0 && n1Idx < q5, `${L}: NOTIF1 at ${n1Idx} must precede q5@${q5}`);

    // #1567 counts unchanged by the position-preservation: in-place carrier
    // stripped while the client pair rides inbound (0 markers), summary text
    // exactly in the two pair quotes.
    const count = (needle: string) => t2.raw.split(needle).length - 1;
    assert.equal(count(SUM_MARKER), 0, `${L}: in-place carrier leaked (${count(SUM_MARKER)} markers)`);
    assert.equal(count(SUM_A), 2, `${L}: SUM_A occurrences ${count(SUM_A)} != 2 (pair quotes only)`);
});

test("responses plugin mode: leading additional_tools stays head-neutral — head developer still hoisted", async () => {
    const extraTools = { raw: { type: "additional_tools", tools: [{ type: "code_mode_exec" }, { type: "code_mode_wait" }] } };
    const steps: Step[] = [
        { send: [extraTools, D(SYS), T(1)] },
        { send: [A(1), D(NOTIF1), T(2)] },
    ];
    const caps = await driveResponses(steps, "plugin");
    assert.equal(caps.length, 2, "expected 2 outbound bodies");
    const L = (i: number) => `devpos/head-neutral t${i + 1}`;

    // additional_tools re-emitted verbatim at [0]; the front block lands
    // right after it and contains the hoisted head system text.
    for (const c of caps) {
        assert.equal(c.input[0]!.type, "additional_tools", `${L(0)}: additional_tools not at input[0]`);
        const f = frontDev(c);
        assert.equal(f.index, 1, `${L(0)}: front block not directly after additional_tools`);
        assert.ok(f.content.includes(SYS), `${L(0)}: head developer item not hoisted past additional_tools`);
        assert.ok(!f.content.includes(NOTIF1), `${L(0)}: notification leaked into front block`);
    }
    assert.equal(JSON.stringify(frontDev(caps[1]!).content), JSON.stringify(frontDev(caps[0]!).content), "front block bytes differ across turns");
    assert.equal(notifItems(caps[1]!, NOTIF1).length, 1, `${L(1)}: NOTIF1 in-place occurrences != 1`);
});

test("responses proxy mode: hoist semantics unchanged — notifications are not re-emitted in place (#1638 negative pin)", async () => {
    const steps: Step[] = [
        { send: [D(SYS), T(1)] },
        { send: [A(1), D(NOTIF1), T(2)] },
    ];
    const caps = await driveResponses(steps, "proxy");
    assert.equal(caps.length, 2, "expected 2 outbound bodies");
    const L = (i: number) => `devpos/proxy t${i + 1}`;
    const t2 = caps[1]!;

    // Native/proxy mode keeps the hoist (#1085 anchor path owns stability):
    // the notification must not appear as an in-place developer item.
    assert.equal(notifItems(t2, NOTIF1).length, 0, `${L(1)}: proxy mode must keep hoist semantics — NOTIF1 was re-emitted in place`);
    // Client content still reaches the upstream somewhere (merged front
    // block or anchor diff note) — never silently dropped.
    assert.ok(t2.raw.includes(NOTIF1), `${L(1)}: NOTIF1 vanished from the forwarded body`);
    // Front block exists and carries the head system text.
    const f = frontDev(t2);
    assert.ok(f.content.includes(SYS), `${L(1)}: front block lost the head system text`);
});
