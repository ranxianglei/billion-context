// #7791: the kernel's mid-turn diagnostics must never reach a terminal through
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
import { fileURLToPath } from "node:url";
import { kernelWarnSink } from "../src/kernel-warn-channel.js";
import { defaultLogFile } from "../src/paths.js";
import { rmrf } from "./tmp-rm.js";

test("#7791: inline lane routes kernel diagnostics to bili.log with zero terminal traffic", async () => {
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

test("#7791: server lane hands kernel diagnostics to the tee logger, not the console", async () => {
    // Isolated state dir: the tee logger would otherwise append this line to the
    // operator's real bili.log.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-kernel-warn-server-"));
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
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
        if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous;
        await rmrf(dir);
    }
});

test("#7791: every kernel core bili builds is constructed WITH a lane sink", () => {
    // Static wiring pin: the sink is baked into the pipeline nodes at
    // construction, so a `createCore` call that forgets it silently reverts to
    // console.warn — and the terminal pollution comes back with no test
    // failing. Every construction site in src/ must pass kernelWarnSink.
    // A Node fs walk, not a shell-out: CI runners carry no ripgrep, and a
    // spawning test would need a LIVE_FILES registration for no reason.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const srcDir = path.join(root, "src");
    const sites: string[] = [];
    for (const entry of fs.readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
        const rel = path.relative(root, path.join(entry.parentPath, entry.name));
        if (/createCore\(.*\{/.test(fs.readFileSync(path.join(root, rel), "utf8"))) sites.push(rel);
    }
    assert.ok(sites.length > 0, "expected at least one createCore construction site");
    for (const file of sites) {
        const text = fs.readFileSync(path.join(root, file), "utf8");
        assert.match(text, /kernelWarnSink\(/, `${file}: builds a kernel core without a warn sink (#7791)`);
        assert.match(text, /kernelWarnSink\(opts\.inlineLane === true \? "inline" : "server"\)/, `${file}: the sink must pick the lane at construction`);
    }
});
