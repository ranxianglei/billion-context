import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { WebSocketServer } from "ws";

process.env.NODE_ENV = "test";

// #2111 (implementation follow-up to #2073/#2080): Pi native mode must route
// openai-codex-responses WebSocket traffic through bili even when transport
// "auto"/"websocket" connects successfully. The REAL pi CLI runs package-native
// (repo root loaded as a pi package) against a deterministic local mock that
// speaks Responses over WS — plus SSE for the fallback legs — zero tokens.
// Asserted end to end:
//   A  explicit "websocket": upgrade interception, session-id + x-bili-plugin*
//      stamps on the handshake (#2073 Q4), real compress/decompress through the
//      plugin channel, post-fold history consistency;
//   B  "auto": WS success still routes (the #2073 gap) AND previous_response_id
//      incremental continuation arrives expanded;
//   C  "auto" with a failing WS handshake: same-turn SSE fallback stays stamped;
//   D  explicit "sse": regression guard, full fold cycle over HTTP;
//   E  two subagent-style sessions sharing one proxy: distinct conversations,
//      identical tool args, no cross-talk.
// Hermetic PI_CODING_AGENT_DIR + XDG dirs; spawn cwd outside the repo tree
// (#815); pi pinned in CI (ci-e2e-pi-ws.yml).
// Run: npm run build && ACP_TEST_E2E_PI_WS=1 node --import tsx --test tests/e2e/e2e-pi-codex-ws.test.ts

const PI_BIN = process.env.E2E_PI_BIN ?? "pi";
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const PI_NATIVE_ENTRY = path.join(REPO_ROOT, "dist/agent/pi-native.js");
const TMO = Number(process.env.E2E_TMO ?? 180_000);
const WORK_ROOT = path.join(process.cwd(), "tmp");
fs.mkdirSync(WORK_ROOT, { recursive: true });
const CWD_ROOT = path.join(os.tmpdir(), "billion-context-e2e-pi-ws");
fs.mkdirSync(CWD_ROOT, { recursive: true });

const run = process.env.ACP_TEST_E2E_PI_WS === "1";

function piAvailable(): boolean {
    try {
        return spawnSync(PI_BIN, ["--version"], { timeout: 15_000 }).status === 0;
    } catch {
        return false;
    }
}

const skipReason = !run
    ? "set ACP_TEST_E2E_PI_WS=1 (real pi + local mock WS upstream; deterministic, zero tokens)"
    : !fs.existsSync(PI_NATIVE_ENTRY)
        ? "dist/agent/pi-native.js missing — run `npm run build` first"
        : !piAvailable()
            ? `pi binary "${PI_BIN}" not found on PATH`
            : undefined;

type Item = Record<string, unknown>;
type Row = { transport: "ws" | "http"; body: Item; full: Item[]; headers: Record<string, string> };

/** pi's extractAccountId requires a 3-part JWT carrying the chatgpt_account_id
 *  claim, so the fake apiKey is a structurally valid (unsigned) JWT. */
function fakeJwt(accountId: string): string {
    const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64");
    return `${b64({ alg: "none", typ: "JWT" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
}

function filler(lines: number, tag: string): string {
    const out: string[] = [];
    for (let n = 0; n < lines; n += 1) out.push(`filler ${tag} line ${n}: marker=${n * 7} ${"x".repeat(30)}`);
    return out.join("\n");
}

const itemText = (item: Item | undefined): string => typeof item?.content === "string"
    ? item.content
    : Array.isArray(item?.content)
        ? item.content.map((part) => typeof part === "object" && part !== null ? String((part as Item).text ?? "") : "").join("\n")
        : "";

/** ACP ref tags injected by bili into forwarded request text (hex-escaped per KDD #2). */
const refsOf = (text: string): string[] => {
    const out: string[] = [];
    for (const m of text.matchAll(/\x3cacp[^\x3e]*\x3e(m\d+)\x3c\/acp\x3e/g)) out.push(m[1]!);
    return out;
};

function recordHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) if (typeof v === "string") out[k] = v;
    return out;
}

// ---------------------------------------------------------------------------
// Mock upstream: Responses-over-WS (+ SSE on the POST leg), scripted model.
// Directives ride in the user text: WS_FOLD_REQUEST_B64 / WS_DECOMPRESS_B64
// carry b64-encoded tool args; WS_STATUS triggers an acp_status call.
// previous_response_id frames are expanded against per-response snapshots,
// mirroring the real Codex continuation protocol.
// ---------------------------------------------------------------------------

type MockUpstream = {
    server: http.Server;
    port: number;
    rows: Row[];
    stats: { wsConnections: number };
};

async function startMock(opts: { failUpgrade?: boolean; getRowsPath?: () => string | undefined } = {}): Promise<MockUpstream> {
    const rows: Row[] = [];
    const stats = { wsConnections: 0 };
    let serial = 0;
    const snapshots = new Map<string, Item[]>();
    // One-shot instruction guard: the directive text persists in the user message
    // across the tool loop, so without this the scripted model re-issues the same
    // tool call forever after a failed attempt (observed: ~2000 requests in 179 s).
    const instructed = new Set<string>();

    const reply = (body: Item, headers: Record<string, string>, transport: "ws" | "http", send: (event: Item) => void): void => {
        const prior = typeof body.previous_response_id === "string" ? snapshots.get(body.previous_response_id) : undefined;
        const input = Array.isArray(body.input) ? (body.input as Item[]) : [];
        const full = [...(prior ?? []), ...input];
        rows.push({ transport, body, full, headers });
        // Incremental evidence: survives any later t.after crash (the final
        // dump alone lost rows.json whenever cleanup threw first).
        const rowsPath = opts.getRowsPath?.();
        if (rowsPath) {
            try {
                // Item-level projection keeps post-mortem forensics possible even
                // when t.after dies before the final pretty dump.
                const brief = (i: Item): string[] => {
                    const text = i.type === "function_call_output" ? String(i.output ?? "") : itemText(i);
                    return [String(i.type ?? "?"), String(i.name ?? i.role ?? ""), String(i.call_id ?? ""), text.slice(0, 60).replace(/\n/g, "\\n")];
                };
                fs.writeFileSync(rowsPath, JSON.stringify(rows.map((r) => ({ transport: r.transport, headers: r.headers, prevId: r.body.previous_response_id, inputLen: Array.isArray(r.body.input) ? (r.body.input as unknown[]).length : 0, fullLen: r.full.length, items: r.full.map(brief) }))));
            } catch { /* evidence-only */ }
        }

        const lastUser = [...full].reverse().find((item) => item.role === "user");
        const text = itemText(lastUser);
        const foldEnc = text.match(/WS_FOLD_REQUEST_B64 ([A-Za-z0-9+/=]+)/)?.[1];
        const decEnc = text.match(/WS_DECOMPRESS_B64 ([A-Za-z0-9+/=]+)/)?.[1];
        let name: string | undefined;
        let args = "{}";
        const conv = typeof headers["x-bili-plugin-conversation"] === "string" ? headers["x-bili-plugin-conversation"] : "?";
        // ACP tools register during call #1's before_provider_headers, so they are
        // invisible to pi's executor until call >= 2 of the same process. Prime the
        // tool loop with probe_tool (package-registered at load, visible from call
        // #1), then issue the ACP call on the continuation — the pattern proven in
        // e2e-native-pi.test.ts ("请调用probe_tool;请调用compress;请调用acp_status").
        const pick = (key: string, tool: string, toolArgs: string): void => {
            if (name !== undefined || instructed.has(`${conv}:${key}`)) return;
            if (instructed.has(`${conv}:${key}-prime`)) {
                instructed.add(`${conv}:${key}`);
                name = tool;
                args = toolArgs;
                return;
            }
            instructed.add(`${conv}:${key}-prime`);
            name = "probe_tool";
        };
        if (foldEnc) pick("fold", "compress", Buffer.from(foldEnc, "base64").toString("utf8"));
        else if (decEnc) pick("decompress", "decompress", Buffer.from(decEnc, "base64").toString("utf8"));
        else if (/WS_STATUS/.test(text)) pick("status", "acp_status", "{}");

        const id = `resp_pi_ws_${++serial}`;
        const fcId = `fc_${id}`;
        const msgId = `msg_${id}`;
        const item: Item = name
            ? { type: "function_call", id: fcId, call_id: `call_${id}`, name, arguments: args, status: "completed" }
            : { type: "message", id: msgId, role: "assistant", status: "completed", content: [{ type: "output_text", text: "WS_E2E_OK", annotations: [] }] };
        const inputTokens = Math.max(1, Math.ceil(full.reduce((n, i) => n + itemText(i).length, 0) / 4));
        let sequence = 0;
        const event = (type: string, data: Item): void => send({ type, sequence_number: sequence++, ...data });
        event("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
        event("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", ...(name ? { arguments: "" } : { content: [] }) } });
        if (name) {
            event("response.function_call_arguments.delta", { item_id: fcId, output_index: 0, delta: args });
            event("response.function_call_arguments.done", { item_id: fcId, output_index: 0, arguments: args });
        } else {
            event("response.content_part.added", { item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
            event("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta: "WS_E2E_OK" });
            event("response.output_text.done", { item_id: msgId, output_index: 0, content_index: 0, text: "WS_E2E_OK" });
            event("response.content_part.done", { item_id: msgId, output_index: 0, content_index: 0, part: (item.content as Item[])[0] });
        }
        event("response.output_item.done", { output_index: 0, item });
        snapshots.set(id, [...full, item]);
        event("response.completed", { response: { id, object: "response", model: body.model, status: "completed", output: [item], usage: { input_tokens: inputTokens, output_tokens: 10, total_tokens: inputTokens + 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
    };

    const server = http.createServer((req, res) => {
        if (req.method !== "POST") { res.writeHead(404).end(); return; }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            // pi's SSE leg zstd-compresses the body (Codex backend contract).
            let raw = Buffer.concat(chunks);
            if (String(req.headers["content-encoding"] ?? "").includes("zstd")) raw = zlib.zstdDecompressSync(raw);
            let body: Item;
            try {
                body = JSON.parse(raw.toString("utf8")) as Item;
            } catch {
                res.writeHead(400).end();
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            reply(body, recordHeaders(req.headers), "http", (ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
            res.end();
        });
    });
    if (!opts.failUpgrade) {
        const wss = new WebSocketServer({ server });
        wss.on("connection", (peer, req) => {
            stats.wsConnections += 1;
            peer.on("message", (raw) => {
                let body: Item;
                try {
                    body = JSON.parse(String(raw)) as Item;
                } catch {
                    return;
                }
                reply(body, recordHeaders(req.headers), "ws", (ev) => peer.send(JSON.stringify(ev)));
            });
        });
    } else {
        // Refuse the handshake the way a real server would: HTTP status on the
        // upgrade request. A raw socket.destroy() surfaces as a NON-transport
        // error in pi's classifier (isCodexNonTransportError → throw, no SSE
        // fallback); production ChatGPT refusals carry status codes.
        server.on("upgrade", (_req, socket) => {
            stats.wsConnections += 1; // refusals count too: C asserts upstream ATTEMPTS
            socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            socket.end();
        });
    }
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, port: (server.address() as { port: number }).port, rows, stats };
}

// ---------------------------------------------------------------------------
// Hermetic pi context (mirrors e2e-native-pi.test.ts mechanics)
// ---------------------------------------------------------------------------

type Ctx = {
    work: string;
    piCwd: string;
    piAgentDir: string;
    xdg: { config: string; cache: string; state: string; data: string };
};

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    // This suite may run INSIDE a bili-driven shell: the native lane must
    // bootstrap/attach its OWN proxy, so every bili side-channel has to go.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("BILI") || key.startsWith("BILLION_CONTEXT") || key.startsWith("ACP_")) delete env[key];
    }
    // NODE_TEST_CONTEXT stands down pi-native inside node:test; the spawned pi
    // is a real client, not a test context (same rationale as e2e-native-pi).
    for (const key of ["NODE_EXTRA_CA_CERTS", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "NODE_OPTIONS", "NODE_TEST_CONTEXT"]) delete env[key];
    return { ...env, ...extra };
}

async function startCtx(transport: string, mockPort: number): Promise<Ctx> {
    const work = fs.mkdtempSync(path.join(WORK_ROOT, "e2e-pi-codex-ws-"));
    const ctx: Ctx = {
        work,
        piCwd: fs.mkdtempSync(path.join(CWD_ROOT, "cwd-")),
        piAgentDir: path.join(work, "pi-agent"),
        xdg: {
            config: path.join(work, "xdg-config"),
            cache: path.join(work, "xdg-cache"),
            state: path.join(work, "xdg-state"),
            data: path.join(work, "xdg-data"),
        },
    };
    const biliCfgDir = path.join(ctx.xdg.config, "billion-context");
    for (const d of [ctx.piAgentDir, biliCfgDir, ctx.xdg.cache, ctx.xdg.state, ctx.xdg.data]) fs.mkdirSync(d, { recursive: true });

    // Benign host tool visible from call #1 of every process: primes the tool
    // loop before ACP tools land (they register from the 2nd request on). Same
    // package shape as e2e-native-pi.test.ts.
    const probePkg = path.join(work, "probe-pkg");
    fs.mkdirSync(probePkg, { recursive: true });
    fs.writeFileSync(
        path.join(probePkg, "package.json"),
        JSON.stringify({ name: "probe-pkg", version: "1.0.0", pi: { extensions: ["./index.js"] } }, null, 2),
    );
    fs.writeFileSync(
        path.join(probePkg, "index.js"),
        [
            `const BIG = Array.from({ length: 60 }, (_, i) => \`probe payload line \${i}: unique-\${i * 7} \${"p".repeat(30)}\`).join("\\n");`,
            "export default function (pi) {",
            "  pi.registerTool({",
            '    name: "probe_tool",',
            '    description: "e2e probe tool returning an oversized payload for compress tests",',
            '    parameters: { type: "object", properties: { text: { type: "string" } } },',
            '    execute: async () => ({ content: [{ type: "text", text: `probe ok\\n${BIG}` }] }),',
            "  });",
            "}",
        ].join("\n"),
    );
    fs.writeFileSync(path.join(ctx.piAgentDir, "settings.json"), JSON.stringify({ packages: [REPO_ROOT, probePkg], transport }, null, 2));
    fs.writeFileSync(
        path.join(ctx.piAgentDir, "models.json"),
        JSON.stringify(
            {
                providers: {
                    "codex-fake": {
                        baseUrl: `http://127.0.0.1:${mockPort}/backend-api`,
                        api: "openai-codex-responses",
                        apiKey: fakeJwt("acct-e2e-pi-ws"),
                        models: [{ id: "codex-fake-model", name: "CodexFake", input: ["text"], contextWindow: 200_000, maxTokens: 8192 }],
                    },
                },
            },
            null,
            2,
        ),
    );
    // Loosen the kernel's recent-content protection so the scripted fold can
    // target the planted bulk (same seam the opencode WS suite uses).
    fs.writeFileSync(path.join(biliCfgDir, "billion-context.json"), JSON.stringify({ compress: { preserveRecentTokens: 0 } }));
    return ctx;
}

function piRun(
    ctx: Ctx,
    prompt: string,
    opts: { resume?: boolean; extraEnv?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
    const args = ["-p", "--model", "codex-fake/codex-fake-model"];
    if (opts.resume) args.push("--continue");
    args.push(prompt);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const outFile = path.join(ctx.work, `pi-${stamp}.out`);
    const errFile = path.join(ctx.work, `pi-${stamp}.err`);
    return new Promise((resolve, reject) => {
        const child = spawn(PI_BIN, args, {
            cwd: ctx.piCwd,
            env: {
                ...cleanEnv(opts.extraEnv),
                PI_CODING_AGENT_DIR: ctx.piAgentDir,
                XDG_CONFIG_HOME: ctx.xdg.config,
                XDG_CACHE_HOME: ctx.xdg.cache,
                XDG_STATE_HOME: ctx.xdg.state,
                XDG_DATA_HOME: ctx.xdg.data,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => { out += c; });
        child.stderr.on("data", (c) => { err += c; });
        const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* noop */ }
            reject(new Error(`pi -p timed out after ${TMO}ms`));
        }, TMO);
        child.on("exit", (code) => {
            clearTimeout(timer);
            fs.writeFileSync(outFile, out);
            fs.writeFileSync(errFile, err);
            resolve({ code: code ?? -1, stdout: out, stderr: err });
        });
    });
}

function stopProxiesGracefully(ctx: Ctx): void {
    const dir = path.join(ctx.xdg.state, "billion-context", "instances");
    try {
        for (const f of fs.readdirSync(dir)) {
            try {
                const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { pid?: number };
                if (typeof rec.pid === "number" && rec.pid > 0) {
                    try { process.kill(rec.pid, "SIGTERM"); } catch { /* already gone */ }
                }
            } catch { /* unreadable record */ }
        }
    } catch { /* no instances dir */ }
}

function teardownProxies(ctx: Ctx): void {
    const dir = path.join(ctx.xdg.state, "billion-context", "instances");
    try {
        for (const f of fs.readdirSync(dir)) {
            try {
                const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { pid?: number };
                if (typeof rec.pid === "number" && rec.pid > 0) {
                    try { process.kill(rec.pid, "SIGKILL"); } catch { /* already gone */ }
                }
            } catch { /* unreadable record */ }
        }
    } catch { /* no instances dir */ }
}

function biliLog(ctx: Ctx): string {
    try {
        return fs.readFileSync(path.join(ctx.xdg.state, "billion-context", "bili.log"), "utf8");
    } catch {
        return "";
    }
}

type SessionFile = { payload?: { metadata?: { pluginAgent?: string }; stats?: { requests?: number }; state?: { blocks?: unknown[] } } };

function sessionFiles(ctx: Ctx): SessionFile[] {
    const dir = path.join(ctx.xdg.data, "billion-context", "sessions");
    const out: SessionFile[] = [];
    try {
        for (const prov of fs.readdirSync(dir)) {
            let entries: string[];
            try { entries = fs.readdirSync(path.join(dir, prov)); } catch { continue; }
            for (const f of entries) {
                if (!f.endsWith(".json")) continue;
                try { out.push(JSON.parse(fs.readFileSync(path.join(dir, prov, f), "utf8")) as SessionFile); } catch { /* unreadable */ }
            }
        }
    } catch { /* no sessions dir */ }
    return out;
}

function proxyOriginOf(ctx: Ctx): string | undefined {
    const dir = path.join(ctx.xdg.state, "billion-context", "instances");
    try {
        for (const f of fs.readdirSync(dir)) {
            const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { origin?: string; host?: string; port?: number };
            if (typeof rec.origin === "string" && rec.origin) return rec.origin;
            if (typeof rec.port === "number" && rec.port > 0) return `http://${rec.host ?? "127.0.0.1"}:${rec.port}`;
        }
    } catch { /* no instances dir */ }
    return undefined;
}

const convsOf = (rows: Row[]): Set<string> => {
    const out = new Set<string>();
    for (const r of rows) {
        const c = r.headers["x-bili-plugin-conversation"];
        if (typeof c === "string" && c) out.add(c);
    }
    return out;
};

/** Find the tool-result text for a given call in a row's expanded history. */
function toolResult(row: Row, name: string): string | undefined {
    const call = [...row.full].reverse().find((i) => i.type === "function_call" && i.name === name);
    if (!call) return undefined;
    const out = row.full.find((i) => i.type === "function_call_output" && i.call_id === call.call_id);
    return out ? String(out.output ?? "") : undefined;
}

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("preflight: pi binary + built dist + mock handshake (E2E_CHECK)", { skip: skipReason }, async (t) => {
    const version = spawnSync(PI_BIN, ["--version"], { timeout: 15_000 }).stdout?.toString().trim() ?? "?";
    const mock = await startMock();
    try {
        assert.ok(mock.port > 0);
    } finally {
        mock.server.closeAllConnections();
        await new Promise<void>((r) => mock.server.close(() => r()));
    }
    t.diagnostic(`pi ${version}, dist ${PI_NATIVE_ENTRY}, mock handshake ok`);
});

test("A: explicit websocket — intercepted, stamped, compress/decompress round trip", { skip: skipReason, timeout: 900_000 }, async (t) => {
    let ctx: Ctx | undefined;
    const mock = await startMock({ getRowsPath: () => (ctx ? path.join(ctx.work, "rows.json") : undefined) });
    t.after(async () => {
        if (ctx) stopProxiesGracefully(ctx);
        await new Promise((r) => setTimeout(r, 500));
        if (ctx) teardownProxies(ctx);
        mock.server.closeAllConnections();
        await new Promise<void>((r) => mock.server.close(() => r()));
        if (ctx) fs.writeFileSync(path.join(ctx.work, "rows.json"), JSON.stringify(mock.rows.map((r) => ({ transport: r.transport, headers: r.headers, prevId: r.body.previous_response_id, fullLen: r.full.length, inputLen: Array.isArray(r.body.input) ? (r.body.input as unknown[]).length : 0 })), null, 2));
    });
    ctx = await startCtx("websocket", mock.port);

    const SENTINEL = "SENTINEL_A_PI_WS";
    const SUMMARY = "FOLDED_SUMMARY_A_PI_WS: folded 150 lines of filler bulk planted by scenario A; no decisions or state retained beyond this marker.";
    const ok = (label: string, r: { code: number; stdout: string; stderr: string }): void => {
        assert.equal(r.code, 0, `${label}: exit ${r.code}\n${r.stderr.slice(-2000)}`);
        assert.ok(r.stdout.includes("WS_E2E_OK"), `${label}: model answer missing\n${r.stdout.slice(-1000)}\n${r.stderr.slice(-1000)}`);
    };

    ok("warmup", await piRun(ctx, "ping one"));
    ok("bulk", await piRun(ctx, `${filler(150,"A")} ${SENTINEL}`, { resume: true }));
    ok("pushback 1", await piRun(ctx, "pushback one", { resume: true }));
    ok("pushback 2", await piRun(ctx, "pushback two", { resume: true }));

    const wsRows = mock.rows.filter((r) => r.transport === "ws");
    assert.ok(wsRows.length >= 4, `expected >=4 WS requests, got ${wsRows.length}`);
    assert.equal(convsOf(wsRows).size, 1, "one conversation across all WS requests");
    const conv = [...convsOf(wsRows)][0]!;
    assert.equal(wsRows.every((r) => r.headers["x-bili-plugin"] === "pi"), true, "x-bili-plugin stamp on every WS handshake");
    assert.ok(wsRows.every((r) => typeof r.headers["session-id"] === "string" && r.headers["session-id"].length > 0), "session-id header reaches the proxy");
    assert.equal(wsRows[0]!.headers["session-id"], conv, "WS session-id equals the conversation identity (HTTP-path parity)");

    // Harvest refs from the last pre-fold request. The fold starts at the FIRST
    // USER message ref (never the pinned head-system anchor) and ends at the
    // sentinel message ref.
    const lastPreFold = wsRows.at(-1)!;
    const userRefs = lastPreFold.full.filter((i) => i.role === "user").flatMap((i) => refsOf(itemText(i)));
    assert.ok(userRefs.length >= 2, `ACP tags on user messages present (${userRefs.length})`);
    const sentinelItem = lastPreFold.full.find((i) => i.role === "user" && itemText(i).includes(SENTINEL));
    const sentinelRef = sentinelItem ? refsOf(itemText(sentinelItem))[0] : undefined;
    assert.ok(sentinelRef, "sentinel message carries an ACP ref tag");
    const minRef = userRefs.reduce((a, b) => (Number(a.slice(1)) < Number(b.slice(1)) ? a : b));

    ok("fold", await piRun(ctx, `WS_FOLD_REQUEST_B64 ${b64({ content: [{ startId: minRef, endId: sentinelRef, summary: SUMMARY }] })}`, { resume: true }));
    const foldedRow = mock.rows.filter((r) => r.transport === "ws").find((r) => toolResult(r, "compress")?.includes("Compressed"));
    assert.ok(foldedRow, "compress executed and reported the fold");

    ok("status", await piRun(ctx, "WS_STATUS post-fold recall", { resume: true }));
    const statusRow = mock.rows.filter((r) => r.transport === "ws").find((r) => toolResult(r, "acp_status"));
    assert.ok(statusRow, "acp_status executed after the fold");
    // Harvest the block id from the COMPRESSED BLOCKS section only. The
    // naive /\bb(\d+)\b/ lottery: the ACTIVE SURFACE line carries the build
    // stamp "(b<shortsha>)", and a PR merge ref whose abbreviated SHA is 'b'
    // followed by digits (e.g. b288144) matches FIRST and hijacks the harvest
    // (observed on #2736, run 38119865934: decompress b288144 → not found).
    const blockId = toolResult(statusRow!, "acp_status")!.match(/COMPRESSED BLOCKS[^\n]*\n[\s\S]*?\n\s+b(\d+) \(/)?.[1];
    assert.ok(blockId, "acp_status report lists the compressed block (need its bN ref)");
    const statusJson = JSON.stringify(statusRow!.full);
    assert.ok(!statusJson.includes(SENTINEL), "post-fold request no longer carries the folded bulk");
    assert.ok(statusJson.includes(SUMMARY), "post-fold request carries the summary");

    ok("decompress", await piRun(ctx, `WS_DECOMPRESS_B64 ${b64({ blockId: `b${blockId}` })}`, { resume: true }));
    ok("recall", await piRun(ctx, "final recall", { resume: true }));

    const final = mock.rows.filter((r) => r.transport === "ws").at(-1)!;
    assert.ok(JSON.stringify(final.full).includes(SENTINEL), "decompressed content is back in the rebuilt history");

    const log = biliLog(ctx);
    assert.match(log, /forward WS/);
    assert.match(log, /tool compress executed via plugin/);
    assert.match(log, /acp-usage/);

    stopProxiesGracefully(ctx);
    await new Promise((r) => setTimeout(r, 500));
    const sessions = sessionFiles(ctx);
    assert.ok(sessions.length >= 1, "session persisted");
    assert.ok(sessions.every((s) => s.payload?.metadata?.pluginAgent === "pi"), "plugin-mode binding persisted");
    assert.ok(sessions.some((s) => Array.isArray(s.payload?.state?.blocks) && (s.payload.state.blocks as unknown[]).length >= 1), "compressed block persisted");
});

test("B: auto — successful WS still routes, previous_response_id continuation expands", { skip: skipReason, timeout: 900_000 }, async (t) => {
    let ctx: Ctx | undefined;
    const mock = await startMock({ getRowsPath: () => (ctx ? path.join(ctx.work, "rows.json") : undefined) });
    t.after(async () => {
        if (ctx) stopProxiesGracefully(ctx);
        await new Promise((r) => setTimeout(r, 500));
        if (ctx) teardownProxies(ctx);
        mock.server.closeAllConnections();
        await new Promise<void>((r) => mock.server.close(() => r()));
    });
    ctx = await startCtx("auto", mock.port);

    const SENTINEL = "SENTINEL_B_PI_WS";
    const SUMMARY = "FOLDED_SUMMARY_B_PI_WS: folded 150 lines of filler bulk planted by scenario B; no decisions or state retained beyond this marker.";
    const ok = (label: string, r: { code: number; stdout: string; stderr: string }): void => {
        assert.equal(r.code, 0, `${label}: exit ${r.code}\n${r.stderr.slice(-2000)}`);
        assert.ok(r.stdout.includes("WS_E2E_OK"), `${label}: model answer missing`);
    };

    ok("warmup", await piRun(ctx, "ping auto one"));
    ok("bulk", await piRun(ctx, `${filler(150,"B")} ${SENTINEL}`, { resume: true }));
    ok("pushback 1", await piRun(ctx, "pushback one", { resume: true }));
    ok("pushback 2", await piRun(ctx, "pushback two", { resume: true }));

    const wsRows = () => mock.rows.filter((r) => r.transport === "ws");
    assert.ok(wsRows().length >= 4, `auto mode used WS (${wsRows().length} rows)`);
    assert.equal(convsOf(wsRows()).size, 1);
    assert.ok(wsRows().every((r) => r.headers["x-bili-plugin"] === "pi" && typeof r.headers["session-id"] === "string" && r.headers["session-id"].length > 0));

    const lastPreFold = wsRows().at(-1)!;
    const userRefs = lastPreFold.full.filter((i) => i.role === "user").flatMap((i) => refsOf(itemText(i)));
    const sentinelItem = lastPreFold.full.find((i) => i.role === "user" && itemText(i).includes(SENTINEL));
    const sentinelRef = sentinelItem ? refsOf(itemText(sentinelItem))[0] : undefined;
    assert.ok(sentinelRef && userRefs.length >= 2, `user-message ACP refs present (${userRefs.length})`);
    const minRef = userRefs.reduce((a, b) => (Number(a.slice(1)) < Number(b.slice(1)) ? a : b));

    ok("fold", await piRun(ctx, `WS_FOLD_REQUEST_B64 ${b64({ content: [{ startId: minRef, endId: sentinelRef, summary: SUMMARY }] })}`, { resume: true }));

    // Delta frames emerge inside multi-call tool-loop processes (pi's
    // websocketSessionCache is per-process): A/E show them on the final call of
    // an acp_status loop, never on single-prompt runs. Mirror A's proven shape.
    ok("status", await piRun(ctx, "WS_STATUS", { resume: true }));

    // findLast, not find (#2880): the fold turn's own FIRST upstream call can
    // itself arrive as a previous_response_id delta frame — by definition it
    // predates compress execution, so its expanded full can never carry the
    // "Compressed" tool result. Picking the LATEST continuation (the status
    // turn's final call) keeps the fold-result assertion below deterministic
    // regardless of which turns
    // pi's per-process websocketSessionCache happens to send incrementally.
    const cont = wsRows().findLast((r) => typeof r.body.previous_response_id === "string" && Array.isArray(r.body.input) && r.full.length > (r.body.input as unknown[]).length);
    assert.ok(cont, "previous_response_id incremental continuation observed and expanded");
    assert.ok(cont!.full.some((i) => i.type === "function_call_output" && String(i.output ?? "").includes("Compressed")), "continuation frame carries the fold result");

    const afterFold = wsRows().filter((r) => r.full.some((i) => i.type === "function_call_output" && String(i.output ?? "").includes("Compressed")));
    const final = afterFold.at(-1)!;
    assert.ok(!JSON.stringify(final.full).includes(SENTINEL), "post-fold history lost the bulk");
    assert.ok(JSON.stringify(final.full).includes(SUMMARY), "post-fold history carries the summary");

    assert.match(biliLog(ctx), /forward WS/);
});

test("C: auto — upstream WS refusal falls back to HTTP egress; explicit sse unaffected", { skip: skipReason, timeout: 900_000 }, async (t) => {
    let ctx: Ctx | undefined;
    let ctxSse: Ctx | undefined;
    const mock = await startMock({ failUpgrade: true, getRowsPath: () => (ctx ? path.join(ctx.work, "rows.json") : undefined) });
    t.after(async () => {
        if (ctx) stopProxiesGracefully(ctx);
        if (ctxSse) stopProxiesGracefully(ctxSse);
        await new Promise((r) => setTimeout(r, 500));
        if (ctx) teardownProxies(ctx);
        if (ctxSse) teardownProxies(ctxSse);
        mock.server.closeAllConnections();
        await new Promise<void>((r) => mock.server.close(() => r()));
    });
    ctx = await startCtx("auto", mock.port);

    // #3342: interception moves the client handshake onto bili (local — always
    // succeeds), so an upstream WS refusal lands on bili's UPSTREAM leg — where
    // bili now falls back to the supplier's plain HTTP/SSE leg instead of failing
    // the turn. This mock refuses the upgrade (503) yet still serves POST/SSE on
    // the same port, so the ping completes transparently over HTTP and pi sees a
    // normal success. pi does no same-turn SSE fallback of its own (#2111: a
    // mid-stream WS failure just throws), so success here can only mean bili's
    // internal HTTP fallback carried the turn end-to-end.
    const r = await piRun(ctx, "ping fallback");
    assert.equal(r.code, 0, `WS refusal falls back to HTTP egress (exit ${r.code})\n${r.stderr.slice(-2000)}`);
    assert.ok(r.stdout.includes("WS_E2E_OK"), "the turn's response returned through the HTTP fallback");
    assert.ok(mock.stats.wsConnections >= 1, "bili attempted the upstream WS connection before falling back");
    assert.ok(mock.rows.some((x) => x.transport === "http"), "bili served the turn over the upstream's HTTP/SSE leg");
    assert.match(biliLog(ctx), /codex-responses-ws/, "client leg reached bili's WS bridge lane");

    // Explicit sse stays usable against the same WS-refusing upstream.
    ctxSse = await startCtx("sse", mock.port);
    const sse = await piRun(ctxSse, "ping sse after ws failure");
    assert.equal(sse.code, 0, `sse leg exit ${sse.code}\n${sse.stderr.slice(-2000)}`);
    assert.ok(sse.stdout.includes("WS_E2E_OK"), "sse leg answered");
    const httpRows = mock.rows.filter((x) => x.transport === "http");
    assert.ok(httpRows.length >= 1, "sse leg reached the upstream through bili");
    assert.ok(httpRows.every((x) => x.headers["x-bili-plugin"] === "pi" && typeof x.headers["session-id"] === "string" && x.headers["session-id"].length > 0), "sse leg keeps plugin stamp + session-id");
});

test("D: explicit sse — regression guard, full fold cycle over HTTP", { skip: skipReason, timeout: 900_000 }, async (t) => {
    let ctx: Ctx | undefined;
    const mock = await startMock({ getRowsPath: () => (ctx ? path.join(ctx.work, "rows.json") : undefined) });
    t.after(async () => {
        if (ctx) stopProxiesGracefully(ctx);
        await new Promise((r) => setTimeout(r, 500));
        if (ctx) teardownProxies(ctx);
        mock.server.closeAllConnections();
        await new Promise<void>((r) => mock.server.close(() => r()));
    });
    ctx = await startCtx("sse", mock.port);

    const SENTINEL = "SENTINEL_D_PI_WS";
    const SUMMARY = "FOLDED_SUMMARY_D_PI_WS: folded 150 lines of filler bulk planted by scenario D; no decisions or state retained beyond this marker.";
    const ok = (label: string, r: { code: number; stdout: string; stderr: string }): void => {
        assert.equal(r.code, 0, `${label}: exit ${r.code}\n${r.stderr.slice(-2000)}`);
        assert.ok(r.stdout.includes("WS_E2E_OK"));
    };

    ok("warmup", await piRun(ctx, "ping sse one"));
    ok("bulk", await piRun(ctx, `${filler(150,"D")} ${SENTINEL}`, { resume: true }));
    ok("pushback 1", await piRun(ctx, "pushback one", { resume: true }));
    ok("pushback 2", await piRun(ctx, "pushback two", { resume: true }));

    const preFoldRows = mock.rows.filter((r) => r.transport === "http");
    assert.ok(preFoldRows.length >= 4, `explicit sse stayed on HTTP (${preFoldRows.length} rows)`);
    assert.equal(mock.stats.wsConnections, 0, "explicit sse never opens a WS connection");
    assert.equal(convsOf(preFoldRows).size, 1);
    assert.ok(preFoldRows.every((r) => r.headers["x-bili-plugin"] === "pi" && typeof r.headers["session-id"] === "string" && r.headers["session-id"].length > 0));

    const lastPreFold = preFoldRows.at(-1)!;
    const userRefs = lastPreFold.full.filter((i) => i.role === "user").flatMap((i) => refsOf(itemText(i)));
    const sentinelItem = lastPreFold.full.find((i) => i.role === "user" && itemText(i).includes(SENTINEL));
    const sentinelRef = sentinelItem ? refsOf(itemText(sentinelItem))[0] : undefined;
    assert.ok(sentinelRef && userRefs.length >= 2, `user-message ACP refs present (${userRefs.length})`);
    const minRef = userRefs.reduce((a, b) => (Number(a.slice(1)) < Number(b.slice(1)) ? a : b));

    ok("fold", await piRun(ctx, `WS_FOLD_REQUEST_B64 ${b64({ content: [{ startId: minRef, endId: sentinelRef, summary: SUMMARY }] })}`, { resume: true }));
    ok("recall", await piRun(ctx, "final recall", { resume: true }));

    // Re-capture AFTER fold/recall: preFoldRows is a pre-fold snapshot.
    const httpRows = mock.rows.filter((r) => r.transport === "http");
    const final = httpRows.at(-1)!;
    const foldedSeen = httpRows.some((r) => toolResult(r, "compress")?.includes("Compressed"));
    assert.ok(foldedSeen, "compress executed over the SSE leg");
    assert.ok(!JSON.stringify(final.full).includes(SENTINEL), "post-fold HTTP history lost the bulk");
    assert.ok(JSON.stringify(final.full).includes(SUMMARY), "post-fold HTTP history carries the summary");
    assert.match(biliLog(ctx), /tool compress executed via plugin/);
});

test("E: two subagent-style sessions share one proxy — distinct state, identical tool args, no cross-talk", { skip: skipReason, timeout: 900_000 }, async (t) => {
    let ctxX: Ctx | undefined;
    let ctxY: Ctx | undefined;
    const mock = await startMock({ getRowsPath: () => (ctxX ?? ctxY ? path.join((ctxX ?? ctxY)!.work, "rows.json") : undefined) });
    t.after(async () => {
        if (ctxX) stopProxiesGracefully(ctxX);
        if (ctxY) stopProxiesGracefully(ctxY);
        await new Promise((r) => setTimeout(r, 500));
        if (ctxX) teardownProxies(ctxX);
        if (ctxY) teardownProxies(ctxY);
        mock.server.closeAllConnections();
        await new Promise<void>((r) => mock.server.close(() => r()));
    });
    ctxX = await startCtx("websocket", mock.port);
    ctxY = await startCtx("websocket", mock.port);

    const ok = (label: string, r: { code: number; stdout: string; stderr: string }): void => {
        assert.equal(r.code, 0, `${label}: exit ${r.code}\n${r.stderr.slice(-2000)}`);
        assert.ok(r.stdout.includes("WS_E2E_OK"));
    };

    ok("X warmup", await piRun(ctxX, "alpha marker ALPHA_X_SEED"));
    const origin = proxyOriginOf(ctxX);
    assert.ok(origin, "X's proxy origin discovered from its instance record");
    // Y attaches to X's proxy (real subagent posture: inherited
    // BILLION_CONTEXT_PROXY), so ONE proxy serves BOTH conversations.
    const yEnv = { BILLION_CONTEXT_PROXY: origin };

    ok("Y warmup", await piRun(ctxY, "beta marker BETA_Y_SEED", { extraEnv: yEnv }));

    // Same tool args ({}) from both sessions, interleaved.
    const [xStatus, yStatus] = await Promise.all([
        piRun(ctxX, "WS_STATUS alpha status", { resume: true }),
        piRun(ctxY, "WS_STATUS beta status", { resume: true, extraEnv: yEnv }),
    ]);
    ok("X status", xStatus);
    ok("Y status", yStatus);

    const rows = mock.rows;
    const convs = convsOf(rows.filter((r) => r.transport === "ws"));
    assert.equal(convs.size, 2, `two distinct conversations on one proxy (got ${convs.size})`);
    const xSeedRow = rows.find((r) => r.transport === "ws" && r.full.some((i) => itemText(i).includes("ALPHA_X_SEED")));
    const xConv = xSeedRow?.headers["x-bili-plugin-conversation"];
    const yConv = [...convs].find((c) => c !== xConv);
    assert.ok(typeof xConv === "string" && typeof yConv === "string", "both conversations identified");

    const xStatusRow = rows.find((r) => r.headers["x-bili-plugin-conversation"] === xConv && toolResult(r, "acp_status"));
    const yStatusRow = rows.find((r) => r.headers["x-bili-plugin-conversation"] === yConv && toolResult(r, "acp_status"));
    assert.ok(xStatusRow && yStatusRow, "both sessions got an acp_status result");
    const xReport = toolResult(xStatusRow!, "acp_status")!;
    const yReport = toolResult(yStatusRow!, "acp_status")!;
    // acp_status reports structural state, not message content — per-session
    // ownership is proven by what each status REQUEST carried: identical {}
    // args from two sessions, distinct histories, no cross-content either way.
    assert.ok(xReport.length > 50 && yReport.length > 50, "both sessions got a real acp_status report");
    assert.ok(JSON.stringify(xStatusRow!.full).includes("ALPHA_X_SEED"), "X's status request carried X's history");
    assert.ok(!JSON.stringify(xStatusRow!.full).includes("BETA_Y_SEED"), "X's status request did not carry Y's content");
    assert.ok(JSON.stringify(yStatusRow!.full).includes("BETA_Y_SEED"), "Y's status request carried Y's history");
    assert.ok(!JSON.stringify(yStatusRow!.full).includes("ALPHA_X_SEED"), "Y's status request did not carry X's content");

    // Concurrent plain turns, same proxy, no cross-talk afterwards.
    const [xFin, yFin] = await Promise.all([
        piRun(ctxX, "concurrent X tail", { resume: true }),
        piRun(ctxY, "concurrent Y tail", { resume: true, extraEnv: yEnv }),
    ]);
    ok("X concurrent", xFin);
    ok("Y concurrent", yFin);
    const xTail = rows.filter((r) => r.headers["x-bili-plugin-conversation"] === xConv).at(-1)!;
    const yTail = rows.filter((r) => r.headers["x-bili-plugin-conversation"] === yConv).at(-1)!;
    assert.ok(JSON.stringify(xTail.full).includes("ALPHA_X_SEED"), "X tail carries X's own history");
    assert.ok(JSON.stringify(yTail.full).includes("BETA_Y_SEED"), "Y tail carries Y's own history");
    assert.ok(!JSON.stringify(xTail.full).includes("BETA_Y_SEED"), "concurrent turns did not mix X/Y histories");
    assert.ok(!JSON.stringify(yTail.full).includes("ALPHA_X_SEED"), "concurrent turns did not mix X/Y histories");
});
