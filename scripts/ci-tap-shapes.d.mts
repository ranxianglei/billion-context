export interface TapSummary {
    tests?: number;
    suites?: number;
    pass?: number;
    fail: number;
    cancelled: number;
    skipped?: number;
    todo?: number;
}

export function parseTapSummary(output: string): TapSummary | null;
export function extractSwallowedFiles(output: string, baseToFile: Map<string, string>): string[];
export function extractDrainCancelledFiles(output: string, baseToFile: Map<string, string>): string[] | null;
