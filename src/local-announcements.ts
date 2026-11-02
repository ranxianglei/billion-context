// #5548 P2 lane B: local announcements — one validated record per *.json file
// under <configDir>/announcements/. The directory is re-scanned on every load;
// a result is memoized by a name:size:mtime signature so bad files log once
// per change instead of once per overview poll. A broken file never takes
// down the other files or the page (§六: any source unavailable → that source absent).
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./paths.js";
import { log } from "./logger.js";
import { validateNoticeRecord, type NoticeRecord } from "./notices.js";

export const ANNOUNCEMENTS_DIRNAME = "announcements";
export const LOCAL_FILE_CAP_BYTES = 64 * 1024; // §六.3 size cap

export interface LocalAnnouncementLoad {
    records: NoticeRecord[];
    errors: Array<{ file: string; reason: string }>;
}

function announcementsDirFor(env: NodeJS.ProcessEnv): string {
    const v = env.XDG_CONFIG_HOME;
    const base = v && v.length > 0 ? path.join(path.resolve(v), "billion-context") : configDir();
    return path.join(base, ANNOUNCEMENTS_DIRNAME);
}

let cache: { dir: string; sig: string; result: LocalAnnouncementLoad } | undefined;

export function loadLocalAnnouncements(env: NodeJS.ProcessEnv = process.env): LocalAnnouncementLoad {
    const dir = announcementsDirFor(env);
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        // no directory = zero local notices, not an error
        return { records: [], errors: [] };
    }
    const names = entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name).sort();
    const parts: string[] = [];
    const records: NoticeRecord[] = [];
    const errors: LocalAnnouncementLoad["errors"] = [];
    for (const name of names) {
        const file = path.join(dir, name);
        let st: fs.Stats;
        try {
            st = fs.statSync(file);
        } catch {
            continue; // vanished between readdir and stat
        }
        parts.push(`${name}:${st.size}:${st.mtimeMs}`);
        if (st.size > LOCAL_FILE_CAP_BYTES) {
            errors.push({ file: name, reason: `exceeds ${LOCAL_FILE_CAP_BYTES} bytes` });
            continue;
        }
        let doc: unknown;
        try {
            doc = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch (e) {
            errors.push({ file: name, reason: `bad JSON: ${String(e)}` });
            continue;
        }
        const res = validateNoticeRecord(doc);
        if (!res.ok) {
            errors.push({ file: name, reason: res.reason });
            continue;
        }
        if (res.droppedFields.length > 0) log("debug", `[notices] ${name}: dropped unknown field(s) ${res.droppedFields.join(", ")}`);
        records.push(res.rec);
    }
    const sig = parts.join("|");
    if (cache && cache.dir === dir && cache.sig === sig) return cache.result;
    if (errors.length > 0) log("warn", `[notices] local lane: ${errors.map((e) => `${e.file} (${e.reason})`).join("; ")}`);
    const result: LocalAnnouncementLoad = { records, errors };
    cache = { dir, sig, result };
    return result;
}
