// #5706: the opencode plugin entries run INSIDE the opencode host process,
// where stdout/stderr IS the interactive TUI terminal — a raw console.* write
// lands on the physical screen on every startup and cannot be silenced
// (host-log.ts contract; #2827/#2831 moved every other native lane onto
// logHostEvent, which writes bili.log only). These two files are the last
// opencode entries that still printed their v1 bootstrap on the terminal.
// Pin both directions (#3617 gate discipline): no raw console.* call may
// remain in either file, AND every relocated diagnostic must still exist —
// riding logHostEvent — so a "fix" cannot just delete the line.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CONSOLE_CALL = /console\.(log|info|warn|error)\s*\(/;

function entryLines(file: string): string[] {
    return readFileSync(new URL(`../src/agent/${file}`, import.meta.url), "utf8").split("\n");
}

function assertNoRawConsole(file: string, lines: string[]): void {
    for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*")) continue;
        assert.doesNotMatch(t, CONSOLE_CALL, `${file}: raw console.* reaches the host TUI terminal — route it through logHostEvent (#5706): ${t}`);
    }
}

function assertRidesLogHostEvent(file: string, lines: string[], marker: string): void {
    const hits = lines.filter((l) => l.includes(marker));
    assert.ok(hits.length > 0, `${file}: diagnostic "${marker}" is missing entirely — rerouted or dropped?`);
    for (const l of hits) {
        assert.match(l.trim(), /^logHostEvent\(/, `${file}: "${marker}" must ride logHostEvent, got: ${l.trim()}`);
    }
}

test("#5706: opencode-native v1 bootstrap keeps the TUI terminal clean", () => {
    const lines = entryLines("opencode-native.ts");
    assertNoRawConsole("opencode-native.ts", lines);
    assertRidesLogHostEvent("opencode-native.ts", lines, "zod unavailable — plugin tools skipped");
    assertRidesLogHostEvent("opencode-native.ts", lines, "fetch patch installed (catches providers without an explicit baseURL)");
    assertRidesLogHostEvent("opencode-native.ts", lines, "no live proxy at startup");
    assertRidesLogHostEvent("opencode-native.ts", lines, "v1 active (proxy");
});

test("#5706: opencode launcher-lane entry keeps the TUI terminal clean", () => {
    const lines = entryLines("opencode.ts");
    assertNoRawConsole("opencode.ts", lines);
    assertRidesLogHostEvent("opencode.ts", lines, "plugin active (proxy");
    assertRidesLogHostEvent("opencode.ts", lines, "fetch patch installed (catches providers without an explicit baseURL)");
});
