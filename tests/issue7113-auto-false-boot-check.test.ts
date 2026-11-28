// #7113: a dsh patch replaces a row's whole `config`, and `compaction-basic`
// defaults `auto` to true — so any patch applied AFTER bili (a hand-written
// profile row, a later bundle, a partial #2474 snapshot) that restates
// `- id: compaction-basic` silently re-arms native auto-compaction, and the
// user only learns about it when a checkpoint destroys the fold base. These
// tests pin the detector in both directions plus the gate wiring that turns it
// into a boot-time alarm.
import test from "node:test";
import assert from "node:assert/strict";
import * as gate from "../src/agent/dsh-compaction-gate.ts";
import {
    hostPlaneOverrideLostWarning,
    hostPlaneRowsMissingAutoFalse,
    type CompactionDisableHost,
} from "../src/agent/dsh-compaction-disable.ts";

const BASIC = "@deepseek-ai/dsh-compaction-basic";

function entry(over: Record<string, unknown> = {}) {
    return { options: { id: "compaction-basic", name: BASIC, ...over } };
}

test("#7113: an enabled row that kept auto:false is not reported", () => {
    assert.deepEqual(hostPlaneRowsMissingAutoFalse([entry({ config: { auto: false } })]), []);
});

test("#7113: a later patch row that dropped auto is reported by entry id", () => {
    assert.deepEqual(
        hostPlaneRowsMissingAutoFalse([entry({ config: { thresholdRatio: 0.9 } })]),
        ["compaction-basic"],
    );
});

test("#7113: a row whose config was replaced entirely is reported", () => {
    assert.deepEqual(hostPlaneRowsMissingAutoFalse([{ options: { name: BASIC } }]), [BASIC]);
});

test("#7113: a disabled row is stock web-profile behaviour, not a lost override", () => {
    assert.deepEqual(hostPlaneRowsMissingAutoFalse([entry({ disabled: true, config: { thresholdRatio: 0.9 } })]), []);
});

test("#7113: only compaction-basic rows with a usable config are judged", () => {
    assert.deepEqual(hostPlaneRowsMissingAutoFalse([
        { options: { id: "llm-deepseek", name: "@deepseek-ai/dsh-llm-deepseek" } },
        entry({ config: [{ auto: false }] }),
        { options: undefined },
        null,
    ]), ["compaction-basic"]);
});

test("#7113: the alarm names the row and says what to fix", () => {
    const message = hostPlaneOverrideLostWarning(["compaction-basic"]);
    assert.match(message, /compaction-basic/);
    assert.match(message, /auto: false/);
    assert.match(message, /ARMED/);
    assert.match(hostPlaneOverrideLostWarning(["a", "b"]), /"a", "b"/);
});

test("#7113: the gate entry scans the composed tree through an optional loader", () => {
    let injectedDeps: string[] | undefined;
    let scan: ((inner: { loader?: { entries?: () => Iterable<unknown> } }) => void) | undefined;
    const ctx = {
        on: () => {},
        reflect: { provide: () => {} },
        inject: (deps: string[], callback: (inner: { loader?: { entries?: () => Iterable<unknown> } }) => void) => {
            injectedDeps = deps;
            scan = callback;
        },
    } as unknown as CompactionDisableHost;

    gate.apply(ctx);
    assert.deepEqual(injectedDeps, ["loader"], "the loader is awaited in a child fiber, not injected hard");
    assert.equal(typeof scan, "function");

    assert.equal(gate.hostPlaneWarningFor({ loader: undefined }), null, "no loader ⇒ silent");
    assert.equal(gate.hostPlaneWarningFor({ loader: { entries: () => [] } }), null, "no rows ⇒ silent");
    assert.match(
        String(gate.hostPlaneWarningFor({ loader: { entries: () => [entry({ config: { thresholdRatio: 0.9 } })] } })),
        /ARMED/,
    );
    assert.equal(
        gate.hostPlaneWarningFor({ loader: { entries: () => [entry({ config: { auto: false } })] } }),
        null,
        "healthy declaration ⇒ silent",
    );
});

test("#7113: the gate entry keeps publishing the service even without a loader", () => {
    const provided: string[] = [];
    gate.apply({
        on: () => {},
        reflect: { provide: (name: string) => { provided.push(name) } },
    } as unknown as CompactionDisableHost);
    assert.equal(provided.length, 1);
});
