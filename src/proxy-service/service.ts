import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    isPidAlive,
    isProxyInstanceFile,
    lanePreferredPort,
    readProxyInstanceFile,
} from "../instance.js";
import { stateDir } from "../paths.js";
import {
    BILI_TASK_NAME,
    planTaskDelete,
    planTaskDisable,
    planTaskEnable,
    planTaskEnd,
    planTaskQuery,
    planTaskRegisterXml,
    planTaskRun,
    renderTaskLauncherVbs,
    renderTaskXml,
    type TaskCommand,
    type TaskRunner,
    type TaskRunnerResult,
} from "./task-scheduler.js";
import {
    BILI_SYSTEMD_UNIT,
    planDaemonReload,
    planSystemdDisable,
    planSystemdEnableNow,
    planSystemdIsActive,
    planSystemdIsEnabled,
    planSystemdStart,
    planSystemdStop,
    renderSystemdUnit,
    systemdUnitActive,
    systemdUnitEnabled,
    systemdUnitMissing,
    systemdUserBusUnavailable,
} from "./systemd.js";

const SERVICE_STATE_FILE = "proxy-service.json";

interface ProxyServiceConfig {
    taskName?: string;
    nodePath?: string;
    entryPath?: string;
    port?: number;
    host?: string;
    platform?: NodeJS.Platform;
    runner?: TaskRunner;
    stateDirectory?: string;
    /** Absolute path of the systemd user unit (Linux backend). Defaults to
     *  $XDG_CONFIG_HOME/systemd/user/<BILI_SYSTEMD_UNIT>. */
    unitPath?: string;
}

interface ProxyServiceResult {
    ok: boolean;
    action:
        | "installed"
        | "already-installed"
        | "removed"
        | "already-absent"
        | "enabled"
        | "disabled"
        | "restarted"
        | "status"
        | "unsupported"
        | "error";
    message: string;
    state?: "ready" | "disabled" | "missing" | "unknown";
    output?: string;
}

interface ProxyServiceRecord {
    taskName: string;
    port: number;
    host: string;
    entryPath: string;
    installedAt: string;
}

/** Which backend owns the registration on this machine. Recorded so a status
 *  query never has to guess (and so a Windows record is never mistaken for a
 *  systemd unit with the same logical name). */
type ServiceBackend = "schtasks" | "systemd";

interface ServiceRecord extends ProxyServiceRecord {
    backend: ServiceBackend;
    /** systemd only: absolute unit path written by install. */
    unitPath?: string;
    /** Shape version of the registration this record describes. Bump whenever
     *  the GENERATED artifact changes in a way a pre-existing registration must
     *  adopt (e.g. adding <Hidden> to the Task Scheduler document). Without it
     *  the path-based idempotency check below would treat a task registered by an
     *  older bili as "already installed" and never apply the new shape. */
    registrationVersion?: number;
}

/** Current registration shape. Bump this whenever renderTaskXml / the task
 *  command / the systemd unit changes in a way existing installs must adopt.
 *  v2 = hidden Task Scheduler document (no console window).
 *  v3 = task action goes through wscript.exe + a hidden-mode .vbs launcher;
 *       v2's <Hidden> alone provably did NOT stop the console window.
 *  v4 = launcher waits on the proxy (Run(..., 0, True)) so the task keeps
 *       owning the process and uninstall can actually stop it. */
const REGISTRATION_VERSION = 4;

/** Task names are user-visible but not filename-safe; the generated companion
 *  files (hidden launcher, temporary XML transport) derive their names from it. */
function safeTaskFileName(taskName: string): string {
    return taskName.replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Path of the persistent hidden-mode launcher the task invokes through
 *  wscript.exe. Lives in the state directory because the task references it at
 *  every logon and it must outlive the install command. */
function taskLauncherPath(c: ResolvedConfig): string {
    return path.join(
        c.stateDirectory,
        `${safeTaskFileName(c.taskName)}.launch.vbs`,
    );
}

/** Legacy records (written before the Linux backend existed) carry no
 *  `backend`; they are by definition Task Scheduler registrations. */
function recordBackend(record: ServiceRecord): ServiceBackend {
    return record.backend === "systemd" ? "systemd" : "schtasks";
}

/** schtasks on a Chinese Windows prints GBK; systemctl output is UTF-8. A
 *  single hard-wired label garbles one backend's error text on the other OS. */
function spawnRunner(platform: NodeJS.Platform): TaskRunner {
    const label = platform === "win32" ? "gbk" : "utf8";
    return (command: TaskCommand) =>
        new Promise((resolve, reject) => {
            import("node:child_process").then(({ spawn }) => {
                const child = spawn(command.file, command.args, {
                    windowsHide: true,
                    stdio: ["ignore", "pipe", "pipe"],
                });
                const stdout: Buffer[] = [];
                const stderr: Buffer[] = [];
                child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
                child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
                child.once("error", reject);
                child.once("close", (code) => {
                    const decode = (chunks: Buffer[]): string =>
                        new TextDecoder(label).decode(Buffer.concat(chunks));
                    resolve({
                        exitCode: code ?? 1,
                        stdout: decode(stdout),
                        stderr: decode(stderr),
                    });
                });
            });
        });
}

function serviceRecordPath(directory = stateDir()): string {
    return path.join(directory, SERVICE_STATE_FILE);
}

function readRecord(file: string): ServiceRecord | undefined {
    try {
        const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
        if (value === null || typeof value !== "object" || Array.isArray(value))
            return undefined;
        const row = value as Record<string, unknown>;
        if (
            typeof row.taskName !== "string" ||
            typeof row.entryPath !== "string" ||
            typeof row.host !== "string" ||
            typeof row.port !== "number" ||
            typeof row.installedAt !== "string"
        )
            return undefined;
        return {
            taskName: row.taskName,
            entryPath: row.entryPath,
            host: row.host,
            port: row.port,
            installedAt: row.installedAt,
            backend: row.backend === "systemd" ? "systemd" : "schtasks",
            ...(typeof row.unitPath === "string" ? { unitPath: row.unitPath } : {}),
            ...(typeof row.registrationVersion === "number"
                ? { registrationVersion: row.registrationVersion }
                : {}),
        };
    } catch {
        return undefined;
    }
}

function writeRecord(file: string, record: ServiceRecord): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
    });
    fs.renameSync(temporary, file);
}

function removeRecord(file: string): void {
    try {
        fs.unlinkSync(file);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            throw error;
    }
}

function resolveConfig(config: ProxyServiceConfig) {
    const taskName = config.taskName ?? BILI_TASK_NAME;
    const platform = config.platform ?? process.platform;
    const entryPath =
        config.entryPath ??
        process.argv[1] ??
        fileURLToPath(new URL("../index.js", import.meta.url));
    return {
        taskName,
        nodePath: config.nodePath ?? process.execPath,
        entryPath,
        port: config.port ?? lanePreferredPort("codex"),
        host: config.host ?? "127.0.0.1",
        platform,
        runner: config.runner ?? spawnRunner(platform),
        stateDirectory: config.stateDirectory ?? stateDir(),
        unitPath: config.unitPath ?? defaultUnitPath(),
    };
}

/** $XDG_CONFIG_HOME/systemd/user/<unit>, defaulting under ~/.config. Mirrors
 *  paths.ts's XDG handling without importing its billion-context leaf dirs
 *  (the unit belongs to systemd's namespace, not ours). */
function defaultUnitPath(): string {
    const base = process.env["XDG_CONFIG_HOME"]?.trim();
    const root =
        base !== undefined && base.length > 0
            ? path.resolve(base)
            : path.join(os.homedir(), ".config");
    return path.join(root, "systemd", "user", BILI_SYSTEMD_UNIT);
}

async function invoke(
    runner: TaskRunner,
    command: TaskCommand,
): Promise<TaskRunnerResult> {
    try {
        return await runner(command);
    } catch (error) {
        return {
            exitCode: 1,
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
        };
    }
}

function taskExists(result: TaskRunnerResult): boolean {
    return result.exitCode === 0 && /<Task(?:\s|>)/i.test(result.stdout);
}

function taskDisabled(result: TaskRunnerResult): boolean {
    return /<Enabled>false<\/Enabled>/i.test(result.stdout);
}

function taskMissing(result: TaskRunnerResult): boolean {
    return (
        result.exitCode !== 0 &&
        /cannot find|does not exist|not found|ERROR: The system cannot find|系统找不到|找不到指定的文件|不存在/i.test(
            `${result.stdout}\n${result.stderr}`,
        )
    );
}

function hasOwnedTask(file: string, taskName: string): boolean {
    const record = readRecord(file);
    return (
        record !== undefined &&
        record.taskName === taskName &&
        recordBackend(record) === "schtasks"
    );
}

/** systemd twin of hasOwnedTask: the unit this machine's record claims, and
 *  only when the record says the systemd backend wrote it. */
function hasOwnedUnit(file: string, unitPath: string): boolean {
    const record = readRecord(file);
    return (
        record !== undefined &&
        recordBackend(record) === "systemd" &&
        record.unitPath === unitPath
    );
}

/** A record written by the OTHER backend. Presenting it as ours would let
 *  `remove` delete a registration the running copy did not create. */
function hasForeignBackendRecord(
    file: string,
    backend: ServiceBackend,
): boolean {
    const record = readRecord(file);
    return record !== undefined && recordBackend(record) !== backend;
}

function unsupportedPlatform(platform: NodeJS.Platform): ProxyServiceResult {
    return {
        ok: false,
        action: "unsupported",
        state: "unknown",
        message: `persistent proxy service is not supported on ${platform} (Windows Task Scheduler and Linux systemd user units are)`,
    };
}

function describeFailure(
    action: string,
    result: TaskRunnerResult,
): ProxyServiceResult {
    const detail = (
        result.stderr ||
        result.stdout ||
        `exit code ${result.exitCode}`
    ).trim();
    return { ok: false, action: "error", message: `${action} failed: ${detail}` };
}

export async function proxyServiceStatus(
    config: ProxyServiceConfig = {},
): Promise<ProxyServiceResult> {
    const c = resolveConfig(config);
    if (c.platform === "linux") return statusSystemd(c);
    if (c.platform !== "win32") return unsupportedPlatform(c.platform);
    const result = await invoke(c.runner, planTaskQuery(c.taskName));
    if (taskMissing(result))
        return {
            ok: true,
            action: "status",
            state: "missing",
            message: "scheduled task is not registered",
        };
    if (result.exitCode !== 0)
        return describeFailure("query scheduled task", result);
    if (!taskExists(result))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: "scheduled task query returned unrecognized XML",
        };
    if (!hasOwnedTask(serviceRecordPath(c.stateDirectory), c.taskName)) {
        return {
            ok: true,
            action: "status",
            state: "unknown",
            message: "scheduled task name is occupied by an unowned task",
        };
    }
    return {
        ok: true,
        action: "status",
        state: taskDisabled(result) ? "disabled" : "ready",
        message: taskDisabled(result)
            ? "scheduled task is registered but disabled"
            : "scheduled task is registered",
        output: result.stdout,
    };
}

export async function installProxyService(
    config: ProxyServiceConfig = {},
): Promise<ProxyServiceResult> {
    const c = resolveConfig(config);
    if (c.platform === "linux") return installSystemd(c);
    if (c.platform !== "win32") return unsupportedPlatform(c.platform);
    const file = serviceRecordPath(c.stateDirectory);
    const query = await invoke(c.runner, planTaskQuery(c.taskName));
    if (query.exitCode !== 0 && !taskMissing(query))
        return describeFailure("query scheduled task", query);
    if (query.exitCode === 0 && !taskExists(query)) {
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: "scheduled task query returned unrecognized XML; left untouched",
        };
    }
    if (query.exitCode === 0 && taskExists(query)) {
        const existing = readRecord(file);
        if (existing?.taskName !== c.taskName) {
            return {
                ok: false,
                action: "error",
                state: "unknown",
                message:
                    "scheduled task name is occupied by an unowned task; left untouched",
            };
        }
        if (
            existing.entryPath === c.entryPath &&
            existing.port === c.port &&
            existing.host === c.host &&
            existing.registrationVersion === REGISTRATION_VERSION
        ) {
            return {
                ok: true,
                action: "already-installed",
                state: taskDisabled(query) ? "disabled" : "ready",
                message:
                    "scheduled task is already registered with the current bili entry",
            };
        }
    }
    const xmlPath = path.join(
        c.stateDirectory,
        `${safeTaskFileName(c.taskName)}.task.xml`,
    );
    // The task action is a .vbs run through wscript.exe, not node.exe directly:
    // a console-subsystem binary started by the scheduler in the interactive
    // session allocates a conhost window that <Hidden> cannot suppress. The
    // launcher PERSISTS (the task references it at every logon) — only the XML
    // transport file is temporary.
    const launcherPath = taskLauncherPath(c);
    let result: TaskRunnerResult;
    try {
        fs.mkdirSync(c.stateDirectory, { recursive: true });
        fs.writeFileSync(
            launcherPath,
            Buffer.from(`\ufeff${renderTaskLauncherVbs(c)}`, "utf16le"),
        );
        // Task Scheduler requires a UTF-16 document to carry the FF FE byte-order
        // mark; Node's "utf16le" encoder writes none, and without it schtasks
        // fails with "任务 XML 格式错误 (1,2)::错误: 一个根元素".
        const xml = Buffer.from(
            `\ufeff${renderTaskXml({ ...c, launcherPath })}`,
            "utf16le",
        );
        fs.writeFileSync(xmlPath, xml);
        result = await invoke(c.runner, planTaskRegisterXml(xmlPath, c.taskName));
    } catch (err) {
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: `could not register the scheduled task from its hidden XML document: ${err instanceof Error ? err.message : String(err)}`,
        };
    } finally {
        fs.rmSync(xmlPath, { force: true });
    }
    if (result.exitCode !== 0)
        return describeFailure("register scheduled task", result);
    writeRecord(file, {
        taskName: c.taskName,
        entryPath: c.entryPath,
        port: c.port,
        host: c.host,
        installedAt: new Date().toISOString(),
        backend: "schtasks",
        registrationVersion: REGISTRATION_VERSION,
    });
    const verified = await invoke(c.runner, planTaskQuery(c.taskName));
    if (verified.exitCode !== 0 || !taskExists(verified)) {
        await invoke(c.runner, planTaskDelete(c.taskName));
        removeRecord(file);
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message:
                "registration command succeeded but scheduled task could not be verified; registration was rolled back",
        };
    }
    const started = await invoke(c.runner, planTaskRun(c.taskName));
    if (started.exitCode !== 0) {
        await invoke(c.runner, planTaskDelete(c.taskName));
        removeRecord(file);
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: `scheduled task registered but immediate start failed; registration was rolled back: ${(started.stderr || started.stdout || `exit code ${started.exitCode}`).trim()}`,
        };
    }
    return {
        ok: true,
        action: "installed",
        state: taskDisabled(verified) ? "disabled" : "ready",
        message:
            "registered per-user at-logon Task Scheduler task and requested an immediate start",
    };
}

function readProxyPidOnPort(port: number): number | undefined {
    const info = readProxyInstanceFile();
    if (!isProxyInstanceFile(info)) return undefined;
    if (info.port !== port || info.pid <= 0) return undefined;
    return isPidAlive(info.pid) ? info.pid : undefined;
}

/** Best-effort stop of a proxy that the scheduler can no longer reach.
 *
 * `schtasks /End` terminates the task's direct child (our wscript launcher) but
 * the node it spawned can survive as a reparented orphan still holding the
 * port — uninstall would then report success while traffic keeps being
 * compressed by a process with no task handle left. The proxy publishes its own
 * pid in the instance file, so reap that pid when it is still alive and is the
 * one owning the port we registered. Never throws: a failure here must not turn
 * a successful uninstall into an error. */
function reapOrphanProxy(port: number): boolean {
    let killed = false;
    const pid = readProxyPidOnPort(port);
    if (pid !== undefined) {
        try {
            process.kill(pid);
            killed = true;
        } catch {
            // The process exited between the liveness check and the signal, or we
            // lack permission; either way removal proceeds without it.
        }
    }
    return killed;
}

export async function removeProxyService(
    config: ProxyServiceConfig = {},
): Promise<ProxyServiceResult> {
    const c = resolveConfig(config);
    if (c.platform === "linux") return removeSystemd(c);
    if (c.platform !== "win32") return unsupportedPlatform(c.platform);
    const file = serviceRecordPath(c.stateDirectory);
    const query = await invoke(c.runner, planTaskQuery(c.taskName));
    if (query.exitCode !== 0 && !taskMissing(query))
        return describeFailure("query scheduled task", query);
    if (query.exitCode === 0 && !taskExists(query))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: "scheduled task query returned unrecognized XML; left untouched",
        };
    if (
        query.exitCode === 0 &&
        taskExists(query) &&
        !hasOwnedTask(file, c.taskName)
    ) {
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message:
                "scheduled task name is occupied by an unowned task; left untouched",
        };
    }
    // Stop the live instance BEFORE deleting the task: the task is the only
    // handle on that process, so removing it first would orphan a running proxy
    // that keeps listening (and keeps compressing traffic) with no way to stop it
    // except by hand. A "not running" answer is the normal already-stopped case.
    const end = await invoke(c.runner, planTaskEnd(c.taskName));
    if (
        end.exitCode !== 0 &&
        !/not running|not currently running/i.test(`${end.stdout}\n${end.stderr}`)
    )
        return describeFailure("stop scheduled task instance", end);
    const result = await invoke(c.runner, planTaskDelete(c.taskName));
    if (result.exitCode !== 0 && !taskMissing(result))
        return describeFailure("remove scheduled task", result);
    // /End killed our launcher but the node it spawned may have survived as an
    // orphan still holding the port; reap it so "removed" means removed.
    reapOrphanProxy(c.port);
    // The hidden launcher is only referenced by the task we just deleted; a
    // leftover .vbs would otherwise survive uninstall and keep pointing at a
    // dist/ tree the user may have removed.
    fs.rmSync(taskLauncherPath(c), { force: true });
    removeRecord(file);
    return {
        ok: true,
        action: result.exitCode === 0 ? "removed" : "already-absent",
        state: "missing",
        message:
            result.exitCode === 0
                ? "scheduled task removed"
                : "scheduled task was already absent",
    };
}

export async function disableProxyService(
    config: ProxyServiceConfig = {},
): Promise<ProxyServiceResult> {
    const c = resolveConfig(config);
    if (c.platform === "linux") return disableSystemd(c);
    if (c.platform !== "win32") return unsupportedPlatform(c.platform);
    const file = serviceRecordPath(c.stateDirectory);
    const query = await invoke(c.runner, planTaskQuery(c.taskName));
    if (taskMissing(query))
        return {
            ok: false,
            action: "error",
            state: "missing",
            message: "scheduled task is not registered; install it first",
        };
    if (query.exitCode !== 0)
        return describeFailure("query scheduled task", query);
    if (!taskExists(query))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: "scheduled task query returned unrecognized XML; left untouched",
        };
    if (!hasOwnedTask(file, c.taskName))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message:
                "scheduled task name is occupied by an unowned task; left untouched",
        };
    const result = await invoke(c.runner, planTaskDisable(c.taskName));
    if (
        result.exitCode !== 0 &&
        !/already disabled/i.test(`${result.stdout}\n${result.stderr}`)
    )
        return describeFailure("disable scheduled task", result);
    return {
        ok: true,
        action: "disabled",
        state: "disabled",
        message: "scheduled task disabled",
    };
}

export async function restartProxyService(
    config: ProxyServiceConfig = {},
): Promise<ProxyServiceResult> {
    const c = resolveConfig(config);
    if (c.platform === "linux") return restartSystemd(c);
    if (c.platform !== "win32") return unsupportedPlatform(c.platform);
    const query = await invoke(c.runner, planTaskQuery(c.taskName));
    if (taskMissing(query))
        return {
            ok: false,
            action: "error",
            state: "missing",
            message: "scheduled task is not registered; install it first",
        };
    if (query.exitCode !== 0)
        return describeFailure("query scheduled task", query);
    if (!taskExists(query))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: "scheduled task query returned unrecognized XML; left untouched",
        };
    if (!hasOwnedTask(serviceRecordPath(c.stateDirectory), c.taskName))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message:
                "scheduled task name is occupied by an unowned task; left untouched",
        };
    const end = await invoke(c.runner, planTaskEnd(c.taskName));
    if (
        end.exitCode !== 0 &&
        !/not running|not currently running/i.test(`${end.stdout}\n${end.stderr}`)
    )
        return describeFailure("stop scheduled task instance", end);
    const run = await invoke(c.runner, planTaskRun(c.taskName));
    if (run.exitCode !== 0) return describeFailure("start scheduled task", run);
    return {
        ok: true,
        action: "restarted",
        state: "ready",
        message: "scheduled task restart requested",
    };
}

export async function enableProxyService(
    config: ProxyServiceConfig = {},
): Promise<ProxyServiceResult> {
    const c = resolveConfig(config);
    if (c.platform === "linux") return enableSystemd(c);
    if (c.platform !== "win32") return unsupportedPlatform(c.platform);
    const file = serviceRecordPath(c.stateDirectory);
    const query = await invoke(c.runner, planTaskQuery(c.taskName));
    if (taskMissing(query))
        return {
            ok: false,
            action: "error",
            state: "missing",
            message: "scheduled task is not registered; install it first",
        };
    if (query.exitCode !== 0)
        return describeFailure("query scheduled task", query);
    if (!taskExists(query))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: "scheduled task query returned unrecognized XML; left untouched",
        };
    if (!hasOwnedTask(file, c.taskName))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message:
                "scheduled task name is occupied by an unowned task; left untouched",
        };
    const result = await invoke(c.runner, planTaskEnable(c.taskName));
    if (result.exitCode !== 0)
        return describeFailure("enable scheduled task", result);
    return {
        ok: true,
        action: "enabled",
        state: "ready",
        message: "scheduled task enabled",
    };
}

// ---------------------------------------------------------------------------
// Linux backend: per-user systemd unit (~/.config/systemd/user/bili-proxy.service).
// Same ownership discipline as the Windows half — the record file decides whose
// registration this is, and every mutating step verifies itself and rolls back
// on failure, so a half-written unit never survives an install that errored.
// ---------------------------------------------------------------------------

type ResolvedConfig = ReturnType<typeof resolveConfig>;

/** Bus reachability preflight shared by every mutating systemd path. Returns a
 *  failure result when `systemctl --user` cannot talk to a user manager, else
 *  undefined. Writing a unit into a machine whose user manager will never load
 *  it is the failure mode this prevents. */
async function requireSystemdBus(
    c: ResolvedConfig,
): Promise<ProxyServiceResult | undefined> {
    const probe = await invoke(
        c.runner,
        planSystemdIsEnabled({ unitName: c.taskName, unitPath: c.unitPath }),
    );
    if (systemdUserBusUnavailable(probe))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message:
                "systemctl --user cannot reach a user manager (no systemd user bus in this session) — run `loginctl enable-linger $USER` on a systemd host, or start the proxy with `bili start` instead",
        };
    return undefined;
}

async function statusSystemd(c: ResolvedConfig): Promise<ProxyServiceResult> {
    const probe = await invoke(
        c.runner,
        planSystemdIsEnabled({ unitName: c.taskName }),
    );
    if (systemdUserBusUnavailable(probe))
        return {
            ok: false,
            action: "unsupported",
            state: "unknown",
            message:
                "systemctl --user cannot reach a user manager (no systemd user bus in this session)",
        };
    const unitName = c.taskName;
    const enabled = await querySystemdEnabled(c);
    if (enabled === undefined)
        return {
            ok: true,
            action: "status",
            state: "missing",
            message: "systemd user unit is not registered",
        };
    if (!hasOwnedUnit(serviceRecordPath(c.stateDirectory), c.unitPath))
        return {
            ok: true,
            action: "status",
            state: "unknown",
            message: "systemd user unit is not owned by this bili copy",
        };
    const active = await invoke(c.runner, planSystemdIsActive({ unitName }));
    return {
        ok: true,
        action: "status",
        state: enabled
            ? systemdUnitActive(active)
                ? "ready"
                : "disabled"
            : "disabled",
        message: enabled
            ? systemdUnitActive(active)
                ? "systemd user unit is enabled and active"
                : "systemd user unit is enabled but not running"
            : "systemd user unit is registered but disabled",
        output: active.stdout,
    };
}

/** Renders the unit, wires it into systemd and starts it immediately. */
async function installSystemd(c: ResolvedConfig): Promise<ProxyServiceResult> {
    const bus = await requireSystemdBus(c);
    if (bus !== undefined) return bus;
    const file = serviceRecordPath(c.stateDirectory);
    if (hasForeignBackendRecord(file, "systemd"))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message:
                "a Task Scheduler registration is recorded for this copy; remove it with `bili service remove` before installing the systemd unit",
        };
    const existing = await querySystemdEnabled(c);
    // Ownership is decided against what systemd ACTUALLY knows, not against the
    // record alone: a unit file left behind by another copy (or by a hand edit)
    // while our record is missing must still be seen as foreign, or install
    // would silently overwrite someone else's unit.
    const unitOnDisk = fs.existsSync(c.unitPath);
    if (
        (existing !== undefined || unitOnDisk) &&
        !hasOwnedUnit(file, c.unitPath)
    ) {
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: `systemd user unit ${c.taskName} already exists and is not owned by this bili copy; left untouched`,
        };
    }
    const previous = readRecord(file);
    if (
        existing !== undefined &&
        previous !== undefined &&
        recordBackend(previous) === "systemd" &&
        previous.entryPath === c.entryPath &&
        previous.port === c.port &&
        previous.host === c.host &&
        previous.registrationVersion === REGISTRATION_VERSION
    ) {
        const active = await invoke(
            c.runner,
            planSystemdIsActive({ unitName: c.taskName }),
        );
        return {
            ok: true,
            action: "already-installed",
            state: systemdUnitActive(active) ? "ready" : "disabled",
            message: systemdUnitActive(active)
                ? "systemd user unit is already registered with the current bili entry"
                : "systemd user unit is registered but not running",
        };
    }
    return writeAndEnableSystemd(c, file, previous);
}

/** Write the unit, reload systemd, enable-and-start it, then verify it is
 *  actually active. Every failure path restores the previous unit text (or
 *  deletes the file we created) and the previous record, so an install that
 *  reports an error leaves the machine exactly as it found it. */
async function writeAndEnableSystemd(
    c: ResolvedConfig,
    file: string,
    previous: ServiceRecord | undefined,
): Promise<ProxyServiceResult> {
    let priorText: string | undefined;
    try {
        priorText = fs.readFileSync(c.unitPath, "utf8");
    } catch {}
    try {
        fs.mkdirSync(path.dirname(c.unitPath), { recursive: true });
        fs.writeFileSync(
            c.unitPath,
            renderSystemdUnit({
                nodePath: c.nodePath,
                entryPath: c.entryPath,
                port: c.port,
                host: c.host,
                unitPath: c.unitPath,
            }),
        );
    } catch (error) {
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: `could not write ${c.unitPath}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    const reload = await invoke(c.runner, planDaemonReload());
    if (reload.exitCode !== 0) {
        restoreUnit(c.unitPath, priorText);
        return describeFailure("reload systemd user manager", reload);
    }
    const enable = await invoke(
        c.runner,
        planSystemdEnableNow({ unitName: c.taskName }),
    );
    if (enable.exitCode !== 0) {
        restoreUnit(c.unitPath, priorText);
        await invoke(c.runner, planDaemonReload());
        return describeFailure("enable systemd user unit", enable);
    }
    writeRecord(file, {
        taskName: c.taskName,
        entryPath: c.entryPath,
        port: c.port,
        host: c.host,
        installedAt: new Date().toISOString(),
        backend: "systemd",
        unitPath: c.unitPath,
        registrationVersion: REGISTRATION_VERSION,
    });
    const verifiedActive = await invoke(
        c.runner,
        planSystemdIsActive({ unitName: c.taskName }),
    );
    if (!systemdUnitActive(verifiedActive)) {
        await invoke(c.runner, planSystemdDisable({ unitName: c.taskName }));
        restoreUnit(c.unitPath, priorText);
        await invoke(c.runner, planDaemonReload());
        if (previous !== undefined) writeRecord(file, previous);
        else removeRecord(file);
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message: `systemd user unit enabled but did not become active; registration was rolled back (${(verifiedActive.stderr || verifiedActive.stdout || `exit code ${verifiedActive.exitCode}`).trim()})`,
        };
    }
    return {
        ok: true,
        action: "installed",
        state: "ready",
        message:
            "wrote per-user systemd unit, enabled it at logon and started it immediately",
    };
}

/** Put back what was on disk before us, or remove the file we created. */
function restoreUnit(unitPath: string, priorText: string | undefined): void {
    try {
        if (priorText === undefined) fs.unlinkSync(unitPath);
        else fs.writeFileSync(unitPath, priorText);
    } catch {}
}

/** Ask systemd whether the unit is enabled. `undefined` means systemd does not
 *  know this unit at all — distinct from "known but disabled", so callers can
 *  tell "nothing installed" from "installed, turned off". */
async function querySystemdEnabled(
    c: ResolvedConfig,
): Promise<boolean | undefined> {
    const result = await invoke(
        c.runner,
        planSystemdIsEnabled({ unitName: c.taskName }),
    );
    if (systemdUnitMissing(result)) return undefined;
    return systemdUnitEnabled(result);
}

async function removeSystemd(c: ResolvedConfig): Promise<ProxyServiceResult> {
    const file = serviceRecordPath(c.stateDirectory);
    if (hasForeignBackendRecord(file, "systemd"))
        return {
            ok: false,
            action: "error",
            state: "unknown",
            message:
                "a Task Scheduler registration is recorded for this copy, not a systemd unit; left untouched",
        };
    if (!hasOwnedUnit(file, c.unitPath)) {
        return {
            ok: true,
            action: "already-absent",
            state: "missing",
            message: "no systemd user unit is registered for this bili copy",
        };
    }
    const disable = await invoke(
        c.runner,
        planSystemdDisable({ unitName: c.taskName }),
    );
    if (disable.exitCode !== 0 && !systemdUnitMissing(disable))
        return describeFailure("disable systemd user unit", disable);
    const stop = await invoke(
        c.runner,
        planSystemdStop({ unitName: c.taskName }),
    );
    if (stop.exitCode !== 0 && !systemdUnitMissing(stop))
        return describeFailure("stop systemd user unit", stop);
    try {
        fs.unlinkSync(c.unitPath);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            return {
                ok: false,
                action: "error",
                state: "unknown",
                message: `could not delete ${c.unitPath}: ${error instanceof Error ? error.message : String(error)}`,
            };
    }
    await invoke(c.runner, planDaemonReload());
    removeRecord(file);
    return {
        ok: true,
        action: "removed",
        state: "missing",
        message: "systemd user unit disabled, stopped and deleted",
    };
}

async function disableSystemd(c: ResolvedConfig): Promise<ProxyServiceResult> {
    if ((await querySystemdEnabled(c)) === undefined)
        return {
            ok: false,
            action: "error",
            state: "missing",
            message:
                "no systemd user unit is registered for this bili copy; install it first",
        };
    const result = await invoke(
        c.runner,
        planSystemdDisable({ unitName: c.taskName }),
    );
    if (
        result.exitCode !== 0 &&
        !/not enabled|already disabled/i.test(`${result.stdout}\n${result.stderr}`)
    )
        return describeFailure("disable systemd user unit", result);
    const stop = await invoke(
        c.runner,
        planSystemdStop({ unitName: c.taskName }),
    );
    if (
        stop.exitCode !== 0 &&
        !systemdUnitMissing(stop) &&
        !/not running/i.test(`${stop.stdout}\n${stop.stderr}`)
    )
        return describeFailure("stop systemd user unit", stop);
    return {
        ok: true,
        action: "disabled",
        state: "disabled",
        message: "systemd user unit disabled and stopped",
    };
}

async function enableSystemd(c: ResolvedConfig): Promise<ProxyServiceResult> {
    if ((await querySystemdEnabled(c)) === undefined)
        return {
            ok: false,
            action: "error",
            state: "missing",
            message:
                "no systemd user unit is registered for this bili copy; install it first",
        };
    const result = await invoke(
        c.runner,
        planSystemdEnableNow({ unitName: c.taskName }),
    );
    if (result.exitCode !== 0)
        return describeFailure("enable systemd user unit", result);
    return {
        ok: true,
        action: "enabled",
        state: "ready",
        message: "systemd user unit enabled and started",
    };
}

async function restartSystemd(c: ResolvedConfig): Promise<ProxyServiceResult> {
    if ((await querySystemdEnabled(c)) === undefined)
        return {
            ok: false,
            action: "error",
            state: "missing",
            message:
                "no systemd user unit is registered for this bili copy; install it first",
        };
    const stop = await invoke(
        c.runner,
        planSystemdStop({ unitName: c.taskName }),
    );
    if (
        stop.exitCode !== 0 &&
        !/not running/i.test(`${stop.stdout}\n${stop.stderr}`) &&
        !systemdUnitMissing(stop)
    )
        return describeFailure("stop systemd user unit", stop);
    const start = await invoke(
        c.runner,
        planSystemdStart({ unitName: c.taskName }),
    );
    if (start.exitCode !== 0)
        return describeFailure("start systemd user unit", start);
    return {
        ok: true,
        action: "restarted",
        state: "ready",
        message: "systemd user unit restart requested",
    };
}
