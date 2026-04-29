/**
 * Lightweight integration contract tests for Coordinator Mode plumbing.
 *
 * These tests do not launch Electron or a model. They verify the mode signal
 * crosses renderer -> preload -> IPC -> runtime and that coordinator runtime
 * stays isolated from the normal-mode tool surface.
 *
 * Run:
 *   npx -y tsx tests/coordinator-mode-plumbing.spec.ts
 */

import { readFile } from "fs/promises"
import { join, resolve } from "path"

const PROJECT_ROOT = resolve(__dirname, "..")

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function assertIncludes(value: string, expected: string, label: string): void {
  assert(value.includes(expected), `${label}: expected to include "${expected}"`)
}

function assertMatches(value: string, pattern: RegExp, label: string): void {
  assert(pattern.test(value), `${label}: expected to match ${pattern}`)
}

async function readProjectFile(path: string): Promise<string> {
  return readFile(join(PROJECT_ROOT, path), "utf8")
}

async function testIpcTypesExposeAgentMode(): Promise<void> {
  const types = await readProjectFile("src/main/types.ts")
  assertMatches(
    types,
    /interface AgentInvokeParams[\s\S]*agentMode\?: "normal" \| "coordinator"/,
    "AgentInvokeParams"
  )
  assertMatches(
    types,
    /interface AgentResumeParams[\s\S]*agentMode\?: "normal" \| "coordinator"/,
    "AgentResumeParams"
  )
}

async function testRendererSendsAgentMode(): Promise<void> {
  const switcher = await readProjectFile("src/renderer/src/components/chat/AgentModeSwitcher.tsx")
  assertIncludes(switcher, 'value: "normal"', "AgentModeSwitcher exposes normal mode")
  assertIncludes(switcher, 'value: "coordinator"', "AgentModeSwitcher exposes coordinator mode")
  assertIncludes(
    switcher,
    "选择这次任务是快速直达，还是走多角色 harness",
    "AgentModeSwitcher explains coordinator-only flow"
  )
  assertIncludes(switcher, "setOpen(false)", "AgentModeSwitcher closes after selection")
  assertIncludes(
    switcher,
    "适合日常问答、小范围修改和快速排查",
    "AgentModeSwitcher explains normal mode"
  )
  assertIncludes(
    switcher,
    "适合完整开发任务、文档产出和需要独立验证的改动",
    "AgentModeSwitcher explains coordinator mode"
  )

  const chat = await readProjectFile("src/renderer/src/components/chat/ChatContainer.tsx")
  assertIncludes(chat, "AgentModeSwitcher", "ChatContainer imports mode switcher")
  assertIncludes(chat, 'useState<ChatAgentMode>("normal")', "ChatContainer default mode")
  assertIncludes(
    chat,
    'setAgentMode(metadata.agentMode === "coordinator" ? "coordinator" : "normal")',
    "ChatContainer hydrates mode from thread metadata"
  )
  assertIncludes(
    chat,
    "metadata: { ...metadata, agentMode: nextMode }",
    "ChatContainer persists metadata"
  )
  assertIncludes(chat, "agent_mode: agentMode", "ChatContainer stream config")
  assertIncludes(chat, "disabled={isLoading}", "ChatContainer disables mode switcher while running")

  const transport = await readProjectFile("src/renderer/src/lib/electron-transport.ts")
  assertIncludes(
    transport,
    "payload.config?.configurable?.agent_mode",
    "Electron transport reads agent_mode"
  )
  assertMatches(
    transport,
    /window\.api\.agent\.streamAgent\([\s\S]*modelId,\s*agentMode/,
    "Electron transport forwards agentMode"
  )

  const preload = await readProjectFile("src/preload/index.ts")
  assertMatches(
    preload,
    /ipcRenderer\.send\("agent:invoke", \{ threadId, message, modelId, agentMode \}\)/,
    "preload invoke forwards agentMode"
  )
  assertMatches(
    preload,
    /ipcRenderer\.send\("agent:resume", \{ threadId, command, modelId, agentMode \}\)/,
    "preload resume forwards agentMode"
  )
}

async function testMainResolvesAndPersistsMode(): Promise<void> {
  const agentIpc = await readProjectFile("src/main/ipc/agent.ts")
  assertIncludes(agentIpc, "resolveCoordinatorHarnessRequest", "agent IPC imports harness resolver")
  assertIncludes(
    agentIpc,
    "getAgentModeFromMetadata(metadata)",
    "agent IPC can load persisted mode"
  )
  assertIncludes(agentIpc, "requestedAgentMode", "agent IPC reads requested mode")
  assertIncludes(
    agentIpc,
    'requestedMode ?? (harnessRequest.enabled ? "coordinator" : metadataAgentMode)',
    "agent IPC resolves requested mode before metadata/prefix fallback"
  )
  assertIncludes(agentIpc, "metadata.agentMode = effectiveAgentMode", "agent IPC persists mode")
  assertIncludes(agentIpc, 'type: "agent_mode"', "agent IPC emits active mode event")
  assertIncludes(agentIpc, "agentMode: effectiveAgentMode", "agent IPC passes mode to runtime")
  assertIncludes(agentIpc, "agentMode: interruptAgentMode", "interrupt IPC passes mode to runtime")
  assertIncludes(agentIpc, "agentMode: resumeAgentMode", "resume IPC passes mode to runtime")
}

async function testRuntimeKeepsNormalAndCoordinatorSeparate(): Promise<void> {
  const runtime = await readProjectFile("src/main/agent/runtime.ts")
  assertIncludes(runtime, 'agentMode = "normal"', "runtime defaults to normal mode")
  assertIncludes(
    runtime,
    'const isCoordinatorMode = agentMode === "coordinator"',
    "runtime mode guard"
  )
  assertIncludes(runtime, "getRuntimeTimeContext()", "runtime creates shared time context")
  assertIncludes(
    runtime,
    "Timestamp rule: Do not invent dates or timestamps",
    "runtime subagent prompt time rule"
  )
  assertIncludes(
    runtime,
    "createCoordinatorHarnessTools({ workspacePath, threadId })",
    "runtime creates coordinator tools"
  )
  assertIncludes(
    runtime,
    "systemPrompt = buildCoordinatorSystemPrompt",
    "runtime replaces normal prompt in coordinator mode"
  )
  assertIncludes(runtime, "threadId,", "runtime passes threadId into coordinator prompt")
  assertIncludes(
    runtime,
    "timezone: timeContext.timezone",
    "runtime passes timezone into coordinator prompt"
  )
  assertIncludes(
    runtime,
    "currentTime: timeContext.currentTime",
    "runtime passes current time into coordinator prompt"
  )
  assertIncludes(
    runtime,
    "Current time: ${timeContext.currentTime}",
    "runtime keeps subagent time format aligned with normal mode"
  )
  assertIncludes(
    runtime,
    "mainTools = isCoordinatorMode ? coordinatorHarnessTools : finalTools",
    "runtime main tool split"
  )
  assertIncludes(runtime, "workerTools = finalTools", "runtime keeps full tools for workers")
  assertIncludes(runtime, "subagentDefaultTools: workerTools", "runtime worker tool split")
  assertIncludes(
    runtime,
    "mainTodosEnabled: !isCoordinatorMode",
    "runtime disables coordinator todos"
  )
  assertIncludes(
    runtime,
    "mainFilesystemEnabled: !isCoordinatorMode",
    "runtime disables coordinator filesystem"
  )
  assertIncludes(
    runtime,
    "includeGeneralPurposeSubagent: !isCoordinatorMode",
    "runtime hides general worker in coordinator"
  )
  assertIncludes(runtime, "buildHarnessSubagents(", "runtime registers harness subagents")
  assertIncludes(runtime, "timeContext", "runtime passes time context into harness subagents")
  assertIncludes(
    runtime,
    "buildCoordinatorTaskPrompt(threadId)",
    "runtime scopes task prompt to threadId"
  )
  assertIncludes(
    runtime,
    "skills: mainSkillSources",
    "runtime avoids injecting full skill middleware into coordinator main thread"
  )
  assertIncludes(
    runtime,
    "memory: mainMemorySources",
    "runtime avoids injecting memory middleware into coordinator main thread"
  )
}

async function run(): Promise<void> {
  await testIpcTypesExposeAgentMode()
  console.log("PASS coordinator IPC types")
  await testRendererSendsAgentMode()
  console.log("PASS coordinator renderer/preload plumbing")
  await testMainResolvesAndPersistsMode()
  console.log("PASS coordinator main IPC mode handling")
  await testRuntimeKeepsNormalAndCoordinatorSeparate()
  console.log("PASS coordinator runtime isolation")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
