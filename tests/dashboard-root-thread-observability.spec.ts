/**
 * Regression tests for root-thread observability query wiring.
 *
 * Run:
 *   npx tsx tests/dashboard-root-thread-observability.spec.ts
 */

import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertIncludes(source: string, expected: string, message: string): void {
  assert(source.includes(expected), `${message}: expected to find ${expected}`)
}

function assertNotIncludes(source: string, unexpected: string, message: string): void {
  assert(!source.includes(unexpected), `${message}: did not expect ${unexpected}`)
}

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start)
  assert(startIndex >= 0, `missing section start: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert(endIndex > startIndex, `missing section end: ${end}`)
  return source.slice(startIndex, endIndex)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const dashboardSource = readFileSync(join(__dirname, "../src/main/ipc/dashboard.ts"), "utf8")
const projectModePanelSource = readFileSync(
  join(__dirname, "../src/renderer/src/components/dashboard/panels/ProjectModePanel.tsx"),
  "utf8"
)

function testThreadListAggUsesRootThreadId(): void {
  const source = section(dashboardSource, "function threadListAgg", "function parseThreadListContainer")
  assertIncludes(
    source,
    'total_threads: { cardinality: { field: "rootThreadId" } }',
    "thread view total count should use rootThreadId"
  )
  assertIncludes(source, 'field: "rootThreadId"', "thread view buckets should use rootThreadId")
  assertNotIncludes(source, 'field: "threadId"', "thread view should not bucket by physical threadId")
}

function testCommitAdoptionUsesRootThreadId(): void {
  const source = section(dashboardSource, "async function fetchCommitAdoptionMap", "function attachCommitAdoption")
  assertIncludes(
    source,
    'by_thread: { terms: { field: "properties.rootThreadId", size: 50 } }',
    "commit adoption should aggregate root thread ids"
  )
}

function testCommitPairUsesRootThreadId(): void {
  const source = section(dashboardSource, "async function fetchCommitAdoptionEvents", "// ─────────────────────────────────────────────────────────\n// Dashboard data fetchers")
  assertIncludes(source, '"properties.rootThreadId"', "commit adoption event detail should load rootThreadId")
  assertIncludes(source, "eventRootThreadId(gen)", "paired gen rows should prefer rootThreadId")
  assertIncludes(source, "eventRootThreadId(adopt)", "unpaired adopt rows should prefer rootThreadId")
}

function testUncommittedDetailUsesRootThreadId(): void {
  const source = section(dashboardSource, "async function fetchUncommittedDetail", "return {")
  assertIncludes(source, '"properties.rootThreadId"', "uncommitted detail should load rootThreadId")
  assertIncludes(source, "threadId: eventRootThreadId(props)", "uncommitted samples should prefer rootThreadId")
}

function testDevMockContainsWorkflowAndTaskSubagents(): void {
  const source = section(dashboardSource, "function makeMockSubagentSessionTraces", "function makeMockAgentTrace")
  assertIncludes(source, 'subagentKind: "workflow_agent"', "mock should include workflow agent sub traces")
  assertIncludes(source, 'subagentKind: "task"', "mock should include task agent sub traces")
  assertIncludes(source, "rootThreadId: workflowRootThreadId", "workflow sub traces should link root thread")
  assertIncludes(source, "rootThreadId: taskRootThreadId", "task sub traces should link root thread")
}

function testDevMockContainsVisibleReasoning(): void {
  const helper = section(
    dashboardSource,
    "function makeMockTraceWithConversation",
    "function isSubagentMockTrace"
  )
  const linkedTraces = section(
    dashboardSource,
    "function makeMockSubagentSessionTraces",
    "function makeMockAgentTrace"
  )
  const ordinaryTraces = section(
    dashboardSource,
    "function makeMockAgentTrace",
    "function makeMockSkillRecentTraces"
  )
  assertIncludes(
    helper,
    "reasoning: args.initialReasoning",
    "conversation mock helper should attach initial reasoning"
  )
  assertIncludes(
    helper,
    "reasoning: args.finalReasoning",
    "conversation mock helper should attach final reasoning"
  )
  assertIncludes(linkedTraces, "finalReasoning:", "multi-agent mock should include reasoning")
  assertIncludes(ordinaryTraces, "reasoning:", "ordinary mock should include reasoning")
}

function testDevMockThreadTracesResolveNamespacedRootThread(): void {
  const source = section(dashboardSource, "function makeMockThreadTraces", "function makeMockSkillCodeStats")
  assertIncludes(
    source,
    "findMockThreadGroupForThreadId(groups, threadId)",
    "threadTraces mock should resolve namespaced root thread ids"
  )
  assertIncludes(
    source,
    "namespaceMockThreadGroupForRequest(exactGroup.traces, threadId)",
    "threadTraces mock should return full namespaced mock groups"
  )
}

function testProjectListConversationCountUsesActiveMainAgentTraces(): void {
  const filterSource = section(
    dashboardSource,
    "function projectModeMainAgentConversationFilter",
    "/** Build the `name@version` key"
  )
  assertIncludes(
    filterSource,
    "buildChatTriggeredTraceFilter()",
    "project-list conversation count should include only active triggers"
  )
  assertIncludes(
    filterSource,
    '{ term: { traceKind: "root" } }',
    "project-list conversation count should include root traces"
  )
  assertIncludes(
    filterSource,
    '{ exists: { field: "parentTraceId" } }',
    "legacy fallback should reject parent-linked child traces"
  )

  const usageSource = section(
    dashboardSource,
    "async function fetchProjectModePageUsage",
    "/**\n * Code-adoption stats for project mode."
  )
  assertIncludes(
    usageSource,
    "filter: projectModeMainAgentConversationFilter(),",
    "per-project usage should aggregate active main-Agent conversations separately"
  )
  assertIncludes(
    usageSource,
    "perProject.set(key, asNumber(mainAgentConversations.doc_count))",
    "project-list values and metric sorting should use the main-Agent bucket"
  )
  assertNotIncludes(
    usageSource,
    "perProject.set(key, asNumber(b.doc_count))",
    "project-list conversation count must not use the all-trace project bucket"
  )
}

function testSuspectedTechnicalDetailMetricIsGatedAndNested(): void {
  const accessSource = section(
    dashboardSource,
    "const DASHBOARD_ALLOWED_IDS_ENV",
    "function getDashboardAccessContext"
  )
  assertIncludes(
    accessSource,
    "VITE_DASHBOARD_SUSPECTED_TECHNICAL_DETAIL_YST_IDS",
    "technical-detail metric access should come from encrypted environment configuration"
  )

  const usageSource = section(
    dashboardSource,
    "async function fetchProjectModePageUsage",
    "/**\n * Code-adoption stats for project mode."
  )
  assertIncludes(
    usageSource,
    "includeSuspectedTechnicalDetail",
    "technical-detail aggregation should be conditional on viewer access"
  )
  assertIncludes(
    usageSource,
    "filter: { term: { suspectedTechnicalDetailSupplement: true } }",
    "technical-detail count should use the forward-only trace boolean"
  )
  assertIncludes(
    projectModePanelSource,
    "用户输入全文中累计包含 10 个及以上英文字母的会话数量",
    "technical-detail metric should explain its conversation-count heuristic in the UI"
  )
  assertNotIncludes(
    projectModePanelSource,
    "历史 Trace 不回填",
    "technical-detail metric should not expose trace implementation details in the UI"
  )
}

function testProjectListConversationCountExplainsItsScope(): void {
  assertIncludes(
    projectModePanelSource,
    "仅统计主动触发的主 Agent 会话",
    "project-list conversation count should expose its scope in an info hint"
  )
  assertIncludes(
    projectModePanelSource,
    "也不包含子 Agent 会话",
    "project-list conversation count hint should explain child traces are excluded"
  )
}

function run(): void {
  testThreadListAggUsesRootThreadId()
  console.log("PASS dashboard thread list rootThreadId aggregation")
  testCommitAdoptionUsesRootThreadId()
  console.log("PASS dashboard commit adoption rootThreadId aggregation")
  testCommitPairUsesRootThreadId()
  console.log("PASS dashboard commit pair rootThreadId detail")
  testUncommittedDetailUsesRootThreadId()
  console.log("PASS dashboard uncommitted rootThreadId detail")
  testDevMockContainsWorkflowAndTaskSubagents()
  console.log("PASS dashboard dev mock workflow/task subagents")
  testDevMockContainsVisibleReasoning()
  console.log("PASS dashboard dev mock visible reasoning")
  testDevMockThreadTracesResolveNamespacedRootThread()
  console.log("PASS dashboard dev mock namespaced threadTraces")
  testProjectListConversationCountUsesActiveMainAgentTraces()
  console.log("PASS dashboard project-list active main-Agent conversation count")
  testProjectListConversationCountExplainsItsScope()
  console.log("PASS dashboard project-list conversation-count scope hint")
  testSuspectedTechnicalDetailMetricIsGatedAndNested()
  console.log("PASS dashboard project-list suspected technical-detail metric")
}

run()
