---
name: autobiz-native-archive
description: 归档本流程实际确认产物及其逐字节摘要，由Host结束当前任务。
---

只在Host推进到此阶段后执行。读取全部实际NORMALIZED_REQUIREMENTS.json、PRD.bundle.json、SPECS.bundle.json、DESIGN.bundle.json、PLAN.bundle.json、CODE_RESULT.json、CICD.bundle.json。
输出 ARCHIVE.bundle.json：{feature,stage:"archive",publicationStatus:"prepared-only",files:{每个上述文件名:完整原始UTF-8文本},artifactDigests:{每个上述文件名:原始UTF-8字节SHA-256}}。
保留所有bundle正文和来源，不把JSON重新格式化后再归档，不漏来源/规格/设计/计划。检查会对实际workspace文件逐字核对并重新核对原Code运行、动作和Git证据。
这是Host不可变产物归档；Host接受检查后进入统一终态。不要搬移/删除旧features目录、覆写已有归档、修改旧state.json或伪造archived checkpoint。原运行日志、批准和操作事实继续归原Host/Workflow拥有。
不得声称外部发布已完成；本组合源仅归档准备成果。外部发布需求尚未满足时停止并明确所缺正式适配器。
