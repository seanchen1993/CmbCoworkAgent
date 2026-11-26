import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { countTokensApproximately, createAgent, createMiddleware, FakeToolCallingModel, tool, type ModelRequest } from "langchain"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { calculateContextCompactionBudget } from "../../shared/model-token-budget"
import { createSideConversationMiddleware, fitSideContextMessage, prependSideContext } from "./side-conversation-context"

describe("side conversation model input budget", () => {
  const { inputBudgetTokens } = calculateContextCompactionBudget(32_000, 8192)
  const systemMessage = new SystemMessage("Workspace instructions ".repeat(20))
  const exampleTool = tool(() => "result", {
    name: "example",
    description: "This schema uses context. ".repeat(20),
    schema: z.object({ key: z.string() })
  })
  const inherited = [
    { role: "user" as const, content: "older question" },
    { role: "assistant" as const, content: `${"x".repeat(2_000)} recent marker` }
  ]

  it("trims inherited rows after charging the existing messages, prompt and tool schemas", () => {
    const child = new HumanMessage("x".repeat(4 * (inputBudgetTokens - 380)))
    const request = { messages: [child], systemMessage, tools: [exampleTool] }
    const messages = prependSideContext(request, inherited, inputBudgetTokens)

    expect(messages).toHaveLength(3)
    expect(messages.at(-1)).toBe(child)
    expect(messages[0].content).toMatch(/recent marker$/)
    expect(String(messages[0].content).length).toBeLessThan(inherited[1].content.length)
    const tokens = countTokensApproximately([systemMessage, ...messages], [exampleTool])
    expect(tokens).toBeLessThanOrEqual(inputBudgetTokens)
    expect(tokens).toBeGreaterThan(inputBudgetTokens - 80)
  })

  it("keeps a running parent's unanswered task inside the transcript and leaves the side question as the last user turn", () => {
    const child = new HumanMessage("只回答主会话的标记")
    const messages = prependSideContext({ messages: [child], systemMessage, tools: [] }, [
      { role: "user", content: "标记为青枣628，写一篇游记" }
    ], inputBudgetTokens)
    expect(messages.map(message => message.type)).toEqual(["human", "ai", "human"])
    expect(messages[0].content).toContain("用户：标记为青枣628，写一篇游记")
    expect(messages[2]).toBe(child)
  })

  it("leaves the original child request intact when there is no room for inherited content", () => {
    const child = new HumanMessage("x".repeat(4 * inputBudgetTokens))
    const request = { messages: [child], systemMessage, tools: [exampleTool] }
    expect(prependSideContext(request, inherited, inputBudgetTokens)).toBe(request.messages)
  })

  it("trims inherited text on UTF-8 boundaries", () => {
    const row = { role: "assistant" as const, content: "before😀after" }
    expect(fitSideContextMessage(row, 6)?.row.content).toBe("after")
  })

  it("reuses the successful fallback through multiple tool calls and tries inheritance in a new runtime", async () => {
    const attempts: boolean[] = []
    const runTool = vi.fn(({ key }: { key: string }) => `result for ${key}`)
    const toolWithResults = tool(runTool, {
      name: "example",
      description: "Return a result for a key",
      schema: z.object({ key: z.string() })
    })
    function createRun(providerRejectsParent: boolean) {
      return createAgent({
        model: new FakeToolCallingModel({ toolCalls: [
          [{ id: "call-1", name: "example", args: { key: "one" } }],
          [{ id: "call-2", name: "example", args: { key: "two" } }],
          []
        ] }),
        tools: [toolWithResults],
        middleware: [
          createSideConversationMiddleware(inherited, inputBudgetTokens),
          createMiddleware({
            name: "ProviderContextLimit",
            wrapModelCall(request, invoke) {
              const hasParent = request.messages.some(message => String(message.content).includes(inherited[0].content))
              attempts.push(hasParent)
              if (hasParent && providerRejectsParent) throw new Error("exceeds the context window")
              return invoke(request)
            }
          })
        ]
      })
    }

    const input = { messages: [new HumanMessage("child question")] }
    const currentRun = createRun(true)
    const newRun = createRun(false)
    await currentRun.invoke(input)
    expect(runTool.mock.calls.map(([args]) => args.key)).toEqual(["one", "two"])
    expect(attempts).toEqual([true, false, false, false])

    attempts.length = 0
    await newRun.invoke(input)
    expect(attempts).toEqual([true, true, true])
  })

  it.each([
    { name: "an unrelated error", first: new Error("network disconnected"), attempts: 1 },
    { name: "a failed overflow fallback", first: new Error("exceeds the context window"), fallback: new Error("maximum context length"), attempts: 2 },
    { name: "a cancelled overflow fallback", first: new Error("exceeds the context window"), fallback: new DOMException("Cancelled", "AbortError"), attempts: 2 }
  ])("keeps inheritance available after $name", async ({ first, fallback, attempts }) => {
    const middleware = createSideConversationMiddleware(inherited, inputBudgetTokens)
    const controller = new AbortController()
    const messages = [new HumanMessage("child question")]
    const request = {
      messages,
      model: new FakeToolCallingModel(),
      systemMessage,
      systemPrompt: systemMessage.text,
      tools: [],
      state: { messages },
      runtime: { signal: controller.signal }
    } satisfies ModelRequest
    const invoke = vi.fn().mockRejectedValueOnce(first)
    if (fallback) invoke.mockImplementationOnce(async () => {
      if (fallback.name === "AbortError") controller.abort(fallback)
      throw fallback
    })
    const response = new AIMessage("child answer")
    invoke.mockResolvedValue(response)

    await expect(middleware.wrapModelCall!(request, invoke)).rejects.toBe(fallback ?? first)
    expect(invoke).toHaveBeenCalledTimes(attempts)
    if (fallback) expect(invoke).toHaveBeenLastCalledWith(request)

    const nextRequest = { ...request, runtime: { signal: new AbortController().signal } }
    await expect(middleware.wrapModelCall!(nextRequest, invoke)).resolves.toBe(response)
    expect(invoke.mock.lastCall?.[0].messages[0].content).toContain(inherited[0].content)
  })
})
