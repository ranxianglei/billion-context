# REQ: Responses type-less input items enter the kernel

Issue #247 A/B testing (model switch overflow) revealed: omp (pi-ai wire) sends
user items as `{role, content}` WITHOUT the spec-required `type:"message"`.
`responsesToCore` switches on `item.type` and silently drops them, so user
prompts never entered compression state — no refs, never tagged, never
compressible, invisible to nudge and to #254's preflight. With this fix,
#254's preflight compression works end-to-end for omp (verified: 12 turns ×
12KB on a 100k-window model, switch to 24k window → preflight compressed 5
ranges, saved 39166 tokens, payload 20140 < 24000, request passed, no error).
