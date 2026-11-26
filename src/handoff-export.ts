import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UNSAFE_ID_CHARS = /[^A-Za-z0-9._-]/g;

/** #7233: keep the browser download's filename scheme exactly. */
export function handoffExportName(sessionId: string): string {
    return `billion-context-handoff-${String(sessionId).replace(UNSAFE_ID_CHARS, "_")}.md`;
}

/** Pick the first free name, using the browser's ` (n)` duplicate convention. */
export function uniqueHandoffPath(
    dir: string,
    sessionId: string,
    exists: (candidate: string) => boolean = fs.existsSync,
): string {
    const name = handoffExportName(sessionId);
    const first = path.join(dir, name);
    if (!exists(first)) return first;

    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; n < 10_000; n++) {
        const candidate = path.join(dir, `${stem} (${n})${ext}`);
        if (!exists(candidate)) return candidate;
    }
    throw new Error("too many handoff exports for this session");
}

/** Downloads is the destination the existing button used; keep it. */
function defaultDownloadsDir(): string {
    if (process.platform === "linux") {
        try {
            // Respect XDG user dirs when the desktop has localized Downloads.
            const dir = execFileSync("xdg-user-dir", ["DOWNLOADS"], {
                encoding: "utf8",
                timeout: 1000,
            }).trim();
            if (dir && dir !== os.homedir()) return dir;
        } catch {
            // xdg-user-dir is optional; fall back to the conventional path.
        }
    }
    return path.join(os.homedir(), "Downloads");
}

export function revealCommand(filePath: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
    if (platform === "win32") return { command: "explorer.exe", args: [`/select,${filePath}`] };
    if (platform === "darwin") return { command: "open", args: ["-R", filePath] };
    return { command: "xdg-open", args: [path.dirname(filePath)] };
}

/** Best-effort: a headless/permission failure must not turn a saved file into an error. */
export function revealInFileManager(filePath: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const { command, args } = revealCommand(filePath, platform);
            const child = spawn(command, args, { detached: true, stdio: "ignore" });
            // A spawn failure (ENOENT on a headless host) must not surface as an
            // unhandled 'error' event, and the caller needs the truth for its toast.
            child.once("error", () => resolve(false));
            child.once("spawn", () => {
                child.unref();
                resolve(true);
            });
        } catch {
            resolve(false);
        }
    });
}

/** Write the same Markdown the browser used to download, then return its path. */
export function writeHandoffExport(
    sessionId: string,
    markdown: string,
    dir: string = defaultDownloadsDir(),
): string {
    fs.mkdirSync(dir, { recursive: true });
    const name = handoffExportName(sessionId);
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 0; n < 10_000; n++) {
        const filePath = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
        let fd: number;
        try {
            // "wx" makes name reservation and creation one atomic operation, so
            // concurrent exports of the same session cannot overwrite each other.
            fd = fs.openSync(filePath, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
            throw error;
        }
        try {
            fs.writeFileSync(fd, markdown, "utf8");
        } catch (error) {
            fs.closeSync(fd);
            fs.rmSync(filePath, { force: true });
            throw error;
        }
        fs.closeSync(fd);
        return filePath;
    }
    throw new Error("too many handoff exports for this session");
}
