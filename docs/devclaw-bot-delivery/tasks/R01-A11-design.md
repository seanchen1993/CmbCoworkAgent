# R01-A11-design · Astra 专家长期记忆方案

状态：design_delivered（2026-10-15），未授权实施。用户要求Astra结合Grok Bot与DevClaw需求设计一版，Astra主方案与两点补充已返回，root核对并保存reviews/Astra-expert-memory-grok-design.md。仅文档和进度记录变化，43个非docs dirty路径SHA保持36336f77。

设计代理沿用 /root/astra_mvp_expert_design（gpt-6-astra），root负责独立核对和落盘。代理不得写文件、派生代理、启动/停止服务或测试、调用业务模型、访问内网/付费。保留当前App及所有dirty，不恢复定时。

基准：集成树codex/devclaw-bot-integration/2f0d6c3f，包含未提交A9/A10。当前专家手工记忆、MySQL权威、JSON可重建缓存、固定Run快照、任意revision变化使在途任务失效；无自动提炼/执行检索/自然语言记忆命令，仍模拟模型。Group不展示、不建用户级或团队记忆UI；首版允许破坏性更新、不要求旧版兼容。JDK8/MySQL5.7/无物理FK，专家与Runtime解耦，本地负责人节点先行。

参考：用户提供的 grok-bot-0.18-reconstructed-main 非官方重建源码。检查提取、profile/log/note、episode、显式记住/遗忘、召回、后台synthesis/verification与门控、显式记忆保护、tombstone及生产接线，不把辅助代码存在当线上已启用。

产出：源码对比依据；最短Biz—Dev用户旅程；明确首版推荐方案；产生/证据/候选确认/维护/遗忘/召回/运行快照完整闭环；模块接口与字段最小增量；负责人本地模型计算与服务端存储边界；普通更新不应被机械等同敏感撤销的推荐语义；跨任务共享专家知识的来源权限与确认；提示词/JSON示例；两三阶段实现切片与验收；真正待用户决定事项。方案交付不等于接口冻结或实施授权。

目标报告：reviews/Astra-expert-memory-grok-design.md，由root整理保存并注明原建议/独立核对/尚未实现。
