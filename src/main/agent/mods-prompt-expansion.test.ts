import { beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
const mocks = vi.hoisted(() => ({ roots: [] as string[], hooks: vi.fn(), activate: vi.fn() }))
vi.mock("../storage", async (original) => ({
  ...(await original<typeof import("../storage")>()),
  getEnabledSkillsSources: async () => mocks.roots,
  getEnabledPluginSkillSourceMetadata: () => [],
  getDisabledSkillDirs: () => []
}))
vi.mock("../hooks/required-skill", () => ({
  runHooksEnriched: (...args: unknown[]) => mocks.hooks(...args)
}))
vi.mock("./skill-lifecycle/activation", () => ({
  activateSkillLifecycle: (...args: unknown[]) => mocks.activate(...args),
  formatSkillHookContext: (_skill: unknown, notes: string[]) => notes.join("\n") || null
}))
vi.mock("./runtime", () => ({ createAgentRuntime: vi.fn() }))
import { prepareStandardUserPrompt } from "./standard-thread-turn"
import { formatSkillUseBlock } from "./skill-lifecycle/marker"
import { createHookScope } from "../hooks/scope"
import { createSkillUseTracker } from "./skill-lifecycle/tracker"

beforeEach(() => {
  mocks.hooks.mockReset().mockResolvedValue(null)
  mocks.activate.mockReset().mockResolvedValue({ blocked: false, notes: [], skipped: false })
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
