---
name: knowledge-sync
description: 从当前 AutoBiz Feature 的真实产物形成可审阅的知识沉淀草稿，保留证据来源并运行实际校验；未经认可不发布。
---

读取当前 Feature 已生成的需求、设计、实现或验证产物，形成知识沉淀草稿。
保持平台提供的项目、Feature、部署单元与工作树绑定；不要另建同名 Feature。

1. 通过实际文件读取收集证据。仅将当前 Feature 内可复核的产物列为来源；对话中的推测必须明确标记为待确认，不能伪装成已验证事实。
2. 在当前 Feature 产物目录生成 `KNOWLEDGE_DRAFT.md`，说明目标、可复用结论、适用条件、证据及局限。不得复制凭据、访问令牌或原提示中的 leanToken。
3. 生成 `KNOWLEDGE_DRAFT.json`，格式如下。所有摘要必须通过实际工具计算，不能猜测。`sources[].path` 相对于当前 Feature 目录，不能引用草稿自身或越过目录。

```json
{
  "schemaVersion": "autobiz.knowledge-draft/v1",
  "title": "本次知识沉淀主题",
  "summary": "有来源支持的摘要",
  "sources": [{ "path": "PRD.md", "digest": "实际 SHA-256" }],
  "markdownDigest": "KNOWLEDGE_DRAFT.md 的实际 SHA-256",
  "securityReview": "pending"
}
```

4. 通过当前插件目录执行 `mods/business/autobiz.knowledge/validate-knowledge-draft.py`。该脚本使用平台已有的 `PLUGIN_WORKSPACE`、`PROJECT_DIR` 和 `FEATURE_ID` 环境定位产物，实际核对文件、来源和摘要。失败时修复草稿；不得修改原业务阶段、校验脚本或凭据来绕过。
5. 校验成功后向用户展示草稿位置及证据，明确状态为“待人工审阅”。校验成功只说明草稿及来源可复核，不代表业务结论已获认可。

本 Mod 不向远端发布知识、不自动提交 Git，也不修改只读知识库。远端发布需要真实目标、明确授权和独立发布动作；缺少这些条件时保留草稿，不宣称完成远端同步。
