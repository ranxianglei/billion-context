import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPrompts } from "acp-kernel";
import { buildAcpSystemPrompt, ACP_DELEGATE_PROMPT, sanitizePromptSections, SECTION_KEYS } from "../src/agent/pi-inprocess/system-prompt.js";
import { sanitizeToolPrompts, sanitizeNudgeSections, applyToolPromptOverrides, readToolSurfaceSync, sanitizeSurfaceConfig } from "../src/agent/pi-inprocess/surface.js";
import { loadUserConfig } from "../src/agent/pi-inprocess/user-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("default system prompt is byte-identical to the recorded fixture", async () => {
  const fixture = await import("node:fs/promises").then((fs) => fs.readFile(path.join(here, "pi-inprocess-fixtures/pi-system-prompt-default.txt"), "utf8"));
  assert.equal(buildAcpSystemPrompt(defaultPrompts), fixture);
});
