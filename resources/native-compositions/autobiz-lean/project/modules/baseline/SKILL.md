---
name: autobiz-lean-baseline
description: 从Host原始请求整理并提交需求基线确认
---

先读固定插件包根的contracts/baseline.md。request.text取当前Host最初用户任务的原始正文，保留换行和空白，不包含其后追加的CMBDEVCLAW-SKILL-USE-V1执行包装或后续澄清消息；projectId取当前Host阶段上下文。可逐字复制原文到工作区临时文件，仅计算真实UTF-8字节数及SHA-256，副本不能替代原文权威。不得扫描应用内部数据库、运行快照或请求日志来寻找来源。从原任务提炼编号需求，真实后续澄清记入decisions，形成RequestBaseline.json。检查器会将原文与Host独立注入的来源元数据核对；自行写入confirmed/approved字段不能代替批准。

普通用户只需审阅提炼结果，无需手写文件。向用户完整展示需求、范围取舍和未决事项；不把原文引用或哈希一致说成语义完整证明。Host真实成果接受后才可进入Definition。基线未获接受不得继续；需求修订须重新审查基线并使下游旧结果失效。只完成本阶段，不执行旧状态脚本，不自报用户批准。
