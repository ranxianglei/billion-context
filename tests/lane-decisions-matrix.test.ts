import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _setForTest } from "../src/registry.ts";
import { resetToolRingForTest } from "../src/tool-ring.ts";
import { closeServers } from "./server-close-guard.ts";

// #3417 lane-decisions truth table (characterization pass): pin the CURRENT
// compress-surface behavior (standing prompt + nudge) per lane across all four
// wires BEFORE extracting the lane-decisions module. Rows:
//   - omp plugin (control): surface kept
//   - dsh plugin, no tools on the wire (#3177 shape): surface dropped
//   - dsh plugin, compress declared on the wire (#3401 shape): fixed — kept
//     (the bug) — this row is pinned as-is and flips in the fix commit
//   - dsh plugin, only acp_status on the wire: dropped (named-tool precision
//     target — today trivially dropped, post-fix still dropped for the right
//     reason: the nudge names compress, which is NOT on the wire)
//   - #3617-D completion: every profile's host-scoped default exercised via
//     the real prepare chain (pi/opencode not scoped → kept; omp single
//     regular tool ignored → kept), plus the proxy-mode structural-on control,
//     plus the EMERGENCY override pair (#3461 guardrail): taught usage 45k/64k
//     = 70% sits between the host escalation line (0.7) and the kernel
//     over-limit line (0.75), so the kernel declines on cadence (fresh
//     session, growth 0 < floor) while ≥5K of executable mass stays above
//     minPressureBenefit — the override must inject where the surface is
//     reachable and must NOT punch through an unreachable dsh tool table.
//
// The nudge arms deterministically: usage reports 50k against a 64k
// operator-declared window (78%) with a compressible history outside the
// protected recent zone (same recipe as plugin-nudge-injection.test.ts).

process.env.NODE_ENV = "test";

const root = mkdtempSync(join(tmpdir(), "bili-lane-matrix-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;

type Wire = "anthropic" | "openai" | "responses" | "google";
// "proxy" = no x-bili-plugin header at all (plain client; bili injects its own tools).
type Lane = "omp" | "dsh" | "pi" | "opencode" | "zcode" | "proxy";

interface RowOutcome {
    nudge: boolean;
    standingPrompt: boolean;
}

// Differential marker for the FULL standing compress prompt (9.7KB with the
// tool surface) vs the tags-only fallback (508B — carries ACP TAGS but no tool
// surface): "acp_status" appears only in the full prompt (verified against
// buildCompressSystemPrompt vs buildAcpTagsOnlyPrompt).
const STANDING_MARKER = "acp_status";

function wireTools(wire: Wire, names: string[]): unknown {
    if (wire === "openai") return names.map((name) => ({ type: "function", function: { name, description: "d", parameters: { type: "object", properties: {} } } }));
    if (wire === "google") return [{ functionDeclarations: names.map((name) => ({ name, description: "d", parameters: { type: "object", properties: {} } })) }];
    return names.map((name) => ({ name, description: "d", input_schema: { type: "object", properties: {} } })); // anthropic + responses
}

// 29-message history (plugin-nudge-injection recipe): long compressible text
// outside the preserve zone + filler past preserveRecentMessages/Tokens.
function historyTexts(): string[] {
    const out: string[] = ["hello", "ok", "continue", "y".repeat(20_000)];
    for (let i = 1; i <= 12; i++) {
        out.push(`q${i} ` + "f".repeat(997));
        out.push(`a${i} ` + "e".repeat(997));
    }
    out.push("now summarize");
    return out;
}

// teachTokens: what the fake upstream REPORTS as input_tokens on every reply.
// The loop adopts it as the next turn's tokenCount (usage-grade baseline), so
// this is how each row dials context usage against the 64k declared window.

async function harness(wire: Wire, lane: Lane, toolNames: string[], injectTool = true, teachTokens = 50_000) {
    // Windows CI flake class (seen on runners, not on dev VMs): listen(0)
    // occasionally lands in an OS-reserved/excluded port range and emits
    // "error" (EACCES/EADDRINUSE) instead of "listening". events.once(
    // server, "listening") REJECTS on error, so surface that as a bounded
    // retry instead of letting a failed listen strand the test promise
    // ("Promise resolution is still pending but the event loop has already
    // resolved" — #3490 windows shards).
    const listenWithRetry = async (server: http.Server) => {
        for (let attempt = 1; ; attempt++) {
            try {
                server.listen(0, "127.0.0.1");
                await once(server, "listening");
                return;
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (attempt >= 5 || (code !== "EACCES" && code !== "EADDRINUSE")) throw err;
                await new Promise((r) => setTimeout(r, 25 * attempt));
            }
        }
    };
    _resetSessionsForTest();
    _resetPluginStateForTest();
    resetToolRingForTest();
    _setForTest({});
    const store = new SessionStore({ dir: join(root, "sessions"), enabled: false });
    _setStoreForTest(store);
    const forwarded: Record<string, unknown>[] = [];
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            forwarded.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
            res.writeHead(200, { "content-type": "application/json" });
            const bodies = {
                anthropic: { id: "msg_fixture", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: teachTokens, output_tokens: 10 } },
                openai: { id: "chat_fixture", choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: teachTokens, completion_tokens: 10 } },
                responses: { id: "resp_fixture", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }], usage: { input_tokens: teachTokens, output_tokens: 10 } },
                google: { candidates: [{ content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: teachTokens, candidatesTokenCount: 10 } },
            };
            res.end(JSON.stringify(bodies[wire]));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await listenWithRetry(upstream);
    const addr = upstream.address();
    assert(addr && typeof addr === "object");
    const upstreamUrl = `http://127.0.0.1:${addr.port}`;
    const proxy = await startServer({
        port: 0, host: "127.0.0.1", upstream: upstreamUrl,
        routes: { [upstreamUrl]: { models: { "model-test": { context: 64_000 } } } },
        modelContextLimit: 200_000, kernelConfig: defaultConfig(200_000),
        compress: { injectTool, injectNudge: true },
        promptCache: { routing: "auto" }, sessionHeader: "x-acp-session",
        log: false, debug: false, passthrough: false, autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const paddr = proxy.address();
    assert(paddr && typeof paddr === "object");
    const origin = `http://127.0.0.1:${paddr.port}`;

    const buildBody = (texts: string[]) => {
        const roles = texts.map((_, i) => (i % 2 === 0 ? "user" : "assistant"));
        if (wire === "google") {
            return {
                contents: texts.map((text, i) => ({ role: i % 2 === 0 ? "user" : "model", parts: [{ text }] })),
                ...(toolNames.length > 0 ? { tools: wireTools("google", toolNames) } : {}),
                generationConfig: { maxOutputTokens: 1024 },
            };
        }
        if (wire === "responses") {
            return {
                model: "model-test",
                input: texts.map((text, i) => ({ role: roles[i], content: [{ type: i % 2 === 0 ? "input_text" : "output_text", text }] })),
                ...(toolNames.length > 0 ? { tools: wireTools("responses", toolNames) } : {}),
                max_output_tokens: 1024, stream: false,
            };
        }
        return {
            model: "model-test",
            messages: texts.map((text, i) => ({ role: roles[i], content: text })),
            ...(toolNames.length > 0 ? { tools: wireTools(wire, toolNames) } : {}),
            max_tokens: 64_000, stream: false,
        };
    };
    const endpoint = wire === "anthropic" ? "/v1/messages" : wire === "openai" ? "/v1/chat/completions" : wire === "responses" ? "/v1/responses" : "/v1beta/models/model-test:generateContent";
    const send = async (texts: string[], opts?: { headerless?: boolean }) => {
        const r = await fetch(`${origin}/bili/${upstreamUrl}${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": `lane-${lane}-${toolNames.join("-") || "notools"}`, ...(lane === "proxy" || opts?.headerless ? {} : { "x-bili-plugin": lane }) },
            body: JSON.stringify(buildBody(texts)),
        });
        const bodyText = await r.text();
        assert.equal(r.status, 200, bodyText);
    };
    const close = async () => {
        store.cancelAll();
        await closeServers([proxy, upstream], "lane-decisions harness");
    };
    return { send, forwarded, close };
}

function outcome(wire: Wire, sentCount: number, forwarded: Record<string, unknown>): RowOutcome {
    // The nudge is an appended trailing USER message with long guidance text;
    // the client's own last turn is a short "now summarize". The standing
    // prompt adds a leading system/instructions entry, so count-based detection
    // is unreliable across wires — detect by shape.
    if (wire === "openai" || wire === "anthropic") {
        const msgs = (forwarded["messages"] ?? []) as { role?: string; content?: unknown }[];
        const last = msgs[msgs.length - 1];
        const lastText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
        const nudge = last?.role === "user" && lastText.length > 200;
        let sys = "";
        if (wire === "openai") {
            const first = msgs[0] as { role?: string; content?: unknown } | undefined;
            sys = first?.role === "system" ? String(first.content ?? "") : "";
        } else {
            const s = forwarded["system"];
            sys = typeof s === "string" ? s : JSON.stringify(s ?? "");
        }
        return { nudge, standingPrompt: sys.includes(STANDING_MARKER) };
    }
    if (wire === "responses") {
        const items = (forwarded["input"] ?? []) as { role?: string; content?: unknown }[];
        const last = items[items.length - 1];
        const lastText = JSON.stringify(last?.content ?? "");
        const nudge = last?.role === "user" && lastText.length > 200;
        let instr = "";
        const raw = forwarded["instructions"];
        if (typeof raw === "string") instr = raw;
        else if (Array.isArray(raw)) instr = raw.map(String).join("\n");
        const devItem = items.find((it) => (it as { type?: string }).type === "developer" || it.role === "developer" || it.role === "system");
        const devText = devItem ? JSON.stringify(devItem.content ?? "") : "";
        return { nudge, standingPrompt: instr.includes(STANDING_MARKER) || devText.includes(STANDING_MARKER) };
    }
    // google
    const contents = (forwarded["contents"] ?? []) as { role?: string; parts?: { text?: string }[] }[];
    const last = contents[contents.length - 1];
    const nudge = last?.role === "user" && (last.parts?.map((p) => p.text ?? "").join("").length ?? 0) > 200;
    const si = forwarded["systemInstruction"];
    const sys = typeof si === "string" ? si : JSON.stringify(si ?? "");
    return { nudge, standingPrompt: sys.includes(STANDING_MARKER) };
}

const ROWS: { name: string; lane: Lane; tools: string[]; injectTool?: boolean; teach?: number; headerlessProbe?: boolean; expect: (w: Wire) => RowOutcome }[] = [
    { name: "omp control keeps the surface", lane: "omp", tools: [], expect: () => ({ nudge: true, standingPrompt: true }) },
    { name: "dsh no-tools drops the surface (#3177)", lane: "dsh", tools: [], expect: () => ({ nudge: false, standingPrompt: false }) },
    // #3401 FIX ROW: dsh with compress actually declared on
    // the wire still drops the surface today. The fix commit flips this row to
    // {nudge:true, standingPrompt:true} — until then this pins the bug.
    { name: "dsh compress-on-wire keeps the surface (fix #3401 via lane-decisions observation)", lane: "dsh", tools: ["compress", "get_weather"], expect: () => ({ nudge: true, standingPrompt: true }) },
    // #3600 FIX ROW: dsh PTC presets collapse every tool into a single
    // `run_code` omnibus (SDK bindings nested inside it), so the top-level
    // absence of `compress` is NOT evidence of unreachability. 0.1.198 read
    // this shape as unreachable and suppressed the nudge all the way to the
    // 100% window (89× ARMED-SUPPRESSED, output clamped) — the omnibus reads
    // as reachable now.
    { name: "dsh run_code omnibus keeps the surface (#3600 PTC shape)", lane: "dsh", tools: ["run_code"], expect: () => ({ nudge: true, standingPrompt: true }) },
    // #3884 FIX ROW: DSH 0.2.x moved Code Mode into the dsh-codemode plugin,
    // whose transport is named `code_run` (the reserved name `run_code` belongs
    // to dsh-tools) — the #3603 single-literal gate missed this renamed shape
    // and suppressed the surface forever (issue log: 12× ARMED-SUPPRESSED at
    // 42% usage with pendingT1=504985 vs the 50000 threshold, 0 INJECT). The
    // omnibus-name set reads it reachable now; the precision rows below are
    // the negative direction of the same pair.
    { name: "dsh code_run omnibus keeps the surface (#3884 DSH 0.2.x shape)", lane: "dsh", tools: ["code_run"], expect: () => ({ nudge: true, standingPrompt: true }) },
    // Named-tool precision must survive the #3600 fix: a bare single tool
    // that is NOT the omnibus and NOT compress stays a true negative
    // (#3177 preset-standard shape keeps its suppression).
    { name: "dsh single non-omnibus tool still drops the surface (precision retained)", lane: "dsh", tools: ["get_weather"], expect: () => ({ nudge: false, standingPrompt: false }) },
    { name: "dsh acp_status-only drops the surface (named-tool precision target)", lane: "dsh", tools: ["acp_status"], expect: () => ({ nudge: false, standingPrompt: false }) },
    // #3427 review: pin the disclosed anthropic-wire convergence — with
    // injectTool off the nudge must stay off on ALL wires (master allowed it
    // on anthropic: gate drift, #3293 shape); red on pre-fix master [anthropic].
    { name: "injectTool-off drops the surface everywhere (anthropic nudge convergence)", lane: "omp", tools: [], injectTool: false, expect: () => ({ nudge: false, standingPrompt: false }) },
    // #3617-D: every profile's host-scoped default through the real chain.
    // pi/opencode are NOT host-scoped (registry default false) → the tool
    // table is irrelevant and the surface stays on.
    { name: "pi no-tools keeps the surface (registry default: not host-scoped)", lane: "pi", tools: [], expect: () => ({ nudge: true, standingPrompt: true }) },
    { name: "opencode no-tools keeps the surface (registry default: not host-scoped)", lane: "opencode", tools: [], expect: () => ({ nudge: true, standingPrompt: true }) },
    // Contrast twin of the dsh precision rows: a non-host-scoped lane ignores
    // the declared tool table entirely.
    { name: "omp single regular tool keeps the surface (non-host-scoped ignores tool table)", lane: "omp", tools: ["get_weather"], expect: () => ({ nudge: true, standingPrompt: true }) },
    // Proxy mode: bili injects its own tools into the outbound body, so the
    // surface is structurally on regardless of what the client declares.
    { name: "proxy control keeps the surface (structural on: bili owns the tool table)", lane: "proxy", tools: [], expect: () => ({ nudge: true, standingPrompt: true }) },
    // #3617-D EMERGENCY pair (#3461 guardrail), taught usage 45k/64k = 70%:
    // between the host escalation line (0.7) and the kernel over-limit line
    // (0.75) — the kernel declines on cadence while executable mass clears
    // minPressureBenefit, so ONLY the host override can arm the nudge.
    { name: "EMERGENCY override injects where the kernel declined cadence (#3461 guard)", lane: "omp", tools: [], teach: 45_000, expect: () => ({ nudge: true, standingPrompt: true }) },
    { name: "EMERGENCY cannot punch through an unreachable dsh tool table (reverse guard)", lane: "dsh", tools: [], teach: 45_000, expect: () => ({ nudge: false, standingPrompt: false }) },
    { name: "EMERGENCY override fires on the PTC run_code shape too", lane: "dsh", tools: ["run_code"], teach: 45_000, expect: () => ({ nudge: true, standingPrompt: true }) },
    { name: "EMERGENCY override fires on the PTC code_run shape too (#3884)", lane: "dsh", tools: ["code_run"], teach: 45_000, expect: () => ({ nudge: true, standingPrompt: true }) },
    // #4344 FIX ROWS (zcode). zcode reaches the ACP tools ONLY through its MCP
    // bridge, and bridge delivery is environmental (agent modes gate MCP tools;
    // the degraded shim serves an EMPTY tool list). The profile now mirrors
    // that truth: host-scoped, observed per request — a lane whose bridge is
    // absent goes silent instead of advertising a tool the model cannot call
    // (the #4344 shape: 5+ T1 nudges at 21-29% usage, 0 compressions in 46
    // requests). The dialect row is the companion fix: a healthy bridge
    // declares mcp__bili__compress, which counts as reachable (#4344).
    { name: "zcode no-tools drops the surface (#4344: bridge absent → do not advertise)", lane: "zcode", tools: [], expect: () => ({ nudge: false, standingPrompt: false }) },
    { name: "zcode mcp__bili__compress keeps the surface (#4344 dialect-aware reachability)", lane: "zcode", tools: ["mcp__bili__compress", "mcp__bili__acp_status"], expect: () => ({ nudge: true, standingPrompt: true }) },
    { name: "zcode bare compress keeps the surface (#4344 observed declaration)", lane: "zcode", tools: ["compress", "get_weather"], expect: () => ({ nudge: true, standingPrompt: true }) },
    { name: "zcode single regular tool still drops the surface (precision retained)", lane: "zcode", tools: ["get_weather"], expect: () => ({ nudge: false, standingPrompt: false }) },
    // #2155 FIX ROW: the sticky zcode session serves a HEADERLESS round (the
    // zombie shape — plugin gone from the client, session still bound). The
    // nudge channel doubles as the self-heal probe: #4372's host-scoped zcode
    // profile read these rounds as unreachable and starved zombieStreak, so
    // degrade-to-proxy never fired (issue2155-self-heal red on master). A
    // headerless plugin-bound round keeps the surface ON; the #4344 silent
    // bridge (header PRESENT, tools empty — row above) keeps going silent.
    { name: "zcode headerless zombie round keeps the surface (#2155 probe must stay armed)", lane: "zcode", tools: [], headerlessProbe: true, expect: () => ({ nudge: true, standingPrompt: true }) },
    // Dialect reachability is lane-independent: any host-scoped lane whose
    // wire carries the MCP-prefixed compress reads reachable, same as #3401's
    // bare-name observation on dsh.
    { name: "dsh mcp__bili__compress keeps the surface (#4344 dialect is lane-independent)", lane: "dsh", tools: ["mcp__bili__compress"], expect: () => ({ nudge: true, standingPrompt: true }) },
];

for (const wire of ["anthropic", "openai", "responses", "google"] as const) {
    for (const row of ROWS) {
        test(`lane matrix [${wire}] ${row.name}`, { timeout: 60_000 }, async () => {
            const h = await harness(wire, row.lane, row.tools, row.injectTool, row.teach);
            try {
                await h.send(["hello"]);                 // teach usage 50k / 64k = 78%
                await h.send(historyTexts(), { headerless: row.headerlessProbe === true });            // arm the nudge
                assert.equal(h.forwarded.length, 2, "both turns forwarded");
                const got = outcome(wire, historyTexts().length, h.forwarded[1]!);
                const want = row.expect(wire);
                assert.deepEqual(got, want, `wire=${wire} row=${row.name}`);
            } finally {
                await h.close();
            }
        });
    }
}

// #3417 Step 3 structural guard: the four wire prepares must not compare
// pluginAgent against lane names — gating flows through lane-decisions
// (resolveLaneDecisions). Header-evidence helpers (isCodexClient: codex sends
// no x-bili-plugin header) are exempt by design.
test("lane matrix: prepares carry no raw pluginAgent name comparisons (#3417)", { timeout: 60_000 }, async () => {
    const root = new URL("../src/server/", import.meta.url);
    for (const f of ["prepare-anthropic.ts", "prepare-openai.ts", "prepare-google.ts", "prepare-responses.ts"]) {
        const src = await readFile(new URL(f, root), "utf8");
        // Name-literal comparisons only (the typeof-cast feeding
        // resolveLaneDecisions is input plumbing, not a gate).
        assert.ok(!/\["pluginAgent"\]\s*===\s*"(dsh|pi|omp|opencode|codex|kimi)"/.test(src), `${f}: raw pluginAgent name comparison — route it through resolveLaneDecisions (#3417)`);
        assert.ok(!/(pluginAgent|pluginAgentHeader\([^)]*\))\s*===\s*"(dsh|pi|omp|opencode|codex|kimi)"/.test(src), `${f}: raw lane-name comparison — route it through resolveLaneDecisions (#3417)`);
    }
});

// #3482 Step 2 structural guard: the four migrated B-class sites must stay
// name-gate-free — identity policy lives in the lane-decisions registries.
test("lane matrix: B-class sites carry no raw lane-name gates (#3482)", { timeout: 60_000 }, async () => {
    const srcRoot = new URL("../src/", import.meta.url);
    // Site 3 (omp body stamp): the stamp channel is a registry property.
    // Brace-balanced slice (helpers between exports make anchor-based bounds
    // under-slice/over-slice).
    const piSrc = await readFile(new URL("agent/pi.ts", srcRoot), "utf8");
    const stampStart = piSrc.indexOf("export function stampPromptCacheKey");
    let depth = 0, stampEnd = -1;
    for (let i = stampStart; i < piSrc.length; i++) {
        if (piSrc[i] === "{") depth++;
        else if (piSrc[i] === "}") { depth--; if (depth === 0) { stampEnd = i + 1; break; } }
    }
    const stampFn = piSrc.slice(stampStart, stampEnd < 0 ? undefined : stampEnd);
    assert.ok(!/agent\s*[!=]==\s*"(omp|pi|dsh)"/.test(stampFn), "agent/pi.ts stampPromptCacheKey: raw agent-name gate — use hostProfileFor(agent).stampsBodyPromptCacheKey (#3482 site 3)");
    // Site 4 (instructions fingerprint): the wire-client header literals live
    // ONLY in the registry — session-id.ts observes, never decides.
    const sidSrc = await readFile(new URL("session-id.ts", srcRoot), "utf8");
    const fpFn = sidSrc.slice(sidSrc.indexOf("export function instructionsFingerprintApplies"), sidSrc.indexOf("}", sidSrc.indexOf("instructionsFingerprintKeyed")));
    assert.ok(!/x-codex-turn-metadata|x-claude-code-session-id/.test(fpFn), "session-id.ts instructionsFingerprintApplies: raw wire-client header literal — the decision table lives in WIRE_CLIENTS (#3482 site 4)");
    // Registry hygiene: every wire-client entry's matches() must reference the
    // signals it matches on (guards against an entry rotting into a copy-paste
    // of another's condition).
    const laneSrc = await readFile(new URL("server/lane-decisions.ts", srcRoot), "utf8");
    const registryBlock = laneSrc.slice(laneSrc.indexOf("const WIRE_CLIENTS"), laneSrc.indexOf("resolveWireClientProfile"));
    const entryCount = (registryBlock.match(/profile:\s*\{/g) ?? []).length;
    const matchCount = (registryBlock.match(/matches:\s*\(/g) ?? []).length;
    assert.equal(entryCount, matchCount, "lane-decisions.ts WIRE_CLIENTS: every entry needs a matches() (#3482)");
    // #3482 review: the profile registry must stay an IMPORT-FREE leaf —
    // agent-side bundles (dist/agent/pi.js, omp.js) import it directly; any
    // import here would drag server modules (preflight → kernel) into the
    // client-process bundles (first cut of this PR doubled them).
    const hpSrc = await readFile(new URL("host-profiles.ts", srcRoot), "utf8");
    assert.ok(!/^import /m.test(hpSrc), "src/host-profiles.ts must stay import-free (#3482 review)");
});
