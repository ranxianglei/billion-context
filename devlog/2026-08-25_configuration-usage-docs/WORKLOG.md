# 工作日志

- branch 2026-08-25_configuration-usage-docs（自 master e551506）。
- git diff 7d958b1..master 导出 README 删行 → /tmp/en-deleted.txt、/tmp/zh-deleted.txt 作为素材。
- 核对 src/launcher.ts（claude ANTHROPIC_BASE_URL 路由 :236-246、各 client env :920-975、BILI_LAUNCHER_PLUGIN :358、direct 警告 :907/:911）后重写表格，不照搬过时内容。
- CONFIGURATION.md：环境变量表 +16 行；追加 5 节（CLI Reference / Client Integration / Launcher Reference / Plugin Mode / Sessions & Migration），346→620 行。
- CONFIGURATION.zh-CN.md：环境变量表 +18 行（含补齐 BILI_REPLAY_*）；追加对应 5 节，344→620 行，与英文逐节对应。
- 纯文档改动，不涉及代码/版本号。
