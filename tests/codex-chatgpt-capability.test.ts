import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chatGptDesktopCapability } from "../src/codex-integration/chatgpt-capability.ts";

test("ChatGPT subscription and Desktop remain explicitly unsupported without credential access", () => {
    assert.deepEqual(chatGptDesktopCapability, {
        state: "待完成/可实现",
        credentials: "not-read-not-persisted",
        officialLoginChannels: "preserved",
        desktopMcp: "separate-from-model-routing",
    });
    const source = fs.readFileSync(
        new URL("../src/codex-integration/chatgpt-capability.ts", import.meta.url),
        "utf8",
    );
    assert.doesNotMatch(source, /readFileSync|writeFileSync/);
});
