// #2489: deterministic usage-ledger fixtures for the trajectory-brush tests.
// Timestamps are absolute (UTC-anchored); tests pin TZ=UTC so local-time rendering is reproducible.

export const T0 = Date.parse("2026-10-01T00:00:00Z");
const MIN = 60_000;

interface TrajLine { seq: number; at: number; input: number; cached: number; }
interface TrajFold { seq: number; at: number; S: number; }
interface TrajSeamEvent { seq: number; at: number; hitPct: number; lcpBytes: number; msgIndex: number; prevMsgs: number; curMsgs: number; }
interface TrajSeam { suspects: number; missed: number; events: TrajSeamEvent[]; providerSide: { count: number; missed: number }; rewinds: { count: number; missed: number }; abortCorrelated: number; }
interface BigFixture { lines: TrajLine[]; folds: TrajFold[]; seam: TrajSeam; systemPromptTokens: number; }
interface SmallFixture { lines: TrajLine[]; folds: TrajFold[]; seam: TrajSeam; win: number; baseIn: number; }

// >1000 samples: the default view is as unreadable as a real long session (the #2489 repro).
// No contextWindow on purpose — Y-axis adaptivity of the zoomed view must be observable.
export function bigFixture(n = 1200): BigFixture {
    const lines: TrajLine[] = [];
    for (let i = 0; i < n; i++) {
        const input = 80_000 + (i % 50) * 1_000 + (i === 900 ? 400_000 : 0);
        lines.push({ seq: i + 1, at: T0 + i * MIN, input, cached: Math.round(input * 0.97) });
    }
    const folds: TrajFold[] = [100, 450, 700, 1100].map((k) => ({ seq: k + 1, at: T0 + k * MIN, S: 5_000 }));
    const seam: TrajSeam = {
        suspects: 2,
        missed: 12_345,
        events: [
            { seq: 430, at: T0 + 430 * MIN, hitPct: 42.5, lcpBytes: 9_000, msgIndex: 12, prevMsgs: 30, curMsgs: 31 },
            { seq: 800, at: T0 + 800 * MIN, hitPct: 38.2, lcpBytes: 7_500, msgIndex: 8, prevMsgs: 21, curMsgs: 22 },
        ],
        providerSide: { count: 0, missed: 0 },
        rewinds: { count: 0, missed: 0 },
        abortCorrelated: 0,
    };
    return { lines, folds, seam, systemPromptTokens: 30_000 };
}

// Small fixture that exercises every renderer branch — window ceiling line, measured baseline,
// burst-fold pixel merge ("×N"), cause bands, both seam marks — for the byte-stability golden.
export function smallFixture(): SmallFixture {
    const n = 24;
    const lines: TrajLine[] = [];
    for (let i = 0; i < n; i++) {
        const input = 50_000 + i * 1_000;
        lines.push({ seq: i + 1, at: T0 + i * MIN, input, cached: i === 0 ? 0 : Math.round(input * 0.9) });
    }
    const folds: TrajFold[] = [
        { seq: 11, at: T0 + 10 * MIN, S: 5_000 },
        { seq: 12, at: T0 + 10 * MIN, S: 3_000 },
        { seq: 19, at: T0 + 18 * MIN, S: 8_000 },
    ];
    const seam: TrajSeam = {
        suspects: 1,
        missed: 999,
        events: [
            { seq: 8, at: T0 + 7 * MIN, hitPct: 42.5, lcpBytes: 9_000, msgIndex: 12, prevMsgs: 30, curMsgs: 31 },
            { seq: 21, at: T0 + 20 * MIN, hitPct: 38.2, lcpBytes: 7_500, msgIndex: 8, prevMsgs: 21, curMsgs: 22 },
        ],
        providerSide: { count: 0, missed: 0 },
        rewinds: { count: 0, missed: 0 },
        abortCorrelated: 0,
    };
    return { lines, folds, seam, win: 200_000, baseIn: 25_000 };
}

export function seamEventsOf(seam: TrajSeam): TrajSeamEvent[] {
    return (seam.events || []).filter((e) => e && e.at > 0);
}

export function bigDetailPayload(fx: BigFixture, overrides?: { folds?: TrajFold[]; seamEvents?: TrajSeamEvent[] }): Record<string, unknown> {
    const folds = overrides?.folds ?? fx.folds;
    const seamEvents = overrides?.seamEvents ?? fx.seam.events;
    return {
        id: "big-1",
        title: "Big session",
        protocol: "anthropic",
        live: false,
        requests: fx.lines.length,
        inputTokens: 0,
        cachedTokens: 0,
        systemPromptTokens: fx.systemPromptTokens,
        contextWindow: 0,
        ledger: { lines: fx.lines, folds, seam: { ...fx.seam, events: seamEvents }, totals: {}, linesOmitted: 0 },
        blockDetails: [],
        conflicts: [],
        handoffHtml: "",
    };
}
