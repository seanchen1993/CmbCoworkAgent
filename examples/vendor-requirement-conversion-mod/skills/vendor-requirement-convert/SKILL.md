---
name: vendor-requirement-convert
description: 将用户的供应商准入需求转换为经过 Schema 校验的结构化输入。
---

VENDOR_REQUIREMENT_CONVERT_SKILL。先读取本插件冻结的 knowledge/admission-policy.md，
再通过原生配置工具读取 policyTier。读取用户实际提供的 raw-request.json，提取供应商名称、
信用标识和资料来源，写入 normalized-request.json。缺项时询问用户，不得捏造。
normalized-request.json 使用 schemaVersion:1，包含 vendorName、registrationId、source、
policyTier 字段。后续资料步骤必须实际读取此文件，不能只使用会话摘要。

只生成当前工作区产物，不直接改项目状态。由宿主实际校验 JSON Schema 后推进阶段。
