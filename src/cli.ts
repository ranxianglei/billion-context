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
import { startAutoUpdate, installUpdate } from "./update.js";
import { resolveProxy } from "./upstream-proxy.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
    claimCodexTakeover,
    disableCodexTakeover,
    enableCodexTakeover,
    getCodexTakeoverStatus,
    recoverStaleCodexTakeover,
} from "./codex-takeover.js";

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
  bili [start] [options]        start the proxy (default: reads ${defaultConfigFile()})
  bili codex enable [--port N]  route Codex Desktop through the local proxy
  bili codex disable            restore the active Codex provider endpoint
  bili codex status             show Codex Desktop local-route status
  bili update                   check for & install a newer version now
  bili --version                print version
  bili --help                   show this help

Options (override config file / env):
  --port <N>                    listen port (default 8787)
  --host <ADDR>                 listen host (default 127.0.0.1)
  --config <FILE>               path to config JSON (default: XDG location)
  --debug                       verbose logging
  --passthrough                 forward without compression
  --no-passthrough              force compression on (overrides config)
  --no-auto-update              disable background self-update this run

Config: ${defaultConfigFile()}
  Set port/host/debug/providers/compress/autoUpdate there. See README §Configuration.
  Env vars (ACP_*, BILI_*) also work and override the file; CLI flags win.

Docs: https://github.com/ranxianglei/billion-context
`;

type Parsed = {
    command: "start" | "update" | "codex" | "help" | "version";
    codexAction?: "enable" | "disable" | "status";
    overrides: Record<string, string | undefined>;
};

function parseArgs(argv: string[]): Parsed {
    const overrides: Record<string, string | undefined> = {};
    let command: Parsed["command"] = "start";
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
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
                // Override the current run to manual only — never persist.
                overrides.BILI_UPDATE_MODE = "manual";
                break;
            case "--passthrough":
                overrides.ACP_PASSTHROUGH = "1";
                break;
            case "--no-passthrough":
                overrides.ACP_PASSTHROUGH = "0";
                break;
            case "--port":
            case "--host":
            case "--config": {
                const val = argv[++i];
                if (val === undefined) {
                    console.error(`bili: ${a} requires a value`);
                    process.exit(2);
                }
                if (a === "--port") overrides.ACP_PORT = val;
                else if (a === "--host") overrides.ACP_HOST = val;
                else overrides.BILI_CONFIG_FILE = val;
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

    // First positional (if any) is the command. "start" | "update" | "codex" are recognized;
    // an unknown command is an error.
    if (positional.length > 0) {
        const cmd = positional[0]!;
        if (cmd === "start") {
            command = command === "help" || command === "version" ? command : "start";
        } else if (cmd === "update") {
            command = "update";
        } else if (cmd === "codex") {
            command = "codex";
        } else {
            console.error(`bili: unknown command "${cmd}" (try "bili --help")`);
            process.exit(2);
        }
    }

    let codexAction: Parsed["codexAction"];
    if (positional[0] === "codex") {
        command = "codex";
        const action = positional[1];
        if (action !== "enable" && action !== "disable" && action !== "status") {
            console.error('bili: "codex" requires enable, disable, or status');
            process.exit(2);
        }
        if (positional.length > 2) {
            console.error(`bili: unexpected argument "${positional[2]}"`);
            process.exit(2);
        }
        codexAction = action;
    }

    return { command, codexAction, overrides };
}

export async function main(): Promise<void> {
    const { command, codexAction, overrides } = parseArgs(process.argv.slice(2));
    if (command === "help") {
        process.stdout.write(HELP);
        return;
    }
    if (command === "version") {
        process.stdout.write(VERSION + "\n");
        return;
    }
    if (command === "update") {
        // Manual one-shot update — check + install now, bypasses the throttle.
        const opts = loadOptions();
        const proxyUrl = resolveProxy(opts.routes, opts.proxy, "https://registry.npmjs.org", opts.proxyFallback);
        const result = await installUpdate({
            packageName: PACKAGE_NAME,
            currentVersion: VERSION,
            mode: opts.updateMode,
            ...(proxyUrl ? { proxyUrl } : {}),
        });
        if (result.ok) {
            process.stdout.write(result.installedTo === VERSION
                ? `billion-context is up to date (v${VERSION})\n`
                : `✔ billion-context updated ${VERSION} → ${result.installedTo}. Restart bili to finish.\n`);
        } else {
            process.stderr.write(`✖ update failed: ${result.error}\n`);
            process.exitCode = 1;
        }
        return;
    }

    for (const [k, v] of Object.entries(overrides)) {
        if (v !== undefined) process.env[k] = v;
    }
    if (command === "codex") {
        if (codexAction === "enable") recoverStaleCodexTakeover();
        const status = codexAction === "enable"
            ? enableCodexTakeover(loadOptions().port)
            : codexAction === "disable"
              ? disableCodexTakeover()
              : getCodexTakeoverStatus();
        if (status.state === "enabled") {
            process.stdout.write(`Codex route enabled for ${status.providerId}: ${status.baseUrl} → ${status.originalBaseUrl}\n`);
        } else if (status.state === "disabled") {
            const provider = status.provider ? ` (provider ${status.provider.id})` : "";
            process.stdout.write(`Codex route disabled${provider}: ${status.configPath}${status.detail ? `\n${status.detail}` : ""}\n`);
        } else {
            process.stdout.write(`Codex Desktop local route conflict: ${status.detail ?? status.configPath}\n`);
            process.exitCode = 1;
        }
        return;
    }

    // CLI flags override env (which overrides the config file inside
    // loadOptions). Merge into process.env so loadOptions picks them up.
    // First run: seed a template config so the user has a file to edit rather
    // than a bare error. No-op if it already exists.
    recoverStaleCodexTakeover();
    ensureConfigTemplate();
    const opts = loadOptions();
    claimCodexTakeover(process.pid);
    await startServer(opts);

    // Start the background update scheduler after the server is listening so a
    // slow registry check never delays startup or races the listen socket.
    // startAutoUpdate branches internally: auto/check schedule periodic checks
    // (auto also installs), manual schedules nothing.
    const proxyUrl = resolveProxy(opts.routes, opts.proxy, "https://registry.npmjs.org", opts.proxyFallback);
    startAutoUpdate({
        packageName: PACKAGE_NAME,
        currentVersion: VERSION,
        mode: opts.updateMode,
        ...(proxyUrl ? { proxyUrl } : {}),
    });
}
