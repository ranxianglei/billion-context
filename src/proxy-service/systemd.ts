// #ticket-linux-service: per-user systemd backend for the persistent proxy
// service (the Linux twin of task-scheduler.ts's per-user ONLOGON task).
//
// Shape mirrors the Windows backend deliberately: a PURE planner emitting
// absolute `systemctl` argv, so every branch is testable without a live bus,
// and the caller (service.ts) keeps ownership checks, rollback and status
// reporting in ONE place. Unit lives in the XDG user unit dir
// (~/.config/systemd/user) — no root, no /etc, and the same per-user
// "start at logon" semantics as the Task Scheduler task.
//
// NOT called `systemd` — the file is imported by src/proxy-service/service.ts
// and kept dependency-free (node:path only), like its Windows sibling.

import path from "node:path";

/** Unit basename. Fixed, like BILI_TASK_NAME: one service per machine. */
export const BILI_SYSTEMD_UNIT = "bili-proxy.service";

interface SystemdUnitOptions {
    nodePath: string;
    entryPath: string;
    port: number;
    host?: string;
    /** Absolute path of the unit file. */
    unitPath: string;
}

function checkedOptions(
    options: SystemdUnitOptions,
): Required<SystemdUnitOptions> {
    if (
        !Number.isInteger(options.port) ||
        options.port < 1 ||
        options.port > 65535
    ) {
        throw new RangeError(
            "proxy service port must be an integer from 1 to 65535",
        );
    }
    if (
        !path.isAbsolute(options.nodePath) ||
        !path.isAbsolute(options.entryPath) ||
        !path.isAbsolute(options.unitPath)
    ) {
        throw new TypeError(
            "proxy service executable, entry and unit paths must be absolute",
        );
    }
    return {
        nodePath: options.nodePath,
        entryPath: options.entryPath,
        port: options.port,
        host: options.host ?? "127.0.0.1",
        unitPath: options.unitPath,
    };
}

/** systemd ExecStart quoting: each argv element is quoted, with `"` and `\`
 *  backslash-escaped (systemd.syntax(7): double quotes keep a value as ONE
 *  argument; the shell only sees the unquoted result). */
function quoteArg(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The unit file bili owns. Restart=on-failure keeps the proxy alive across a
 *  crash without a supervisor of its own; --no-auto-update matches the Windows
 *  task (an auto-updating service would restart itself under systemd's feet). */
export function renderSystemdUnit(options: SystemdUnitOptions): string {
    const o = checkedOptions(options);
    const exec = [
        quoteArg(o.nodePath),
        quoteArg(o.entryPath),
        "start",
        "--host",
        quoteArg(o.host),
        "--port",
        String(o.port),
        "--no-auto-update",
    ].join(" ");
    return [
        "[Unit]",
        "Description=Billion Context proxy (bili)",
        "Documentation=https://github.com/ranxianglei/billion-context",
        "After=network-online.target",
        "",
        "[Service]",
        "Type=simple",
        `ExecStart=${exec}`,
        "Restart=on-failure",
        "RestartSec=5",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
    ].join("\n");
}

interface SystemdCommand {
    file: string;
    args: string[];
}

interface SystemdQueryOptions {
    unitName?: string;
    unitPath?: string;
}

function unitNameOf(options: SystemdQueryOptions): string {
    return options.unitName ?? BILI_SYSTEMD_UNIT;
}

function planSystemctl(
    args: string[],
    options: SystemdQueryOptions = {},
): SystemdCommand {
    return {
        file: "systemctl",
        args: ["--user", ...args, unitNameOf(options)],
    };
}

export function planDaemonReload(): SystemdCommand {
    return { file: "systemctl", args: ["--user", "daemon-reload"] };
}

export function planSystemdStart(
    options: SystemdQueryOptions = {},
): SystemdCommand {
    return planSystemctl(["start"], options);
}

export function planSystemdStop(
    options: SystemdQueryOptions = {},
): SystemdCommand {
    return planSystemctl(["stop"], options);
}

export function planSystemdDisable(
    options: SystemdQueryOptions = {},
): SystemdCommand {
    return planSystemctl(["disable"], options);
}

export function planSystemdEnableNow(
    options: SystemdQueryOptions = {},
): SystemdCommand {
    return planSystemctl(["enable", "--now"], options);
}

/** `systemctl --user is-enabled <unit>`: exit 0 with "enabled"/"enabled-runtime"
 *  ... on stdout when the [Install] section is wired up. */
export function planSystemdIsEnabled(
    options: SystemdQueryOptions = {},
): SystemdCommand {
    return planSystemctl(["is-enabled"], options);
}

/** `systemctl --user is-active <unit>`: exit 0 with "active" when running. */
export function planSystemdIsActive(
    options: SystemdQueryOptions = {},
): SystemdCommand {
    return planSystemctl(["is-active"], options);
}

/** True when `systemctl --user` can actually reach a user bus. A bare SSH
 *  session or a container often has systemd installed but no user manager for
 *  this login, where every systemctl --user call fails with
 *  "Failed to connect to bus"; the caller degrades to a clear message instead
 *  of writing a unit nothing will ever load. */
export function systemdUserBusUnavailable(result: {
    exitCode: number;
    stdout: string;
    stderr: string;
}): boolean {
    if (result.exitCode === 0) return false;
    return /failed to connect to bus|no medium found|systemd.*not been booted|connection refused/i.test(
        `${result.stdout}\n${result.stderr}`,
    );
}

/** `systemctl is-enabled` verdicts that mean the unit is NOT wired to start. */
export function systemdUnitEnabled(result: {
    exitCode: number;
    stdout: string;
    stderr: string;
}): boolean {
    if (result.exitCode !== 0) return false;
    return /^\s*enabled(-runtime)?\s*$/m.test(result.stdout);
}

export function systemdUnitActive(result: {
    exitCode: number;
    stdout: string;
    stderr: string;
}): boolean {
    if (result.exitCode !== 0) return false;
    return /^\s*active\s*$/m.test(result.stdout);
}

/** Exit-code/liveness text from `systemctl` that means "no such unit" — the
 *  Linux twin of task-scheduler's taskMissing. */
export function systemdUnitMissing(result: {
    exitCode: number;
    stdout: string;
    stderr: string;
}): boolean {
    const text = `${result.stdout}\n${result.stderr}`;
    if (/^\s*(inactive|unknown|not-found)\s*$/m.test(result.stdout)) return true;
    return /could not be found|not loaded|no such unit|does not exist/i.test(
        text,
    );
}
