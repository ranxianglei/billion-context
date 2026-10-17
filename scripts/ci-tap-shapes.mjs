// #3029/#3356: TAP output shape classifiers for the CI runner's bounded
// flake-recovery gate. Exactly TWO shapes may enter retry; anything else
// fails hard so a real regression is never masked:
//
// swallowed (#3029)        — a top-level `not ok N - <file>` whose YAML payload
//                            is only `error: 'test failed'`: the test child died
//                            SILENTLY (OOM kill, worker death, race exit under
//                            concurrency). Successful files promote their inner
//                            tests to top level by name and never emit a
//                            file-level entry, so this line can only mean death.
// drain-cancelled (#3356)  — node:test cancelled still-pending tests because the
//                            event loop drained while a promise was unresolved
//                            (win22 under load: a teardown await with zero live
//                            handles). Every not-ok entry carries
//                            `failureType: 'cancelledByParent'` AND the summary
//                            says `# fail 0` — zero real assertion failures.
// A single real assertion failure anywhere (summary fail > 0 or one non-cancel
// not-ok entry) voids both shapes -> hard fail.
//
// Pure functions, no I/O: unit-tested by tests/ci-tap-shapes.test.ts against
// fixtures modeled on real red legs (run 39024457776).

const SUMMARY_KEYS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];

// The runner's final summary block comes LAST; some suites print TAP-shaped
// text themselves (observed in red logs: `# \# tests 39`), so an exact-line
// match plus last-occurrence-wins keeps the noise from clobbering the totals.
export function parseTapSummary(output) {
    const summary = {};
    for (const key of SUMMARY_KEYS) {
        let value;
        const re = new RegExp(`^# ${key} (\\d+)\\s*$`, "gm");
        let m;
        while ((m = re.exec(output)) !== null) value = Number(m[1]);
        if (value !== undefined) summary[key] = value;
    }
    return summary.fail !== undefined && summary.cancelled !== undefined ? summary : null;
}

export function extractSwallowedFiles(output, baseToFile) {
    const lines = output.split(/\r?\n/);
    const found = new Set();
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^not ok \d+ - (.+?)\s*$/);
        if (!m) continue;
        const window = lines.slice(i, i + 20).join("\n");
        if (!/error:\s*'test failed'/.test(window)) continue;
        const base = m[1].trim().split(/[\\/]/).pop();
        const rel = baseToFile.get(base);
        if (rel) found.add(rel);
    }
    return [...found];
}

// Returns the affected file list when the output is EXACTLY the drain-cancel
// shape, otherwise null (null = "not this shape" — caller hard-fails unless
// the swallowed shape matched). An empty list means the shape matched but no
// location resolved; the caller still retries the whole phase.
export function extractDrainCancelledFiles(output, baseToFile) {
    const summary = parseTapSummary(output);
    if (!summary || summary.fail !== 0 || !(summary.cancelled > 0)) return null;
    const lines = output.split(/\r?\n/);
    const found = new Set();
    let entries = 0;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^not ok \d+ - (.+?)\s*$/);
        if (!m) continue;
        entries++;
        const window = lines.slice(i, i + 30).join("\n");
        if (!/failureType:\s*'cancelledByParent'/.test(window)) return null;
        const loc = window.match(/location:\s*'([^']+)'/);
        if (loc) {
            const base = loc[1].replace(/:\d+(:\d+)?$/, "").split(/[\\/]/).pop();
            const rel = baseToFile.get(base);
            if (rel) found.add(rel);
        }
    }
    return entries === 0 ? null : [...found];
}
