import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../harness-board/service", () => ({ resolveHarnessFeatureCurrentStage: vi.fn() }))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getEnabledHooks: vi.fn(() => []),
  getEnabledPluginHookMetadata: () => [],
  getEnabledSkillHookMetadata: () => [],
  getHookLoggingConfig: vi.fn(() => ({ enabled: false, diagnostic: false }))
}))

import { runCompletionHooksWithRevision } from "../agent/skill-lifecycle/completion-hooks"
import { getEnabledHooks, getHookLoggingConfig } from "../storage"
import { runHooks, type HookContext, type HookResultCallback } from "./runner"
import { createHookScope, createInheritedHookScope, resolveEnabledHooksForRun } from "./scope"
import { fireSessionEnd, fireSessionEndAll, fireSessionStartOnce } from "./session-lifecycle"
import type { HookConfig, HookEvent } from "./types"

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

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.mocked(getEnabledHooks).mockReset()
  vi.mocked(getHookLoggingConfig).mockClear()
})

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

async function captureHttpBody(
  event: HookEvent,
  context: HookContext,
  onResult?: HookResultCallback
): Promise<Record<string, unknown>> {
  const url = "https://example.test/hook"
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal("fetch", fetchMock)
  const httpHook: HookConfig = { ...hook, command: undefined, event, type: "http", url }
  await runHooks([httpHook], event, context, onResult)
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
    url,
    expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json" } })
  )
  const body = fetchMock.mock.calls[0][1]?.body
  expect(typeof body).toBe("string")
  return JSON.parse(body as string) as Record<string, unknown>
}

describe("raw_user_input in the HTTP hook request body", () => {
  it("preserves the original text independently of the composed prompt", async () => {
    const raw = "  你好\n<CMBDEVCLAW-SKILL-USE-V1>字面文本</CMBDEVCLAW-SKILL-USE-V1>  "
    const prompt = `${raw.trim()}\n\n程序追加的技能说明`
    const context = { rawUserInput: raw, userPrompt: prompt, toolArgs: { rawMessage: prompt } }
    expect(await captureHttpBody("UserPromptSubmit", context)).toMatchObject({
      raw_user_input: raw,
      prompt,
      tool_input: { rawMessage: prompt }
    })
  })

  it("includes empty text for a skill-only submission", async () => {
    const body = await captureHttpBody("UserPromptSubmit", {
      rawUserInput: "",
      userPrompt: "技能调用块"
    })
    expect(body.raw_user_input).toBe("")
  })

  it("omits the field when there is no original input in the invocation", async () => {
    vi.stubEnv("RAW_USER_INPUT", "stale host value")
    const body = await captureHttpBody("UserPromptSubmit", { userPrompt: "内部生成的提示词" })
    expect(body).not.toHaveProperty("raw_user_input")
  })

  it("uses the current scope's original input for PreToolUse", async () => {
    const scope = createHookScope()
    scope.rawUserInput = "  本轮原文\n"
    const context: HookContext = {}
    resolveEnabledHooksForRun(undefined, "PreToolUse", context, scope)
    const body = await captureHttpBody("PreToolUse", context)
    expect(body.raw_user_input).toBe(scope.rawUserInput)
  })

  it("delivers the original input to Stop when normal turn completion runs the hook", async () => {
    const threadId = "stop-raw-input"
    const scope = createHookScope()
    scope.rawUserInput = "  本轮用户原文\n"
    const stopContext = { userMessage: "改写后的提示词", assistantResponse: "回复" }
    const url = "https://example.test/stop"
    vi.mocked(getEnabledHooks).mockReturnValue([
      { ...hook, command: undefined, event: "Stop", type: "http", url }
    ])
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      runCompletionHooksWithRevision({
        threadId,
        abortSignal: new AbortController().signal,
        getStopContext: () => stopContext,
        hookScope: scope,
        runRevision: vi.fn(),
        sendNotice: vi.fn(),
        sendError: vi.fn(),
        maxRevisionAttempts: 0,
        revisionPromptPrefix: ""
      })
    ).resolves.toBe("passed")

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      url,
      expect.objectContaining({ method: "POST" })
    )
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body).toMatchObject({
      hook_event_name: "Stop",
      session_id: threadId,
      stop_context: stopContext,
      raw_user_input: scope.rawUserInput
    })
  })

  it.each(["thread deletion", "app shutdown"] as const)(
    "omits the previous turn's input from SessionEnd HTTP requests during %s",
    async (ending) => {
      const threadId = "session-end-raw-input"
      const scope = createHookScope()
      scope.rawUserInput = "  已结束回合的私密输入\n"
      const url = "https://example.test/session-end"
      vi.mocked(getEnabledHooks).mockReturnValue([
        { ...hook, command: undefined, event: "SessionEnd", type: "http", url }
      ])
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
      vi.stubGlobal("fetch", fetchMock)

      await fireSessionStartOnce(threadId, undefined, undefined, scope)
      if (ending === "thread deletion") {
        await fireSessionEnd(threadId)
      } else {
        await fireSessionEndAll(100)
      }

      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        url,
        expect.objectContaining({ method: "POST" })
      )
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
      expect(body).toMatchObject({ hook_event_name: "SessionEnd", session_id: threadId })
      expect(body).not.toHaveProperty("raw_user_input")
    }
  )

  it("adds the original text to the request without copying it to the diagnostic payload", async () => {
    vi.mocked(getHookLoggingConfig).mockReturnValueOnce({ enabled: true, diagnostic: true })
    const onResult = vi.fn<HookResultCallback>()
    const body = await captureHttpBody(
      "UserPromptSubmit",
      { rawUserInput: "原文", userPrompt: "提交提示词" },
      onResult
    )
    expect(body.raw_user_input).toBe("原文")
    const diagnostic = JSON.parse(onResult.mock.calls[0][2].stdinPayload ?? "")
    expect(diagnostic).toMatchObject({ prompt: "提交提示词" })
    expect(diagnostic).not.toHaveProperty("raw_user_input")
  })
})
