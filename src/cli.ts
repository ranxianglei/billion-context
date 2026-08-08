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
import { loadOptions } from "./config.js";
import { startServer } from "./server.js";
import { configFile as defaultConfigFile } from "./paths.js";
import { checkForUpdate, startAutoUpdate } from "./update.js";
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
  bili [start] [options]        start the proxy (default: reads ${defaultConfigFile()})
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
    command: "start" | "update" | "help" | "version";
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
                overrides.ACP_AUTO_UPDATE = "0";
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

    // First positional (if any) is the command. "start" | "update" are recognized;
    // an unknown command is an error.
    if (positional.length > 0) {
        const cmd = positional[0]!;
        if (cmd === "start") {
            command = command === "help" || command === "version" ? command : "start";
        } else if (cmd === "update") {
            command = "update";
        } else {
            console.error(`bili: unknown command "${cmd}" (try "bili --help")`);
            process.exit(2);
        }
    }

    return { command, overrides };
}

export async function main(): Promise<void> {
    const { command, overrides } = parseArgs(process.argv.slice(2));
    if (command === "help") {
        process.stdout.write(HELP);
        return;
    }
    if (command === "version") {
        process.stdout.write(VERSION + "\n");
        return;
    }
    if (command === "update") {
        // Manual one-shot update — bypasses the 6h throttle.
        await checkForUpdate({ packageName: PACKAGE_NAME, currentVersion: VERSION, autoUpdate: true }, true);
        return;
    }

    // CLI flags override env (which overrides the config file inside
    // loadOptions). Merge into process.env so loadOptions picks them up.
    for (const [k, v] of Object.entries(overrides)) {
        if (v !== undefined) process.env[k] = v;
    }
    const opts = loadOptions();
    await startServer(opts);

    // Start background auto-update after the server is listening so a slow
    // registry check never delays startup or races the listen socket.
    if (opts.autoUpdate) {
        startAutoUpdate({ packageName: PACKAGE_NAME, currentVersion: VERSION, autoUpdate: true });
    }
}
