# CI-GATES.md — billion-context 外部贡献者踩坑记录

> 2026-11-18 15:56 重建（原未跟踪文件随 worktree 切换丢失）。内容按已发生的判例回收，只保留有据可查的条目。

## §1 rollup 会保留上一轮的 FAILURE

`statusCheckRollup` 里的红可能是**旧 run 的残留**，直到新一轮同名 check 跑完才刷新。
判红前必须走 `gh run list --workflow ci.yml --branch <head 分支> --limit 3`，取最新一条 run 的 `conclusion`。
最新 run 非 completed（queued/in_progress）→ 视为等待，不做任何动作。

## §2 CANCELLED 不等于红

同一 head 上出现多条 run 时，被 concurrency 取消的那条会在 rollup 里留一串 `CANCELLED`。
`CANCELLED` 不是失败；只看 `FAILURE` / `failure`。
判例：#7117 head `de688485` 的 rollup 有 20+ 条 CANCELLED，实际最新 run `44257421198` 是 success。

## §3 master-broken 必须用「同一 head 的最新 run」复核

判 `master-broken` 前要先确认：同一 head 的**最新** run 是否仍红。
PR run 走的是 merge ref（`refs/pull/N/merge`），base 前移会改变结论——上一轮的红可能已被 base 带进来的修复消掉。
判例：#7116 一度被判 master-broken，后来同一 head `81780db7` 的最新 run success，结论被推翻，`ci` 项应删除。

## §4 Windows 红优先怀疑 stale base（最高频）

master 侧修好的测试会留在 PR 里继续红，因为 PR 的 base 停在旧提交。
排查顺序：
1. `git log upstream/master --oneline -20 -- <失败测试文件>` 找修复提交；
2. `git merge-base --is-ancestor <修复提交> HEAD` —— 返回非 0 即「base 没带上」；
3. 是 → `classification:"stale-base"`，合 master 解决，**不重跑、不改测试**。

判例：`tests/server-process-listeners.test.ts` 在 win32 上 `process.kill(self, SIGINT)` = TerminateProcess，零 TAP 输出、文件级失败；master `3186e54ad2` 修好后，7116/7117/5994 均需合 master 才转绿。

## §5 只有「最新 run completed 且仍 red」才进分类

顺序：diff 碰了 → 本 PR 引入；日志含 `full retry also FAILED … genuine failure, not a flaky` → master 侧确定性失败；master 同 job 近期同红 → master 侧；否则真 flake。

## §6 外部贡献者无 rerun 权限

`POST /actions/jobs/<id>/rerun` 返回 403。重跑只能用 close+reopen（`ci.yml` 的 `pull_request.types` 含 `reopened`，且不产生空提交）。
close+reopen 只对真 flake 用；`rerunPolicy:"never"` 一律跳过。

## §7 取失败日志别用 `gh run view --log-failed`

常报 stream error。改用：
`curl -sL -H "Authorization: Bearer $(gh auth token)" https://api.github.com/repos/ranxianglei/billion-context/actions/jobs/<id>/logs`

## §8 push 按 ref，不要依赖 HEAD

`/tmp/bili-work` 会被其他会话 checkout 到别的分支（已发生两次）。
推送固定用 `git push fork <branch>:refs/heads/<branch>`，并在 push 前 `git fetch fork <branch>` 确认远端未前移。

## §9 只在 CI 存在、本地跑不了的门禁

`issue3354` / `issue3662` 依赖 launcher→kernel 链路，本地无法跑，只能交 CI 复核；本地门禁全绿不代表这些通过。
真机验证走 dsh `0.2.2-rc.4` 三场景（gate 在 / gate 禁用 / bili-native 禁用）。

## §10 评论正文一律 `--body-file`

zsh 会把反引号当命令替换，`--body "…`x`…"` 会被吞空。

## §11 单 PR 绿 ≠ 批次绿：cross-PR cherry-pick 要按批次树复核

owner 会把多个 PR 打成 batch（例 #7196 = batch-4，含 #5994/#7115/#7116/#7117；#7199 = wave-12，含 #7158/#7159/#7161/#7177/#7127/#7129）。
**每个单 PR 的 rollup 全绿，批次仍可能红**——不同 PR 改同一个 hook 的调用约定会互相踩。

判例（2026-11-18）：#7115 把 `internal/config` 监听器改成 `(fiber, next)`（`this` 恒 null），而 #6770 的测试 fixture 仍用 `mw.call({entry:{…}}, null, next)`，第一参数为 null → `entryNameOf` 退化为 `unnamed-entry` → `tests/issue6770-compaction-coverage-text.test.ts:70` 在 4 个 shard 稳定红。属两个提交的语义冲突，不是 flake、也不是 master-broken。

纪律：
1. 看到批次 PR 红，先按「同一条断言 × 多 shard」聚合，往往只是一个用例。
2. `git cat-file -p <batch-ref>:<test>` 读批次树里的夹具，与本分支的监听器签名逐字比对——**签名漂移比逻辑错误更常见**。
3. 单 PR 侧改不了别人的夹具时，只给证据 + 最小修法，不越界改 owner 分支。

## §12 断言「重写 / 非 verbatim」前先看 cherry-pick 标记

判例（2026-11-18，#7196）：我把批次里 `ffc75459b` 说成「owner 非 verbatim 重写」，被 owner 当场更正——该 commit 带 `-x` 标记 `(cherry picked from 9ec1e6f3…)`，作者/日期/消息原样。
纪律：`git log -1 --format=%B <sha>` 先看有无 `(cherry picked from` 或 `(cherry picked from commit` 行；有则不得称为重写。
同时更正一处因果：**跨 PR 的真实耦合点在装配层**（`dsh-compaction-gate.ts` 里 #7116 boot alarm 与 #7117 reconcile 被合成进同一个 `ctx.inject(["loader"])` 回调），而非判据层；#7115 的 fiber 语义与 #7117 的 `entry.update()` 重载不直接耦合。核批次冲突要看装配点，不是逐个措辞比对。

## §13 CONFLICTING 也用 merge 解，不 rebase（force-push 禁令优先）

任务书写「rebase 到最新 upstream/master」，但硬约束禁 force-push —— rebase 必然要 force。二者冲突时以硬约束为准：**把 `upstream/master` 合进分支，产生 additive merge commit 再普通 push**，效果等价（冲突解决 + 新 run 触发），且不改写历史。

共享注册表数组（`scripts/live-files.mjs` 的 `LIVE_FILES`、`kernel` 的 ledger 列表等）的冲突几乎都是 **both-add**：两边各加一条，冲突只因同一 anchor。做法是**两条都留**，按各自注释成组保留，不要删任何一边 —— 删一边等于静默砍掉别人的测试登记，会让对应 tripwire 失效。

判定「冲突是否在本分支改动范围」的最快办法：
```bash
git merge --no-commit --no-ff upstream/master   # 先看谁冲突
git diff --name-only --diff-filter=U            # 只列未合并文件
git diff --stat $(git merge-base upstream/master <branch>)...<branch>   # 对照本分支改了哪些
```
命中 → 自己解；未命中 → 标 `待人工`，别替别人改。

## §14 发现 PR 落后 main 时主动 update branch（2026-11-24 owner 指令）
- 只对 head 在 `resec/billion-context` fork 的 PR 生效。head 在 `ranxianglei/billion-context` 本体（如 owner 批次载体 #7196、历史线程 #6470/#5994）无写权限，禁改别人分支 → 不动。
- 做法同 §13：合 `upstream/master` 产生 additive merge commit，门禁全绿后按 ref push fork；不 force-push、不 rebase。
- 冲突文件若不在本分支改动范围、或与 owner 已落地的改动在同一装配点语义叠加（§11/§12），属跨 PR 耦合 → 标待人工，不强行 merge（判例：#7117 与 #7113 的 hostPlane 告警在 dsh-compaction-gate.ts 同点叠加）。
- 一个 update = merge commit + push，按单轮写动作额度计；多 PR 落后时按风险从低到高逐轮处理。
