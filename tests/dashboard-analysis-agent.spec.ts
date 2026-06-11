/**
 * Unit tests for dashboard analysis agent helpers.
 *
 * Run:
 *   npx tsx tests/dashboard-analysis-agent.spec.ts
 */

import {
  buildDashboardToolRetryMessage,
  mergeDashboardAnalysisToolContext
} from "../src/main/services/dashboard-analysis-agent.ts"
import type { DashboardEsQueryInput } from "../src/main/services/dashboard-es-query.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function testPanelContextOverridesToolContext(): void {
  const input: DashboardEsQueryInput = {
    indexAlias: "event",
    operation: "search",
    body: { size: 0 },
    context: {
      scope: "platform",
      upperOrgLv1: "模型传入组织",
      projectId: "tool-project",
      featureSlug: "tool-feature"
    }
  }

  const merged = mergeDashboardAnalysisToolContext(input, {
    scope: "project",
    upperOrgLv1: ["面板组织"],
    projectId: "panel-project"
  })

  assert(merged.context?.scope === "project", "panel scope should override tool scope")
  assert(
    Array.isArray(merged.context?.upperOrgLv1) && merged.context.upperOrgLv1[0] === "面板组织",
    "panel org filter should override tool org filter"
  )
  assert(merged.context?.projectId === "panel-project", "panel project should override tool project")
  assert(
    merged.context?.featureSlug === "tool-feature",
    "tool feature should be preserved when panel context does not specify one"
  )
}

function testToolRetryMessageGuidesJsonRepair(): void {
  const message = buildDashboardToolRetryMessage(new Error("ES query body must be a JSON object"))
  assert(message.includes("Please retry"), "retry message should ask the model to retry")
  assert(message.includes("strict JSON object"), "retry message should mention strict JSON")
  assert(message.includes("body must be a JSON object"), "retry message should mention body object")
  assert(message.includes("not a string"), "retry message should reject stringified DSL")
}

function run(): void {
  testPanelContextOverridesToolContext()
  console.log("PASS dashboard analysis agent context guard")
  testToolRetryMessageGuidesJsonRepair()
  console.log("PASS dashboard analysis agent retry guidance")
}

run()
