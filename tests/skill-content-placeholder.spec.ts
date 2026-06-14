/**
 * Tests for runtime placeholder rendering in AGENTS.md-compatible skill content paths.
 *
 * Run:
 *   npx tsx tests/skill-content-placeholder.spec.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"
import {
  hasCompleteHarnessPlaceholderContext,
  replaceHarnessPlaceholders
} from "../src/main/agent/placeholders.ts"
import { SkillLifecycleRegistry } from "../src/main/agent/skill-lifecycle/registry.ts"
import { enrichHookResultWithRequiredSkill } from "../src/main/hooks/required-skill.ts"
import { deletePlugin, getCustomSkillsDir, upsertPlugin } from "../src/main/storage.ts"
import type { HookResult } from "../src/main/hooks/types.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function normalizeExpectedPath(value: string): string {
  return resolve(value).replace(/\\/g, "/")
}

async function writeSkill(
  rootDir: string,
  name: string,
  body = [
    "plugin={PLUGIN_ROOT}",
    "workspace={PLUGIN_WORKSPACE}",
    "code={PROJECT_CODE}",
    "feature={FEATURE_ID}"
  ].join("\n")
): Promise<string> {
  await mkdir(rootDir, { recursive: true })
  const skillPath = join(rootDir, "SKILL.md")
  await writeFile(skillPath, ["---", `name: ${name}`, "---", "", body].join("\n"), "utf8")
  return skillPath
}

function baseHookResult(requiredSkill: string, overrides: Partial<HookResult> = {}): HookResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: false,
    requiredSkill,
    ...overrides
  }
}

function uniqueName(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

function assertRenderedSkillContent(
  output: string,
  expected: {
    pluginRoot?: string
    pluginWorkspace: string
    projectCode: string
    featureId: string
  }
): void {
  if (expected.pluginRoot) {
    assert(
      output.includes(`plugin=${normalizeExpectedPath(expected.pluginRoot)}`),
      `PLUGIN_ROOT should render, got: ${output}`
    )
  }
  assert(
    output.includes(`workspace=${normalizeExpectedPath(expected.pluginWorkspace)}`),
    `PLUGIN_WORKSPACE should render, got: ${output}`
  )
  assert(output.includes(`code=${expected.projectCode}`), `PROJECT_CODE should render: ${output}`)
  assert(output.includes(`feature=${expected.featureId}`), `FEATURE_ID should render: ${output}`)
}

function testSharedPlaceholderHelper(): void {
  const rendered = replaceHarnessPlaceholders(
    [
      "plugin={PLUGIN_ROOT}",
      "workspace={PLUGIN_WORKSPACE}",
      "code=[{PROJECT_CODE}]",
      "feature=[{FEATURE_ID}]",
      "unknown={UNKNOWN_PLACEHOLDER}"
    ].join("\n"),
    {
      pluginRoot: "C:\\plugins\\demo",
      pluginWorkspace: "C:\\workspaces\\demo",
      projectCode: "   ",
      featureId: "feature-1"
    }
  )

  assert(rendered.includes("plugin=C:/plugins/demo"), `plugin path should normalize: ${rendered}`)
  assert(
    rendered.includes("workspace=C:/workspaces/demo"),
    `workspace path should normalize: ${rendered}`
  )
  assert(rendered.includes("code=[   ]"), `PROJECT_CODE should not trim: ${rendered}`)
  assert(rendered.includes("feature=[feature-1]"), `FEATURE_ID should render: ${rendered}`)
  assert(
    rendered.includes("unknown={UNKNOWN_PLACEHOLDER}"),
    `unknown placeholders should remain: ${rendered}`
  )

  const retained = replaceHarnessPlaceholders(
    "plugin={PLUGIN_ROOT} workspace={PLUGIN_WORKSPACE} code={PROJECT_CODE} feature={FEATURE_ID}",
    { pluginRoot: "", pluginWorkspace: "", projectCode: "", featureId: "" }
  )
  assert(
    retained.includes("{PLUGIN_ROOT}") &&
      retained.includes("{PLUGIN_WORKSPACE}") &&
      retained.includes("{PROJECT_CODE}") &&
      retained.includes("{FEATURE_ID}"),
    `empty values should retain placeholders: ${retained}`
  )
  assert(
    hasCompleteHarnessPlaceholderContext({
      pluginWorkspace: "workspace",
      projectCode: "project",
      featureId: "feature"
    }),
    "complete harness context should be detected"
  )
  assert(
    !hasCompleteHarnessPlaceholderContext({
      pluginWorkspace: "workspace",
      projectCode: "",
      featureId: "feature"
    }),
    "empty projectCode should make harness context incomplete"
  )
}

async function testLocalSandboxRendersStandaloneSkill(): Promise<void> {
  await withTempDir("skill-placeholder-standalone", async (dir) => {
    const skillRoot = join(dir, "skills", "demo")
    const workspace = join(dir, "workspace")
    await mkdir(workspace, { recursive: true })
    await writeSkill(skillRoot, "placeholder-standalone")
    const sandbox = new LocalSandbox({
      rootDir: dir,
      pluginRoot: join(dir, "harness-plugin"),
      pluginWorkspace: workspace,
      projectCode: "PROJ-1",
      featureId: "feature-a",
      skillLifecycleRegistry: new SkillLifecycleRegistry([join(dir, "skills")])
    })

    const output = await sandbox.read(join(skillRoot, "SKILL.md"), 0, 20)
    assertRenderedSkillContent(output, {
      pluginRoot: join(dir, "harness-plugin"),
      pluginWorkspace: workspace,
      projectCode: "PROJ-1",
      featureId: "feature-a"
    })
  })
}

async function testLocalSandboxRendersPluginSkillRoot(): Promise<void> {
  await withTempDir("skill-placeholder-plugin", async (dir) => {
    const pluginRoot = join(dir, "plugins", "demo-plugin")
    const workspace = join(dir, "workspace")
    await mkdir(workspace, { recursive: true })
    await writeSkill(pluginRoot, "placeholder-plugin")
    const sandbox = new LocalSandbox({
      rootDir: dir,
      pluginRoot: join(dir, "harness-plugin"),
      pluginWorkspace: workspace,
      projectCode: "PROJ-2",
      featureId: "feature-b",
      skillLifecycleRegistry: new SkillLifecycleRegistry([
        {
          sourceDir: pluginRoot,
          pluginId: "demo-plugin",
          pluginName: "Demo Plugin",
          pluginRoot
        }
      ])
    })

    const output = await sandbox.read(join(pluginRoot, "SKILL.md"), 0, 20)
    assertRenderedSkillContent(output, {
      pluginRoot,
      pluginWorkspace: workspace,
      projectCode: "PROJ-2",
      featureId: "feature-b"
    })
  })
}

async function testLocalSandboxLeavesNonHarnessAndBundleFilesRaw(): Promise<void> {
  await withTempDir("skill-placeholder-raw", async (dir) => {
    const pluginRoot = join(dir, "plugins", "demo-plugin")
    await writeSkill(pluginRoot, "placeholder-raw")
    await mkdir(join(pluginRoot, "references"), { recursive: true })
    await writeFile(
      join(pluginRoot, "references", "template.txt"),
      "bundle plugin={PLUGIN_ROOT} workspace={PLUGIN_WORKSPACE}",
      "utf8"
    )
    const registry = new SkillLifecycleRegistry([
      {
        sourceDir: pluginRoot,
        pluginId: "demo-plugin",
        pluginName: "Demo Plugin",
        pluginRoot
      }
    ])

    const nonHarness = new LocalSandbox({
      rootDir: dir,
      skillLifecycleRegistry: registry
    })
    const rawSkill = await nonHarness.read(join(pluginRoot, "SKILL.md"), 0, 20)
    assert(rawSkill.includes("{PLUGIN_ROOT}"), `non-harness skill should stay raw: ${rawSkill}`)

    const harness = new LocalSandbox({
      rootDir: dir,
      pluginWorkspace: join(dir, "workspace"),
      projectCode: "PROJ-3",
      featureId: "feature-c",
      skillLifecycleRegistry: registry
    })
    const rawBundle = await harness.read(join(pluginRoot, "references", "template.txt"), 0, 20)
    assert(rawBundle.includes("{PLUGIN_ROOT}"), `bundle file should stay raw: ${rawBundle}`)
    assert(
      rawBundle.includes("{PLUGIN_WORKSPACE}"),
      `bundle workspace placeholder should stay raw: ${rawBundle}`
    )
  })
}

async function testRequiredSkillRendersHarnessContext(): Promise<void> {
  const skillName = uniqueName("required-placeholder")
  const skillRoot = join(getCustomSkillsDir(), skillName)
  const workspace = join(skillRoot, "workspace")
  try {
    await mkdir(workspace, { recursive: true })
    await writeSkill(skillRoot, skillName)

    const result = await enrichHookResultWithRequiredSkill(baseHookResult(skillName), {
      pluginRoot: join(skillRoot, "harness-plugin"),
      pluginWorkspace: workspace,
      projectCode: "PROJ-4",
      featureId: "feature-d"
    })
    const context = result?.additionalContext ?? ""
    assertRenderedSkillContent(context, {
      pluginRoot: join(skillRoot, "harness-plugin"),
      pluginWorkspace: workspace,
      projectCode: "PROJ-4",
      featureId: "feature-d"
    })

    const raw = await enrichHookResultWithRequiredSkill(baseHookResult(skillName), {
      pluginRoot: join(skillRoot, "harness-plugin"),
      pluginWorkspace: workspace,
      featureId: "feature-d"
    })
    assert(
      raw?.additionalContext?.includes("{PLUGIN_WORKSPACE}"),
      `missing projectCode should retain placeholders: ${raw?.additionalContext}`
    )
  } finally {
    await rm(skillRoot, { recursive: true, force: true })
  }
}

async function testRequiredSkillBlockingFieldsUseRenderedGuidance(): Promise<void> {
  const skillName = uniqueName("required-block-placeholder")
  const skillRoot = join(getCustomSkillsDir(), skillName)
  const workspace = join(skillRoot, "workspace")
  try {
    await mkdir(workspace, { recursive: true })
    await writeSkill(skillRoot, skillName)

    const result = await enrichHookResultWithRequiredSkill(
      baseHookResult(skillName, {
        blocked: true,
        stdout: "blocked",
        reason: "reason",
        stopReason: "stop"
      }),
      {
        pluginWorkspace: workspace,
        projectCode: "PROJ-5",
        featureId: "feature-e"
      }
    )

    for (const field of ["additionalContext", "stdout", "reason", "stopReason"] as const) {
      const value = result?.[field] ?? ""
      assert(value.includes("workspace="), `${field} should include guidance: ${value}`)
      assert(!value.includes("{PLUGIN_WORKSPACE}"), `${field} should be rendered: ${value}`)
    }
  } finally {
    await rm(skillRoot, { recursive: true, force: true })
  }
}

async function testRequiredSkillRendersPluginRoot(): Promise<void> {
  await withTempDir("required-placeholder-plugin", async (dir) => {
    const pluginId = uniqueName("placeholder-plugin")
    const skillName = uniqueName("required-plugin-placeholder")
    const pluginRoot = join(dir, "plugin")
    const workspace = join(dir, "workspace")
    await mkdir(workspace, { recursive: true })
    await writeSkill(pluginRoot, skillName)
    upsertPlugin({
      id: pluginId,
      name: "Placeholder Plugin",
      version: "0.0.0-test",
      description: "temporary test plugin",
      author: "test",
      path: pluginRoot,
      enabled: true,
      skillCount: 1,
      mcpServerCount: 0,
      origin: "local",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })

    try {
      const result = await enrichHookResultWithRequiredSkill(baseHookResult(skillName), {
        pluginRoot: join(dir, "harness-plugin"),
        pluginWorkspace: workspace,
        projectCode: "PROJ-6",
        featureId: "feature-f"
      })
      assertRenderedSkillContent(result?.additionalContext ?? "", {
        pluginRoot,
        pluginWorkspace: workspace,
        projectCode: "PROJ-6",
        featureId: "feature-f"
      })
    } finally {
      deletePlugin(pluginId)
    }
  })
}

async function run(): Promise<void> {
  testSharedPlaceholderHelper()
  console.log("PASS shared placeholder helper")
  await testLocalSandboxRendersStandaloneSkill()
  console.log("PASS LocalSandbox standalone SKILL.md rendering")
  await testLocalSandboxRendersPluginSkillRoot()
  console.log("PASS LocalSandbox plugin SKILL.md rendering")
  await testLocalSandboxLeavesNonHarnessAndBundleFilesRaw()
  console.log("PASS LocalSandbox raw non-harness and bundle files")
  await testRequiredSkillRendersHarnessContext()
  console.log("PASS requiredSkill harness rendering")
  await testRequiredSkillBlockingFieldsUseRenderedGuidance()
  console.log("PASS requiredSkill blocking field rendering")
  await testRequiredSkillRendersPluginRoot()
  console.log("PASS requiredSkill plugin root rendering")
}

run().catch((error: Error) => {
  console.error(`FAIL ${error.message}`)
  process.exit(1)
})
