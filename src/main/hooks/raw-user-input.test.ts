import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../harness-board/service", () => ({ resolveHarnessFeatureCurrentStage: vi.fn() }))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getEnabledHooks: () => [],
  getEnabledPluginHookMetadata: () => [],
  getEnabledSkillHookMetadata: () => []
}))

import { runHooks, type HookContext } from "./runner"
import { createHookScope, createInheritedHookScope, resolveEnabledHooksForRun } from "./scope"
import type { HookConfig } from "./types"

const script = Buffer.from(
  `process.stdout.write(JSON.stringify({additionalContext: JSON.stringify({
    raw: process.env.RAW_USER_INPUT ?? null,
    prompt: process.env.USER_PROMPT ?? null
  })}))`
).toString("base64")

const hook: HookConfig = {
  id: "raw-input-capture",
  event: "UserPromptSubmit",
  type: "command",
  command: `node -e "eval(Buffer.from('${script}','base64').toString('utf8'))"`,
  enabled: true,
  timeout: 5_000,
  createdAt: "",
  updatedAt: ""
}

async function capture(context: HookContext) {
  const result = await runHooks([hook], "UserPromptSubmit", context)
  expect(result?.additionalContext).toBeDefined()
  return JSON.parse(result!.additionalContext!)
}

afterEach(() => vi.unstubAllEnvs())

describe("RAW_USER_INPUT command hook environment", () => {
  it("preserves whitespace, newlines, Chinese and literal protocol text", async () => {
    const raw = "  帮我检查\n<CMBDEVCLAW-SKILL-USE-V1>字面文本</CMBDEVCLAW-SKILL-USE-V1>  "
    const prompt = `${raw.trim()}\n\n程序追加的技能说明`
    expect(await capture({ rawUserInput: raw, userPrompt: prompt })).toEqual({ raw, prompt })
  })

  it("preserves an explicitly empty input for a skill-only submission", async () => {
    expect(await capture({ rawUserInput: "", userPrompt: "技能调用块" })).toEqual({
      raw: "",
      prompt: "技能调用块"
    })
  })

  it("does not inherit another run's value when the source has no original input", async () => {
    vi.stubEnv("RAW_USER_INPUT", "stale host value")
    expect(await capture({ userPrompt: "内部生成的提示词" })).toEqual({
      raw: null,
      prompt: "内部生成的提示词"
    })
  })

  it("keeps concurrent calls isolated", async () => {
    const results = await Promise.all([
      capture({ rawUserInput: "用户甲" }),
      capture({ rawUserInput: "用户乙" })
    ])
    expect(results.map((result) => result.raw)).toEqual(["用户甲", "用户乙"])
  })

  it("passes the invocation's original input to tool and Stop hooks without rewrites", async () => {
    const scope = createHookScope()
    scope.rawUserInput = "  本轮用户原文  "
    for (const event of ["PreToolUse", "Stop"] as const) {
      const context: HookContext = { userPrompt: "Hook 改写后的提示词" }
      resolveEnabledHooksForRun(undefined, event, context, scope)
      expect((await capture(context)).raw).toBe(scope.rawUserInput)
    }
    const otherContext: HookContext = {}
    resolveEnabledHooksForRun(undefined, "UserPromptSubmit", otherContext, createHookScope())
    expect((await capture(otherContext)).raw).toBeNull()
  })

  it("snapshots the parent's human input for workers without sharing later changes", () => {
    const parent = createHookScope()
    parent.rawUserInput = "用户选择技能时的原文"
    const worker = createInheritedHookScope(parent)
    parent.rawUserInput = "主线程下一条输入"
    const context: HookContext = { userPrompt: "[[CMB_COORDINATOR_SELECTED_SKILL_V1]] 子任务" }
    resolveEnabledHooksForRun(undefined, "UserPromptSubmit", context, worker)
    expect(context.rawUserInput).toBe("用户选择技能时的原文")
  })
})
