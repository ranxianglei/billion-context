// #7112: the internal/config middleware read the entry name from `this`, but
// cordis dispatches that waterfall as `('internal/config', fiber, next)` — the
// first argument is the event name, so no `this` is bound (thisArg null) and
// the listener receives (fiber, next). Every name-keyed branch was therefore
// dead: coverage telemetry degraded to "unnamed-entry", sawFactoryPreset never
// latched, and PR #5994's #5248 restore could never fire. These tests dispatch
// through a REAL cordis Context — the mock hosts elsewhere call the captured
// listener directly, which is exactly why the defect stayed green.
import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import {
    BILI_COMPACTION_DISABLE_SERVICE,
    _resetDshCompactionGateTelemetryForTest,
    _resetDshCompactionVerdictForTest,
    declareDshCompactionActive,
    dshCompactionGateTelemetry,
    entryNameOf,
    registerCompactionDisable,
} from "../src/agent/dsh-compaction-disable.ts";

const FACTORY_PRESET = "@deepseek-ai/dsh-agent-preset";

function presetConfig() {
    return {
        id: "standard",
        plugins: [
            {
                id: "compaction",
                group: true,
                config: [{ id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" }],
            },
        ],
    };
}

function fiberNamed(name: string) {
    return { entry: { options: { id: "preset-standard", name } } };
}

function dispatch(name: string): { config: unknown; telemetry: ReturnType<typeof dshCompactionGateTelemetry> } {
    const ctx = new Context();
    registerCompactionDisable(ctx as unknown as Parameters<typeof registerCompactionDisable>[0]);
    const dispatchConfig = ctx.waterfall as unknown as
        (event: string, fiber: unknown, next: () => unknown) => unknown;
    const config = dispatchConfig("internal/config", fiberNamed(name), () => presetConfig());
    return { config, telemetry: dshCompactionGateTelemetry() };
}

test("#7112: the hook binds no `this`, so the name comes from the fiber argument", () => {
    _resetDshCompactionVerdictForTest();
    _resetDshCompactionGateTelemetryForTest();
    declareDshCompactionActive();
    try {
        const ctx = new Context();
        let seenThis: unknown = "unset";
        let seenFiberName: string | undefined;
        const on = ctx.on as unknown as
            (event: string, listener: (fiber: unknown, next: () => unknown) => unknown, options?: { global?: boolean }) => void;
        const listener: (this: unknown, fiber: unknown, next: () => unknown) => unknown =
            function (this: unknown, fiber: unknown, next: () => unknown) {
                seenThis = this;
                seenFiberName = entryNameOf(fiber);
                return next();
            };
        on("internal/config", listener, { global: true });
        const dispatchConfig = ctx.waterfall as unknown as
            (event: string, fiber: unknown, next: () => unknown) => unknown;
        dispatchConfig("internal/config", fiberNamed(FACTORY_PRESET), () => presetConfig());
        assert.equal(seenThis, null, "cordis must bind null, not the fiber");
        assert.equal(seenFiberName, FACTORY_PRESET, "the fiber argument carries the entry name");
    } finally {
        _resetDshCompactionVerdictForTest();
    }
});

test("#7112: coverage telemetry records the real entry name, not unnamed-entry", () => {
    _resetDshCompactionVerdictForTest();
    _resetDshCompactionGateTelemetryForTest();
    declareDshCompactionActive();
    try {
        const { config, telemetry } = dispatch(FACTORY_PRESET);
        assert.ok(telemetry, "the transform must record coverage");
        assert.deepEqual(telemetry.covered, [{ entry: FACTORY_PRESET, rows: 1 }]);
        assert.equal(telemetry.sawFactoryPreset, true, "the factory preset must latch");
        const rows = (config as { plugins: Array<{ config: Array<{ disabled?: boolean }> }> }).plugins;
        assert.equal(rows[0]?.config[0]?.disabled, true, "the rewrite still disables the row");
    } finally {
        _resetDshCompactionVerdictForTest();
    }
});

test("#7112: a custom preset keeps its own name and does not latch sawFactoryPreset", () => {
    _resetDshCompactionVerdictForTest();
    _resetDshCompactionGateTelemetryForTest();
    declareDshCompactionActive();
    try {
        const { telemetry } = dispatch("my-custom-preset");
        assert.deepEqual(telemetry?.covered, [{ entry: "my-custom-preset", rows: 1 }]);
        assert.equal(telemetry?.sawFactoryPreset, false);
    } finally {
        _resetDshCompactionVerdictForTest();
    }
});

test("#7112: absent or empty names fall back to undefined (caller renders unnamed-entry)", () => {
    assert.equal(entryNameOf(undefined), undefined);
    assert.equal(entryNameOf({}), undefined);
    assert.equal(entryNameOf({ entry: { options: { name: "" } } }), undefined);
    assert.equal(entryNameOf({ entry: { options: { name: FACTORY_PRESET } } }), FACTORY_PRESET);
});

test("#7112: the gate service is published even when the transform cannot bind a name", () => {
    const provided: string[] = [];
    registerCompactionDisable({
        on: () => {},
        reflect: { provide: (name: string) => { provided.push(name) } },
    } as unknown as Parameters<typeof registerCompactionDisable>[0]);
    assert.deepEqual(provided, [BILI_COMPACTION_DISABLE_SERVICE]);
});
