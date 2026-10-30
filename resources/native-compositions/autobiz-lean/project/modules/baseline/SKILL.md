---
name: autobiz-lean-baseline
description: 从Host原始请求整理并提交需求基线确认
---

先读固定插件包根的contracts/baseline.md。当前Host项目的原始任务消息是request.text的来源，逐字保留完整正文，计算真实UTF-8字节数及SHA-256。从原任务提炼编号需求并记录需要用户裁定的事项，形成RequestBaseline.json。检查器会将原文与Host独立注入的来源元数据核对；自行写入confirmed/approved字段不能代替批准。

普通用户只需审阅提炼结果，无需手写文件。向用户完整展示需求、范围取舍和未决事项；不把原文引用或哈希一致说成语义完整证明。Host真实成果接受后才可进入Definition。基线未获接受不得继续；需求修订须重新审查基线并使下游旧结果失效。只完成本阶段，不执行旧状态脚本，不自报用户批准。
