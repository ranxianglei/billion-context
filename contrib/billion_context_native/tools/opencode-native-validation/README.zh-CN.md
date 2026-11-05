# 隔离原生验收复跑

这里是可移植的合成验收脚本，不是日常项目插件。产品安装入口在 `../../opencode/`。本轮实际执行的命令、失败和结果另存于交付包 evidence；不要覆盖该证据或借新目录清零旧调用和未知用量。

需要 Python 3.12+、已验证的 OpenCode 2.2.5。设置非秘密变量 `OPENCODE_BIN` 为该版本可执行文件路径；默认从 PATH 找 `opencode`。源码位置默认取当前工具目录的上两级，也可显式设置 `BILLION_CONTEXT_NATIVE_SOURCE_DIR`（兼容 `RECALL_SOURCE_DIR`）。只有运行时继承用户已经授权的 `deponia_key`；配置始终使用环境引用，不填写或保存 key 值。

经明确授权新试验预算后，在全新工作副本执行：

```sh
python3 native_harness.py setup
python3 native_harness.py config
python3 native_harness.py cycle
python3 native_harness.py check-cycle
python3 native_harness.py restart
python3 native_harness.py check-restart
```

`setup` 不发认证或推理，只创建隔离 HOME/XDG、空项目和显式 session allowlist。预算模板最多20次请求、已知usage加未知保守预留最多200000 tokens；不得自动循环重试。继续旧试验时保留原预算文件全部已用和未知预留，由控制器记录恢复决定，不能重新setup丢掉记录。这里的脚本不替代账户总预算管理。

工具参数使用短的 `{"fixture":"native-long-v1"}`，本地工具生成长输出，proof不在prompt。长I块是内部输出，不能冒充模型长参数。首次idle通过官方V2队列真实执行manual `session.compact`及摘要模型，再由待执行synthetic提示触发Recall。测试摘要约束不抄proof，但不替换摘要结果。产品插件本身不关闭自动压缩、不接管上下文。

restart明确使用structured search、原生anchor和locator，按next_cursor读全UTF-8字节页。检查器同时验证实际compaction事件、真实HTTP usage、压缩前后context、原生工具调用关联、完整原文、hash和答案。握手、mock或只见正确答案都不单独算通过。

`guard-plugin/test-local.mjs`、`test-plugin/test-local.mjs` 是无网络合成检查；它们不算真实hook或真实模型。运行日志须过滤密钥、Bearer和认证头；交付排除HOME/XDG、auth、session DB和.env。

适配器单元/故障回归在源码根运行 `python3 -X utf8 -m unittest discover -s tests -v`。无需为已验证且未改的代码反复重跑。本轮最终115项测试和真实压缩/重启证据均已随交付包保存。
