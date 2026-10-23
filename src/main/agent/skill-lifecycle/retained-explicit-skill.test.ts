import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { PluginMetadata } from "../../types"
import { RetainedPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"
import { getPluginSkillSearchSources, readPluginManifest } from "../../plugins/manifest"
import { SkillLifecycleRegistry } from "./registry"
import {
  appendRetainedExplicitSkillContext,
  relocateRetainedExplicitSkill
} from "./retained-explicit-skill"
import { formatSkillUseBlock, parseSkillUseBlock } from "./marker"

let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "retained-explicit-skill-"))
})
afterEach(() => {
  expect(root.split(/[\\/]/).at(-1)).toMatch(/^retained-explicit-skill-/)
  rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const installed = join(root, "installed"),
    workspace = join(root, "workspace")
  const name = "autobiz-requirement-discuss"
  const directory = join(installed, "skills/autobiz", name)
  mkdirSync(directory, { recursive: true })
  mkdirSync(workspace)
  writeFileSync(
    join(installed, "plugin.json"),
    JSON.stringify({
      name: "independent-state-plugin",
      version: "1.0.4",
      skills: ["skills"]
    })
  )
  const oldPath = join(directory, "SKILL.md")
  writeFileSync(
    oldPath,
    `---\nname: ${name}\ndescription: Original business Skill\n---\nRead original requirements.`
  )
  const snapshots = new RetainedPackageSnapshots(join(root, "snapshots"))
  const snapshot = snapshots.capture(installed)
  const retainedPath = join(snapshot.root, "skills/autobiz", name, "SKILL.md")
  const installedPlugin: PluginMetadata = {
    id: "original-installed-uuid",
    name: "independent-state-plugin",
    version: "1.0.4",
    enabled: true,
    path: installed,
    description: "",
    author: "",
    skillCount: 1,
    hookCount: 0,
    mcpServerCount: 0,
    createdAt: "first",
    updatedAt: "first"
  }
  const plugins = [installedPlugin]
  const disabled: string[] = []
  let current = true
  const assertSource = snapshots.captureGuard(snapshot.digest)
  const token = issueRuntimePluginSourceToken(
    {
      mode: "legacy",
      threadId: "thread",
      incarnationKey: "inc",
      projectId: "project",
      operationId: "op",
      workspace,
      packageDigest: snapshot.digest,
      stageId: "biz.prd",
      plugin: { ...installedPlugin, path: snapshot.root }
    },
    assertSource,
    () => {
      if (!current) throw Error("NATIVE_PROJECT_REVOKED")
    }
  )
  const registry = new SkillLifecycleRegistry(
    getPluginSkillSearchSources(snapshot.root, readPluginManifest(snapshot.root)!.manifest)
  )
  const input = { name, path: oldPath }
  const scope = {
    workspacePath: workspace,
    threadId: "thread",
    readInstalledPlugins: () => plugins,
    readDisabledSkillDirs: () => disabled
  }
  return {
    installedPlugin,
    plugins,
    disabled,
    snapshot,
    retainedPath,
    oldPath,
    token,
    input,
    scope,
    registry,
    revoke: () => {
      current = false
    }
  }
}

it("reproduces the explicit installed-path miss then routes the exact Skill onto the native snapshot", async () => {
  const f = fixture()
  expect(f.registry.resolveExplicit({ skillName: f.input.name, skillPath: f.oldPath })).toBeNull()
  const selected = await withRuntimePluginSource(f.token, () =>
    relocateRetainedExplicitSkill(f.input, f.scope)
  )
  expect(selected).toEqual({ name: f.input.name, path: f.retainedPath })
  expect(
    f.registry.resolveExplicit({ skillName: selected.name, skillPath: selected.path })?.name
  ).toBe(f.input.name)
  expect(f.input.path).toBe(f.oldPath)
})

it("leaves ordinary and already retained references unchanged without reading the installed catalog", async () => {
  const f = fixture(),
    readInstalledPlugins = vi.fn(() => f.plugins)
  expect(await relocateRetainedExplicitSkill(f.input, { ...f.scope, readInstalledPlugins })).toBe(
    f.input
  )
  const retained = { ...f.input, path: f.retainedPath }
  expect(
    await withRuntimePluginSource(f.token, () =>
      relocateRetainedExplicitSkill(retained, { ...f.scope, readInstalledPlugins })
    )
  ).toBe(retained)
  expect(readInstalledPlugins).not.toHaveBeenCalled()
})

it.each(["[Starting active goal]", "[Continuing active goal]"])(
  "preserves %s objective and audit scaffolding while emitting the canonical Skill path",
  async (marker) => {
    const f = fixture()
    const body = `${marker}\n\nObjective: retain all requirements.\nCompletion: checked output.\nAudit: do not replace.`
    for (const existing of [false, true]) {
      const prompt = existing ? body + "\n\n" + formatSkillUseBlock(f.input) : body
      const result = await withRuntimePluginSource(f.token, () =>
        appendRetainedExplicitSkillContext(prompt, f.input, f.scope)
      )
      const parsed = parseSkillUseBlock(result)!
      expect(parsed.rest).toBe(body)
      expect(parsed.skillPath).toBe(f.retainedPath)
      expect(result).not.toContain(f.oldPath)
      expect(result.match(/<CMBDEVCLAW-SKILL-USE-V1>/g)).toHaveLength(1)
    }
  }
)

it("keeps installed Skill disablement effective for an already canonical retained goal reference", async () => {
  const f = fixture()
  const canonical = { ...f.input, path: f.retainedPath }
  f.disabled.push(join(f.installedPlugin.path, "skills"))
  await expect(
    withRuntimePluginSource(f.token, () => relocateRetainedExplicitSkill(canonical, f.scope))
  ).rejects.toThrow("EXPLICIT_SKILL_DISABLED")
  await expect(
    withRuntimePluginSource(f.token, () =>
      appendRetainedExplicitSkillContext(
        "[Continuing active goal]\nOriginal objective.\n\n" + formatSkillUseBlock(canonical),
        f.input,
        f.scope
      )
    )
  ).rejects.toThrow("EXPLICIT_SKILL_DISABLED")
})

it.each(["disabled", "skill-disabled", "version", "name", "uuid", "bytes"] as const)(
  "rejects a changed %s instead of admitting a same-name Skill",
  async (change) => {
    const f = fixture()
    if (change === "disabled") f.installedPlugin.enabled = false
    if (change === "skill-disabled") f.disabled.push(join(f.installedPlugin.path, "skills"))
    if (change === "version") f.installedPlugin.version = "2.0.0"
    if (change === "name") f.installedPlugin.name = "foreign"
    if (change === "uuid") f.installedPlugin.id = "foreign-uuid"
    if (change === "bytes")
      writeFileSync(f.oldPath, "---\nname: autobiz-requirement-discuss\n---\nChanged")
    const result = withRuntimePluginSource(f.token, () =>
      relocateRetainedExplicitSkill(f.input, f.scope)
    )
    if (change === "uuid") {
      const unchanged = await result
      expect(unchanged).toBe(f.input)
      expect(
        f.registry.resolveExplicit({ skillName: unchanged.name, skillPath: unchanged.path })
      ).toBeNull()
    } else
      await expect(result).rejects.toThrow(/EXPLICIT_SKILL_SOURCE_CHANGED|EXPLICIT_SKILL_DISABLED/)
  }
)

it.each(["foreign-path", "forged-name", "not-a-skill"] as const)(
  "keeps %s outside the snapshot rather than resolving by name",
  async (change) => {
    const f = fixture()
    const input = { ...f.input }
    if (change === "foreign-path") input.path = join(root, "other-plugin", "SKILL.md")
    if (change === "forged-name") input.name = "forged-name"
    if (change === "not-a-skill") {
      input.path = join(f.installedPlugin.path, "notes.md")
      writeFileSync(input.path, "Not an admitted Skill")
    }
    const selected = await withRuntimePluginSource(f.token, () =>
      relocateRetainedExplicitSkill(input, f.scope)
    )
    expect(selected).toBe(input)
    expect(
      f.registry.resolveExplicit({ skillName: selected.name, skillPath: selected.path })
    ).toBeNull()
  }
)

it.each(["thread", "workspace"] as const)("rejects a foreign %s scope", async (change) => {
  const f = fixture()
  const scope = {
    ...f.scope,
    ...(change === "thread" ? { threadId: "foreign" } : { workspacePath: root })
  }
  await expect(
    withRuntimePluginSource(f.token, () => relocateRetainedExplicitSkill(f.input, scope))
  ).rejects.toThrow("LEGACY_CHILD_ADMISSION_REQUIRED")
})

it.each(["disable", "skill-disable", "reinstall", "revoke", "abort", "retained-bytes"] as const)(
  "rejects %s while the asynchronous identity check is in flight",
  async (change) => {
    const f = fixture(),
      controller = new AbortController()
    const result = withRuntimePluginSource(f.token, () =>
      relocateRetainedExplicitSkill(f.input, { ...f.scope, signal: controller.signal })
    )
    if (change === "disable") f.installedPlugin.enabled = false
    if (change === "skill-disable") f.disabled.push(join(f.installedPlugin.path, "skills"))
    if (change === "reinstall") f.installedPlugin.updatedAt = "same-version-reinstalled"
    if (change === "revoke") f.revoke()
    if (change === "abort") controller.abort(Error("TEST_ABORTED"))
    if (change === "retained-bytes") writeFileSync(f.retainedPath, "changed retained bytes")
    await expect(result).rejects.toThrow(/CHANGED|REVOKED|TEST_ABORTED|DISABLED/)
  }
)
