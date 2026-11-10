---
title: "What to do when your model keeps treating compressed old content as fresh user instructions?"
date: 2026-11-02
excerpt: "Weak-attention models read compressed summaries as fresh instructions — what to do?"
excerpt_zh: "弱注意力模型把压缩摘要当成新指令，怎么办？"
---

Some models, especially ones with weak attention like qwen3.8 27b, always rework things once compression kicks in. The reason: the content of the compressed summary gets treated as a user instruction. There is now a pretty good solution to this problem. After a compress call, we swap the positions of compress and the recent protected user messages, so on the next request the model treats compress as historical messages, avoiding attention drift. This parameter is an experimental feature, off by default, and can be turned on by ticking "fold replacement in place (compressAtFoldPoint)" on the web config page (or JSON `compress.compressAtFoldPoint: true` / env var `BILI_COMPRESS_AT_FOLD_POINT=1`).
