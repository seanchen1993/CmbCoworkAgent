/**
 * Architecture contract for the transport-neutral standard-turn preparation
 * and controlled Runtime factory introduced by unified-bot PR-B.
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

const PROJECT_ROOT = resolve(__dirname, "..")

function read(relativePath: string): string {
  return readFileSync(join(PROJECT_ROOT, relativePath), "utf8").replace(/\r\n/g, "\n")
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertIncludes(source: string, expected: string, label: string): void {
  assert(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`)
}

function assertNotIncludes(source: string, expected: string, label: string): void {
  assert(!source.includes(expected), `${label}: unexpectedly includes ${JSON.stringify(expected)}`)
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1
}

const shared = read("src/main/agent/standard-thread-turn.ts")
const desktop = read("src/main/ipc/agent.ts")
const packageJson = read("package.json")

for (const electronDependency of ['from "electron"', "BrowserWindow", "ipcMain", "webContents"]) {
  assertNotIncludes(
    shared,
    electronDependency,
    `standard-turn preparation is headless (${electronDependency})`
  )
}

for (const sharedApi of [
  "export function parseStandardThreadMetadata(",
  "export async function resolveHarnessFeatureBindingContext(",
  "export async function getHarnessAgentContext(",
  "export function getHarnessHookContext(",
  "export async function prepareStandardUserPrompt(",
  "export async function resolveStandardTurnRouting(",
  "export function createStandardTurnTrace(",
  "export function prepareStandardThreadRuntimeFactory("
]) {
  assertIncludes(shared, sharedApi, `shared API ${sharedApi}`)
}

assertIncludes(
  shared,
  "return createAgentRuntime(options)",
  "controlled factory delegates to the existing Runtime"
)
assertIncludes(
  shared,
  "assertLocalThreadRunLease(options.threadId, input.runLease.owner, input.runLease.runId)",
  "controlled factory refuses Runtime creation without the exact local lease"
)
assertNotIncludes(
  desktop,
  "createAgentRuntime(",
  "desktop IPC cannot bypass the controlled Runtime factory"
)
assertNotIncludes(
  desktop,
  "async function prepareUserPromptForRun(",
  "desktop IPC no longer owns a private prompt preparation copy"
)
assertNotIncludes(
  desktop,
  "function getHarnessAgentContext(",
  "desktop IPC no longer owns a private Harness preparation copy"
)
assertNotIncludes(
  desktop,
  "JSON.parse(thread.metadata",
  "desktop Runtime entrypoints use the shared Thread metadata parser"
)
assert(
  count(desktop, "parseStandardThreadMetadata(") === 10,
  "all ten desktop Thread metadata reads use the shared parser, including the remote inbox guard"
)
for (const metadataField of [
  'typeof metadata.workspacePath === "string"',
  'typeof metadata.model === "string"',
  "agentMode: getAgentModeFromMetadata(metadata)"
]) {
  assertIncludes(shared, metadataField, `shared Thread metadata field ${metadataField}`)
}

assert(count(desktop, "prepareStandardThreadRuntimeFactory({") === 3, "one factory per IPC mode")
assert(count(desktop, "invokeRuntimeFactory.create(") === 3, "invoke failover uses one factory")
assert(count(desktop, "resumeRuntimeFactory.create(") === 2, "resume failover uses one factory")
assert(
  count(desktop, "interruptRuntimeFactory.create(") === 2,
  "interrupt failover uses one factory"
)

for (const restrictivePolicyMapping of [
  "policy.disableScheduler ? { noSchedulerTool: true }",
  "policy.disableSkillEvolution ? { noSkillEvolutionTool: true }",
  "policy.disableRequestUserInput ? { enableRequestUserInput: false }",
  "policy.disableSubagents ? { disableSubagents: true }",
  "policy.disableMemoryInjection ? { disableMemoryInjection: true }",
  "policy.disableAgentsPrompt ? { enableAgentsPrompt: false }"
]) {
  assertIncludes(
    shared,
    restrictivePolicyMapping,
    `remote policy only narrows Runtime capability (${restrictivePolicyMapping})`
  )
}

assertIncludes(
  packageJson,
  "tests/standard-thread-turn-architecture.spec.ts",
  "architecture contract runs in the desktop baseline suite"
)

console.log("standard-thread-turn-architecture.spec.ts passed")
