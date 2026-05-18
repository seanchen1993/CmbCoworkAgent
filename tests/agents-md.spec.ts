/**
 * Smoke tests for AGENTS.md discovery, ordering, budgets, and truncation.
 *
 * Run:
 *   npx tsx tests/agents-md.spec.ts
 */

import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "fs/promises"
import { tmpdir } from "os"
import { basename, join } from "path"
import * as agentsMd from "../src/main/agent/agents-md.ts"

const {
  discoverGlobalAgentsFiles,
  discoverAgentsFiles,
  findProjectRootByGitMarker,
  loadAgentsPromptForWorkspace,
  readAgentsFiles
} = agentsMd as typeof import("../src/main/agent/agents-md.ts")

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) {
        return true
      }
      index += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(await realpath(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function setupWorkspace(base: string): Promise<{
  root: string
  nested: string
  globalHome: string
}> {
  const root = join(base, "workspace")
  const nested = join(root, "packages", "app")
  const globalHome = join(base, "global-home")
  await mkdir(join(root, ".git"), { recursive: true })
  await mkdir(nested, { recursive: true })
  await mkdir(globalHome, { recursive: true })
  return { root, nested, globalHome }
}

async function testGlobalAndProjectOrdering(): Promise<void> {
  await withTempDir("agents-md-order", async (base) => {
    const { root, nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    await writeFile(join(globalHome, "AGENTS.md"), "GLOBAL_RULE", "utf8")
    await writeFile(join(root, "AGENTS.md"), "ROOT_RULE", "utf8")
    await writeFile(join(nested, "AGENTS.md"), "NESTED_RULE", "utf8")

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 2048
    })
    const prompt = result.prompt ?? ""
    assert(
      result.loadedPaths.length === 3,
      `expected 3 loaded paths, got ${result.loadedPaths.length}`
    )
    assert(result.loadedPaths[0].startsWith(globalHome), "global AGENTS should be listed first")
    assert(result.loadedPaths[1].startsWith(root), "root project AGENTS should be listed second")
    assert(result.loadedPaths[2].startsWith(nested), "nested project AGENTS should be listed third")
    assert(
      result.loadedPaths.every((path) => basename(path) === "AGENTS.md"),
      "expected AGENTS.md files"
    )
    assert(prompt.includes("# Global AGENTS.md instructions"), "missing global section")
    assert(prompt.includes("--- project-doc ---"), "missing project separator")
    assert(
      prompt.indexOf("GLOBAL_RULE") < prompt.indexOf("ROOT_RULE"),
      "global should render before project"
    )
    assert(
      prompt.indexOf("ROOT_RULE") < prompt.indexOf("NESTED_RULE"),
      "project should render root-to-cwd"
    )
    assert(result.truncated === false, "small files should not be truncated")
  })
}

async function testOverridePriority(): Promise<void> {
  await withTempDir("agents-md-override", async (base) => {
    const { root, nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    await writeFile(join(globalHome, "AGENTS.md"), "GLOBAL_NORMAL_SHOULD_NOT_LOAD", "utf8")
    await writeFile(join(globalHome, "AGENTS.override.md"), "GLOBAL_OVERRIDE", "utf8")
    await writeFile(join(root, "AGENTS.md"), "ROOT_NORMAL_SHOULD_NOT_LOAD", "utf8")
    await writeFile(join(root, "AGENTS.override.md"), "ROOT_OVERRIDE", "utf8")

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 1024
    })
    const prompt = result.prompt ?? ""
    assert(prompt.includes("GLOBAL_OVERRIDE"), "global override should load")
    assert(
      !prompt.includes("GLOBAL_NORMAL_SHOULD_NOT_LOAD"),
      "global normal file should be skipped"
    )
    assert(prompt.includes("ROOT_OVERRIDE"), "project override should load")
    assert(!prompt.includes("ROOT_NORMAL_SHOULD_NOT_LOAD"), "project normal file should be skipped")
  })
}

async function testGlobalSymlinkCannotEscapeHome(): Promise<void> {
  await withTempDir("agents-md-symlink", async (base) => {
    const { nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    const secretFile = join(base, "secret.txt")
    await writeFile(secretFile, "SECRET_SHOULD_NOT_LOAD", "utf8")
    await symlink(secretFile, join(globalHome, "AGENTS.md"))

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 1024
    })
    const prompt = result.prompt ?? ""
    assert(!prompt.includes("SECRET_SHOULD_NOT_LOAD"), "global AGENTS symlink escaped agents home")
    assert(
      result.loadedPaths.length === 0,
      "escaped global symlink should not be reported as loaded"
    )
  })
}

async function testGlobalSymlinkOverrideFallsBackToAgents(): Promise<void> {
  await withTempDir("agents-md-symlink-override", async (base) => {
    const { nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    const overrideTarget = join(globalHome, "override-target.md")
    await writeFile(overrideTarget, "GLOBAL_SYMLINK_OVERRIDE_SHOULD_NOT_LOAD", "utf8")
    await symlink(overrideTarget, join(globalHome, "AGENTS.override.md"))
    await writeFile(join(globalHome, "AGENTS.md"), "GLOBAL_NORMAL_FALLBACK", "utf8")

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 1024
    })
    const prompt = result.prompt ?? ""
    assert(
      !prompt.includes("GLOBAL_SYMLINK_OVERRIDE_SHOULD_NOT_LOAD"),
      "global symlink override should not load"
    )
    assert(prompt.includes("GLOBAL_NORMAL_FALLBACK"), "global AGENTS should fallback from symlink")
    assert(result.loadedPaths.length === 1, "only fallback global AGENTS should be loaded")
    assert(
      basename(result.loadedPaths[0]) === "AGENTS.md",
      "fallback global AGENTS.md should be reported as loaded"
    )
  })
}

async function testUnreadableGlobalOverrideFallsBackToAgents(): Promise<void> {
  await withTempDir("agents-md-unreadable-override", async (base) => {
    const { globalHome } = await setupWorkspace(base)

    const overridePath = join(globalHome, "AGENTS.override.md")
    await writeFile(overridePath, "GLOBAL_OVERRIDE_SHOULD_NOT_LOAD", "utf8")
    await writeFile(join(globalHome, "AGENTS.md"), "GLOBAL_NORMAL_AFTER_READ_FAILURE", "utf8")

    const globalFiles = await discoverGlobalAgentsFiles(globalHome)
    await rm(overridePath, { force: true })

    const result = await readAgentsFiles(globalFiles, 1024)
    const combined = result.entries.map((entry) => entry.content).join("\n")
    assert(
      !combined.includes("GLOBAL_OVERRIDE_SHOULD_NOT_LOAD"),
      "removed override should not load after read failure"
    )
    assert(
      combined.includes("GLOBAL_NORMAL_AFTER_READ_FAILURE"),
      "global AGENTS should fallback when override read fails"
    )
    assert(
      result.entries.length === 1 && basename(result.entries[0].path) === "AGENTS.md",
      "fallback global AGENTS.md should be reported as loaded after read failure"
    )
  })
}

async function testGlobalHardlinkCannotLoadSecret(): Promise<void> {
  await withTempDir("agents-md-hardlink", async (base) => {
    const { nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    const secretFile = join(base, "secret.txt")
    await writeFile(secretFile, "SECRET_FROM_HARDLINK_SHOULD_NOT_LOAD", "utf8")
    await link(secretFile, join(globalHome, "AGENTS.md"))

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 1024
    })
    const prompt = result.prompt ?? ""
    assert(
      !prompt.includes("SECRET_FROM_HARDLINK_SHOULD_NOT_LOAD"),
      "global AGENTS hardlink loaded external secret"
    )
    assert(result.loadedPaths.length === 0, "global hardlink should not be reported as loaded")
  })
}

async function testProjectHardlinkCannotLoadSecret(): Promise<void> {
  await withTempDir("agents-md-project-hardlink", async (base) => {
    const { root, nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    const secretFile = join(base, "project-secret.txt")
    await writeFile(secretFile, "PROJECT_SECRET_FROM_HARDLINK_SHOULD_NOT_LOAD", "utf8")
    await link(secretFile, join(root, "AGENTS.md"))

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 1024
    })
    const prompt = result.prompt ?? ""
    assert(
      !prompt.includes("PROJECT_SECRET_FROM_HARDLINK_SHOULD_NOT_LOAD"),
      "project AGENTS hardlink loaded external secret"
    )
    assert(result.loadedPaths.length === 0, "project hardlink should not be reported as loaded")
  })
}

async function testProjectSymlinkCannotLoadSecret(): Promise<void> {
  await withTempDir("agents-md-project-symlink", async (base) => {
    const { root, nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    const targetFile = join(root, ".env")
    await writeFile(targetFile, "SECRET_TOKEN_SHOULD_NOT_LOAD=abc123", "utf8")
    await symlink(targetFile, join(root, "AGENTS.md"))

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 1024
    })
    const prompt = result.prompt ?? ""
    assert(!prompt.includes("SECRET_TOKEN_SHOULD_NOT_LOAD"), "project AGENTS symlink loaded secret")
    assert(result.loadedPaths.length === 0, "project symlink should not be reported as loaded")
  })
}

async function testBlankAncestorAgentsDoesNotConsumeBudget(): Promise<void> {
  await withTempDir("agents-md-blank-ancestor", async (base) => {
    const { root, nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    await writeFile(join(root, "AGENTS.md"), " ".repeat(1000), "utf8")
    await writeFile(join(nested, "AGENTS.md"), "NESTED_SHOULD_LOAD", "utf8")

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 512
    })
    const prompt = result.prompt ?? ""
    assert(prompt.includes("NESTED_SHOULD_LOAD"), "blank ancestor should not consume budget")
    assert(result.loadedPaths.length === 1, "only nested AGENTS should be reported as loaded")
    assert(
      result.loadedPaths[0] === join(nested, "AGENTS.md"),
      "nested AGENTS should be reported as loaded"
    )
  })
}

async function testLeadingWhitespaceDoesNotConsumeBudget(): Promise<void> {
  await withTempDir("agents-md-leading-whitespace", async (base) => {
    const { root, nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    await writeFile(join(root, "AGENTS.md"), `${" ".repeat(500)}ROOT_RULE`, "utf8")
    await writeFile(
      join(nested, "AGENTS.md"),
      `NESTED_BEGIN\n${"N".repeat(120)}\nNESTED_END`,
      "utf8"
    )

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 700
    })
    const prompt = result.prompt ?? ""
    assert(prompt.includes("ROOT_RULE"), "leading whitespace file should keep useful content")
    assert(prompt.includes("NESTED_END"), "leading whitespace should not truncate nested AGENTS")
    assert(result.truncated === false, "rendered prompt fits and should not report truncation")
  })
}

async function testReadAgentsFilesLegacySignature(): Promise<void> {
  await withTempDir("agents-md-legacy-api", async (base) => {
    const { root, nested } = await setupWorkspace(base)

    await writeFile(join(root, "AGENTS.md"), "ROOT_LEGACY_RULE", "utf8")
    await writeFile(join(nested, "AGENTS.md"), "NESTED_LEGACY_RULE", "utf8")

    const projectRoot = await findProjectRootByGitMarker(nested)
    const files = await discoverAgentsFiles(projectRoot, nested)
    const result = await readAgentsFiles(nested, files, 2048)
    const combined = result.entries.map((entry) => entry.content).join("\n")
    assert(combined.includes("ROOT_LEGACY_RULE"), "legacy readAgentsFiles should load root")
    assert(combined.includes("NESTED_LEGACY_RULE"), "legacy readAgentsFiles should load nested")
    assert(result.truncated === false, "legacy readAgentsFiles should not truncate small docs")
  })
}

async function testSeparateGlobalAndProjectBudgets(): Promise<void> {
  await withTempDir("agents-md-budget", async (base) => {
    const { root, nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    const globalContent = `GLOBAL_BEGIN\n${"G".repeat(80)}\nGLOBAL_END`
    const projectContent = `PROJECT_BEGIN\n${"P".repeat(400)}\nPROJECT_END`
    await writeFile(join(globalHome, "AGENTS.md"), globalContent, "utf8")
    await writeFile(join(root, "AGENTS.md"), projectContent, "utf8")

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 500
    })
    const prompt = result.prompt ?? ""
    assert(prompt.includes("GLOBAL_END"), "global AGENTS should not use the project budget")
    assert(prompt.includes("PROJECT_BEGIN"), "project AGENTS should still be included")
    assert(!prompt.includes("PROJECT_END"), "project AGENTS should be truncated by project budget")
    assert(
      prompt.includes("[truncated to fit prompt budget]"),
      "truncated project AGENTS should be marked"
    )
    assert(result.truncated === true, "result should report truncation")
  })
}

async function testNumericBudgetAppliesToFinalPrompt(): Promise<void> {
  await withTempDir("agents-md-numeric-budget", async (base) => {
    const { root, nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    await writeFile(
      join(globalHome, "AGENTS.md"),
      `GLOBAL_BEGIN\n${"G".repeat(400)}\nGLOBAL_END`,
      "utf8"
    )
    await writeFile(
      join(root, "AGENTS.md"),
      `PROJECT_BEGIN\n${"P".repeat(400)}\nPROJECT_END`,
      "utf8"
    )

    const result = await loadAgentsPromptForWorkspace(nested, 500)
    const prompt = result.prompt ?? ""
    assert(Buffer.byteLength(prompt, "utf8") <= 500, "numeric budget should cap final prompt")
    assert(
      prompt.includes("PROJECT_BEGIN"),
      "numeric budget should keep project instructions first"
    )
    assert(result.truncated === true, "numeric budget truncation should be reported")
  })
}

async function testUtf8SafeTruncation(): Promise<void> {
  await withTempDir("agents-md-utf8", async (base) => {
    const { root, nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    await writeFile(join(root, "AGENTS.md"), `中文开始\n${"汉".repeat(400)}\n中文结束`, "utf8")

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 500
    })
    const prompt = result.prompt ?? ""
    assert(prompt.includes("中文开始"), "UTF-8 content should be loaded before truncation")
    assert(!prompt.includes("\uFFFD"), "UTF-8 truncation should not emit replacement characters")
    assert(result.truncated === true, "UTF-8 truncation should be reported")
  })
}

async function testEmojiSafeRenderedBudgetTruncation(): Promise<void> {
  await withTempDir("agents-md-emoji", async (base) => {
    const { root, nested, globalHome } = await setupWorkspace(base)
    process.env.CMB_COWORK_AGENT_HOME = globalHome

    await writeFile(join(root, "AGENTS.md"), `emoji开始\n${"😀".repeat(400)}\nemoji结束`, "utf8")

    const result = await loadAgentsPromptForWorkspace(nested, {
      globalMaxBytes: 1024,
      projectMaxBytes: 500
    })
    const prompt = result.prompt ?? ""
    assert(prompt.includes("emoji开始"), "emoji content should be loaded before truncation")
    assert(!prompt.includes("\uFFFD"), "emoji truncation should not emit replacement characters")
    assert(!hasLoneSurrogate(prompt), "emoji truncation should not leave lone surrogates")
    assert(result.truncated === true, "emoji truncation should be reported")
  })
}

async function run(): Promise<void> {
  try {
    await testGlobalAndProjectOrdering()
    console.log("PASS global/project ordering")
    await testOverridePriority()
    console.log("PASS override priority")
    await testGlobalSymlinkCannotEscapeHome()
    console.log("PASS global symlink boundary")
    await testGlobalSymlinkOverrideFallsBackToAgents()
    console.log("PASS global symlink override fallback")
    await testUnreadableGlobalOverrideFallsBackToAgents()
    console.log("PASS unreadable global override fallback")
    await testGlobalHardlinkCannotLoadSecret()
    console.log("PASS global hardlink boundary")
    await testProjectHardlinkCannotLoadSecret()
    console.log("PASS project hardlink boundary")
    await testProjectSymlinkCannotLoadSecret()
    console.log("PASS project symlink boundary")
    await testBlankAncestorAgentsDoesNotConsumeBudget()
    console.log("PASS blank ancestor AGENTS budget")
    await testLeadingWhitespaceDoesNotConsumeBudget()
    console.log("PASS leading whitespace AGENTS budget")
    await testReadAgentsFilesLegacySignature()
    console.log("PASS readAgentsFiles legacy signature")
    await testSeparateGlobalAndProjectBudgets()
    console.log("PASS separate global/project budgets")
    await testNumericBudgetAppliesToFinalPrompt()
    console.log("PASS numeric final budget compatibility")
    await testUtf8SafeTruncation()
    console.log("PASS UTF-8 safe truncation")
    await testEmojiSafeRenderedBudgetTruncation()
    console.log("PASS emoji safe rendered truncation")
  } finally {
    delete process.env.CMB_COWORK_AGENT_HOME
  }
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
