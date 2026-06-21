/**
 * Tests for agent spec parsing and template rendering.
 *
 * Run:
 *   npx tsx tests/agent-spec.spec.ts
 */

import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  loadAgentSpec,
  renderTemplate,
  resolveSystemPromptPath,
  AgentSpecError
} from "../src/main/agent/agent-spec.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function testRenderTemplate(): Promise<void> {
  const template = "Hello ${NAME}, you are on ${OS}."
  const result = renderTemplate(template, { NAME: "World", OS: "Windows" })
  assert(result === "Hello World, you are on Windows.", `Unexpected render result: ${result}`)
}

async function testRenderTemplateUnknownVariable(): Promise<void> {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  }

  try {
    const template = "Hello ${KNOWN}, unknown ${UNKNOWN}."
    const result = renderTemplate(template, { KNOWN: "world" })
    assert(result === "Hello world, unknown .", `Unexpected result: ${result}`)
    assert(
      warnings.some((w) => w.includes("UNKNOWN")),
      "Expected warning for unknown variable"
    )
  } finally {
    console.warn = originalWarn
  }
}

async function testResolveSystemPromptPath(): Promise<void> {
  const absolute = resolveSystemPromptPath("/foo", "/bar/system.md")
  assert(absolute === "/bar/system.md", `Expected absolute path, got ${absolute}`)

  const relative = resolveSystemPromptPath("/foo", "./system.md")
  assert(
    relative.includes("foo") && relative.endsWith("system.md"),
    `Expected resolved relative path containing foo and ending with system.md, got ${relative}`
  )
}

async function testLoadAgentSpec(): Promise<void> {
  await withTempDir("agent-spec", async (dir) => {
    const agentYaml = `
version: 1
agent:
  name: "test-agent"
  system_prompt_path: ./system.md
  system_prompt_args:
    ROLE_ADDITIONAL: "Test role"
  tools:
    - "ToolA"
    - "ToolB"
  subagents:
    worker:
      path: ./worker.yaml
      description: "A worker agent"
`
    await writeFile(join(dir, "agent.yaml"), agentYaml, "utf8")
    await writeFile(join(dir, "system.md"), "system prompt", "utf8")

    const spec = await loadAgentSpec(join(dir, "agent.yaml"))
    assert(spec.name === "test-agent", `Unexpected name: ${spec.name}`)
    assert(spec.systemPromptPath === join(dir, "system.md"), "Unexpected system prompt path")
    assert(spec.systemPromptArgs.ROLE_ADDITIONAL === "Test role", "Unexpected role arg")
    assert(spec.tools.length === 2, `Expected 2 tools, got ${spec.tools.length}`)
    assert(spec.tools[0] === "ToolA", `Unexpected tool: ${spec.tools[0]}`)
    assert(spec.subagents.worker.description === "A worker agent", "Unexpected subagent desc")
  })
}

async function testLoadAgentSpecMissingName(): Promise<void> {
  await withTempDir("agent-spec-missing", async (dir) => {
    const agentYaml = `
version: 1
agent:
  system_prompt_path: ./system.md
`
    await writeFile(join(dir, "agent.yaml"), agentYaml, "utf8")

    try {
      await loadAgentSpec(join(dir, "agent.yaml"))
      assert(false, "Expected AgentSpecError")
    } catch (error) {
      assert(error instanceof AgentSpecError, `Expected AgentSpecError, got ${error}`)
    }
  })
}

async function testLoadAgentSpecInvalidYaml(): Promise<void> {
  await withTempDir("agent-spec-yaml", async (dir) => {
    await writeFile(join(dir, "agent.yaml"), "not: valid: yaml: [", "utf8")

    try {
      await loadAgentSpec(join(dir, "agent.yaml"))
      assert(false, "Expected AgentSpecError")
    } catch (error) {
      assert(error instanceof AgentSpecError, `Expected AgentSpecError, got ${error}`)
    }
  })
}

async function main(): Promise<void> {
  await testRenderTemplate()
  await testRenderTemplateUnknownVariable()
  await testResolveSystemPromptPath()
  await testLoadAgentSpec()
  await testLoadAgentSpecMissingName()
  await testLoadAgentSpecInvalidYaml()
  console.log("agent-spec.spec.ts: all tests passed")
}

main().catch((error) => {
  console.error("agent-spec.spec.ts failed:", error)
  process.exit(1)
})
