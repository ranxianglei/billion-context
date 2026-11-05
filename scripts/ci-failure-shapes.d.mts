interface TapCounts {
    pass: number;
    fail: number;
    cancelled: number;
}

type PhaseFailureVerdict =
    | { kind: "swallowed"; files: string[] }
    | { kind: "cancelled-drain"; counts: TapCounts }
    | { kind: "cleanup-lock"; locks: number }
    | { kind: "timing-window"; timing: number }
    | { kind: "concrete"; counts: TapCounts | null };

export function extractSwallowedFiles(output: string, baseToFile: Map<string, string>): string[];
export function extractTapCounts(output: string): TapCounts | null;
export function countNotOkEntries(output: string): { lock: number; timing: number; other: number };
export function classifyPhaseFailure(output: string, baseToFile: Map<string, string>): PhaseFailureVerdict;
export function describeRetryOutcome(verdict: PhaseFailureVerdict): string;
export function isMergeGateEvent(eventName: string): boolean;
export function shouldDrainPass(first: PhaseFailureVerdict, retry: PhaseFailureVerdict, eventName: string): boolean;
export function extractDrainCancelledTests(output: string): string[];
export function describeDrainPass(
    first: { kind: "cancelled-drain"; counts: TapCounts },
    retry: { kind: "cancelled-drain"; counts: TapCounts },
    cancelledTests: string[],
    eventName: string,
): string;
