/**
 * Tests for configured system prompt loading.
 *
 * Run:
 *   npx tsx tests/system-prompt-config.spec.ts
 */

import { mkdtemp, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import {
  getSystemPromptCandidatePaths,
  loadConfiguredSystemPrompt
} from "../src/main/agent/system-prompt-config.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

async function withPromptHome(name: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  const previousHome = process.env.CMB_COWORK_AGENT_HOME
  process.env.CMB_COWORK_AGENT_HOME = dir
  try {
    await fn(dir)
  } finally {
    if (previousHome === undefined) {
      delete process.env.CMB_COWORK_AGENT_HOME
    } else {
      process.env.CMB_COWORK_AGENT_HOME = previousHome
    }
    await rm(dir, { recursive: true, force: true })
  }
}

async function testSessionSpecificPromptWins(): Promise<void> {
  await withPromptHome("system-prompt-session", async (dir) => {
    await writeFile(join(dir, "system-prompt.md"), "COMMON_PROMPT", "utf-8")
    await writeFile(join(dir, "session.system-prompt.md"), "SESSION_PROMPT", "utf-8")

    const result = await loadConfiguredSystemPrompt("session")

    assert(result.prompt === "SESSION_PROMPT", "session prompt should win")
    assert(
      result.path === join(dir, "session.system-prompt.md"),
      "session prompt path should be reported"
    )
  })
}

async function testHarnessboardSpecificPromptWins(): Promise<void> {
  await withPromptHome("system-prompt-harness", async (dir) => {
    await writeFile(join(dir, "system-prompt.md"), "COMMON_PROMPT", "utf-8")
    await writeFile(join(dir, "harnessboard.system-prompt.md"), "HARNESS_PROMPT", "utf-8")

    const result = await loadConfiguredSystemPrompt("harnessboard")

    assert(result.prompt === "HARNESS_PROMPT", "harnessboard prompt should win")
    assert(
      result.path === join(dir, "harnessboard.system-prompt.md"),
      "harnessboard prompt path should be reported"
    )
  })
}

async function testCommonPromptFallbackAndNoTemplateSubstitution(): Promise<void> {
  await withPromptHome("system-prompt-common", async (dir) => {
    const content = "COMMON ${ROLE_ADDITIONAL} ${AGENTS_MD}"
    await writeFile(join(dir, "system-prompt.md"), content, "utf-8")

    const sessionResult = await loadConfiguredSystemPrompt("session")
    const harnessResult = await loadConfiguredSystemPrompt("harnessboard")

    assert(sessionResult.prompt === content, "session should fall back to common prompt")
    assert(harnessResult.prompt === content, "harnessboard should fall back to common prompt")
  })
}

async function testMissingPromptThrowsWithCandidatePaths(): Promise<void> {
  await withPromptHome("system-prompt-missing", async (dir) => {
    const candidates = getSystemPromptCandidatePaths("session", dir)
    let message = ""
    try {
      await loadConfiguredSystemPrompt("session")
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    assert(message.includes("System prompt config is required for session mode."), "missing error")
    for (const candidate of candidates) {
      assert(message.includes(candidate), `missing candidate path: ${candidate}`)
    }
  })
}

async function main(): Promise<void> {
  await testSessionSpecificPromptWins()
  await testHarnessboardSpecificPromptWins()
  await testCommonPromptFallbackAndNoTemplateSubstitution()
  await testMissingPromptThrowsWithCandidatePaths()
  console.log("system-prompt-config.spec.ts: all tests passed")
}

main().catch((error) => {
  console.error("system-prompt-config.spec.ts failed:", error)
  process.exit(1)
})
