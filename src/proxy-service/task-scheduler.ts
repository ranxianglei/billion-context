import path from "node:path";

export const BILI_TASK_NAME = "Billion Context Proxy";

export interface TaskCommand {
    file: string;
    args: string[];
}

interface ProxyTaskOptions {
    taskName?: string;
    nodePath: string;
    entryPath: string;
    port: number;
    host?: string;
    /** Absolute path of the generated .vbs launcher the task executes through
     *  wscript.exe. Required for the hidden registration; `planTaskRegister`
     *  (the flag form) ignores it. */
    launcherPath?: string;
}

/** Absolute on ANY supported OS: these plans describe Windows command lines,
 *  but the unit suite also runs on POSIX hosts where `path.isAbsolute` rejects
 *  drive-letter paths. */
function isAnyAbsolutePath(value: string): boolean {
    return (
        path.isAbsolute(value) ||
        /^[A-Za-z]:[\\/]/.test(value) ||
        value.startsWith("\\\\")
    );
}

function checkedOptions(options: ProxyTaskOptions): Required<ProxyTaskOptions> {
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
        !isAnyAbsolutePath(options.nodePath) ||
        !isAnyAbsolutePath(options.entryPath)
    ) {
        throw new TypeError(
            "proxy service executable and entry paths must be absolute",
        );
    }
    return {
        taskName: options.taskName ?? BILI_TASK_NAME,
        nodePath: options.nodePath,
        entryPath: options.entryPath,
        port: options.port,
        host: options.host ?? "127.0.0.1",
        launcherPath: options.launcherPath ?? "",
    };
}

function xmlEscape(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** The registration document for the at-logon proxy task.
 *
 * <Hidden>true</Hidden> is the load-bearing setting: without it Task Scheduler
 * launches the proxy in the interactive session with a console window, and the
 * child's own windowsHide cannot suppress a console the SCHEDULER created.
 * <LogonType>InteractiveToken</LogonType> keeps the run per-user and
 * non-elevated (equivalent to the flag form's ONLOGON + /RL LIMITED).
 * MultipleInstancesPolicy=IgnoreNew makes a duplicate logon a no-op instead of
 * a second proxy racing for the same port. */
export function renderTaskXml(options: ProxyTaskOptions): string {
    const o = checkedOptions(options);
    if (o.launcherPath.length === 0)
        throw new TypeError(
            "hidden task registration requires an absolute launcher path (the generated .vbs the task runs through wscript.exe)",
        );
    const author = process.env.USERNAME ?? process.env.USER ?? "";
    return [
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        "  <RegistrationInfo>",
        `    <Author>${xmlEscape(author)}</Author>`,
        "    <Description>Billion Context compression proxy (per-user, at logon).</Description>",
        "  </RegistrationInfo>",
        "  <Triggers>",
        "    <LogonTrigger>",
        "      <Enabled>true</Enabled>",
        "    </LogonTrigger>",
        "  </Triggers>",
        "  <Principals>",
        '    <Principal id="Author">',
        `      <UserId>${xmlEscape(author)}</UserId>`,
        "      <LogonType>InteractiveToken</LogonType>",
        "      <RunLevel>LeastPrivilege</RunLevel>",
        "    </Principal>",
        "  </Principals>",
        "  <Settings>",
        "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "    <AllowHardTerminate>true</AllowHardTerminate>",
        "    <StartWhenAvailable>true</StartWhenAvailable>",
        "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
        "    <IdleSettings>",
        "      <StopOnIdleEnd>false</StopOnIdleEnd>",
        "      <RestartOnIdle>false</RestartOnIdle>",
        "    </IdleSettings>",
        "    <AllowStartOnDemand>true</AllowStartOnDemand>",
        "    <Enabled>true</Enabled>",
        "    <Hidden>true</Hidden>",
        "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
        "    <WakeToRun>false</WakeToRun>",
        "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
        "    <Priority>7</Priority>",
        "  </Settings>",
        '  <Actions Context="Author">',
        "    <Exec>",
        `      <Command>wscript.exe</Command>`,
        `      <Arguments>${xmlEscape(`//B //Nologo "${o.launcherPath}"`)}</Arguments>`,
        "    </Exec>",
        "  </Actions>",
        "</Task>",
        "",
    ].join("\r\n");
}

/** Windows Script Host launcher used as the task action.
 *
 * A console-subsystem binary (node.exe) started by the Task Scheduler in the
 * interactive session allocates a conhost window, and <Hidden> does NOT
 * suppress it: <Hidden> only keeps the task out of the Task Scheduler UI. WSH's
 * Run(cmd, 0, ...) launches with hidden window style, and wscript.exe is a
 * GUI-subsystem binary, so no console is ever created for this chain.
 *
 * The third argument is True (WAIT) on purpose. With False, wscript exits
 * immediately and node is REPARENTED away from the task, so `schtasks /End` can
 * no longer reach it — uninstall then leaves an orphan proxy holding the port
 * forever. Waiting keeps wscript alive as the task's own process with node as
 * its child, so the whole tree stays inside the task's job object and `/End`
 * terminates it (verified: node's window stays 0 in both modes, but only WAIT
 * keeps the process reachable). */
export function renderTaskLauncherVbs(options: ProxyTaskOptions): string {
    const o = checkedOptions(options);
    const command = `"${o.nodePath}" "${o.entryPath}" start --host "${o.host}" --port ${o.port} --no-auto-update`;
    return [
        "' bili: launch the compression proxy with no console window.",
        "Dim sh, cmd",
        `cmd = "${command.replace(/"/g, '""')}"`,
        'Set sh = CreateObject("WScript.Shell")',
        "' 0 = hidden window, True = wait so the task keeps owning the proxy",
        "sh.Run cmd, 0, True",
        "",
    ].join("\r\n");
}

/** Register from the hidden document: schtasks reads the XML at a file path. */
export function planTaskRegisterXml(
    xmlPath: string,
    taskName = BILI_TASK_NAME,
): TaskCommand {
    return {
        file: "schtasks.exe",
        args: ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"],
    };
}

export function planTaskQuery(taskName = BILI_TASK_NAME): TaskCommand {
    return { file: "schtasks.exe", args: ["/Query", "/TN", taskName, "/XML"] };
}

export function planTaskRun(taskName = BILI_TASK_NAME): TaskCommand {
    return { file: "schtasks.exe", args: ["/Run", "/TN", taskName] };
}

export function planTaskEnd(taskName = BILI_TASK_NAME): TaskCommand {
    return { file: "schtasks.exe", args: ["/End", "/TN", taskName] };
}

export function planTaskDisable(taskName = BILI_TASK_NAME): TaskCommand {
    return {
        file: "schtasks.exe",
        args: ["/Change", "/TN", taskName, "/DISABLE"],
    };
}

export function planTaskEnable(taskName = BILI_TASK_NAME): TaskCommand {
    return {
        file: "schtasks.exe",
        args: ["/Change", "/TN", taskName, "/ENABLE"],
    };
}

export function planTaskDelete(taskName = BILI_TASK_NAME): TaskCommand {
    return { file: "schtasks.exe", args: ["/Delete", "/TN", taskName, "/F"] };
}

export interface TaskRunnerResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export type TaskRunner = (command: TaskCommand) => Promise<TaskRunnerResult>;
