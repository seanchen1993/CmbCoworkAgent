---
name: vendor-decision
description: 消费前序资料与可选资质审查产物，生成待人工复核的准入报告。
---

VENDOR_DECISION_SKILL。先实际读取当前插件 knowledge/admission-policy.md，调用本插件 settings，
并通过 read_file 实际读取 dossier.json。若用户组合中加入资质审查步骤，必须读取 qualification.json；
不能仅凭阶段名称推断其内容。报告 vendor-report.json 必须记录 vendorName、policyTier、
decision:"needs-human-review"、sources（实际使用的文件名）及 qualificationStatus。
未加入资质步骤时 qualificationStatus 为 not-requested；有该步骤时必须采用实际资质文件中的结论。
上游资料或准入知识缺失时停止；不得将模型自行声明的“通过”视为原生检查回执或业务审批。
