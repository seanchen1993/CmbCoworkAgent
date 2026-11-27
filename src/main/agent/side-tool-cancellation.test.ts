import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as flush } from "node:timers/promises"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { tool } from "langchain"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { readWpsDocumentText } from "../browser/core/wps-document"
import { createHookScope } from "../hooks/scope"
import type { HookConfig, HookEvent } from "../hooks/types"
import { LocalSandbox } from "./local-sandbox"
import {
  createDeepAgent,
  createRuntimeToolFailureHandler,
  wrapRuntimeToolErrors
} from "./runtime"
import { createToolHookMiddleware } from "./tool-hooks"

const paths: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function hook(event: HookEvent, id: string, matcher?: string): HookConfig {
  return {
    id,
    event,
    matcher,
    type: "http",
    url: `https://hooks.invalid/${id}`,
    enabled: true,
    createdAt: "",
    updatedAt: ""
  }
}

function holdFirstHook() {
  const entered = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Response>()
  const fetchHook = vi.fn()
    .mockImplementationOnce(() => {
      entered.resolve()
      return pending.promise
    })
    .mockImplementation(async () => Response.json({}))
  vi.stubGlobal("fetch", fetchHook)
  return { entered, pending, fetchHook }
}

function toolRequest(id: string, name: string) {
  return {
    toolCall: { id, name, args: {}, type: "tool_call" as const },
    tool: undefined,
    state: { messages: [] },
    runtime: {}
  }
}

describe("side conversation tool hooks", () => {
  it("propagates a WPS read cancellation through the tool wrapper and skips PostToolUse", async () => {
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const pending = Promise.withResolvers<{ text: string; totalChars: number }>()
    const frame = {
      name: "office-iframe",
      executeJavaScript() {
        entered.resolve()
        return pending.promise
      }
    }
    const mainFrame = { framesInSubtree: [frame] }
    const name = "inAppBrowser_read_wps_document"
    const read = tool(
      async () =>
        JSON.stringify(
          await readWpsDocumentText({ mainFrame, isDestroyed: () => false } as never, {
            signal: controller.signal
          })
        ),
      { name, description: "Read a document", schema: z.object({}) }
    )
    wrapRuntimeToolErrors([read], controller.signal)
    const fetchHook = vi.fn()
    vi.stubGlobal("fetch", fetchHook)
    const middleware = createToolHookMiddleware({
      workspacePath: tmpdir(),
      threadId: "side-wps",
      hookScope: createHookScope(),
      abortSignal: controller.signal,
      resolveHooksForContext: (event) =>
        event === "PostToolUse" ? [hook(event, "post")] : []
    })
    const invoke = middleware.wrapToolCall!(toolRequest("wps", name), async () => {
      const result = await read.invoke({})
      return new ToolMessage({ content: String(result), tool_call_id: "wps" })
    })
    const outcome = expect(invoke).rejects.toMatchObject({ name: "AbortError" })
    await entered.promise
    controller.abort()
    await outcome
    pending.resolve({ text: "late", totalChars: 4 })
    await flush()
    expect(fetchHook).not.toHaveBeenCalled()
  })

  it("drops an error result returned by a tool after cancellation before accounting or hooks", async () => {
    const controller = new AbortController()
    const entered = Promise.withResolvers<void>()
    const result = Promise.withResolvers<ToolMessage>()
    const hooksFor = vi.fn(() => [])
    const onToolFailureDecision = vi.fn()
    const onToolSuccess = vi.fn()
    const middleware = createToolHookMiddleware({
      workspacePath: tmpdir(),
      threadId: "side-tool",
      hookScope: createHookScope(),
      abortSignal: controller.signal,
      resolveHooksForContext: hooksFor,
      onToolFailureDecision,
      onToolSuccess
    })
    const outcome = expect(
      middleware.wrapToolCall!(toolRequest("tool", "test_tool"), () => {
        entered.resolve()
        return result.promise
      })
    ).rejects.toMatchObject({ name: "AbortError" })
    await entered.promise
    controller.abort()
    result.resolve(new ToolMessage({ content: "late error", status: "error", tool_call_id: "tool" }))
    await outcome
    expect(hooksFor.mock.calls).toHaveLength(1)
    expect(hooksFor).toHaveBeenCalledWith("PreToolUse", expect.any(Object))
    expect(onToolFailureDecision).not.toHaveBeenCalled()
    expect(onToolSuccess).not.toHaveBeenCalled()
  })

  it.each(["PreToolUse", "PostToolUse"] as const)(
    "stops waiting for an active generic %s hook",
    async (event) => {
      const controller = new AbortController()
      const { entered, pending, fetchHook } = holdFirstHook()
      const handler = vi.fn(
        async () => new ToolMessage({ content: "done", tool_call_id: "generic" })
      )
      const onHookResult = vi.fn()
      const middleware = createToolHookMiddleware({
        workspacePath: tmpdir(),
        threadId: "side-generic",
        hookScope: createHookScope(),
        abortSignal: controller.signal,
        resolveHooksForContext: (name) =>
          name === event ? [hook(event, "first"), hook(event, "next")] : [],
        onHookResult
      })
      const outcome = expect(
        middleware.wrapToolCall!(toolRequest("generic", "testing"), handler)
      ).rejects.toMatchObject({ name: "AbortError" })
      await entered.promise
      controller.abort()
      await outcome
      expect(onHookResult).not.toHaveBeenCalled()
      pending.resolve(Response.json({}))
      await flush()
      expect(fetchHook).toHaveBeenCalledOnce()
      expect(handler).toHaveBeenCalledTimes(event === "PreToolUse" ? 0 : 1)
      expect(onHookResult).toHaveBeenCalledOnce()
    }
  )

  it.each([
    { event: "PreToolUse", file: "fixture.txt" },
    { event: "PostToolUse", file: "missing.txt" }
  ] as const)(
    "stops waiting for native read $event hooks on $file",
    async ({ event, file }) => {
      const workspace = await mkdtemp(join(tmpdir(), "cmb-side-hook-"))
      paths.push(workspace)
      await writeFile(join(workspace, "fixture.txt"), "contents")
      const controller = new AbortController()
      const { entered, pending, fetchHook } = holdFirstHook()
      const onHookResult = vi.fn()
      const sandbox = new LocalSandbox({
        rootDir: workspace,
        runId: "side-read",
        windowsSandbox: "none",
        abortSignal: controller.signal,
        stopPendingHooksOnAbort: true,
        hooks: [
          hook(event, "first", "read_file"),
          hook(event, "next", "read_file"),
          hook("PostToolUseFailure", "failure", "read_file")
        ],
        onHookResult
      })
      const outcome = expect(sandbox.read(file)).rejects.toMatchObject({ name: "AbortError" })
      await entered.promise
      controller.abort()
      await outcome
      expect(onHookResult).not.toHaveBeenCalled()
      pending.resolve(Response.json({}))
      await flush()
      expect(fetchHook).toHaveBeenCalledOnce()
      expect(onHookResult).toHaveBeenCalledExactlyOnceWith(
        event,
        expect.objectContaining({ id: "first" }),
        expect.objectContaining({ exitCode: 0 })
      )
    }
  )

  it("keeps the generic main-session post hook on ordinary tool failure output", async () => {
    const fetchHook = vi.fn(async () => Response.json({}))
    vi.stubGlobal("fetch", fetchHook)
    const middleware = createToolHookMiddleware({
      workspacePath: tmpdir(),
      threadId: "main",
      hookScope: createHookScope(),
      resolveHooksForContext: (event) =>
        event === "PostToolUse" ? [hook(event, "ordinary")] : []
    })
    const result = new ToolMessage({
      content: "tool error",
      status: "error",
      tool_call_id: "main-tool"
    })
    await expect(
      middleware.wrapToolCall!(toolRequest("main-tool", "testing"), async () => result)
    ).resolves.toMatchObject({
      status: "error",
      content: "tool error\n\n[Hook output]\n{}"
    })
    expect(fetchHook).toHaveBeenCalledOnce()
  })

  it("does not classify a cancelled generic tool throw as PostToolUseFailure", async () => {
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const failed = Promise.withResolvers<string>()
    const name = "cancelled_tool"
    const fixtureTool = tool(
      () => {
        started.resolve()
        return failed.promise
      },
      { name, description: "A pending test tool", schema: z.object({}) }
    )
    const plan = new AIMessage({
      content: "",
      tool_calls: [{ id: "side-tool-throw", type: "tool_call", name, args: {} }],
      response_metadata: { finish_reason: "tool_calls" }
    })
    class ReplayModel extends BaseChatModel {
      _llmType() { return "side-tool-test" }
      bindTools() { return this }
      async _generate() { return { generations: [{ text: "", message: plan }] } }
    }
    const fetchHook = vi.fn(async () => Response.json({}))
    vi.stubGlobal("fetch", fetchHook)
    const reportFailure = vi.fn(createRuntimeToolFailureHandler(
      { sessionId: "side-throw", workspacePath: tmpdir() },
      (event) => [hook(event, "failure")]
    ))
    const agent = createDeepAgent({
      model: new ReplayModel({}),
      tools: [fixtureTool],
      mainTodosEnabled: false,
      mainFilesystemEnabled: false,
      mainSubagentsEnabled: false,
      includeGeneralPurposeSubagent: false,
      onToolFailureSignal: reportFailure,
      sideConversationSignal: controller.signal
    })
    const outcome = expect(
      agent.invoke({ messages: [new HumanMessage("Run the test tool")] }, { recursionLimit: 8 })
    ).rejects.toMatchObject({ name: "AbortError" })
    await started.promise
    controller.abort()
    failed.reject(new Error("late failure from the tool"))
    await outcome
    expect(reportFailure).not.toHaveBeenCalled()
    expect(fetchHook).not.toHaveBeenCalled()
  })
})
