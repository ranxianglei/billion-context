# 原生适配验收预算守卫

仅用于隔离合成验收，不属于产品插件。V2 原生 HTTP hooks保持原请求 URL、body、认证头和代理；只校验发送目标为指定 Deponia chat endpoint、模型为 deepseek-v4.1-flash，单次 max_tokens<=2048。本阶段最多20次请求、初始目标输入加输出<=100000 tokens；父任务后续明确授权本阶段已知usage+未知保守预留最多200000 tokens（请求上限20不变）；之前29670 tokens另记总报告。

controlPath mode=seed仅允许原生synthetic_archive，mode=recall仅允许原生Recall search/get；compaction流不暴露工具。只在真正工具注册后准入。先持久预留再发送；SSE/JSON usage确认后释放。未知usage保留预留，错误锁停；没有自动重试。恢复前必须先检查已知结果、保留原计数和未知预留，并记录新方案，不能直接清零或绕预算。

预留至少配置context32768+output2048，或请求UTF8字节+4096协议裕量+output的较大值。这是保守实验策略，不是已证明的未知服务tokenizer数学上界。nativeHTTP实际usage是最终用量依据；cost:0不代表已核实账单。

node test-local.mjs只使用假ctx与临时合成文件，不读真实key/预算，不发网络。结果保存在上一级evidence而非覆盖真实运行预算。
