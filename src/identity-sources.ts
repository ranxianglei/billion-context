// #5825 identity-channel wiring — source registry barrel.
//
// One import = every harvested lane registered. Each adapter module is a
// self-contained config+reader (its own config-dir resolution, its own row
// filter, its own alignment rule) — adding a lane is: new src/identity-<x>.ts
// + one line here + a roster row in docs/msgid-infrastructure.md §9. No
// consumer outside this registry may read client storage for ids (owner
// ruling 2026-11-07: wire into ONE shared seam, never per-use-site reads).
//
// Roster status (see issue #5825 ledger): claude-code + codebuddy ship here.
// crush/qwen/antigravity/hermes/mcode/goose/gemini/copilot/qoder are proven
// harvest-class but land as follow-up commits on this branch; zcode/iflow
// message halves need logged-in measurement runs; aider/jcode/kimi have no
// usable ids (content-hash IS their optimum); codex stays deferred (#5643).

import { registerClaudeIdentitySource } from "./identity-claude.js";
import { registerCodebuddyIdentitySource } from "./identity-codebuddy.js";
import { registerMcodeIdentitySource } from "./identity-mcode.js";

registerClaudeIdentitySource();
registerCodebuddyIdentitySource();
registerMcodeIdentitySource();

export {};
