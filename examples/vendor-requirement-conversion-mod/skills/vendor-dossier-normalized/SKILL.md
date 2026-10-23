---
name: vendor-dossier-normalized
description: 使用需求转换步骤的结构化输入生成供应商资料，保留原准入资料校验。
---

VENDOR_DOSSIER_NORMALIZED_SKILL。保留原供应商准入规则和 policyTier 配置。
先读取当前插件的 knowledge/admission-policy.md，调用本插件原生 settings 工具，
再实际读取上游 normalized-request.json。核对 schemaVersion 为 1，且 policyTier
与实际配置一致。将其 vendorName、registrationId、source、policyTier 写入 dossier.json。
缺失上游文件、字段或知识时停止，不得用模型自行声明的通过替代宿主产物检查。

本 Skill 是 vendor.dossier 的替换实现；正式组装必须使用精确来源摘要的替换声明，
不能靠同名文件覆盖原插件。已创建项目保留旧快照，新的组合创建独立插件与项目。
