import { test } from "node:test";
import assert from "node:assert/strict";
import { addPromptSection, DELEGATE_PROMPT_SECTION } from "../src/compat.js";

// The acp_delegate prompt rides systemPromptOptions.sections on hosts that
// render sections live (pi 1.x): pi-claude-bridge forwards sections to Claude
// Code and drops a handler-returned systemPrompt. Hosts without live sections
// (pi 0.83) and turns with a forced prompt keep the returned append.

/** pi 1.x before_agent_start shape: systemPrompt is a getter rendering the
 *  mutable options; forceSystemPrompt renders verbatim and ignores sections. */
function liveEvent(base: string, force?: string) {
  const options = { sections: {} as Record<string, string>, forceSystemPrompt: force };
  const event = {
    get systemPrompt(): string {
      if (options.forceSystemPrompt !== undefined) return options.forceSystemPrompt;
      const rendered = Object.entries(options.sections)
        .filter(([, content]) => content)
        .map(([name, content]) => `<${name}>\n${content}\n</${name}>`);
      return [base, ...rendered].join("\n\n");
    },
    systemPromptOptions: options,
  };
  return { event, options };
}

test("live-section host: prompt lands as a named section, no returned systemPrompt", () => {
  const { event, options } = liveEvent("BASE");
  const result = addPromptSection(event, DELEGATE_PROMPT_SECTION, "\nDELEGATE RULES\n");
  assert.equal(result, undefined);
  assert.equal(options.sections[DELEGATE_PROMPT_SECTION], "DELEGATE RULES");
  assert.ok(event.systemPrompt.endsWith(`\n\n<${DELEGATE_PROMPT_SECTION}>\nDELEGATE RULES\n</${DELEGATE_PROMPT_SECTION}>`));
});

test("live-section host: a section already holding the text is left alone", () => {
  const { event, options } = liveEvent("BASE");
  options.sections[DELEGATE_PROMPT_SECTION] = "DELEGATE RULES";
  assert.equal(addPromptSection(event, DELEGATE_PROMPT_SECTION, "DELEGATE RULES"), undefined);
  assert.equal(event.systemPrompt.split("DELEGATE RULES").length, 2);
});

test("forced prompt: returns the append for pi and keeps the section for structured readers", () => {
  const { event, options } = liveEvent("BASE", "FORCED");
  const result = addPromptSection(event, DELEGATE_PROMPT_SECTION, "DELEGATE RULES");
  assert.deepEqual(result, { systemPrompt: "FORCED\n\nDELEGATE RULES" });
  assert.equal(options.sections[DELEGATE_PROMPT_SECTION], "DELEGATE RULES");
  // The forced prompt renders verbatim, so the kept section adds no second copy.
  assert.equal(event.systemPrompt, "FORCED");
});

test("static prompt with a sections object (no live render): falls back and withdraws the section", () => {
  const options = { sections: {} as Record<string, string> };
  const result = addPromptSection({ systemPrompt: "BASE", systemPromptOptions: options }, DELEGATE_PROMPT_SECTION, "DELEGATE RULES");
  assert.deepEqual(result, { systemPrompt: "BASE\n\nDELEGATE RULES" });
  assert.deepEqual(options.sections, {});
});

test("static prompt: a pre-existing section value is restored, not deleted", () => {
  const options = { sections: { [DELEGATE_PROMPT_SECTION]: "OTHER" } as Record<string, string> };
  addPromptSection({ systemPrompt: "BASE", systemPromptOptions: options }, DELEGATE_PROMPT_SECTION, "DELEGATE RULES");
  assert.equal(options.sections[DELEGATE_PROMPT_SECTION], "OTHER");
});

test("pi 0.83 shape (options without sections) and bare events: returned append", () => {
  assert.deepEqual(
    addPromptSection({ systemPrompt: "BASE", systemPromptOptions: { cwd: "/x" } }, DELEGATE_PROMPT_SECTION, "DELEGATE RULES"),
    { systemPrompt: "BASE\n\nDELEGATE RULES" },
  );
  assert.deepEqual(addPromptSection({ systemPrompt: ["A", "B"] }, DELEGATE_PROMPT_SECTION, "X"), { systemPrompt: "A\nB\n\nX" });
});
