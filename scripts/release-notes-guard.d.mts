interface ReleaseNotesEntry {
    version: string;
    date?: string;
    tier: "routine" | "recommended" | "critical";
    summary: string;
}

interface ReleaseNotesPayload {
    schema: 1;
    updated?: string;
    releases: ReleaseNotesEntry[];
}

export function validateReleaseNotesPayload(payload: unknown): string[];
