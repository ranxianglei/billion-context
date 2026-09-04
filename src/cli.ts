#!/usr/bin/env node
/**
 * `bili` — billion-context proxy CLI.
 *
 * Usage:
 *   bili                          start the proxy (default command)
 *   bili start                    start the proxy (explicit)
 *   bili start --port 9000        override listen port
 *   bili start --host 0.0.0.0     override listen host
 *   bili start --debug            verbose logging
 *   bili start --config FILE      path to config file (default: XDG)
 *   bili start --passthrough      forward without compression
 *   bili pi/codex/claude/omp [args]   start a proxy + launch a client via cert-MITM
 *   bili export [id] [--full]     export a persisted session as a handoff doc
 *   bili test pi                  non-polluting pi smoke test
 *   bili --version
 *   bili --help
 *
 * Flags override values from the config file / env. See README §Configuration
 * for the full config-file schema (which also supports `debug`, `port`, etc.
 * — flags are just convenient overrides).
 */
import { loadOptions, ensureConfigTemplate } from "./config.js";
import { startServer } from "./server.js";
import { configFile as defaultConfigFile } from "./paths.js";
import { checkForUpdate, startAutoUpdate } from "./update.js";
import { runMcpStdio } from "./mcp.js";
import { PLUGIN_AGENTS, isPluginAgent, pluginInstall, pluginRemove, pluginStatusAll, type PluginAgent } from "./plugin-install.js";
import { runLaunch, runTestPi, isLaunchClient, type ClientName } from "./launcher.js";
import { exportSession } from "./export.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const VERSION = (() => {
    try {
        // Works in both dev (tsx: src/cli.ts → ../package.json) and bundled
        // (tsup: dist/index.js → ../package.json).
        const here = fileURLToPath(import.meta.url);
        const pkg = path.join(path.dirname(here), "..", "package.json");
        return (JSON.parse(readFileSync(pkg, "utf8")).version as string) ?? "dev";
    } catch {
        return "dev";
    }
})();

const PACKAGE_NAME = (() => {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkg = path.join(path.dirname(here), "..", "package.json");
        return (JSON.parse(readFileSync(pkg, "utf8")).name as string) ?? "billion-context";
    } catch {
        return "billion-context";
    }
})();

const HELP = `bili ${VERSION} — billion-context proxy

Usage:
  bili [start] [options]           start the proxy (default: reads ${defaultConfigFile()})
  bili pi [opts --] [args]         start a proxy + launch pi against it (cert-MITM)
  bili pi-test [opts --] [args]    like bili pi but injects --no-extensions (clean test)
  bili codex [opts --] [args]      start a proxy + launch codex against it (cert-MITM)
  bili claude [opts --] [args]     start a proxy + launch claude against it (cert-MITM)
  bili omp [opts --] [args]        start a proxy + launch omp against it (cert-MITM)
  bili opencode [opts --] [args]   start a proxy + launch opencode against it (cert-MITM)
  bili hermes [opts --] [args]     start a proxy + launch hermes-agent against it (/bili/ rewrite)
  bili dsh [opts --] [args]        start a proxy + launch deepseek-harness against it (/bili/ rewrite)
  bili test pi                     non-polluting pi smoke test through the proxy
  bili export [session] [--full]   list sessions / export one as a Markdown handoff
                                    (--full includes original messages; --output FILE)
  bili update                      check for & install a newer version now
  bili plugin install <agent>      install the thin plugin into a host (pi/omp/
                                    claude/codex/opencode; original backed up once)
  bili plugin remove <agent>       remove it again
  bili plugin list                 show install status for every host
  bili mcp                         run the bili MCP server standalone (stdio)
  bili plugin-register <id>        pre-bind a conversation to the plugin mode
                                    (--origin URL, --agent name)
  bili --version                   print version
  bili --help                      show this help

Launcher (bili pi / bili codex / bili claude / bili omp / bili opencode / bili hermes / bili dsh):
  Brings up a proxy on an independent port (a fresh instance every launch), then runs the client pointed at it via HTTPS_PROXY + the proxy's
  MITM CA — no config-file edits. Discovered HTTPS upstream domains are
  auto-whitelisted for MITM so the proxy TLS-terminates exactly the hosts the
  client uses; HTTP / localhost providers go direct. pi/claude trust the CA
  via NODE_EXTRA_CA_CERTS, codex via SSL_CERT_FILE. Proxy killed on client exit.
  bili flags (-F, --mitm-domain, --port, ...) must precede the client name;
  everything after the client name is passed through to the client.
    bili pi                               # launch pi through the proxy
    bili pi -- print "hi"                 # args after the client are passed through
    bili pi-test                          # pi through the proxy with extensions off (proxy owns compression)
    bili codex                            # launch codex through the proxy
    bili claude                           # launch claude through the proxy
    bili omp                              # launch omp through the proxy (pi-based; /bili/ rewrite)
    bili hermes                           # launch hermes-agent through the proxy (/bili/ rewrite of ~/.hermes/config.yaml)
    bili dsh --profile web "task"         # launch deepseek-harness through the proxy (/bili/ rewrite of ~/.dsh/settings.yaml)
    bili test pi                          # quick end-to-end check of the pi path
    bili --mitm-domain api.foo.com pi     # add a domain to the MITM whitelist (flags precede the client)
    bili -F http://127.0.0.1:7897 codex   # route bili's upstream through a proxy (gost-style -F)

Options (override config file / env):
  -F <url>                         upstream proxy to forward through (gost-style;
                                   http://host:port; must precede the client name)
  --port <N>                       listen port (start: 8787; launcher default: random free port)
  --host <ADDR>                    listen host (default 127.0.0.1)
  --mitm-domain <domain>           extra MITM domain (repeatable; launcher only)
  --config <FILE>                  path to config JSON (default: XDG location)
  --debug                          verbose logging
  --passthrough                    forward without compression
  --no-passthrough                 force compression on (overrides config)
  --no-auto-update                 disable background self-update this run

Config: ${defaultConfigFile()}
  Set port/host/debug/providers/compress/autoUpdate there. See README §Configuration.
  Env vars (ACP_*, BILI_*) also work and override the file; CLI flags win.

Docs: https://github.com/ranxianglei/billion-context
`;

type Parsed = {
    command: "start" | "update" | "help" | "version" | "launch" | "test" | "export" | "plugin-register" | "mcp" | "plugin";
    client?: ClientName;
    clientArgs: string[];
    mitmDomains: string[];
    overrides: Record<string, string | undefined>;
    exportSelector?: string;
    exportOutput?: string;
    exportFull?: boolean;
    registerConversationId?: string;
    pluginAction?: "install" | "remove" | "list";
    pluginAgent?: PluginAgent;
};

export function parseArgs(argv: string[]): Parsed {
    const overrides: Record<string, string | undefined> = {};
    let command: Parsed["command"] = "start";
    const positional: string[] = [];
    let client: ClientName | undefined;
    let clientArgs: string[] = [];
    const mitmDomains: string[] = [];
    let exportSelector: string | undefined;
    let registerConversationId: string | undefined;
    let exportOutput: string | undefined;
    let exportFull = false;
    let pluginAction: Parsed["pluginAction"];
    let pluginAgent: Parsed["pluginAgent"];

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (!client && positional.length === 0 && isLaunchClient(a)) {
            client = a;
            const rest = argv.slice(i + 1);
            // Consume a leading "--" separator (documented form: `bili <client> [opts --] [args]`)
            // so it is never forwarded to the client (clap-style parsers treat everything
            // after "--" as positionals).
            clientArgs = rest[0] === "--" ? rest.slice(1) : rest;
            break;
        }
        switch (a) {
            case "--help":
            case "-h":
                command = "help";
                break;
            case "--version":
            case "-V":
                command = "version";
                break;
            case "--debug":
                overrides.ACP_DEBUG = "1";
                break;
            case "--no-auto-update":
                overrides.ACP_AUTO_UPDATE = "0";
                break;
            case "--passthrough":
                overrides.ACP_PASSTHROUGH = "1";
                break;
            case "--no-passthrough":
                overrides.ACP_PASSTHROUGH = "0";
                break;
            case "--mitm-domain": {
                const val = argv[++i];
                if (val === undefined) {
                    console.error(`bili: ${a} requires a value`);
                    process.exit(2);
                }
                mitmDomains.push(val);
                break;
            }
            case "--full":
                exportFull = true;
                break;
            case "--output": {
                const val = argv[++i];
                if (val === undefined) {
                    console.error(`bili: ${a} requires a value`);
                    process.exit(2);
                }
                exportOutput = val;
                break;
            }
            case "-F":
            case "--port":
            case "--host":
            case "--config":
            case "--origin":
            case "--agent":
            case "--bin": {
                const val = argv[++i];
                if (val === undefined || val.length === 0) {
                    console.error(`bili: ${a} requires a non-empty value`);
                    process.exit(2);
                }
                if (a === "--port") overrides.ACP_PORT = val;
                else if (a === "--host") overrides.ACP_HOST = val;
                else if (a === "--config") overrides.BILI_CONFIG_FILE = val;
                else if (a === "--origin") overrides.BILI_MCP_PROXY = val;
                else if (a === "--bin") process.env.BILI_CLIENT_BIN = val;
                else if (a === "-F") overrides.BILI_UPSTREAM_PROXY = val;
                else overrides.BILI_PLUGIN_AGENT = val;
                break;
            }
            default:
                if (a.startsWith("--")) {
                    // Allow --port=9000 form.
                    const eq = a.indexOf("=");
                    if (eq > 0) {
                        argv.splice(i, 1, a.slice(0, eq), a.slice(eq + 1));
                        i--;
                        break;
                    }
                    console.error(`bili: unknown option ${a}`);
                    process.exit(2);
                }
                positional.push(a);
        }
    }

    // First positional (if any) is the command. "start" | "update" | "test"
    // are recognized; an unknown command is an error.
    if (client) {
        command = "launch";
    } else if (positional.length > 0) {
        const cmd = positional[0]!;
        if (cmd === "start") {
            command = command === "help" || command === "version" ? command : "start";
        } else if (cmd === "update") {
            command = "update";
        } else if (cmd === "export") {
            command = "export";
            exportSelector = positional[1];
        } else if (cmd === "plugin-register") {
            command = "plugin-register";
            registerConversationId = positional[1];
        } else if (cmd === "mcp") {
            command = "mcp";
        } else if (cmd === "plugin") {
            command = "plugin";
            const action = positional[1];
            if (action === "install" || action === "remove" || action === "list") {
                pluginAction = action;
            } else {
                console.error(`bili plugin: unknown action "${action ?? ""}" (try "bili plugin install|remove|list <agent>")`);
                process.exit(2);
            }
            const agent = positional[2];
            if (agent !== undefined) {
                if (!isPluginAgent(agent)) {
                    console.error(`bili plugin: unknown agent "${agent}" (try one of: ${PLUGIN_AGENTS.join(", ")})`);
                    process.exit(2);
                }
                pluginAgent = agent;
            }
            if (pluginAction !== "list" && pluginAgent === undefined) {
                console.error(`bili plugin ${pluginAction}: agent is required (try one of: ${PLUGIN_AGENTS.join(", ")})`);
                process.exit(2);
            }
        } else if (cmd === "test") {
            const target = positional[1];
            if (target && isLaunchClient(target)) {
                command = "test";
                client = target;
            } else {
                console.error(`bili test: unknown client "${target ?? ""}" (try "bili test pi")`);
                process.exit(2);
            }
        } else {
            console.error(`bili: unknown command "${cmd}" (try "bili --help")`);
            process.exit(2);
        }
    }

    return { command, client, clientArgs, mitmDomains, overrides, exportSelector, exportOutput, exportFull, registerConversationId, pluginAction, pluginAgent };
}

export async function main(): Promise<void> {
    const { command, client, clientArgs, mitmDomains, overrides, exportSelector, exportOutput, exportFull, registerConversationId, pluginAction, pluginAgent } = parseArgs(process.argv.slice(2));
    if (command === "help") {
        process.stdout.write(HELP);
        return;
    }
    if (command === "version") {
        process.stdout.write(VERSION + "\n");
        return;
    }
    if (command === "plugin-register") {
        const conversationId = registerConversationId?.trim();
        if (!conversationId) {
            console.error('bili plugin-register: conversation id is required (e.g. bili plugin-register "$CLAUDE_SESSION_ID" --origin http://127.0.0.1:8787 --agent claude)');
            process.exit(2);
        }
        const agent = (overrides.BILI_PLUGIN_AGENT ?? process.env.BILI_PLUGIN_AGENT ?? "claude").trim() || "claude";
        const origin = (overrides.BILI_MCP_PROXY ?? process.env.BILI_MCP_PROXY ?? "http://127.0.0.1:8787").replace(/\/$/, "");
        try {
            const res = await fetch(`${origin}/__bili/plugin/register`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ conversationId, agent, identity: true }),
                signal: AbortSignal.timeout(5000),
            });
            const data = (await res.json()) as { ok?: boolean; error?: string };
            if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        } catch (error) {
            console.error(`bili plugin-register: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
        return;
    }
    if (command === "mcp") {
        runMcpStdio();
        return;
    }
    if (command === "plugin") {
        // Installers read resolveProxyOrigin() (env first) at dispatch time.
        // Apply --origin BEFORE handling the subcommand: the generic env
        // merge further down runs only on the server path, which this
        // branch returns ahead of — without this, a stale ~/.bili/
        // proxy-origin discovery file would silently win over the flag.
        if (overrides.BILI_MCP_PROXY !== undefined) process.env.BILI_MCP_PROXY = overrides.BILI_MCP_PROXY;
        if (pluginAction === "list") {
            for (const row of pluginStatusAll()) {
                console.log(`${row.agent.padEnd(10)} ${row.status}`);
            }
            return;
        }
        if (pluginAction === "install") {
            try {
                console.log(pluginInstall(pluginAgent!));
            } catch (error) {
                console.error(`bili plugin: ${error instanceof Error ? error.message : String(error)}`);
                process.exit(1);
            }
            return;
        }
        if (pluginAction === "remove") {
            try {
                console.log(pluginRemove(pluginAgent!));
            } catch (error) {
                console.error(`bili plugin: ${error instanceof Error ? error.message : String(error)}`);
                process.exit(1);
            }
            return;
        }
    }
    if (command === "export") {
        try {
            const text = await exportSession(exportSelector, { output: exportOutput, full: exportFull });
            process.stdout.write(text + "\n");
        } catch (error) {
            console.error(`bili export: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
        }
        return;
    }
    if (command === "update") {
        // Manual one-shot update — bypasses the throttle.
        await checkForUpdate({ packageName: PACKAGE_NAME, currentVersion: VERSION, autoUpdate: true }, true);
        return;
    }
    if (command === "test") {
        if (client === "pi") {
            await runTestPi({ overrides, mitmDomains });
            return;
        }
        console.error("bili test: only 'pi' supported for now");
        process.exit(2);
    }
    if (command === "launch") {
        await runLaunch({ client: client!, clientArgs, mitmDomains, overrides });
        return;
    }

    for (const [k, v] of Object.entries(overrides)) {
        if (v !== undefined) process.env[k] = v;
    }

    // CLI flags override env (which overrides the config file inside
    // loadOptions). Merge into process.env so loadOptions picks them up.
    // First run: seed a template config so the user has a file to edit rather
    // than a bare error. No-op if it already exists.
    ensureConfigTemplate();
    const opts = loadOptions();
    await startServer(opts);

    // Start background auto-update after the server is listening so a slow
    // registry check never delays startup or races the listen socket.
    if (opts.autoUpdate) {
        startAutoUpdate({ packageName: PACKAGE_NAME, currentVersion: VERSION, autoUpdate: true });
    }
}
