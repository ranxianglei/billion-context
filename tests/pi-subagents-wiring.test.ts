import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { piSubagentsAdapter, wirePiSubagents } from "../src/agent/pi-subagents.ts";
import type { ExtensionAPI, CommandCtx } from "../src/agent/pi.ts";
import { loadConfigFile } from "../src/config.ts";
import { DEFAULT_DELEGATE_POLICY, resolveDelegate } from "billion-context-pi-subagents";

// #2186: hermetic wiring tests for the inlined acp_delegate surface. The
// delegate tools are never EXECUTED here (they spawn real pi children); only
// the registration lifecycle is driven: agent gate, embedded-marker
// check-before-claim, session_start registration, prompt append, read-tracking
// dispatch. HOME is redirected before any import so loadSubagentsUserConfig /
// findPiSubagentsInstalls see an empty world, not the developer's real ~/.pi;
// BILI_CONFIG_FILE likewise isolates the #2230 pi.subagents config-home read
// from the developer's real billion-context.json.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bili-pi-subagents-home-"));
process.env.HOME = HOME;
const BILI_CONFIG_FILE = path.join(HOME, "billion-context.json");
process.env.BILI_CONFIG_FILE = BILI_CONFIG_FILE;

type Handler = (event: unknown, ctx: unknown) => unknown;

type CommandOptions = { description?: string; handler: (args: string, ctx: CommandCtx) => void | Promise<void> };

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler>; tools: string[]; commands: string[]; shortcuts: string[]; commandOpts: Map<string, CommandOptions> } {
    const handlers = new Map<string, Handler>();
    const tools: string[] = [];
    const commands: string[] = [];
    const shortcuts: string[] = [];
    const commandOpts = new Map<string, CommandOptions>();
    const pi = {
        on: (event: string, handler: Handler) => {
            handlers.set(event, handler);
        },
        registerTool: (tool: { name: string }) => {
            tools.push(tool.name);
        },
        registerCommand: (name: string, options?: CommandOptions) => {
            commands.push(name);
            if (options !== undefined) commandOpts.set(name, options);
        },
        registerShortcut: (key: string) => {
            shortcuts.push(key);
        },
    } as unknown as ExtensionAPI;
    return { pi, handlers, tools, commands, shortcuts, commandOpts };
}

function sessionCtx(): { sessionManager: { buildContextEntries: () => unknown; getSessionId: () => string }; cwd: string; ui: { notifications: Array<[string, string?]>; notify: (message: string, type?: string) => void } } {
    const cwd = fs.mkdtempSync(path.join(HOME, "project-"));
    const notifications: Array<[string, string?]> = [];
    return {
        sessionManager: { buildContextEntries: () => [], getSessionId: () => "sid-1" },
        cwd,
        ui: { notifications, notify: (message, type) => { notifications.push([message, type]); } },
    };
}

function embeddedClaimed(): boolean {
    return (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] === true;
}

test("omp never gets the delegate surface and does not claim it", () => {
    assert.equal(embeddedClaimed(), false);
    const { pi, handlers } = fakePi();
    wirePiSubagents(pi, "omp");
    assert.equal(handlers.size, 0);
    assert.equal(embeddedClaimed(), false);
});

test("pi wiring claims the marker and registers the full surface at session_start", async () => {
    assert.equal(embeddedClaimed(), false);
    const { pi, handlers, tools, commands, shortcuts } = fakePi();
    wirePiSubagents(pi, "pi");
    assert.equal(embeddedClaimed(), true);
    // All lifecycle hooks are in place before any session exists.
    for (const event of ["tool_result", "session_start", "session_shutdown", "before_agent_start"]) {
        assert.ok(handlers.has(event), `missing ${event} handler`);
    }
    const ctx = sessionCtx();
    await handlers.get("session_start")!(undefined, ctx);
    assert.deepEqual(tools.sort(), ["acp_delegate", "acp_delegate_cancel", "acp_delegate_wait"]);
    assert.deepEqual(commands, ["acp-fleet"]);
    assert.equal(shortcuts.length, 1);
});

test("a second embedder stands down: marker already claimed", () => {
    const { pi, handlers } = fakePi();
    wirePiSubagents(pi, "pi");
    assert.equal(handlers.size, 0);
});

test("host without buildContextEntries registers the command but not the tools", async () => {
    const { pi, handlers, tools, commands } = fakePi();
    // Pretend the claim is open to reach the session wiring again.
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    const ctx = { sessionManager: { getSessionId: () => "sid-2" }, cwd: HOME };
    await handlers.get("session_start")!(undefined, ctx);
    assert.deepEqual(tools, []);
    assert.deepEqual(commands, ["acp-fleet"]);
});

test("before_agent_start appends the delegate prompt once, after the host prompt", async () => {
    const { pi, handlers } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    const ctx = sessionCtx();
    await handlers.get("session_start")!(undefined, ctx);
    const result = handlers.get("before_agent_start")!({ systemPrompt: "HOST PROMPT" }, ctx) as { systemPrompt: string };
    assert.ok(result.systemPrompt.startsWith("HOST PROMPT\n\n"));
    assert.ok(result.systemPrompt.length > "HOST PROMPT\n\n".length + 100);
    // Array-shaped prompts (omp-style) normalize to a single string.
    const array = handlers.get("before_agent_start")!({ systemPrompt: ["A", "B"] }, ctx) as { systemPrompt: string };
    assert.ok(array.systemPrompt.startsWith("A\nB\n\n"));
});

test("before_agent_start composes via appendSystemPrompt on newer pi (getter event, #2531)", async () => {
    const { pi, handlers } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    const ctx = sessionCtx();
    await handlers.get("session_start")!(undefined, ctx);
    const handler = handlers.get("before_agent_start")!;

    // pi >= 0.87 hands over a live `get systemPrompt()` getter plus a shared
    // systemPromptOptions; returning { systemPrompt } there forces the prompt
    // and silently drops other extensions' appendSystemPrompt (#2531). We must
    // compose through appendSystemPrompt and return nothing instead.
    const options: { appendSystemPrompt?: string } = { appendSystemPrompt: "HARNESS APPEND" };
    const newerEvent = {
        get systemPrompt() { return "RENDERED BASE"; },
        systemPromptOptions: options,
    };
    const result = handler(newerEvent, ctx) as { systemPrompt?: string } | undefined;
    assert.equal(result, undefined, "newer pi: no forced replacement returned");
    assert.ok(options.appendSystemPrompt?.startsWith("HARNESS APPEND\n\n"), "prior extension's append preserved first");
    assert.ok(options.appendSystemPrompt?.includes("ACP_DELEGATE NOTIFICATIONS"), "delegate appendix composed after it");

    handler(newerEvent, ctx);
    assert.equal((options.appendSystemPrompt!.match(/ACP_DELEGATE NOTIFICATIONS/g) ?? []).length, 1, "appended exactly once (idempotent)");
});

test("tool_result dispatches read tracking for read and bash results", async () => {
    const { pi, handlers } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    // Must not throw for the tracked shapes nor for unrelated tools.
    handlers.get("tool_result")!({ isError: false, toolName: "read", input: { path: "/tmp/result.md" } }, sessionCtx());
    handlers.get("tool_result")!({ isError: false, toolName: "bash", input: { command: "cat /tmp/result.md" } }, sessionCtx());
    handlers.get("tool_result")!({ isError: true, toolName: "read", input: { path: "/tmp/x" } }, sessionCtx());
    handlers.get("tool_result")!({ toolName: "edit", input: { path: "/tmp/y" } }, sessionCtx());
    assert.ok(true);
});

test("session_shutdown disposes the status widget without a live session", () => {
    const { pi, handlers } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    handlers.get("session_shutdown")!(undefined, undefined);
    assert.ok(true);
});

test("acp-fleet command handler notifies instead of opening the inspector when delegate is disabled", async () => {
    const { pi, handlers, tools, commands, commandOpts } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    const ctx = sessionCtx();
    fs.mkdirSync(path.join(ctx.cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(ctx.cwd, ".pi", "acp.json"), JSON.stringify({ delegate: { enabled: false } }));
    // This is the deprecated fallback path now (#2230): acp.json keys still
    // work but must say so loudly. Spy (and silence) the warning — the
    // one-shot flag is module-global, and this is the first fallback test.
    const errors: string[] = [];
    const savedError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")) };
    try {
        await handlers.get("session_start")!(undefined, ctx);
    } finally {
        console.error = savedError;
    }
    assert.ok(errors.some((e) => /deprecated/.test(e) && /pi/.test(e)), `deprecation warning logged, got: ${errors.join(" | ")}`);
    assert.deepEqual(tools, []);
    assert.deepEqual(commands, ["acp-fleet"]);
    const opts = commandOpts.get("acp-fleet");
    assert.ok(opts, "acp-fleet registered with options");
    await opts.handler("", { ui: ctx.ui });
    assert.equal(ctx.ui.notifications.length, 1);
    assert.match(ctx.ui.notifications[0][0], /not enabled/);
});

test("project-scope pi-subagents install stands acp_delegate down (#415)", async () => {
    const { pi, handlers, tools, commands, shortcuts } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    const ctx = sessionCtx();
    fs.mkdirSync(path.join(ctx.cwd, ".pi", "npm", "node_modules", "pi-subagents"), { recursive: true });
    fs.writeFileSync(
        path.join(ctx.cwd, ".pi", "npm", "node_modules", "pi-subagents", "package.json"),
        JSON.stringify({ name: "pi-subagents", version: "1.0.0" }),
    );
    await handlers.get("session_start")!(undefined, ctx);
    assert.deepEqual(tools, []);
    assert.deepEqual(commands, ["acp-fleet"]);
    assert.equal(shortcuts.length, 0);
    assert.equal(ctx.ui.notifications.length, 1);
    assert.match(ctx.ui.notifications[0][0], /pi-subagents detected/);
    assert.equal(ctx.ui.notifications[0][1], "warning");
});

// --- #2230 config-home: pi.subagents in billion-context.json ---

function writeBiliConfig(value: unknown): void {
    fs.writeFileSync(BILI_CONFIG_FILE, JSON.stringify(value));
}

function clearBiliConfig(): void {
    fs.rmSync(BILI_CONFIG_FILE, { force: true });
}

test("pi.subagents enabled:false drops the tools, prompt section and shortcut", async () => {
    clearBiliConfig();
    writeBiliConfig({ pi: { subagents: { enabled: false } } });
    const { pi, handlers, tools, shortcuts } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    const ctx = sessionCtx();
    await handlers.get("session_start")!(undefined, ctx);
    assert.deepEqual(tools, []);
    assert.equal(shortcuts.length, 0);
    const prompt = await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctx) as { systemPrompt: string } | undefined;
    assert.equal(prompt, undefined, "no prompt event result while disabled");
});

test("pi.subagents boolean shorthand false is equivalent", async () => {
    writeBiliConfig({ pi: { subagents: false } });
    const { pi, handlers, tools } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    await handlers.get("session_start")!(undefined, sessionCtx());
    assert.deepEqual(tools, []);
});

test("pi.subagents section owns the config: acp.json keys are ignored when both exist", async () => {
    writeBiliConfig({ pi: { subagents: { enabled: true } } });
    const { pi, handlers, tools } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    const ctx = sessionCtx();
    fs.mkdirSync(path.join(ctx.cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(ctx.cwd, ".pi", "acp.json"), JSON.stringify({ delegate: { enabled: false } }));
    await handlers.get("session_start")!(undefined, ctx);
    assert.equal(tools.length, 3, "bili section wins over the disabled acp.json keys");
});

test("pi.subagents prompt rename replaces the delegate appendix", async () => {
    writeBiliConfig({ pi: { subagents: { prompt: "CUSTOM-PROMPT-MARKER" } } });
    const { pi, handlers } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    await handlers.get("session_start")!(undefined, sessionCtx());
    const prompt = await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, sessionCtx()) as { systemPrompt: string };
    assert.ok(prompt.systemPrompt.includes("CUSTOM-PROMPT-MARKER"), "custom prompt present");
    assert.ok(!prompt.systemPrompt.includes("ACP_DELEGATE"), "built-in appendix replaced");
});

test("pi.subagents section values flow through session_start without breaking registration", async () => {
    writeBiliConfig({ pi: { subagents: { debug: true, maxConcurrent: 2 } } });
    const { pi, handlers, tools } = fakePi();
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = false;
    wirePiSubagents(pi, "pi");
    (globalThis as Record<symbol, unknown>)[Symbol.for("acp-delegate.embedded")] = true;
    await handlers.get("session_start")!(undefined, sessionCtx());
    assert.equal(tools.length, 3);
});

// The mapper is the single translation point onto the package adapter shape
// (cross-repo file-format contract); debug/maxConcurrent have no hermetically
// observable wiring-level effect, so the mapping is pinned here directly.
test("piSubagentsAdapter maps the pi.subagents section onto the package adapter shape", () => {
    assert.deepEqual(piSubagentsAdapter(false), { delegate: { enabled: false } });
    assert.deepEqual(piSubagentsAdapter(true), {});
    assert.deepEqual(piSubagentsAdapter({}), {});
    assert.deepEqual(piSubagentsAdapter({ enabled: false }), { delegate: { enabled: false } });
    assert.deepEqual(
        piSubagentsAdapter({ debug: true, maxConcurrent: 2, displayUsage: "merged", prompt: "P", thinkingLevel: "low" }),
        { delegate: { maxConcurrent: 2, displayUsage: "merged", thinkingLevel: "low" }, delegatePrompt: "P", debug: true },
    );
});

// #2260(F): pins the documented precedence PI_ACP_DELEGATE_* > pi.subagents >
// acp.json > default (CONFIGURATION.md). The env readers live INSIDE the
// bundled package's resolveDelegate, so this drives that real function through
// bili's loader chain — a future package or adapter change that silently drops
// env must fail here.
test("PI_ACP_DELEGATE_* env beats pi.subagents file values, which beat defaults (#2260)", () => {
    const envKeys = [
        "PI_ACP_DELEGATE_FORCE_ENABLE",
        "PI_ACP_DELEGATE_MAX_DEPTH",
        "PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES",
        "PI_ACP_DELEGATE_IDLE_TIMEOUT_MINUTES",
        "PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES",
        "PI_ACP_DELEGATE_MAX_CONCURRENT",
    ];
    const saved: Record<string, string | undefined> = {};
    const setEnv = (vals: Record<string, string | undefined>) => {
        for (const k of envKeys) {
            saved[k] = process.env[k];
            if (vals[k] === undefined) delete process.env[k];
            else process.env[k] = vals[k];
        }
    };
    try {
        writeBiliConfig({ pi: { subagents: { maxDepth: 5, syncTimeoutMinutes: 7, forceEnable: false } } });
        const adapter = piSubagentsAdapter(loadConfigFile().pi?.subagents ?? true);

        setEnv({ PI_ACP_DELEGATE_MAX_DEPTH: "3", PI_ACP_DELEGATE_SYNC_TIMEOUT_MINUTES: "2", PI_ACP_DELEGATE_FORCE_ENABLE: "true" });
        const fromEnv = resolveDelegate(adapter);
        assert.equal(fromEnv.maxDepth, 3, "env maxDepth beats file 5");
        assert.equal(fromEnv.syncTimeoutMs, 2 * 60_000, "env sync timeout beats file 7");
        assert.equal(fromEnv.forceEnable, true, "env forceEnable=true beats file false");

        setEnv({});
        const fromFile = resolveDelegate(adapter);
        assert.equal(fromFile.maxDepth, 5, "file maxDepth wins without env");
        assert.equal(fromFile.syncTimeoutMs, 7 * 60_000, "file sync timeout wins without env");
        assert.equal(fromFile.forceEnable, false, "file forceEnable=false holds without env");

        clearBiliConfig();
        const fromDefaults = resolveDelegate(piSubagentsAdapter(true));
        assert.equal(fromDefaults.maxDepth, DEFAULT_DELEGATE_POLICY.maxDepth, "package default when neither env nor file");
        assert.equal(fromDefaults.forceEnable, false);
    } finally {
        for (const k of envKeys) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        clearBiliConfig();
    }
});
