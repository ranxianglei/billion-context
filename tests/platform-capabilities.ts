import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function supportsFileSymlink(): boolean {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-symlink-cap-"));
    try {
        const target = path.join(root, "target");
        const link = path.join(root, "link");
        fs.writeFileSync(target, "x");
        fs.symlinkSync(target, link, "file");
        return fs.lstatSync(link).isSymbolicLink();
    } catch {
        return false;
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

export function supportsDirectorySymlink(): boolean {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bili-dir-symlink-cap-"));
    try {
        const target = path.join(root, "target");
        const link = path.join(root, "link");
        fs.mkdirSync(target);
        fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
        return fs.lstatSync(link).isSymbolicLink();
    } catch {
        return false;
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}
