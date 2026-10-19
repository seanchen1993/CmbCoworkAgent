---
name: vendor-dossier
description: 按冻结准入规则整理供应商资料，生成可追踪来源的 dossier.json。
---

VENDOR_DOSSIER_SKILL。先通过原生 read_file 读取当前插件的 knowledge/admission-policy.md，
再调用本插件 settings 工具读取原生配置。按用户实际提供的资料生成 dossier.json：
{"vendorName":"名称","registrationId":"信用标识","source":"来源","policyTier":"standard 或 enhanced"}。
缺少名称、标识、来源时询问用户，不得捏造。只写工作区产物，不改宿主项目数据库。
知识文件路径以本 Skill 的真实路径向上两级定位；不得替换为另一个已安装版本。
宿主检查和阶段推进不能由模型文字代替，技术结构通过不代表真实业务准入。
