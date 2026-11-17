// #5825 identity-channel wiring — source registry barrel.
//
// One import = every harvested lane registered. Each adapter module is a
// self-contained config+reader (its own config-dir resolution, its own row
// filter, its own alignment rule) — adding a lane is: new src/identity-<x>.ts
// + one line here + a roster row in docs/msgid-infrastructure.md §9. No
// consumer outside this registry may read client storage for ids (owner
// ruling 2026-11-07: wire into ONE shared seam, never per-use-site reads).
//
// Roster status (see issue #5825 ledger + docs/identity-channels.md):
// claude-code / codebuddy / mcode / goose / qwen ship here. Memo rows
// (fact-audited 2026-11-07, /lane-scout): crush = wire key is an XXH3 hash of
// the session UUID + project-local store path — no proxy-side join; gemini-cli
// = install-level id only; hermes-agent = zero per-session wire signal;
// iflow = product sunsetting. zcode/iflow message halves and zed/kiro/qoder/
// copilot need live login/blob runs; aider/jcode/kimi have no usable ids
// (content-hash IS their optimum); codex stays deferred (#5643).

import { registerClaudeIdentitySource } from "./identity-claude.js";
import { registerCodebuddyIdentitySource } from "./identity-codebuddy.js";
import { registerGooseIdentitySource } from "./identity-goose.js";
import { registerMcodeIdentitySource } from "./identity-mcode.js";
import { registerQwenIdentitySource } from "./identity-qwen.js";

registerClaudeIdentitySource();
registerCodebuddyIdentitySource();
registerGooseIdentitySource();
registerMcodeIdentitySource();
registerQwenIdentitySource();

export {};
