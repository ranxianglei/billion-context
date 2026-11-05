export function stripComments(src: string): string;
export function parseObjectMembers(body: string): Array<{ name: string; type: string }>;
export function extractStringSet(src: string, varName: string): string[];
export function extractConfigLeaves(configSrc: string): string[];
export function extractCliFlags(cliSrc: string): string[];
export function loadDocumentedKeys(): Set<string>;
interface ConfigSurfaceReport {
    leaves: string[];
    flags: string[];
    longFlags: string[];
    missingLeaves: string[];
    missingFlags: string[];
}
export function runChecks(): ConfigSurfaceReport;
