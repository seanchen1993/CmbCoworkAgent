import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

/** Deterministic model output for execution tests; not a real delivery or live model claim. */
export function businessInput() {
  const normalized = { feature: "orders", revision: 2, requirements: ["订单查询必须在2秒内返回"] }
  const ui = {
    version: 1,
    featureId: "orders",
    uiRequired: false,
    decisionStatus: "locked",
    decisionSource: "user_confirmed",
    notApplicableReason: "用户明确仅后端接口",
    pages: [],
    interactions: [],
    visualSources: [],
    capabilities: []
  }
  const prd = {
    feature: "orders",
    stage: "prd",
    files: {
      "PRD.md":
        "# 订单查询\n订单查询必须在2秒内返回\n来源：NORMALIZED_REQUIREMENTS.json\n## 当前实现范围\nbackend_only\n## 外部资料与实现约束\n无\n",
      "UI_CONTEXT.json": JSON.stringify(ui),
      "IMPLEMENTATION_SCOPE.json": JSON.stringify({
        featureId: "orders",
        implementationScope: "backend_only",
        source: "用户明确范围"
      })
    }
  }
  const specs = {
    feature: "orders",
    stage: "specs",
    files: {
      "proposal.md": "# Proposal\n## Capabilities\n- order-query: 订单查询\n## Decision Log\n无\n",
      "specs/order-query/spec.md":
        "# 订单查询\n## ADDED Requirements\n### Requirement REQ-001: 订单查询必须在2秒内返回\n#### Scenario SCN-001: 正常订单\nGiven 已有订单 When 查询 Then 2秒内返回\n",
      "UI_CONTEXT.json": JSON.stringify(ui)
    }
  }
  const designText =
    [
      "# 订单查询设计",
      "## Context / 输入上下文",
      "来自PRD和REQ-001/SCN-001",
      "## Code Evidence",
      "新项目，无既有代码；这是样例事实。",
      "## Spec Traceability",
      "REQ-001 SCN-001",
      "## API Decisions",
      "x-auto-no-http-api: true",
      "## Data Decisions",
      "x-auto-no-sql: true",
      "## Technical Design",
      "通过内存索引查询",
      "## Risks / Open Questions",
      "大数据量性能需后续实测"
    ].join("\n") + "\n"
  const design = {
    feature: "orders",
    stage: "design",
    files: {
      "design.md": designText,
      ".design-contract.lock.json": JSON.stringify({
        version: 1,
        featureId: "orders",
        lockOwner: "dev.design",
        lockedAt: "2026-10-23T00:00:00Z",
        designContract: {
          sha256: createHash("sha256").update(designText).digest("hex"),
          apiIds: [],
          dataIds: [],
          decisionIds: [],
          noHttpApi: true,
          noSql: true
        }
      })
    }
  }
  const plan = JSON.parse(
    readFileSync(resolve("tests/fixtures/native-compositions/autobiz-plan.json"), "utf8")
  )
  return { normalized, prd, specs, design, plan }
}
