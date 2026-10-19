---
name: vendor-qualification
description: 读取供应商主体资料，记录真实提供的资质声明及待人工确认结论。
---

VENDOR_QUALIFICATION_SKILL。通过 read_file 实际读取 dossier.json，调用本插件 settings。
根据用户提供的资质声明写 qualification.json：
{"vendorName":"与实际主体资料一致","status":"needs-human-review","source":"dossier.json","policyTier":"实际策略"}。
不对外联网核验、不捏造证照、不给出真实业务通过结论。缺失产物或错误 JSON 必须由宿主必需检查阻断。
此步骤通过业务 Mods catalog 插入，不需要修改平台代码或复制 AutoBiz 的检查点、目录与 Python 内核。
