import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const CODEX_DEFAULT_PROVIDER_ID = "openai";

export type ActiveCodexProvider = {
    id: string;
    explicit: boolean;
    sectionExists: boolean;
    name?: string;
    baseUrl: string;
    wireApi: string;
    requiresOpenaiAuth: boolean;
    supportsWebsockets: boolean;
    configPath: string;
};

export type ProviderFieldValue = string | boolean;

type Line = {
    start: number;
    contentEnd: number;
    end: number;
    content: string;
    eol: string;
};

type Assignment = {
    value: ProviderFieldValue;
    encoded: string;
    start: number;
    end: number;
    lineStart: number;
    lineEnd: number;
};

export type ProviderFieldSnapshot = {
    value: ProviderFieldValue;
    encoded: string;
};

type Section = {
    id: string;
    headerStart: number;
    bodyStart: number;
    end: number;
};

const BUILTIN_PROVIDERS: Record<string, Omit<ActiveCodexProvider, "id" | "explicit" | "sectionExists" | "configPath">> = {
    openai: {
        name: "OpenAI",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        wireApi: "responses",
        requiresOpenaiAuth: true,
        supportsWebsockets: true,
    },
};

function linesOf(text: string): Line[] {
    const lines: Line[] = [];
    const re = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
    for (;;) {
        const match = re.exec(text);
        if (!match || match[0] === "") break;
        const raw = match[0];
        const eol = raw.match(/(\r\n|\r|\n)$/)?.[1] ?? "";
        const content = eol ? raw.slice(0, -eol.length) : raw;
        lines.push({
            start: match.index,
            contentEnd: match.index + content.length,
            end: match.index + raw.length,
            content,
            eol,
        });
        if (match.index + raw.length >= text.length) break;
    }
    return lines;
}

function preferredEol(text: string): string {
    return text.match(/\r\n|\r|\n/)?.[0] ?? (process.platform === "win32" ? "\r\n" : "\n");
}

function parseTomlString(raw: string): string | undefined {
    if (raw.startsWith("\"") && raw.endsWith("\"")) {
        try {
            const parsed = JSON.parse(raw) as unknown;
            return typeof parsed === "string" ? parsed : undefined;
        } catch {
            return undefined;
        }
    }
    if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
    return undefined;
}

function parseProviderId(raw: string): string | undefined {
    const trimmed = raw.trim();
    const quoted = parseTomlString(trimmed);
    if (quoted !== undefined) return quoted;
    return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : undefined;
}

function sections(text: string): Section[] {
    const found: Section[] = [];
    const lines = linesOf(text);
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const match = line.content.match(/^\s*\[\s*model_providers\s*\.\s*("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)\s*\]\s*(?:#.*)?$/);
        if (!match) continue;
        const id = parseProviderId(match[1]!);
        if (!id) continue;
        let end = text.length;
        for (let next = index + 1; next < lines.length; next++) {
            if (/^\s*\[/.test(lines[next].content)) {
                end = lines[next].start;
                break;
            }
        }
        found.push({ id, headerStart: line.start, bodyStart: line.end, end });
    }
    return found;
}

function assignmentInRange(text: string, key: string, start: number, end: number): Assignment | undefined {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^(\\s*${escaped}\\s*=\\s*)(\"(?:\\\\.|[^\"\\\\])*\"|'[^']*'|true|false)(\\s*(?:#.*)?)$`);
    for (const line of linesOf(text)) {
        if (line.start < start || line.start >= end) continue;
        const match = line.content.match(pattern);
        if (!match) continue;
        const raw = match[2]!;
        const value = raw === "true" ? true : raw === "false" ? false : parseTomlString(raw);
        if (value === undefined) continue;
        const valueStart = line.start + match[1]!.length;
        return {
            value,
            encoded: raw,
            start: valueStart,
            end: valueStart + raw.length,
            lineStart: line.start,
            lineEnd: line.end,
        };
    }
    return undefined;
}

function rootAssignment(text: string, key: string): Assignment | undefined {
    const firstSection = linesOf(text).find((line) => /^\s*\[/.test(line.content));
    return assignmentInRange(text, key, 0, firstSection?.start ?? text.length);
}

function sectionFor(text: string, providerId: string): Section | undefined {
    return sections(text).find((section) => section.id === providerId);
}

function fieldFor(text: string, providerId: string, key: string): Assignment | undefined {
    const section = sectionFor(text, providerId);
    return section ? assignmentInRange(text, key, section.bodyStart, section.end) : undefined;
}

function encodeValue(value: ProviderFieldValue): string {
    return typeof value === "boolean" ? String(value) : JSON.stringify(value);
}

export function codexConfigFile(env: NodeJS.ProcessEnv = process.env): string {
    const codexHome = env.CODEX_HOME?.trim();
    return path.join(codexHome ? path.resolve(codexHome) : path.join(homedir(), ".codex"), "config.toml");
}

export function readCodexConfig(configPath: string = codexConfigFile()): string {
    return existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
}

export function resolveActiveCodexProvider(configPath: string = codexConfigFile()): ActiveCodexProvider {
    const text = readCodexConfig(configPath);
    const providerAssignment = rootAssignment(text, "model_provider");
    if (providerAssignment && typeof providerAssignment.value !== "string") {
        throw new Error("Codex model_provider is not a string");
    }
    const explicit = typeof providerAssignment?.value === "string";
    const id = explicit ? providerAssignment.value as string : CODEX_DEFAULT_PROVIDER_ID;
    const section = sectionFor(text, id);
    const builtin = BUILTIN_PROVIDERS[id];
    if (!section && !builtin) {
        throw new Error(`cannot safely resolve active Codex provider \"${id}\": [model_providers.${id}] is missing`);
    }

    const stringField = (key: string, fallback?: string): string | undefined => {
        const assignment = fieldFor(text, id, key);
        if (assignment && typeof assignment.value !== "string") {
            throw new Error(`Codex provider \"${id}\" has a non-string ${key}`);
        }
        return typeof assignment?.value === "string" ? assignment.value : fallback;
    };
    const boolField = (key: string, fallback: boolean): boolean => {
        const assignment = fieldFor(text, id, key);
        if (assignment && typeof assignment.value !== "boolean") {
            throw new Error(`Codex provider \"${id}\" has a non-boolean ${key}`);
        }
        return typeof assignment?.value === "boolean" ? assignment.value : fallback;
    };
    const baseUrl = stringField("base_url", builtin?.baseUrl)?.replace(/\/+$/, "");
    const wireApi = stringField("wire_api", builtin?.wireApi);
    const requiresOpenaiAuth = boolField("requires_openai_auth", builtin?.requiresOpenaiAuth ?? false);
    const supportsWebsockets = boolField("supports_websockets", builtin?.supportsWebsockets ?? false);
    if (!baseUrl || !wireApi) {
        throw new Error(`cannot safely resolve active Codex provider \"${id}\": base_url/wire_api fields are incomplete`);
    }
    let parsed: URL;
    try {
        parsed = new URL(baseUrl);
    } catch {
        throw new Error(`Codex provider \"${id}\" has an invalid base_url`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`Codex provider \"${id}\" base_url must use http:// or https://`);
    }
    if (parsed.search || parsed.hash) {
        throw new Error(`Codex provider \"${id}\" base_url cannot contain a query string or fragment`);
    }
    return {
        id,
        explicit,
        sectionExists: !!section,
        name: stringField("name", builtin?.name),
        baseUrl,
        wireApi,
        requiresOpenaiAuth,
        supportsWebsockets,
        configPath,
    };
}

export function getCodexProviderField(text: string, providerId: string, key: string): ProviderFieldValue | undefined {
    return fieldFor(text, providerId, key)?.value;
}

export function getCodexProviderFieldSnapshot(
    text: string,
    providerId: string,
    key: string,
): ProviderFieldSnapshot | undefined {
    const field = fieldFor(text, providerId, key);
    return field ? { value: field.value, encoded: field.encoded } : undefined;
}

export function setCodexProviderField(
    text: string,
    providerId: string,
    key: string,
    value: ProviderFieldValue,
): { text: string; added: boolean } {
    const existing = fieldFor(text, providerId, key);
    if (existing) {
        return {
            text: text.slice(0, existing.start) + encodeValue(value) + text.slice(existing.end),
            added: false,
        };
    }
    const section = sectionFor(text, providerId);
    if (!section) throw new Error(`Codex provider section \"${providerId}\" is missing`);
    const eol = preferredEol(text);
    const prefix = section.end > 0 && !/(?:\r\n|\r|\n)$/.test(text.slice(0, section.end)) ? eol : "";
    const line = `${key} = ${encodeValue(value)}${eol}`;
    return { text: text.slice(0, section.end) + prefix + line + text.slice(section.end), added: true };
}

export function restoreCodexProviderField(
    text: string,
    providerId: string,
    key: string,
    snapshot: ProviderFieldSnapshot,
): string {
    const existing = fieldFor(text, providerId, key);
    if (!existing) throw new Error(`Codex provider field \"${providerId}.${key}\" is missing`);
    return text.slice(0, existing.start) + snapshot.encoded + text.slice(existing.end);
}

export function removeCodexProviderField(text: string, providerId: string, key: string): string {
    const existing = fieldFor(text, providerId, key);
    return existing ? text.slice(0, existing.lineStart) + text.slice(existing.lineEnd) : text;
}

export function getTopLevelField(text: string, key: string): ProviderFieldValue | undefined {
    return rootAssignment(text, key)?.value;
}

export function getTopLevelFieldSnapshot(text: string, key: string): ProviderFieldSnapshot | undefined {
    const assignment = rootAssignment(text, key);
    return assignment ? { value: assignment.value, encoded: assignment.encoded } : undefined;
}

export function setTopLevelField(
    text: string,
    key: string,
    value: ProviderFieldValue,
): { text: string; added: boolean } {
    const existing = rootAssignment(text, key);
    if (existing) {
        return {
            text: text.slice(0, existing.start) + encodeValue(value) + text.slice(existing.end),
            added: false,
        };
    }
    const eol = preferredEol(text);
    const firstSection = linesOf(text).find((line) => /^\s*\[/.test(line.content));
    const insertAt = firstSection?.start ?? text.length;
    const prefix = insertAt > 0 && !/(?:\r\n|\r|\n)$/.test(text.slice(0, insertAt)) ? eol : "";
    const line = `${key} = ${encodeValue(value)}${eol}`;
    return { text: text.slice(0, insertAt) + prefix + line + text.slice(insertAt), added: true };
}

export function restoreTopLevelField(
    text: string,
    key: string,
    snapshot: ProviderFieldSnapshot,
): string {
    const existing = rootAssignment(text, key);
    if (!existing) throw new Error(`Top-level field "${key}" is missing`);
    return text.slice(0, existing.start) + snapshot.encoded + text.slice(existing.end);
}

export function removeTopLevelField(text: string, key: string): string {
    const existing = rootAssignment(text, key);
    return existing ? text.slice(0, existing.lineStart) + text.slice(existing.lineEnd) : text;
}

export function appendCodexProviderSection(
    text: string,
    providerId: string,
    fields: Record<string, ProviderFieldValue>,
): string {
    if (sectionFor(text, providerId)) throw new Error(`Codex provider section \"${providerId}\" already exists`);
    const eol = preferredEol(text);
    const separator = text.length === 0 ? "" : /(?:\r\n|\r|\n)$/.test(text) ? eol : eol + eol;
    const body = Object.entries(fields).map(([key, value]) => `${key} = ${encodeValue(value)}`).join(eol);
    return `${text}${separator}[model_providers.${providerId}]${eol}${body}${eol}`;
}

export function removeCodexProviderSectionIfEmpty(text: string, providerId: string): string {
    const section = sectionFor(text, providerId);
    if (!section) return text;
    const body = text.slice(section.bodyStart, section.end);
    const meaningful = body.split(/\r\n|\r|\n/).some((line) => {
        const trimmed = line.trim();
        return trimmed.length > 0;
    });
    if (meaningful) return text;
    return text.slice(0, section.headerStart) + text.slice(section.end);
}

export function removeCodexProviderSectionWithPrefixIfEmpty(
    text: string,
    providerId: string,
    prefixLength: number,
): string {
    const section = sectionFor(text, providerId);
    if (!section) return text;
    const withoutSection = removeCodexProviderSectionIfEmpty(text, providerId);
    if (withoutSection === text) return text;
    const start = Math.max(0, section.headerStart - prefixLength);
    return text.slice(0, start) + text.slice(section.end);
}
