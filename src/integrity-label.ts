/**
 * #5154: NTFS mandatory integrity labels — the EPERM-on-startup class.
 *
 * A node.exe that carries a Low (or Untrusted) integrity label — usually
 * INHERITED from a parent directory once labeled "Low (OI)(CI)", e.g. by a
 * stray `icacls <dir> /setintegritylevel "(OI)(CI)Low" /T` — cannot write
 * Medium-labeled files, no matter how correct the ACLs look: Windows
 * integrity control (MIC No-Write-Up) refuses the write with EPERM before
 * ACLs are even consulted. Every startup-time write (CA bundle rebuild,
 * index.db, session envelopes) then fails, which reproduced the whole #5096
 * crash loop with "no visible cause" — the label survives reboots and is
 * invisible to every ACL check users normally run.
 *
 * The remedy runs in the OPPOSITE direction from relabeling data files Low:
 * restore the RUNTIME (node.exe) to Medium. A parent dir polluted with an
 * inheriting Low label is fixed at the dir ROOT only — no /T — because
 * children then inherit "(no label)" and converge (#5154 A/B repro).
 *
 * icacls itself must be invoked by ABSOLUTE path: PATH resolution of icacls
 * fails under some PowerShell/cmd profiles (#5154 field report), exactly on
 * the machines that need the check.
 */
import { execFile } from "node:child_process";
import { log as loggerLog } from "./logger.js";

const ICACLS_ABSOLUTE = "C:\\Windows\\System32\\icacls.exe";

/** Parse `icacls <file>` stdout for the file's mandatory label. icacls prints
 *  the SACL as a line like `Mandatory Label\Low Mandatory Level:(NW)` (and
 *  omits the line entirely for "(no label)"). Case-insensitive: icacls
 *  output casing has varied across Windows versions. */
export function parseIcaclsMandatoryLabel(stdout: string): string | undefined {
    const m = /mandatory label\\(untrusted|low|medium|high|system) mandatory level/i.exec(stdout);
    return m ? m[1].toLowerCase() : undefined;
}

/** #5154 startup self-check: probe THIS process's runtime for a Low/Untrusted
 *  integrity label and say it out loud. Fire-and-forget — the probe NEVER
 *  gates startup (issue asks for a loud warn, not a stop), and any failure of
 *  the probe itself stays silent: this is observability, not a gate. The warn
 *  reaches both log surfaces (tee file + stderr), so #5097's failure page and
 *  the launcher's stderr sampling both surface it even when a later write
 *  failure kills the process. */
export function warnIfLowIntegrityRuntime(): void {
    if (process.platform !== "win32") return;
    const icacls = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\icacls.exe` : ICACLS_ABSOLUTE;
    execFile(icacls, [process.execPath], { windowsHide: true, timeout: 10_000 }, (err, stdout) => {
        if (err) return;
        const label = parseIcaclsMandatoryLabel(String(stdout));
        if (label !== "low" && label !== "untrusted") return;
        loggerLog(
            "warn",
            `[integrity] this Node runtime carries a ${label.toUpperCase()} NTFS mandatory-integrity label (${process.execPath}) — a ${label}-integrity process cannot write Medium-labeled files, so startup-time writes (CA bundle, index.db) fail EPERM while every ACL looks correct (#5154, the #5096 crash-loop class). Fix: icacls "${process.execPath}" /setintegritylevel Medium (verify with icacls "${process.execPath}"). If the label came back inherited ("(I)" marker), a parent dir labeled "Low (OI)(CI)" re-applies it to every file placed inside — restore the dir root only: icacls "<dir>" /setintegritylevel Medium, no /T needed; children converge to (no label). See CONFIGURATION.md "Windows: node runtime labeled Low".`,
        );
    });
}

/** #5103/#5154: "failed to start" with only the raw error dump left users
 *  digging through %TEMP% logs for hours — an EPERM/EACCES here is an
 *  OS-level write refusal, so say what class it is and where the fix usually
 *  lives, before exiting. Integrity-label check FIRST (#5154: it was the real
 *  switch in the field repro; AV exclusions second), because ACL checks all
 *  pass in that class and the AV detour costs the most hours. */
export function startupFailureHints(err: unknown): string | undefined {
    const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "EPERM" || code === "EACCES") {
        return [
            "bili: startup failed because the OS refused a file operation (a permission/lock issue, not a code fault):",
            '      - Windows: check the Node runtime\'s integrity label FIRST — icacls "<path-to-node.exe>"; a Low label makes every write to Medium-labeled files fail EPERM while ACLs look correct (#5154). Fix: icacls "<path-to-node.exe>" /setintegritylevel Medium.',
            "      - Windows: exclude %USERPROFILE%\\.local\\share\\billion-context\\ from antivirus/Defender real-time scanning (CONFIGURATION.md, AV exclusions); OneDrive placeholder files under the profile dir cause the same refusal (#3823).",
            "      - Transient boot-time lockers clear on their own — retrying after a minute often succeeds.",
        ].join("\n");
    }
    return undefined;
}
