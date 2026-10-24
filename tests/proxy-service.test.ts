import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
} from "../src/proxy-service/task-scheduler.ts";
import {
    disableProxyService,
    enableProxyService,
    installProxyService,
    proxyServiceStatus,
    removeProxyService,
    restartProxyService,
} from "../src/proxy-service/service.ts";
import {
    planDaemonReload,
    planSystemdEnableNow,
    planSystemdIsActive,
    planSystemdIsEnabled,
    renderSystemdUnit,
} from "../src/proxy-service/systemd.ts";
import { parseArgs } from "../src/cli.ts";

const result = (
    exitCode: number,
    stdout = "",
    stderr = "",
): TaskRunnerResult => ({ exitCode, stdout, stderr });
const taskRow =
    '<Task version="1.2"><RegistrationInfo/><Triggers/><Principals/><Settings><Enabled>true</Enabled></Settings><Actions/></Task>';

test("Task Scheduler command plans are per-user logon and safely quoted", () => {
    const vbs = renderTaskLauncherVbs({
        taskName: BILI_TASK_NAME,
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        entryPath:
            "C:\\Users\\Alice Example\\AppData\\Roaming\\npm\\node_modules\\billion-context\\dist\\index.js",
        port: 18787,
        host: "127.0.0.1",
    });
    assert.ok(vbs.includes('"C:\\Program Files\\nodejs\\node.exe"'));
    assert.ok(
        vbs.includes(
            '"C:\\Users\\Alice Example\\AppData\\Roaming\\npm\\node_modules\\billion-context\\dist\\index.js"',
        ),
    );
    assert.ok(vbs.includes("--port 18787"));
    assert.equal(
        planTaskQuery().args.join(" "),
        `/Query /TN ${BILI_TASK_NAME} /XML`,
    );
    assert.deepEqual(planTaskRun().args.slice(0, 2), ["/Run", "/TN"]);
    assert.deepEqual(planTaskEnd().args.slice(0, 2), ["/End", "/TN"]);
    assert.ok(planTaskDisable().args.includes("/DISABLE"));
    assert.ok(planTaskEnable().args.includes("/ENABLE"));
    assert.ok(planTaskDelete().args.includes("/F"));
    assert.throws(
        () =>
            renderTaskLauncherVbs({
                taskName: BILI_TASK_NAME,
                nodePath: "node.exe",
                entryPath: "C:\\bili.js",
                port: 8787,
                host: "127.0.0.1",
            }),
        /absolute/,
    );
    assert.throws(
        () =>
            renderTaskLauncherVbs({
                taskName: BILI_TASK_NAME,
                nodePath: "C:\\node.exe",
                entryPath: "C:\\bili.js",
                port: 65536,
                host: "127.0.0.1",
            }),
        /port/,
    );
});

// The proxy must never put a console window in the user's session: an unhidden
// at-logon task makes Task Scheduler create one and no child-side windowsHide
// can suppress it. These assertions pin the setting that prevents the window.
test("the registered task document is hidden and registers from XML", () => {
    const planned = planTaskRegisterXml(
        "C:\\Users\\Alice\\AppData\\Local\\bili\\task.xml",
    );
    assert.equal(planned.file, "schtasks.exe");
    assert.deepEqual(planned.args.slice(0, 2), ["/Create", "/TN"]);
    assert.ok(planned.args.includes("/XML"));
    assert.equal(
        planned.args[planned.args.indexOf("/XML") + 1],
        "C:\\Users\\Alice\\AppData\\Local\\bili\\task.xml",
    );

    const xml = renderTaskXml({
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        entryPath: "C:\\bili & sons\\dist\\index.js",
        port: 18787,
        host: "127.0.0.1",
        launcherPath: "C:\\bili & sons\\launch.vbs",
    });
    assert.ok(xml.includes("<Hidden>true</Hidden>"), "task must be hidden");
    assert.ok(
        xml.includes("<LogonType>InteractiveToken</LogonType>"),
        "must stay per-user and non-elevated",
    );
    assert.ok(xml.includes("<RunLevel>LeastPrivilege</RunLevel>"));
    assert.ok(
        xml.includes(
            "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        ),
        "a second logon must not race for the port",
    );
    // <Hidden> alone does NOT stop the console window: the scheduler launches a
    // console-subsystem node.exe in the interactive session. The action must go
    // through wscript.exe running a hidden-mode .vbs, or a window appears.
    assert.ok(
        xml.includes("<Command>wscript.exe</Command>"),
        "action must launch through the GUI-subsystem script host",
    );
    assert.ok(
        xml.includes("launch.vbs"),
        "action must reference the generated launcher",
    );
    assert.ok(
        !xml.includes("<Command>C:\\Program Files\\nodejs\\node.exe</Command>"),
        "node must never be the task action directly",
    );
    // The launcher path is the only bili path in the task document; the entry
    // path lives inside the .vbs. Ampersands must still be escaped.
    assert.ok(
        xml.includes("&quot;"),
        "the quoted launcher argument must be XML-escaped",
    );
    assert.ok(
        xml.includes("launch.vbs&quot;"),
        "escaping must not swallow the launcher path",
    );
    assert.ok(
        !xml.includes("& sons"),
        "a raw ampersand must never survive into the document",
    );
});

test("the generated launcher runs the proxy in hidden mode through WSH", () => {
    const vbs = renderTaskLauncherVbs({
        nodePath: "C:\\Program Files\\nodejs\\node.exe",
        entryPath: "C:\\bili & sons\\dist\\index.js",
        port: 18787,
        host: "127.0.0.1",
    });
    // VBScript escapes a literal quote by DOUBLING it, so the emitted source
    // carries "" around each path while the value WSH sees is a single quote.
    assert.ok(
        vbs.includes(
            'cmd = """C:\\Program Files\\nodejs\\node.exe"" ""C:\\bili & sons\\dist\\index.js"" start',
        ),
        "must invoke the proxy with doubled-quote escaping",
    );
    assert.ok(vbs.includes("--port 18787"));
    assert.ok(vbs.includes("--no-auto-update"));
    assert.ok(
        /\.Run cmd, 0, True/.test(vbs),
        "window style 0 = hidden, and True = wait so the task keeps owning the proxy",
    );
    assert.ok(
        !/\.Run cmd, 0, False/.test(vbs),
        "False reparents node away from the task and orphans it on uninstall",
    );
    assert.ok(
        vbs.includes('CreateObject("WScript.Shell")'),
        "must use the script host shell object",
    );
});

test("the launcher quoting survives a path containing quotes", () => {
    const vbs = renderTaskLauncherVbs({
        nodePath: 'C:\\odd "quoted" dir\\node.exe',
        entryPath: "C:\\plain\\index.js",
        port: 1,
        host: "127.0.0.1",
    });
    assert.ok(
        vbs.includes('""quoted""'),
        "an embedded quote must be doubled so it stays inside the VBS string literal",
    );
    assert.ok(
        vbs.includes('cmd = """C:\\odd ""quoted"" dir\\node.exe""'),
        "the whole path must remain one quoted token for WSH",
    );
});

test("service operations verify install, remain idempotent, and expose failures", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bili-service-"));
    const commands: TaskCommand[] = [];
    let exists = false;
    let disabled = false;
    let failCreate = false;
    const runner = async (command: TaskCommand): Promise<TaskRunnerResult> => {
        commands.push(command);
        if (command.args[0] === "/Query")
            return exists
                ? result(
                        0,
                        taskRow.replace(
                            "<Enabled>true",
                            disabled ? "<Enabled>false" : "<Enabled>true",
                        ),
                    )
                : result(1, "", "ERROR: The system cannot find the file specified.");
        if (command.args[0] === "/Create") {
            if (failCreate) return result(1, "", "Access is denied.");
            exists = true;
            return result(0, "SUCCESS: The scheduled task was created.");
        }
        if (command.args[0] === "/Delete") {
            const previous = exists;
            exists = false;
            return previous
                ? result(0, "SUCCESS")
                : result(1, "", "ERROR: The system cannot find the file specified.");
        }
        if (command.args[0] === "/Change" && command.args.includes("/DISABLE")) {
            disabled = true;
            return result(0, "SUCCESS");
        }
        if (command.args[0] === "/Change" && command.args.includes("/ENABLE")) {
            disabled = false;
            return result(0, "SUCCESS");
        }
        return result(0, "SUCCESS");
    };
    const config = {
        platform: "win32" as NodeJS.Platform,
        nodePath: "C:\\node.exe",
        entryPath: "C:\\bili\\dist\\index.js",
        port: 18787,
        stateDirectory: directory,
        runner,
    };
    try {
        assert.equal((await proxyServiceStatus(config)).state, "missing");
        failCreate = true;
        const refused = await installProxyService(config);
        assert.equal(refused.ok, false);
        assert.match(refused.message, /Access is denied/);
        assert.equal(
            fs.existsSync(path.join(directory, "proxy-service.json")),
            false,
        );
        failCreate = false;
        const installed = await installProxyService(config);
        assert.equal(installed.action, "installed");
        assert.equal(installed.state, "ready");
        assert.equal(
            (await installProxyService(config)).action,
            "already-installed",
        );
        assert.equal((await disableProxyService(config)).state, "disabled");
        assert.equal((await proxyServiceStatus(config)).state, "disabled");
        assert.equal((await enableProxyService(config)).state, "ready");
        assert.equal((await restartProxyService(config)).action, "restarted");
        assert.equal((await removeProxyService(config)).action, "removed");
        assert.equal((await removeProxyService(config)).action, "already-absent");
        assert.ok(commands.some((c) => c.args[0] === "/Run"));
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("install writes a persistent hidden launcher and remove deletes it", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bili-launcher-"));
    const commands: TaskCommand[] = [];
    let exists = false;
    const runner: TaskRunner = async (command) => {
        commands.push(command);
        if (command.args[0] === "/Query")
            return exists
                ? result(0, taskRow)
                : result(1, "", "ERROR: The system cannot find the file specified.");
        if (command.args[0] === "/Create") {
            exists = true;
            return result(0, "SUCCESS: The scheduled task was created.");
        }
        if (command.args[0] === "/Delete") {
            const previous = exists;
            exists = false;
            return previous
                ? result(0, "SUCCESS")
                : result(1, "", "ERROR: The system cannot find the file specified.");
        }
        return result(0);
    };
    const config = {
        platform: "win32" as NodeJS.Platform,
        nodePath: process.execPath,
        entryPath: path.join(directory, "dist", "index.js"),
        stateDirectory: directory,
        runner,
    };
    const launcher = path.join(directory, "Billion-Context-Proxy.launch.vbs");
    try {
        const installed = await installProxyService(config);
        assert.equal(installed.action, "installed");
        // The task references this file at every logon, so it must persist past
        // the install command (unlike the temporary XML transport).
        assert.ok(fs.existsSync(launcher), "launcher must persist after install");
        // Written UTF-16LE with a BOM for WSH; read it back the same way.
        const vbs = fs.readFileSync(launcher, "utf16le");
        assert.ok(vbs.includes("sh.Run cmd, 0, True"));
        // /Query also carries a bare /XML flag, so target the /Create command.
        const xmlWrite = commands.find(
            (c) => c.args[0] === "/Create" && c.args.includes("/XML"),
        );
        assert.ok(xmlWrite !== undefined, "registration must go through /XML");
        const xmlPath = xmlWrite.args[xmlWrite.args.indexOf("/XML") + 1] ?? "";
        assert.notEqual(xmlPath, "", "the XML path must be present");
        assert.equal(
            fs.existsSync(xmlPath),
            false,
            "the XML transport file must be cleaned up",
        );

        await removeProxyService(config);
        assert.equal(
            fs.existsSync(launcher),
            false,
            "uninstall must not leave a launcher pointing at a removed dist tree",
        );
        // The task is the only handle on the running proxy, so it must be stopped
        // before the task is deleted.
        const endIndex = commands.findIndex((c) => c.args[0] === "/End");
        const deleteIndex = commands.findIndex((c) => c.args[0] === "/Delete");
        assert.notEqual(endIndex, -1, "uninstall must stop the running instance");
        assert.notEqual(deleteIndex, -1, "uninstall must delete the task");
        assert.ok(
            endIndex < deleteIndex,
            "the instance must be stopped before the task handle is removed",
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("service reports unsupported platforms without touching them", async () => {
    // Windows (schtasks) and Linux (systemd user unit) are the two serviced
    // platforms; everything else must refuse rather than silently do nothing.
    const result = await installProxyService({ platform: "darwin" });
    assert.equal(result.action, "unsupported");
    assert.equal(result.ok, false);
    assert.match(result.message, /darwin/);
});

test("CLI parses service lifecycle actions", () => {
    for (const action of [
        "install",
        "status",
        "restart",
        "enable",
        "disable",
        "remove",
    ] as const) {
        const parsed = parseArgs(["service", action]);
        assert.equal(parsed.command, "service");
        assert.equal(parsed.serviceAction, action);
    }
});

test("service leaves an unowned task with the bili name untouched", async () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "bili-service-collision-"),
    );
    const commands: TaskCommand[] = [];
    const runner = async (command: TaskCommand): Promise<TaskRunnerResult> => {
        commands.push(command);
        if (command.args[0] === "/Query") return result(0, taskRow);
        return result(0, "SUCCESS");
    };
    const config = {
        platform: "win32" as NodeJS.Platform,
        nodePath: "C:\\node.exe",
        entryPath: "C:\\bili\\dist\\index.js",
        port: 18787,
        stateDirectory: directory,
        runner,
    };
    try {
        assert.equal((await proxyServiceStatus(config)).state, "unknown");
        assert.equal((await installProxyService(config)).ok, false);
        assert.equal((await disableProxyService(config)).ok, false);
        assert.equal((await enableProxyService(config)).ok, false);
        assert.equal((await restartProxyService(config)).ok, false);
        assert.equal((await removeProxyService(config)).ok, false);
        assert.equal(
            commands.filter((command) =>
                ["/Create", "/Delete", "/Change", "/End"].includes(command.args[0]!),
            ).length,
            0,
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("localized Task Scheduler missing-task output is treated as absent", async () => {
    const runner = async (): Promise<TaskRunnerResult> =>
        result(1, "", "错误: 系统找不到指定的文件。");
    const status = await proxyServiceStatus({ platform: "win32", runner });
    assert.equal(status.ok, true);
    assert.equal(status.state, "missing");
});

// ---------------------------------------------------------------------------
// Linux backend: per-user systemd unit. A fake `systemctl` keeps the whole
// lifecycle deterministic — no live bus, no root, no host mutation.
// ---------------------------------------------------------------------------

const UNIT_PATH = "/home/alice/.config/systemd/user/bili-proxy.service";

/** Minimal systemctl model: enabled/active flags plus the unit file the
 *  installer writes, so status/enable/disable/remove can be asserted against
 *  real state transitions instead of canned strings. `unitPath` must be the
 *  SAME path the config passes to the service — the fake keys its liveness off
 *  that file, exactly as systemd keys it off the unit it actually loaded. */
function fakeSystemctl(
    commands: TaskCommand[],
    initial?: { enabled?: boolean; active?: boolean; unitPath?: string },
) {
    const unitPath = initial?.unitPath ?? UNIT_PATH;
    let enabled = initial?.enabled ?? false;
    let active = initial?.active ?? false;
    const runner = async (command: TaskCommand): Promise<TaskRunnerResult> => {
        commands.push(command);
        if (command.file !== "systemctl") return result(1, "", "unexpected binary");
        const args = command.args.filter((a) => a !== "--user");
        switch (args[0]) {
            case "daemon-reload":
                return result(0, "");
            case "is-enabled":
                if (!fs.existsSync(unitPath))
                    return result(1, "", "Unit bili-proxy.service could not be found.");
                return result(0, enabled ? "enabled" : "disabled");
            case "is-active":
                if (!fs.existsSync(unitPath)) return result(3, "inactive");
                return active ? result(0, "active") : result(3, "inactive");
            case "enable":
                enabled = true;
                // `enable --now` also starts; a bare `enable` does not.
                if (command.args.includes("--now")) active = true;
                return result(0, "");
            case "disable":
                enabled = false;
                active = false;
                return result(0, "");
            case "start":
                active = true;
                return result(0, "");
            case "stop":
                active = false;
                return result(0, "");
            default:
                return result(1, "", `unknown verb ${args[0]}`);
        }
    };
    return { runner, state: () => ({ enabled, active }) };
}

test("systemd unit plans are per-user, quoted and enable at logon", () => {
    const planned = planSystemdEnableNow({ unitName: "bili-proxy.service" });
    assert.equal(planned.file, "systemctl");
    assert.deepEqual(planned.args, [
        "--user",
        "enable",
        "--now",
        "bili-proxy.service",
    ]);
    assert.deepEqual(planDaemonReload().args, ["--user", "daemon-reload"]);
    assert.deepEqual(planSystemdIsEnabled({ unitName: "u" }).args, [
        "--user",
        "is-enabled",
        "u",
    ]);
    assert.deepEqual(planSystemdIsActive({ unitName: "u" }).args, [
        "--user",
        "is-active",
        "u",
    ]);

    const unit = renderSystemdUnit({
        nodePath: "/usr/bin/node",
        entryPath: "/opt/bili path/dist/index.js",
        port: 18787,
        host: "127.0.0.1",
        unitPath: UNIT_PATH,
    });
    assert.match(unit, /^\[Unit\]/m);
    assert.match(unit, /WantedBy=default\.target/);
    assert.match(unit, /Type=simple/);
    assert.match(unit, /Restart=on-failure/);
    assert.match(unit, /--no-auto-update/);
    // The spaced entry path must survive as ONE argv element.
    assert.ok(
        unit.includes(
            'ExecStart="/usr/bin/node" "/opt/bili path/dist/index.js" start --host "127.0.0.1" --port 18787 --no-auto-update',
        ),
    );
    assert.throws(
        () =>
            renderSystemdUnit({
                nodePath: "node",
                entryPath: "/opt/bili/dist/index.js",
                port: 8787,
                unitPath: UNIT_PATH,
            }),
        /absolute/,
    );
    assert.throws(
        () =>
            renderSystemdUnit({
                nodePath: "/usr/bin/node",
                entryPath: "/opt/bili/dist/index.js",
                port: 0,
                unitPath: UNIT_PATH,
            }),
        /RangeError|port/,
    );
});

test("quotes are escaped so a path can never inject extra ExecStart arguments", () => {
    const unit = renderSystemdUnit({
        nodePath: '/usr/bin/node"',
        entryPath: "/opt/b/dist/index.js",
        port: 8787,
        unitPath: UNIT_PATH,
    });
    assert.ok(
        unit.includes('ExecStart="/usr/bin/node\\"" "/opt/b/dist/index.js"'),
    );
});

test("systemd install writes the unit, enables it, starts it and is idempotent", async () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "bili-systemd-install-"),
    );
    const commands: TaskCommand[] = [];
    const unitPath = path.join(directory, "bili-proxy.service");
    const fake = fakeSystemctl(commands, { unitPath });
    const config = {
        platform: "linux" as NodeJS.Platform,
        taskName: "bili-proxy.service",
        nodePath: "/usr/bin/node",
        entryPath: "/opt/bili/dist/index.js",
        port: 18787,
        stateDirectory: directory,
        unitPath,
        runner: fake.runner,
    };
    try {
        assert.equal((await proxyServiceStatus(config)).state, "missing");
        const installed = await installProxyService(config);
        assert.equal(installed.action, "installed");
        assert.equal(installed.state, "ready");
        assert.ok(fs.readFileSync(config.unitPath, "utf8").includes("ExecStart="));
        assert.ok(
            commands.some((c) => c.args.join(" ") === "--user daemon-reload"),
        );
        assert.ok(
            commands.some(
                (c) => c.args.join(" ") === "--user enable --now bili-proxy.service",
            ),
        );
        assert.deepEqual(fake.state(), { enabled: true, active: true });
        assert.equal((await proxyServiceStatus(config)).state, "ready");

        const again = await installProxyService(config);
        assert.equal(again.action, "already-installed");

        assert.equal((await disableProxyService(config)).state, "disabled");
        assert.deepEqual(fake.state(), { enabled: false, active: false });
        assert.equal((await proxyServiceStatus(config)).state, "disabled");

        assert.equal((await enableProxyService(config)).state, "ready");
        assert.deepEqual(fake.state(), { enabled: true, active: true });

        assert.equal((await restartProxyService(config)).action, "restarted");
        assert.equal((await removeProxyService(config)).action, "removed");
        assert.equal(fs.existsSync(config.unitPath), false);
        assert.equal((await removeProxyService(config)).action, "already-absent");
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("systemd install rolls the unit back when it never becomes active", async () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "bili-systemd-rollback-"),
    );
    const commands: TaskCommand[] = [];
    const runner = async (command: TaskCommand): Promise<TaskRunnerResult> => {
        commands.push(command);
        const args = command.args.filter((a) => a !== "--user");
        if (args[0] === "is-enabled")
            return result(1, "", "Unit bili-proxy.service could not be found.");
        if (args[0] === "is-active") return result(3, "inactive");
        return result(0, "");
    };
    const config = {
        platform: "linux" as NodeJS.Platform,
        taskName: "bili-proxy.service",
        nodePath: "/usr/bin/node",
        entryPath: "/opt/bili/dist/index.js",
        port: 18787,
        stateDirectory: directory,
        unitPath: path.join(directory, "bili-proxy.service"),
        runner,
    };
    try {
        const failed = await installProxyService(config);
        assert.equal(failed.ok, false);
        assert.match(failed.message, /did not become active/);
        // The machine is left as it was: no unit file, no record.
        assert.equal(fs.existsSync(config.unitPath), false);
        assert.equal(
            fs.existsSync(path.join(directory, "proxy-service.json")),
            false,
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test("systemd refuses a host with no user manager and names the fix", async () => {
    const runner = async (): Promise<TaskRunnerResult> =>
        result(1, "", "Failed to connect to bus: No medium found");
    const installed = await installProxyService({
        platform: "linux",
        unitPath: UNIT_PATH,
        runner,
    });
    assert.equal(installed.ok, false);
    assert.match(installed.message, /enable-linger/);
});

test("systemd leaves a unit it does not own untouched", async () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "bili-systemd-foreign-"),
    );
    const commands: TaskCommand[] = [];
    const fake = fakeSystemctl(commands, { enabled: true, active: true });
    fs.writeFileSync(path.join(directory, "bili-proxy.service"), "foreign\n");
    const config = {
        platform: "linux" as NodeJS.Platform,
        taskName: "bili-proxy.service",
        nodePath: "/usr/bin/node",
        entryPath: "/opt/bili/dist/index.js",
        port: 18787,
        stateDirectory: directory,
        unitPath: path.join(directory, "bili-proxy.service"),
        runner: fake.runner,
    };
    try {
        const refused = await installProxyService(config);
        assert.equal(refused.ok, false);
        assert.match(refused.message, /not owned by this bili copy/);
        assert.equal(fs.readFileSync(config.unitPath, "utf8"), "foreign\n");
        assert.equal(
            commands.filter((c) =>
                ["disable", "stop", "enable"].includes(
                    c.args.filter((a) => a !== "--user")[0]!,
                ),
            ).length,
            0,
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
