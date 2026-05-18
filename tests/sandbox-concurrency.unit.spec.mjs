import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const execPolicySource = readFileSync(new URL("../src/main/agent/exec-policy.ts", import.meta.url), "utf8")
const runtimeSource = readFileSync(new URL("../src/main/agent/runtime.ts", import.meta.url), "utf8")
const localSandboxSource = readFileSync(new URL("../src/main/agent/local-sandbox.ts", import.meta.url), "utf8")

function sectionBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`)
  const end = endMarker ? source.indexOf(endMarker, start) : -1
  return source.slice(start, end === -1 ? undefined : end)
}

test("command concurrency classification is stricter than command approval safety", () => {
  assert.match(
    execPolicySource,
    /export function classifyCommandConcurrency\(command: string\): CommandConcurrencyClassification/,
    "exec-policy should expose a dedicated concurrency classifier"
  )
  assert.match(
    execPolicySource,
    /const PARALLEL_SAFE_EXECUTABLES = new Set/,
    "parallel-safe command allowlist should be explicit and reviewable"
  )
  assert.match(
    execPolicySource,
    /isSafeGit\(tokens\).*return "parallel_safe"/s,
    "read-only git commands should be eligible for parallel execution"
  )
  assert.doesNotMatch(
    sectionBetween(execPolicySource, "const PARALLEL_SAFE_EXECUTABLES = new Set", "const UNSAFE_FIND_OPTIONS"),
    /"npm"|"pnpm"|"yarn"|"mvn"|"gradle"|"pytest"/,
    "build and package commands should not be considered parallel-safe just because they may be approvable"
  )
})

test("runtime only shares read-only execute calls", () => {
  const exclusiveSection = sectionBetween(runtimeSource, "const EXCLUSIVE_TOOL_NAMES = new Set", "const SHARED_TOOL_NAMES = new Set")
  const sharedSection = sectionBetween(runtimeSource, "const SHARED_TOOL_NAMES = new Set", "function isRecord")
  const classifierSection = sectionBetween(runtimeSource, "function classifyToolConcurrency", "/**")

  assert.match(exclusiveSection, /"write_file"/, "write_file should be exclusive")
  assert.match(exclusiveSection, /"edit_file"/, "edit_file should be exclusive")
  assert.doesNotMatch(sharedSection, /"write_file"|"edit_file"/, "mutating file tools should not be shared")
  assert.match(
    classifierSection,
    /toolName === "execute"[\s\S]*classifyCommandConcurrency\(command\) === "parallel_safe"[\s\S]*\? "shared"[\s\S]*: "exclusive"/,
    "execute should be shared only for commands classified as parallel_safe"
  )
})

test("subagents use their own concurrency gate to avoid parent task deadlock", () => {
  const subagentSection = sectionBetween(runtimeSource, "const subagentMiddleware: any[] = [", "const generalPurposeSubagent =")
  const mainAgentSection = sectionBetween(runtimeSource, "return createAgent({", "createSubAgentMiddleware({")

  assert.match(
    runtimeSource,
    /const subagentToolConcurrencyMiddleware = createGradedToolConcurrencyMiddleware\(`\$\{toolConcurrencyQueueId\}:subagent`\)/,
    "subagents should have a separate queue id from the parent agent"
  )
  assert.match(
    subagentSection,
    /subagentToolConcurrencyMiddleware/,
    "subagent middleware should use the subagent-specific concurrency gate"
  )
  assert.doesNotMatch(
    subagentSection,
    /^\s*gradedToolConcurrencyMiddleware,?$/m,
    "subagents must not reuse the parent concurrency middleware instance"
  )
  assert.match(
    mainAgentSection,
    /gradedToolConcurrencyMiddleware/,
    "the parent agent should keep its own concurrency gate"
  )
})

test("local sandbox keeps risky commands exclusive while limiting read-only command parallelism", () => {
  const executeRawSection = sectionBetween(localSandboxSource, "async executeRaw(", "/**\n   * Execute a command inside")
  const executeInSandboxSection = sectionBetween(
    localSandboxSource,
    "private async executeInWindowsSandbox(",
    "private executeOnce("
  )

  assert.match(
    localSandboxSource,
    /private static readonly PARALLEL_SAFE_EXECUTION_LIMIT = 2/,
    "parallel-safe shell commands should have a bounded per-workspace limit"
  )
  assert.match(
    localSandboxSource,
    /private static async runParallelSafeExecution/,
    "local sandbox should have a separate shared execution path for read-only commands"
  )
  assert.match(
    executeRawSection,
    /effectiveSandboxMode === "none" \|\| backgroundExecution[\s\S]*executeRawUnserialized/,
    "background commands should bypass the foreground workspace gate"
  )
  assert.doesNotMatch(
    executeRawSection,
    /backgroundExecution \? "exclusive"/,
    "background commands must not hold the foreground exclusive gate until completion"
  )
  assert.match(
    executeRawSection,
    /const commandConcurrency = classifyCommandConcurrency\(command\)/,
    "foreground risky commands should still be classified in the sandbox layer"
  )
  assert.match(
    executeRawSection,
    /commandConcurrency === "parallel_safe"[\s\S]*runParallelSafeExecution[\s\S]*runSerializedExecution/,
    "executeRaw should route only parallel-safe commands around the exclusive queue"
  )
  assert.match(
    executeInSandboxSection,
    /sandboxCacheDirs = await LocalSandbox\.raceWithAbort\([\s\S]*LocalSandbox\.prepareSandboxCacheDirs/,
    "sandbox execution should wait for cache dirs before building ACL and writable roots"
  )
  assert.doesNotMatch(
    executeInSandboxSection,
    /void LocalSandbox\.prepareSandboxCacheDirs[\s\S]*getPreparedSandboxCacheDirs/,
    "sandbox execution must not fire-and-forget cache dir prep then immediately read partial results"
  )
})
