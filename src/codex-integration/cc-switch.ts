import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CcSwitchMode = "direct" | "routing" | "aggregation" | "unknown";

export interface CcSwitchDetection {
    discovered: boolean;
    mode: CcSwitchMode;
    compatibility: "unsupported" | "config-route-only";
    evidence: string[];
    detail: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function modeValue(root: unknown): string | undefined {
    const row = object(root);
    if (!row) return undefined;
    const apps = object(row.apps);
    const codex = object(row.codex) ?? object(apps?.codex);
    const values = [
        row.mode,
        row.proxyMode,
        row.routingMode,
        codex?.mode,
        codex?.proxyMode,
    ];
    for (const candidate of values) {
        if (typeof candidate === "string")
            return candidate.trim().toLowerCase().replace(/[ _]/g, "-");
    }
    return undefined;
}

function normalizeMode(value: string | undefined): CcSwitchMode {
    if (value === "direct" || value === "direct-mode") return "direct";
    if (value === "routing" || value === "routing-mode" || value === "proxy")
        return "routing";
    if (
        value === "aggregation" ||
        value === "aggregator" ||
        value === "aggregation-mode"
    )
        return "aggregation";
    return "unknown";
}

export function detectCcSwitchFromText(
    settingsText?: string,
    liveStateText?: string,
): CcSwitchDetection {
    const evidence: string[] = [];
    let mode: CcSwitchMode = "unknown";
    for (const [label, text] of [
        ["settings.json", settingsText],
        ["live-state.json", liveStateText],
    ] as const) {
        if (text === undefined) continue;
        evidence.push(label);
        try {
            const parsed: unknown = JSON.parse(text);
            const found = normalizeMode(modeValue(parsed));
            if (found !== "unknown") mode = found;
        } catch {
            return {
                discovered: true,
                mode: "unknown",
                compatibility: "unsupported",
                evidence,
                detail: `${label} exists but is not valid JSON; bili did not modify it`,
            };
        }
    }
    if (evidence.length === 0)
        return {
            discovered: false,
            mode: "unknown",
            compatibility: "unsupported",
            evidence,
            detail: "CC Switch was not detected",
        };
    return {
        discovered: true,
        mode,
        compatibility: mode === "direct" ? "config-route-only" : "unsupported",
        evidence,
        detail:
            mode === "unknown"
                ? "CC Switch state was found but its Codex mode is not recognized; discovery is not proof of routing compatibility"
                : mode === "direct"
                    ? "CC Switch Direct can use a reversible route on the active Codex provider base_url; provider-database synchronization is not integrated"
                    : `CC Switch reports ${mode} mode; bili does not rewrite its provider state and has no coordination interface, so this is not a compatibility claim`,
    };
}

export function detectCcSwitch(home = os.homedir()): CcSwitchDetection {
    const root = path.join(home, ".cc-switch");
    const files = ["settings.json", "live-state.json"];
    const contents: Array<string | undefined> = files.map((name) => {
        try {
            return fs.readFileSync(path.join(root, name), "utf8");
        } catch {
            return undefined;
        }
    });
    return detectCcSwitchFromText(contents[0], contents[1]);
}

export function isProxyManagedCredential(value: string): boolean {
    return (
        value
            .trim()
            .replace(/^Bearer\s+/i, "")
            .trim()
            .toUpperCase() === "PROXY_MANAGED"
    );
}
