/**
 * Tests for the harnessboard system prompt template structure.
 *
 * Run:
 *   npx tsx tests/system-prompt-template.spec.ts
 */

import { readFile } from "fs/promises"
import { join } from "path"
import { fileURLToPath } from "url"
import { loadAgentSpec, renderTemplate } from "../src/main/agent/agent-spec.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const HARNESS_AGENT_SPEC_PATH = join(
  __dirname,
  "..",
  "src",
  "main",
  "agent",
  "templates",
  "harness",
  "agent.yaml"
)

async function testHarnessTemplateLoads(): Promise<void> {
  const spec = await loadAgentSpec(HARNESS_AGENT_SPEC_PATH)
  assert(spec.name === "cmb-cowork-harness", `Unexpected agent name: ${spec.name}`)
  assert(spec.tools.length > 0, "Expected non-empty tools list")

  const template = await readFile(spec.systemPromptPath, "utf-8")
  assert(template.includes("# Prompt and Tool Use"), "Missing Prompt and Tool Use section")
  assert(template.includes("# General Guidelines for Coding"), "Missing Coding section")
  assert(template.includes("# Working Environment"), "Missing Working Environment section")
  assert(
    template.includes("## Harness Project Context"),
    "Missing Harness Project Context subsection"
  )
  assert(template.includes("# Project Information"), "Missing Project Information section")
  assert(template.includes("${AGENTS_MD}"), "Missing AGENTS_MD variable")
  assert(template.includes("# Skills"), "Missing Skills section")
  assert(template.includes("# Tool Usage"), "Missing Tool Usage section")
  assert(template.includes("${TOOL_USAGE}"), "Missing TOOL_USAGE variable")
  assert(template.includes("# Ultimate Reminders"), "Missing Ultimate Reminders section")
}

async function testHarnessTemplateRendering(): Promise<void> {
  const spec = await loadAgentSpec(HARNESS_AGENT_SPEC_PATH)
  const template = await readFile(spec.systemPromptPath, "utf-8")

  const vars: Record<string, string> = {
    ROLE_ADDITIONAL: "You are in harness mode.",
    CMB_NOW: "2026-06-21T23:03:43+08:00",
    WORKSPACE_PATH: "/workspace",
    WORKSPACE_LS: "src/\nREADME.md",
    OS: "Windows",
    SHELL: "PowerShell",
    HARNESS_PROJECT_INFO: "- Feature: feat-123\n- Project Code: PROJ",
    AGENTS_MD: "# Project Rules\n\nAlways run tests.",
    SKILLS: "- skill-a\n- skill-b",
    TOOL_USAGE: "## Tool Routing Gate\n\nChoose a route."
  }

  const rendered = renderTemplate(template, vars)

  // Verify variables were substituted
  assert(!rendered.includes("${ROLE_ADDITIONAL}"), "ROLE_ADDITIONAL was not substituted")
  assert(!rendered.includes("${AGENTS_MD}"), "AGENTS_MD was not substituted")
  assert(!rendered.includes("${HARNESS_PROJECT_INFO}"), "HARNESS_PROJECT_INFO was not substituted")
  assert(!rendered.includes("${TOOL_USAGE}"), "TOOL_USAGE was not substituted")

  // Verify harness context appears inside Working Environment
  const workingEnvIndex = rendered.indexOf("# Working Environment")
  const harnessContextIndex = rendered.indexOf("## Harness Project Context")
  const projectInfoIndex = rendered.indexOf("# Project Information")
  assert(workingEnvIndex > 0, "Missing Working Environment section")
  assert(
    harnessContextIndex > workingEnvIndex,
    "Harness Project Context should be inside Working Environment"
  )
  assert(
    projectInfoIndex > harnessContextIndex,
    "Project Information should come after Harness Project Context"
  )

  // Verify AGENTS.md appears inside Project Information
  const agentsMdIndex = rendered.indexOf("# Project Rules")
  assert(agentsMdIndex > projectInfoIndex, "AGENTS.md content should be inside Project Information")

  // Verify role addition is at the top
  assert(rendered.startsWith("You are CmbCowork Agent"), "Should start with role declaration")
  assert(
    rendered.indexOf("You are in harness mode.") < workingEnvIndex,
    "Role addition should appear before Working Environment"
  )
}

async function testHarnessProjectInfoFormatting(): Promise<void> {
  // Minimal inline test of the formatting shape by rendering a small template
  const template = "${INFO}"
  const info = ["- Feature: feat-123", "- Project Code: PROJ", "- Plugin: autobizdevops"].join("\n")
  const rendered = renderTemplate(template, { INFO: info })
  assert(rendered.includes("- Feature: feat-123"), "Feature line missing")
  assert(rendered.includes("- Project Code: PROJ"), "Project code line missing")
}

async function main(): Promise<void> {
  await testHarnessTemplateLoads()
  await testHarnessTemplateRendering()
  await testHarnessProjectInfoFormatting()
  console.log("system-prompt-template.spec.ts: all tests passed")
}

main().catch((error) => {
  console.error("system-prompt-template.spec.ts failed:", error)
  process.exit(1)
})
