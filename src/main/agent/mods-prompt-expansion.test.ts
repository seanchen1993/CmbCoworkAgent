import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ClawSourceSelection } from "../../shared/mods/claw"
import type { PluginMetadata } from "../types"
import type { PluginSkillSourceMetadata } from "../storage"
const mocks = vi.hoisted(() => ({
  roots: [] as string[],
  plugins: [] as PluginMetadata[],
  sources: [] as PluginSkillSourceMetadata[],
  disabled: [] as string[],
  hooks: vi.fn(),
  activate: vi.fn(),
  selection: undefined as ClawSourceSelection | undefined
}))
vi.mock("../storage", async (original) => ({
  ...(await original<typeof import("../storage")>()),
  getEnabledSkillsSources: async () => mocks.roots,
  getSkillsSources: () => mocks.roots,
  getPlugins: () => mocks.plugins,
  getEnabledPluginSkillSourceMetadata: () => mocks.sources,
  getDisabledSkillDirs: () => mocks.disabled
}))
vi.mock("../hooks/required-skill", () => ({
  runHooksEnriched: (...args: unknown[]) => mocks.hooks(...args)
}))
vi.mock("./skill-lifecycle/activation", () => ({
  activateSkillLifecycle: (...args: unknown[]) => mocks.activate(...args),
  formatSkillHookContext: (_skill: unknown, notes: string[]) => notes.join("\n") || null
}))
vi.mock("./runtime", () => ({ createAgentRuntime: vi.fn() }))
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({ clawProfile: () => ({ skills: mocks.selection }) })
}))
import { prepareStandardUserPrompt, validateExplicitSkillReference } from "./standard-thread-turn"
import { listClawSkillSources } from "../mods/claw-skills"
import { formatSkillUseBlock, parseSkillUseBlock } from "./skill-lifecycle/marker"
import { createHookScope } from "../hooks/scope"
import { createSkillUseTracker } from "./skill-lifecycle/tracker"
import { RetainedPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { getPluginSkillSearchSources, readPluginManifest } from "../plugins/manifest"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../plugins/runtime-source-scope"

beforeEach(() => {
  mocks.selection = undefined
  mocks.plugins = []
  mocks.sources = []
  mocks.disabled = []
  mocks.hooks.mockReset().mockResolvedValue(null)
  mocks.activate.mockReset().mockResolvedValue({ blocked: false, notes: [], skipped: false })
})

it("repairs the manual project/slash path and goal reference only within the exact native source", async () => {
  const root = mkdtempSync(join(tmpdir(), "retained-prompt-path-"))
  try {
    const installed = join(root, "installed"),
      workspace = join(root, "workspace")
    const name = "autobiz-requirement-discuss"
    const directory = join(installed, "skills/autobiz", name)
    mkdirSync(directory, { recursive: true })
    mkdirSync(workspace)
    writeFileSync(
      join(installed, "plugin.json"),
      JSON.stringify({ name: "sample-state", version: "1.0.4", skills: ["skills"] })
    )
    const oldPath = join(directory, "SKILL.md")
    writeFileSync(
      oldPath,
      `---\nname: ${name}\ndescription: Original requirements\n---\nRead actual requirements`
    )
    const snapshots = new RetainedPackageSnapshots(join(root, "snapshots"))
    const snapshot = snapshots.capture(installed)
    const plugin: PluginMetadata = {
      id: "actual-install-uuid",
      name: "sample-state",
      version: "1.0.4",
      enabled: true,
      path: installed,
      description: "",
      author: "",
      skillCount: 1,
      hookCount: 0,
      mcpServerCount: 0,
      createdAt: "now",
      updatedAt: "now"
    }
    mocks.plugins = [plugin]
    mocks.roots = []
    mocks.sources = getPluginSkillSearchSources(
      snapshot.root,
      readPluginManifest(snapshot.root)!.manifest
    ).map((source) => ({
      ...source,
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginRoot: snapshot.root,
      isProjectModePlugin: true
    }))
    const token = issueRuntimePluginSourceToken(
      {
        mode: "legacy",
        threadId: "thread",
        incarnationKey: "inc",
        projectId: "project",
        operationId: "operation",
        workspace,
        packageDigest: snapshot.digest,
        stageId: "biz.prd",
        plugin: { ...plugin, path: snapshot.root }
      },
      snapshots.captureGuard(snapshot.digest)
    )
    const message = "生成本次需求\n\n" + formatSkillUseBlock({ name, path: oldPath })
    const goalBody =
      "[Starting active goal]\n\nObjective: preserve requirements.\nAudit: original goal."
    const prepare = (trusted = false, goal = false) =>
      prepareStandardUserPrompt({
        rawMessage: trusted ? "生成本次需求" : message,
        initialModelInput: goal
          ? goalBody + "\n\n" + formatSkillUseBlock({ name, path: oldPath })
          : trusted
            ? "生成本次需求"
            : message,
        ...(trusted ? { trustedExplicitSkill: { name, path: oldPath } } : {}),
        threadId: "thread",
        workspacePath: workspace,
        harnessAgentContext: {
          isHarnessProjectSession: true,
          pluginId: plugin.id,
          pluginName: plugin.name
        },
        turnState: {
          hookScope: createHookScope(),
          skillUseTracker: createSkillUseTracker(),
          skillHookKeys: new Set(),
          turnId: "turn"
        },
        onHookResult: vi.fn(),
        onHookSkippedFactory: () => vi.fn()
      })
    // Same direct error as the UI: the retained registry intentionally refuses an installation path.
    expect(await prepare()).toMatchObject({
      accepted: false,
      reason: `显式选择的技能不存在或已禁用：${name}`
    })
    for (const [trusted, goal] of [
      [false, false],
      [true, false],
      [false, true],
      [true, true]
    ]) {
      const result = await withRuntimePluginSource(token, () => prepare(trusted, goal))
      expect(result.accepted).toBe(true)
      if (!result.accepted) throw Error(result.reason)
      const parsed = parseSkillUseBlock(result.content)!
      expect(parsed.skillPath).toBe(join(snapshot.root, "skills/autobiz", name, "SKILL.md"))
      expect(result.content).not.toContain(oldPath)
      expect(result.content.match(/<CMBDEVCLAW-SKILL-USE-V1>/g)).toHaveLength(1)
      if (goal) expect(parsed.rest).toBe(goalBody)
      expect(mocks.activate.mock.lastCall?.[0].skill).toMatchObject({
        name,
        path: parsed.skillPath,
        pluginId: plugin.id
      })
    }
    expect(
      await withRuntimePluginSource(token, () =>
        validateExplicitSkillReference(
          { name, path: oldPath },
          {
            threadId: "thread",
            workspacePath: workspace,
            projectMode: true,
            boundPluginId: plugin.id
          }
        )
      )
    ).toBeNull()
    mocks.activate.mockClear()
    mocks.hooks.mockClear()
    mocks.disabled = [directory]
    expect(await withRuntimePluginSource(token, () => prepare())).toMatchObject({
      accepted: false,
      reason: expect.stringContaining("EXPLICIT_SKILL_DISABLED")
    })
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.hooks).not.toHaveBeenCalled()
  } finally {
    expect(root.split(/[\\/]/).at(-1)).toMatch(/^retained-prompt-path-/)
    rmSync(root, { recursive: true, force: true })
  }
})

async function fixture(
  run: (
    prepare: (overrides?: Record<string, unknown>) => ReturnType<typeof prepareStandardUserPrompt>
  ) => Promise<void>
) {
  const root = mkdtempSync(join(tmpdir(), "mods-expansion-"))
  const skillDir = join(root, "review")
  mkdirSync(skillDir)
  const skillPath = join(skillDir, "SKILL.md")
  writeFileSync(
    skillPath,
    "---\nname: review\ndescription: Review changes\n---\nReview actual changes"
  )
  mocks.roots = [root]
  const rawMessage = "review changes\n\n" + formatSkillUseBlock({ name: "review", path: skillPath })
  try {
    await run((overrides = {}) =>
      prepareStandardUserPrompt({
        rawMessage,
        initialModelInput: rawMessage,
        threadId: "thread",
        workspacePath: root,
        turnState: {
          hookScope: createHookScope(),
          skillUseTracker: createSkillUseTracker(),
          skillHookKeys: new Set(),
          turnId: "turn"
        },
        harnessAgentContext: {},
        onHookResult: vi.fn(),
        onHookSkippedFactory: () => vi.fn(),
        ...overrides
      })
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("real explicit skill prompt expansion", () => {
  it.each(["adapter-one", "adapter-two"])(
    "keeps plugin identity %s through prompt expansion and activation",
    async (pluginId) => {
      await fixture(async (prepare) => {
        expect(
          await prepare({
            harnessAgentContext: { pluginId, pluginName: "Shared adapter" }
          })
        ).toMatchObject({ accepted: true })
        const expansion = mocks.hooks.mock.calls.find((call) => call[1] === "UserPromptExpansion")
        expect(expansion?.[2]).toMatchObject({ harnessAdapterId: pluginId })
        expect(mocks.activate.mock.calls[0]?.[0]).toMatchObject({ harnessAdapterId: pluginId })
      })
    }
  )
  it("rejects an unselected real explicit skill before any expansion, activation or submit Hook", async () => {
    await fixture(async (prepare) => {
      mocks.selection = { mode: "selected", items: [] }
      expect(await prepare()).toMatchObject({
        accepted: false,
        blockedBy: "explicit_skill",
        reason: expect.stringContaining("NOT_SELECTED")
      })
      expect(mocks.hooks).not.toHaveBeenCalled()
      expect(mocks.activate).not.toHaveBeenCalled()
      const reference = { name: "review", path: join(mocks.roots[0], "review", "SKILL.md") }
      expect(
        await validateExplicitSkillReference(reference, {
          threadId: "thread",
          workspacePath: mocks.roots[0]
        })
      ).toContain("NOT_SELECTED")
      expect(await validateExplicitSkillReference(reference)).toBeNull()
    })
  })
  it("allows selected real skills but rechecks digest after asynchronous expansion", async () => {
    await fixture(async (prepare) => {
      mocks.selection = { mode: "selected", items: await listClawSkillSources() }
      expect(await prepare()).toMatchObject({ accepted: true })
      mocks.activate.mockClear()
      mocks.hooks.mockImplementation(async (_hooks, event) => {
        if (event === "UserPromptExpansion")
          writeFileSync(
            join(mocks.roots[0], "review", "SKILL.md"),
            "---\nname: review\n---\nchanged"
          )
        return null
      })
      expect(await prepare()).toMatchObject({
        accepted: false,
        reason: expect.stringContaining("CHANGED")
      })
      expect(mocks.activate).not.toHaveBeenCalled()
    })
  })
  it("checks the resolved skill before activation and passes added context to the model input", async () => {
    await fixture(async (prepare) => {
      mocks.hooks.mockImplementation(async (_hooks, event, context) => {
        if (event === "UserPromptExpansion") {
          expect(mocks.activate).not.toHaveBeenCalled()
          expect(context.promptExpansion).toMatchObject({
            expansion_type: "slash_command",
            command_name: "review",
            command_args: "review changes",
            command_source: "local"
          })
          return { additionalContext: "EXPANSION_CHECKLIST" }
        }
        return null
      })
      const result = await prepare()
      expect(result).toMatchObject({
        accepted: true,
        content: expect.stringContaining("EXPANSION_CHECKLIST")
      })
      expect(mocks.hooks.mock.calls.map((call) => call[1])).toEqual([
        "UserPromptExpansion",
        "UserPromptSubmit"
      ])
      expect(mocks.activate).toHaveBeenCalledOnce()
    })
  })
  it("blocks before PreSkillUse and UserPromptSubmit without activating the skill", async () => {
    await fixture(async (prepare) => {
      mocks.hooks.mockImplementation(async (_hooks, event) =>
        event === "UserPromptExpansion" ? { blocked: true, reason: "CHECK_REQUIRED" } : null
      )
      expect(await prepare()).toMatchObject({ accepted: false, reason: "CHECK_REQUIRED" })
      expect(mocks.activate).not.toHaveBeenCalled()
      expect(mocks.hooks.mock.calls.map((call) => call[1])).toEqual(["UserPromptExpansion"])
    })
  })
  it("does not emit for ordinary text, untrusted markers or unavailable skills", async () => {
    await fixture(async (prepare) => {
      await prepare({ rawMessage: "ordinary", initialModelInput: "ordinary" })
      await prepare({ allowExplicitSkillFromMessage: false })
      mocks.roots = []
      expect(await prepare()).toMatchObject({ accepted: false })
      expect(mocks.hooks.mock.calls.some((call) => call[1] === "UserPromptExpansion")).toBe(false)
    })
  })
  it("cannot activate or continue after the run is replaced while checking", async () => {
    await fixture(async (prepare) => {
      let current = true
      mocks.hooks.mockImplementation(async (_hooks, event) => {
        if (event === "UserPromptExpansion") current = false
        return null
      })
      expect(await prepare({ isPreparationCurrent: () => current })).toMatchObject({
        accepted: false,
        blockedBy: "run_not_ready"
      })
      expect(mocks.activate).not.toHaveBeenCalled()
    })
  })
})
