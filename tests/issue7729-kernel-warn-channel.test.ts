// #7729: the kernel's mid-turn diagnostics must never reach a terminal through
// a raw console call. In the inline lanes the kernel runs INSIDE the host agent
// process, where stderr IS the interactive TUI — a `console.warn` from a
// bundled module appends to whatever line holds the cursor (the input-box
// draft) until the next redraw. Same defect class as #2827/#2831/#5706/#5940,
// this time with the kernel as the producer, and the logger's stderr mute
// cannot reach it (it governs bili's own tee logger, not a foreign console
// call). The sink is chosen per lane at core-construction time.
//
// Both directions pinned (#3617 gate discipline): the lane sinks must write
// the durable bili.log with zero terminal traffic, AND an unrecognized lane
// must keep the legacy console.warn so a new lane can never silently lose the
// diagnostic.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kernelWarnSink } from "../src/kernel-warn-channel.js";
import { defaultLogFile } from "../src/paths.js";
import { rmrf } from "./tmp-rm.js";
import { execSync } from "node:child_process";

test("#7729: inline lane routes kernel diagnostics to bili.log with zero terminal traffic", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-kernel-warn-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    const consoleCalls: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(" ")); };
    try {
        const sink = kernelWarnSink("inline");
        assert.ok(sink.warn, "inline lane must supply a sink");
        sink.warn("[acp-kernel] screenRecommendedUnits funnel zeroed (test line)");
        const output = fs.readFileSync(defaultLogFile(), "utf8");
        assert.match(output, /\[warn\] \[v=[^\]]+\] \[acp-kernel\] screenRecommendedUnits funnel zeroed \(test line\)/);
        assert.doesNotMatch(output, /\[acp-kernel\] \[acp-kernel\]/, "the kernel prefix must not be doubled");
        assert.deepEqual(consoleCalls, [], "no console write: the host TUI stays clean");
    } finally {
        console.warn = realWarn;
        if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
        await rmrf(dir);
    }
});

test("#7729: server lane hands kernel diagnostics to the tee logger, not the console", () => {
    const realWarn = console.warn;
    const consoleCalls: string[] = [];
    console.warn = (...args: unknown[]) => { consoleCalls.push(args.map(String).join(" ")); };
    try {
        const sink = kernelWarnSink("server");
        assert.ok(sink.warn, "server lane must supply a sink");
        sink.warn("[acp-kernel] test diagnostic");
        assert.deepEqual(consoleCalls, [], "console.warn is not the server lane's output");
    } finally {
        console.warn = realWarn;
    }
});

test("#7729: every kernel core bili builds is constructed WITH a lane sink", () => {
    // Static wiring pin: the sink is baked into the pipeline nodes at
    // construction, so a `createCore` call that forgets it silently reverts to
    // console.warn — and the terminal pollution comes back with no test
    // failing. Every construction site in src/ must pass kernelWarnSink.
    const files = execSync("rg -l 'createCore\\(\\.*\\{' src/", { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname })
        .split("\n")
        .filter(Boolean);
    assert.ok(files.length > 0, "expected at least one createCore construction site");
    for (const file of files) {
        const text = fs.readFileSync(new URL(`../${file.replace(/^src\//, "src/")}`, import.meta.url), "utf8");
        assert.match(text, /kernelWarnSink\(/, `${file}: builds a kernel core without a warn sink (#7729)`);
        assert.match(text, /kernelWarnSink\(opts\.inlineLane === true \? "inline" : "server"\)/, `${file}: the sink must pick the lane at construction`);
    }
});
