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
//
// The nudge arms deterministically: usage reports 50k against a 64k
// operator-declared window (78%) with a compressible history outside the
// protected recent zone (same recipe as plugin-nudge-injection.test.ts).

process.env.NODE_ENV = "test";

const root = mkdtempSync(join(tmpdir(), "bili-lane-matrix-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
for (const key of ["HOME", "APPHOME", "HERMES_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) process.env[key] = root;

type Wire = "anthropic" | "openai" | "responses" | "google";
type Lane = "omp" | "dsh";

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

async function harness(wire: Wire, lane: Lane, toolNames: string[], injectTool = true) {
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
                anthropic: { id: "msg_fixture", role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 50_000, output_tokens: 10 } },
                openai: { id: "chat_fixture", choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 50_000, completion_tokens: 10 } },
                responses: { id: "resp_fixture", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }], usage: { input_tokens: 50_000, output_tokens: 10 } },
                google: { candidates: [{ content: { role: "model", parts: [{ text: "answer" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 50_000, candidatesTokenCount: 10 } },
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
    const send = async (texts: string[]) => {
        const r = await fetch(`${origin}/bili/${upstreamUrl}${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-acp-session": `lane-${lane}-${toolNames.join("-") || "notools"}`, "x-bili-plugin": lane },
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

const ROWS: { name: string; lane: Lane; tools: string[]; injectTool?: boolean; expect: (w: Wire) => RowOutcome }[] = [
    { name: "omp control keeps the surface", lane: "omp", tools: [], expect: () => ({ nudge: true, standingPrompt: true }) },
    { name: "dsh no-tools drops the surface (#3177)", lane: "dsh", tools: [], expect: () => ({ nudge: false, standingPrompt: false }) },
    // #3401 FIX ROW: dsh with compress actually declared on
    // the wire still drops the surface today. The fix commit flips this row to
    // {nudge:true, standingPrompt:true} — until then this pins the bug.
    { name: "dsh compress-on-wire keeps the surface (fix #3401 via lane-decisions observation)", lane: "dsh", tools: ["compress", "get_weather"], expect: () => ({ nudge: true, standingPrompt: true }) },
    { name: "dsh acp_status-only drops the surface (named-tool precision target)", lane: "dsh", tools: ["acp_status"], expect: () => ({ nudge: false, standingPrompt: false }) },
    // #3427 review: pin the disclosed anthropic-wire convergence — with
    // injectTool off the nudge must stay off on ALL wires (master allowed it
    // on anthropic: gate drift, #3293 shape); red on pre-fix master [anthropic].
    { name: "injectTool-off drops the surface everywhere (anthropic nudge convergence)", lane: "omp", tools: [], injectTool: false, expect: () => ({ nudge: false, standingPrompt: false }) },
];

for (const wire of ["anthropic", "openai", "responses", "google"] as const) {
    for (const row of ROWS) {
        test(`lane matrix [${wire}] ${row.name}`, { timeout: 60_000 }, async () => {
            const h = await harness(wire, row.lane, row.tools, row.injectTool);
            try {
                await h.send(["hello"]);                 // teach usage 50k / 64k = 78%
                await h.send(historyTexts());            // arm the nudge
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
