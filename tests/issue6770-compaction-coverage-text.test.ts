import test from "node:test";
import assert from "node:assert/strict";
import {
    _resetDshCompactionGateTelemetryForTest,
    _resetDshCompactionVerdictForTest,
    compactionCoverageText,
    declareDshCompactionActive,
    dshCompactionGateTelemetry,
    registerCompactionDisable,
} from "../src/agent/dsh-compaction-disable.ts";

// #6770: the #3962 coverage reading needs an exit that does not depend on the
// durable profile-bundle note — that note stays silent wherever
// profileContext.startedBundles cannot be read (the observed state on both a
// desktop dsh build and the dsh-go runtime), so the reading had no reachable
// exit at all. compactionCoverageText() is the one formatter both exits share.

type Mw = (raw: unknown, next: () => unknown) => unknown;

function middleware(): Mw {
    let mw: Mw | undefined;
    registerCompactionDisable({
        on: (_event, listener) => { mw = listener as Mw; },
        reflect: {},
    });
    assert.equal(typeof mw, "function");
    return mw as Mw;
}

test("#6770: no record yet — the reading states the lazy-resolution caveat instead of reporting zero", () => {
    _resetDshCompactionGateTelemetryForTest();
    assert.equal(dshCompactionGateTelemetry(), null);
    const text = compactionCoverageText();
    assert.match(text, /^no preset entry rewritten in this process/);
    assert.match(text, /resolve lazily/);
});

test("#6770: singular and plural follow the covered-entry count", () => {
    assert.equal(
        compactionCoverageText({ covered: [{ entry: "preset-standard", rows: 2 }], sawFactoryPreset: true }),
        "1 preset entry rewritten (preset-standard\u00d72)",
    );
    assert.equal(
        compactionCoverageText({
            covered: [{ entry: "preset-standard", rows: 2 }, { entry: "preset-go-companion", rows: 1 }],
            sawFactoryPreset: true,
        }),
        "2 preset entries rewritten (preset-standard\u00d72, preset-go-companion\u00d71)",
    );
});

test("#6770: an empty covered list uses the empty frame, not a '0 entries rewritten' line", () => {
    assert.match(compactionCoverageText({ covered: [], sawFactoryPreset: false }), /^no preset entry rewritten/);
});

test("#6770: the argument-less default reads the live record the overlay writes", () => {
    try {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
        assert.match(compactionCoverageText(), /^no preset entry rewritten/, "unlatched overlay reads empty");
        declareDshCompactionActive();
        const mw = middleware();
        const cfg = {
            plugins: [
                { group: true, config: [{ name: "@deepseek-ai/dsh-compaction-basic" }] },
                { name: "@deepseek-ai/dsh-command-compact" },
            ],
        };
        // cordis dispatches `internal/config` as waterfall(name, fiber, next) with
        // thisArg null (#7112) — the entry name rides the fiber argument, not `this`.
        mw.call(null, { entry: { options: { name: "preset-dsh-go-companion" } } }, () => cfg);
        assert.equal(compactionCoverageText(), "1 preset entry rewritten (preset-dsh-go-companion\u00d72)");
    } finally {
        _resetDshCompactionVerdictForTest();
        _resetDshCompactionGateTelemetryForTest();
    }
});
