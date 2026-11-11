import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexToml, parseKimiToml } from "../src/client-config.ts";

const valid: ReadonlyArray<readonly [string, number]> = [
    ["128_000", 128000],
    ["+262_144", 262144],
    ["0x1_f400", 128000],
    ["0o372_000", 128000],
    ["0b1_1111_0100_0000_0000", 128000],
    ["65536", 65536],
];

for (const [literal, expected] of valid) {
    test(`Codex TOML model limits retain the integer ${literal}`, () => {
        const config = parseCodexToml([
            'model = "custom-model"',
            `model_context_window = ${literal} # context`,
            `model_auto_compact_token_limit = ${literal}`,
            `model_max_output_tokens = ${literal}`,
        ].join("\n"));
        assert.equal(config.contextWindow, expected);
        assert.equal(config.autoCompactLimit, expected);
        assert.equal(config.maxOutput, expected);
        assert.deepEqual(config.modelWindows, [{ id: "custom-model", contextWindow: expected, maxOutput: expected }]);
    });

    test(`Kimi launcher model and override limits retain the integer ${literal}`, () => {
        const config = parseKimiToml([
            "[models.base]",
            'model = "base-model"',
            `max_context_size = ${literal} # context`,
            "[models.overridden]",
            'model = "overridden-model"',
            "max_context_size = 1234",
            "[models.overridden.overrides]",
            `max_context_size = ${literal}`,
        ].join("\n"));
        assert.deepEqual(config.models, [
            { id: "base-model", contextWindow: expected },
            { id: "overridden-model", contextWindow: expected },
        ]);
    });
}

for (const literal of ["1.5", "2026-01-01", "01", "1 trailing", "9007199254740993", "1_", "1__0", "0x_10", "+0x10", "-1"]) {
    test(`client TOML readers reject the non-limit ${literal} without using its prefix`, () => {
        const codex = parseCodexToml([
            'model = "custom-model"',
            `model_context_window = ${literal}`,
            `model_auto_compact_token_limit = ${literal}`,
            `model_max_output_tokens = ${literal}`,
        ].join("\n"));
        assert.equal(codex.contextWindow, undefined);
        assert.equal(codex.autoCompactLimit, undefined);
        assert.equal(codex.maxOutput, undefined);
        assert.equal(codex.modelWindows, undefined);
        const kimi = parseKimiToml([
            "[models.invalid]",
            `max_context_size = ${literal}`,
            "[models.valid]",
            "max_context_size = 65536",
            "[models.valid.overrides]",
            `max_context_size = ${literal}`,
        ].join("\n"));
        assert.deepEqual(kimi.models, [{ id: "valid", contextWindow: 65536 }]);
    });
}
