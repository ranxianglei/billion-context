import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dataDir } from "./paths.js";
import { codexConfigFile, readCodexConfig, resolveActiveCodexProvider } from "./codex-provider.js";

export const LEGACY_BILI_CODEX_PROVIDER_IDS = ["billion-context-codex", "bili_chatgpt"] as const;

export type CodexHistoryPreview = {
    targetProviderId: string;
    sourceProviderIds: string[];
    jsonlFiles: number;
    sessions: number;
    stateRows: number;
    stateDbSupported: boolean;
    stateDbError?: string;
};

export type CodexHistoryRepairResult = CodexHistoryPreview & {
    backupPath: string;
    migratedJsonlFiles: number;
    migratedStateRows: number;
};

type SessionFile = {
    path: string;
    relative: string;
    matches: number;
    size: number;
    mtimeMs: number;
    mode: number;
};

type SqliteModule = typeof import("node:sqlite");
type SqliteDatabase = import("node:sqlite").DatabaseSync;

function codexHome(configPath: string): string {
    return path.dirname(configPath);
}

function collectJsonlFiles(root: string, current: string = root, depth: number = 0): string[] {
    if (depth > 10 || !existsSync(current)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(current, { withFileTypes: true })) {
        const filePath = path.join(current, entry.name);
        if (entry.isDirectory()) out.push(...collectJsonlFiles(root, filePath, depth + 1));
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(filePath);
    }
    return out;
}

function legacySessionMeta(line: string): boolean {
    if (!line.includes('"session_meta"') || !line.includes('"model_provider"')) return false;
    try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.type !== "session_meta" || !value.payload || typeof value.payload !== "object") return false;
        const provider = (value.payload as Record<string, unknown>).model_provider;
        return typeof provider === "string" && (LEGACY_BILI_CODEX_PROVIDER_IDS as readonly string[]).includes(provider);
    } catch {
        return false;
    }
}

function sessionFiles(configPath: string): SessionFile[] {
    const root = codexHome(configPath);
    const files = [
        ...collectJsonlFiles(path.join(root, "sessions")),
        ...collectJsonlFiles(path.join(root, "archived_sessions")),
    ];
    return files.flatMap((filePath) => {
        const before = statSync(filePath);
        const matches = readFileSync(filePath, "utf8").split(/\r\n|\r|\n/).filter(legacySessionMeta).length;
        const after = statSync(filePath);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            throw new Error(`Codex session file changed while being inspected: ${filePath}`);
        }
        return matches > 0 ? [{
            path: filePath,
            relative: path.relative(root, filePath),
            matches,
            size: after.size,
            mtimeMs: after.mtimeMs,
            mode: after.mode,
        }] : [];
    });
}

function parseTopLevelString(configText: string, key: string): string | undefined {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const line of configText.split(/\r\n|\r|\n/)) {
        if (/^\s*\[/.test(line)) break;
        const match = line.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(\"(?:\\\\.|[^\"\\\\])*\"|'[^']*')\\s*(?:#.*)?$`));
        if (!match) continue;
        if (match[1]!.startsWith("'")) return match[1]!.slice(1, -1);
        try {
            const value = JSON.parse(match[1]!) as unknown;
            return typeof value === "string" ? value : undefined;
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function resolveUserPath(value: string): string {
    if (value === "~") return homedir();
    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return path.join(homedir(), value.slice(2));
    }
    return path.resolve(value);
}

function stateDbPaths(configPath: string): string[] {
    const home = codexHome(configPath);
    const paths = [path.join(home, "state_5.sqlite")];
    const configText = readCodexConfig(configPath);
    const configured = parseTopLevelString(configText, "sqlite_home");
    const environment = process.env.CODEX_SQLITE_HOME?.trim();
    const extra = configured ?? environment;
    if (extra) {
        const candidate = path.join(resolveUserPath(extra), "state_5.sqlite");
        if (!paths.includes(candidate)) paths.push(candidate);
    }
    return paths.filter(existsSync);
}

async function sqliteModule(): Promise<SqliteModule> {
    return await import("node:sqlite");
}

function hasProviderColumn(database: SqliteDatabase): boolean {
    return database.prepare("PRAGMA table_info(threads)").all().some((row) => row.name === "model_provider");
}

function placeholders(count: number): string {
    return Array.from({ length: count }, () => "?").join(",");
}

async function countStateRows(configPath: string): Promise<{ count: number; supported: boolean; error?: string }> {
    const dbPaths = stateDbPaths(configPath);
    if (dbPaths.length === 0) return { count: 0, supported: true };
    let sqlite: SqliteModule;
    try {
        sqlite = await sqliteModule();
    } catch (error) {
        return { count: 0, supported: false, error: `state DB repair requires a Node runtime with node:sqlite: ${String(error)}` };
    }
    let count = 0;
    try {
        for (const dbPath of dbPaths) {
            const database = new sqlite.DatabaseSync(dbPath);
            try {
                database.exec("PRAGMA busy_timeout = 5000");
                if (!hasProviderColumn(database)) continue;
                const row = database.prepare(
                    `SELECT COUNT(*) AS count FROM threads WHERE model_provider IN (${placeholders(LEGACY_BILI_CODEX_PROVIDER_IDS.length)})`,
                ).get(...LEGACY_BILI_CODEX_PROVIDER_IDS);
                const value = row?.count;
                if (typeof value === "number") count += value;
                else if (typeof value === "bigint") count += Number(value);
            } finally {
                database.close();
            }
        }
        return { count, supported: true };
    } catch (error) {
        return { count, supported: false, error: String(error) };
    }
}

export async function previewLegacyCodexHistory(configPath: string = codexConfigFile()): Promise<CodexHistoryPreview> {
    const provider = resolveActiveCodexProvider(configPath);
    const files = sessionFiles(configPath);
    const state = await countStateRows(configPath);
    return {
        targetProviderId: provider.id,
        sourceProviderIds: [...LEGACY_BILI_CODEX_PROVIDER_IDS],
        jsonlFiles: files.length,
        sessions: files.reduce((sum, file) => sum + file.matches, 0),
        stateRows: state.count,
        stateDbSupported: state.supported,
        ...(state.error ? { stateDbError: state.error } : {}),
    };
}

function assertSessionFileUnchanged(file: SessionFile): void {
    const current = statSync(file.path);
    if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) {
        throw new Error(`Codex session file changed during repair: ${file.path}`);
    }
}

function rewriteSessionFile(file: SessionFile, targetProviderId: string): boolean {
    assertSessionFileUnchanged(file);
    const before = readFileSync(file.path, "utf8");
    assertSessionFileUnchanged(file);
    const eol = before.includes("\r\n") ? "\r\n" : "\n";
    const endsWithEol = /(?:\r\n|\r|\n)$/.test(before);
    let changed = false;
    const lines = before.split(/\r\n|\r|\n/);
    if (endsWithEol) lines.pop();
    const after = lines.map((line) => {
        if (!legacySessionMeta(line)) return line;
        const value = JSON.parse(line) as Record<string, unknown>;
        const payload = value.payload as Record<string, unknown>;
        payload.model_provider = targetProviderId;
        changed = true;
        return JSON.stringify(value);
    }).join(eol) + (endsWithEol ? eol : "");
    if (!changed) return false;
    const tempPath = `${file.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(tempPath, after, { encoding: "utf8", mode: file.mode });
        assertSessionFileUnchanged(file);
        renameSync(tempPath, file.path);
    } catch (error) {
        rmSync(tempPath, { force: true });
        throw error;
    }
    return true;
}

function stateBackupPath(backupPath: string, configPath: string, dbPath: string): string {
    const root = codexHome(configPath);
    const relative = path.relative(root, dbPath);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
        return path.join(backupPath, "state", relative);
    }
    const digest = createHash("sha256").update(path.resolve(dbPath)).digest("hex").slice(0, 16);
    return path.join(backupPath, "state", `external-${digest}`, path.basename(dbPath));
}

export async function repairLegacyCodexHistory(configPath: string = codexConfigFile()): Promise<CodexHistoryRepairResult> {
    const preview = await previewLegacyCodexHistory(configPath);
    if (!preview.stateDbSupported) throw new Error(preview.stateDbError ?? "Codex state DB cannot be repaired safely");
    const files = sessionFiles(configPath);
    const databases = stateDbPaths(configPath);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(dataDir(), "backups", "codex-history-repair", stamp);
    mkdirSync(backupPath, { recursive: true });
    for (const file of files) {
        assertSessionFileUnchanged(file);
        const destination = path.join(backupPath, "jsonl", file.relative);
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(file.path, destination);
        assertSessionFileUnchanged(file);
    }
    const sqlite = databases.length > 0 ? await sqliteModule() : undefined;
    const opened: Array<{ database: SqliteDatabase; path: string }> = [];
    try {
        if (sqlite) {
            for (const dbPath of databases) {
                const database = new sqlite.DatabaseSync(dbPath);
                opened.push({ database, path: dbPath });
                database.exec("PRAGMA busy_timeout = 5000");
                const destination = stateBackupPath(backupPath, configPath, dbPath);
                mkdirSync(path.dirname(destination), { recursive: true });
                await sqlite.backup(database, destination);
            }
        }
        let migratedJsonlFiles = 0;
        for (const file of files) if (rewriteSessionFile(file, preview.targetProviderId)) migratedJsonlFiles++;
        let migratedStateRows = 0;
        for (const entry of opened) {
            if (!hasProviderColumn(entry.database)) continue;
            entry.database.exec("BEGIN IMMEDIATE");
            try {
                const result = entry.database.prepare(
                    `UPDATE threads SET model_provider = ? WHERE model_provider IN (${placeholders(LEGACY_BILI_CODEX_PROVIDER_IDS.length)})`,
                ).run(preview.targetProviderId, ...LEGACY_BILI_CODEX_PROVIDER_IDS);
                migratedStateRows += Number(result.changes);
                entry.database.exec("COMMIT");
            } catch (error) {
                entry.database.exec("ROLLBACK");
                throw error;
            }
        }
        return { ...preview, backupPath, migratedJsonlFiles, migratedStateRows };
    } catch (error) {
        throw new Error(`Codex history repair stopped; backups are at ${backupPath}: ${String(error)}`, { cause: error });
    } finally {
        for (const entry of opened) entry.database.close();
        if (files.length === 0 && databases.length === 0) rmSync(backupPath, { recursive: true, force: true });
    }
}
