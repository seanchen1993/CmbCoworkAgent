---
name: autodev-verify
description: 已退役的独立 Verify 阶段兼容说明。最终验证已并入固定 Code Workflow 的 B-E2E 与只读 evidence aggregate。
version: v2.0.0
---

# 独立 Verify 已退役

当前 Board 没有 `dev.verify` 节点，也没有 `verify_in_progress` 或 `verify_done`
checkpoint。不要调用本技能推进状态、生成独立验收流程或执行新的测试命令。

固定 `/autodev-code` Workflow 完成后会依次完成：

1. 每个 delivery Batch 的 Review 与 UTest；
2. 合并后的 V-E2E `e2e_test`；
3. 只读 evidence aggregate。

全局状态在这些内部步骤期间均为 `code_in_progress`，全部收口后才变为
`code_done`。如需查看最终结论，读取当前 Code Workflow 的运行 manifest、
EVIDENCE 流和 aggregate 输出；不得创建或依赖 `VERIFY_DECISION.json` 来改变
workflow 路由。
