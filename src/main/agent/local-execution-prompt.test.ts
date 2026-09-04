import { AIMessage, SystemMessage } from "@langchain/core/messages"
import { createFilesystemMiddleware, StateBackend } from "deepagents"
import { afterEach, describe, expect, it, vi } from "vitest"
import { patchLocalExecutionPrompt } from "./local-execution-prompt"

type FilesystemMiddleware = ReturnType<typeof createFilesystemMiddleware>
type ModelRequest = Parameters<NonNullable<FilesystemMiddleware["wrapModelCall"]>>[0]

function createMiddleware(supportsExecution = true): FilesystemMiddleware {
  const backend = new StateBackend({ state: {} })
  if (supportsExecution) {
    Object.assign(backend, {
      id: "test-local-backend",
      execute: async () => ({ output: "ok", exitCode: 0, truncated: false })
    })
  }
  return createFilesystemMiddleware({ backend, systemPrompt: "\n\nLocal filesystem tools." })
}

async function captureRequest(
  middleware: FilesystemMiddleware,
  systemMessage = new SystemMessage("User project instructions.")
): Promise<ModelRequest> {
  const request = {
    systemMessage,
    tools: middleware.tools ?? [],
    messages: [],
    state: {},
    runtime: {}
  } as unknown as ModelRequest
  let captured: ModelRequest | undefined
  await middleware.wrapModelCall!(request, (nextRequest) => {
    expect(nextRequest.systemMessage).toBeInstanceOf(SystemMessage)
    captured = nextRequest as ModelRequest
    return new AIMessage("done")
  })
  expect(captured).toBeDefined()
  return captured!
}

afterEach(() => vi.restoreAllMocks())

describe("patchLocalExecutionPrompt", () => {
  it("replaces both real middleware sandbox claims when OS sandboxing is disabled", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32")
    const middleware = createMiddleware()
    const before = await captureRequest(middleware)
    expect(before.systemMessage.text).toContain("shell commands in a sandboxed environment")
    const execute = middleware.tools!.find((tool) => tool.name === "execute")!
    const originalInvoke = execute.invoke
    const originalTools = middleware.tools
    const originalWrapToolCall = middleware.wrapToolCall

    patchLocalExecutionPrompt(middleware, "none")
    const after = await captureRequest(middleware)

    expect(after.systemMessage.text).toContain("OS sandboxing is disabled")
    expect(after.systemMessage.text).toContain("same local filesystem paths as the file tools")
    expect(after.systemMessage.text).not.toContain("sandboxed environment")
    expect(execute.description).toContain("OS sandboxing is disabled")
    expect(execute.description).not.toContain("isolated sandbox environment")
    expect(execute.invoke).toBe(originalInvoke)
    expect(middleware.tools).toBe(originalTools)
    expect(after.tools).toBe(originalTools)
    expect(middleware.wrapToolCall).toBe(originalWrapToolCall)
  })

  it.each(["unelevated", "readonly", "elevated"] as const)(
    "keeps the actual Windows %s sandbox policy in both descriptions",
    async (mode) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32")
      const middleware = createMiddleware()
      patchLocalExecutionPrompt(middleware, mode)
      const request = await captureRequest(middleware)
      const description = middleware.tools!.find((tool) => tool.name === "execute")!.description

      for (const text of [request.systemMessage.text, description]) {
        expect(text).toContain(`Windows sandbox mode \`${mode}\``)
        expect(text).toContain("configured sandbox permissions apply")
        expect(text).not.toContain("OS sandboxing is disabled")
        expect(text).not.toContain("isolated sandbox environment")
      }
    }
  )

  it("reports OS sandboxing disabled off Windows regardless of a saved Windows mode", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux")
    const middleware = createMiddleware()
    patchLocalExecutionPrompt(middleware, "elevated")
    const request = await captureRequest(middleware)

    expect(request.systemMessage.text).toContain("OS sandboxing is disabled")
    expect(request.systemMessage.text).not.toContain("Windows sandbox mode")
    expect(middleware.tools!.find((tool) => tool.name === "execute")!.description).toContain(
      "OS sandboxing is disabled"
    )
  })

  it("only replaces the newly appended suffix on every model call", async () => {
    const middleware = createMiddleware()
    const upstreamRequest = await captureRequest(middleware, new SystemMessage(""))
    const originalText = `User quoted instructions:\n${upstreamRequest.systemMessage.text}`
    const original = new SystemMessage(originalText)
    patchLocalExecutionPrompt(middleware, "none")

    for (let turn = 0; turn < 3; turn += 1) {
      const request = await captureRequest(middleware, original)
      expect(request.systemMessage.text.startsWith(originalText)).toBe(true)
      expect(request.systemMessage.text.slice(originalText.length)).not.toContain(
        "sandboxed environment"
      )
      expect(request.systemMessage.text.slice(originalText.length)).toContain(
        "## Execute Tool `execute`"
      )
      expect(original.text).toBe(originalText)
    }
  })

  it("preserves multimodal blocks, metadata and message serialization", async () => {
    const original = new SystemMessage({
      id: "system-1",
      name: "project-context",
      content: [
        {
          type: "text",
          text: "User instruction: do not rewrite the sandboxed environment phrase."
        },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
      ],
      additional_kwargs: { custom: { retained: true } },
      response_metadata: { source: "project" }
    })
    const middleware = createMiddleware()
    patchLocalExecutionPrompt(middleware, "none")
    const request = await captureRequest(middleware, original)
    const result = request.systemMessage

    expect(result).toBeInstanceOf(SystemMessage)
    expect(Array.isArray(result.content)).toBe(true)
    expect(result.content.slice(0, 2)).toEqual(original.content)
    expect(result.id).toBe(original.id)
    expect(result.name).toBe(original.name)
    expect(result.additional_kwargs).toEqual(original.additional_kwargs)
    expect(result.response_metadata).toEqual(original.response_metadata)
    expect(result.toDict().data.content).toEqual(result.content)
    expect(result.lc_kwargs.content).toEqual(result.content)
    expect(result.text).toContain("OS sandboxing is disabled")
    expect(original.content).toHaveLength(2)
  })

  it("does not add execution docs or retain execute when the backend cannot execute", async () => {
    const middleware = createMiddleware(false)
    patchLocalExecutionPrompt(middleware, "none")
    const request = await captureRequest(middleware)

    expect(request.tools.some((tool) => tool.name === "execute")).toBe(false)
    expect(request.systemMessage.text).toBe("User project instructions.\n\nLocal filesystem tools.")
    expect(request.systemMessage.text).not.toContain("## Execute Tool")
  })
})
