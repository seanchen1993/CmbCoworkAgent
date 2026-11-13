import { describe, expect, it, vi } from "vitest"
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages"
import { tool } from "langchain"
import { z } from "zod"
import { ProjectContext, ProjectContextError } from "./context"
import {
  estimateProjectMessages,
  estimateProjectTokens,
  projectContextBudget
} from "./context-budget"
import { createProjectRunReporter } from "./run-progress"
import { mockStreamingModel } from "./streaming-model-test-fixture"

function setup(window = 32_768, output = 4096) {
  const controller = new AbortController()
  const reviewInputs: BaseMessage[][] = []
  const reviewer = mockStreamingModel({
    invoke: vi.fn(async (messages: BaseMessage[]) => {
      reviewInputs.push(messages.map((m) => new HumanMessage(String(m.content))))
      return new AIMessage("保留 E7：项目 P2 的采纳率为 30%；继续读取 nextOffset=20；未核实阶段。")
    })
  })
  const budget = projectContextBudget({ maxTokens: window, maxOutputTokens: output })
  const context = new ProjectContext(createProjectRunReporter(), controller.signal)
  context.configure({ name: "default", budget, reviewer, agent: reviewer, final: reviewer }, [
    context.readTool
  ])
  return { context, budget, reviewer, reviewInputs, controller }
}

describe("project Agent context management", () => {
  it("uses configured context/output budgets instead of the old 90,000 character limit", async () => {
    const { context, budget, reviewInputs } = setup(128_000, 12_000)
    expect(budget).toEqual({ contextTokens: 128_000, outputTokens: 12_000, inputTokens: 115_000 })
    expect(projectContextBudget({ maxTokens: 32_768, maxOutputTokens: 4096 }).inputTokens).toBe(
      27_672
    )
    expect(() => projectContextBudget({ maxTokens: 16_000, maxOutputTokens: 16_000 })).toThrow(
      "输出配置"
    )
    expect(() => projectContextBudget({})).toThrow("默认模型")
    const messages = [new HumanMessage("证据" + "a".repeat(95_000))]
    context.pin(messages)
    await context.prepare(messages)
    expect(String(messages[0].content)).toHaveLength(95_002)
    expect(reviewInputs).toHaveLength(0)
  })

  it("caches identical queries, retains a single body and keeps every tool-call ID paired", async () => {
    const { context } = setup()
    const invoke = vi.fn(async ({ id }) =>
      JSON.stringify({ id, rows: [{ projectId: "last", value: 123 }] })
    )
    const query = tool(invoke, {
      name: "facts",
      description: "facts",
      schema: z.object({ id: z.string(), offset: z.number() })
    })
    const first = await context.query(query, { id: "P1", offset: 0 })
    const second = await context.query(query, { offset: 0, id: "P1" })
    expect(second).toMatchObject({ resultId: first.resultId, cached: true })
    expect(invoke).toHaveBeenCalledTimes(1)
    const messages: BaseMessage[] = [new SystemMessage("只分析本室")]
    for (const [index, result] of [first, second].entries()) {
      const id = `call-${index}`
      messages.push(
        new AIMessage({
          content: "",
          tool_calls: [{ name: "facts", args: { id: "P1", offset: 0 }, id }]
        })
      )
      messages.push(
        context.toolMessage(
          new ToolMessage({ name: "facts", content: result.content, tool_call_id: id }),
          result.resultId
        )
      )
    }
    await context.prepare(messages)
    expect(JSON.parse(String(messages[2].content)).storedResult).toBe(first.resultId)
    expect(String(messages[4].content)).toBe(second.content)
    expect((messages[2] as ToolMessage).tool_call_id).toBe("call-0")
    expect((messages[4] as ToolMessage).tool_call_id).toBe("call-1")
    const retrieved = JSON.parse(
      await context.readTool.invoke({ resultId: first.resultId, path: ["rows"] })
    )
    expect(retrieved.rows).toEqual([{ projectId: "last", value: 123 }])
    await context.query(query, { id: "P2", offset: 0 })
    expect(invoke).toHaveBeenCalledTimes(2)
    await expect(setup().context.readTool.invoke({ resultId: first.resultId })).rejects.toThrow(
      "本次工作区"
    )
  })

  it("does not cache failures and honours cancellation even for an already cached query", async () => {
    const { context, controller } = setup()
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue("ok")
    const query = tool(invoke, { name: "facts", description: "facts", schema: z.object({}) })
    await expect(context.query(query, {})).rejects.toThrow("unavailable")
    expect((await context.query(query, {})).cached).toBe(false)
    controller.abort()
    await expect(context.query(query, {})).rejects.toThrow()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it("pages through every saved row, including the last, without referring pages back to themselves", async () => {
    const { context, budget } = setup(16_384, 2048)
    const rows = Array.from({ length: 125 }, (_, i) => ({
      projectId: `p-${i}`,
      feature: "字段".repeat(70)
    }))
    const resultId = context.save("all rows", JSON.stringify({ rows }))
    const retrieved: unknown[] = []
    let offset: number | null = 0
    do {
      const args = { resultId, path: ["rows"], offset, limit: 20 }
      const result = await context.query(context.readTool, args)
      const page = JSON.parse(result.content)
      expect(page.rows.length).toBeGreaterThan(0)
      expect(estimateProjectTokens(result.content)).toBeLessThan(budget.inputTokens * 0.15)
      const messages = [
        context.toolMessage(
          new ToolMessage({ content: result.content, tool_call_id: "read", name: "read_context" }),
          result.resultId
        )
      ]
      await context.prepare(messages)
      expect(String(messages[0].content)).toBe(result.content)
      retrieved.push(...page.rows)
      offset = page.nextOffset
    } while (offset !== null)
    expect(retrieved).toEqual(rows)
  })

  it("allows nested and very wide records to be read completely, preserving Chinese and emoji", async () => {
    const { context } = setup(16_384, 2048)
    const original = '中文😀\\"\n'.repeat(2000)
    const resultId = context.save(
      "wide",
      JSON.stringify({ rows: [{ id: "last", details: original }] })
    )
    const page = JSON.parse(await context.readTool.invoke({ resultId, path: ["rows"] }))
    expect(page.rowPath).toEqual(["rows", "0"])
    const fields = JSON.parse(await context.readTool.invoke({ resultId, path: page.rowPath }))
    expect(fields.fields).toEqual(["id", "details"])
    let offset: number | null = 0
    let combined = ""
    do {
      const raw = await context.readTool.invoke({
        resultId,
        path: ["rows", "0", "details"],
        offset
      })
      const part = JSON.parse(raw)
      expect(part.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/)
      combined += part.text
      offset = part.nextOffset
    } while (offset !== null)
    expect(combined).toBe(original)
    await expect(context.readTool.invoke({ resultId, path: ["__proto__"] })).rejects.toThrow(
      "字段不存在"
    )
  })

  it("recalibrates from provider usage and regenerates cached read pages to fit the smaller budget", async () => {
    const { context, budget } = setup()
    const source = context.save("large text", "项目指标😀".repeat(5000))
    const args = { resultId: source }
    const first = await context.query(context.readTool, args)
    const usageMessages = [new HumanMessage("实测 token 用量")]
    const input = estimateProjectMessages(usageMessages) * 2
    const model = mockStreamingModel({
      invoke: async () =>
        new AIMessage({
          content: "ok",
          usage_metadata: { input_tokens: input, output_tokens: 1, total_tokens: input + 1 }
        })
    })
    await context.review(model, usageMessages, "usage")
    expect(context.reviewInputTokens).toBeLessThan(budget.inputTokens / 2)
    const resized = await context.query(context.readTool, args)
    expect(resized.cached).toBe(false)
    expect(JSON.parse(resized.content).text.length).toBeLessThan(
      JSON.parse(first.content).text.length
    )
    const messages = [
      context.toolMessage(
        new ToolMessage({ content: resized.content, tool_call_id: "read" }),
        resized.resultId
      )
    ]
    await context.prepare(messages)
    expect(String(messages[0].content)).toBe(resized.content)
  })

  it("compacts complete old rounds, preserving scope and latest question with raw results accessible", async () => {
    const { context, budget, reviewInputs } = setup(16_384, 2048)
    const scope = new SystemMessage("scope: room-A; metrics are cumulative")
    const question = new HumanMessage("只分析 P2；用采纳率30%作阈值")
    const messages: BaseMessage[] = [scope, question]
    context.pin(messages)
    let lastId = ""
    for (let i = 0; i < 15; i++) {
      const content = JSON.stringify({
        projectId: `P${i}`,
        evidenceId: `E${i}`,
        value: "指标".repeat(300)
      })
      lastId = context.save(`query-${i}`, content)
      messages.push(
        new AIMessage({
          content: "",
          tool_calls: [{ name: "facts", args: { id: i }, id: `q${i}` }]
        })
      )
      messages.push(
        context.toolMessage(
          new ToolMessage({ content, tool_call_id: `q${i}`, name: "facts" }),
          lastId
        )
      )
    }
    await context.prepare(messages)
    expect(messages).toContain(scope)
    expect(messages).toContain(question)
    expect(messages.some((m) => m instanceof ToolMessage)).toBe(false)
    expect(messages.some((m) => m instanceof AIMessage && m.tool_calls?.length)).toBe(false)
    expect(estimateProjectMessages(messages)).toBeLessThan(budget.inputTokens)
    expect(reviewInputs.length).toBeGreaterThan(1)
    expect(reviewInputs.every((m) => estimateProjectMessages(m) <= budget.inputTokens)).toBe(true)
    expect(
      JSON.parse(await context.readTool.invoke({ resultId: lastId, path: ["projectId"] })).text
    ).toBe("P14")
  })

  it("reduces very long histories hierarchically rather than truncating or merging oversized notes", async () => {
    const { context, budget, reviewInputs } = setup(16_384, 2048)
    const original = Array.from({ length: 5000 }, (_, i) => `E${i}:项目记录，未读分页${i}；`).join(
      "\n"
    )
    const note = await context.summarize(original, "保留证据", 400)
    expect(estimateProjectTokens(note)).toBeLessThanOrEqual(400)
    expect(reviewInputs.length).toBeGreaterThan(10)
    expect(reviewInputs.every((m) => estimateProjectMessages(m) < budget.inputTokens)).toBe(true)
    const sourceId = /完整记录：(result-\d+)/.exec(note)![1]
    const tail = JSON.parse(
      await context.readTool.invoke({ resultId: sourceId, offset: original.length - 50 })
    )
    expect(tail.text).toBe(original.slice(-50))
  })

  it("keeps oversized source HTML retrievable and never silently drops it in tool-free repair", async () => {
    const { context } = setup(16_384, 2048)
    const html = "<html>" + "页面".repeat(15_000) + "</html>"
    const document = context.document(new HumanMessage(html), "original HTML")
    const messages: BaseMessage[] = [new SystemMessage("保留旧报告布局"), document]
    context.pin([messages[0]])
    await context.prepare(messages)
    const reference = JSON.parse(String(document.content))
    expect(reference.storedResult).toBeTruthy()
    const tail = JSON.parse(
      await context.readTool.invoke({ resultId: reference.storedResult, offset: html.length - 7 })
    )
    expect(tail.text).toBe("</html>")
    await expect(context.prepare(messages, false)).rejects.toThrow("完整报告源文档")
  })

  it("compacts and retries provider context-limit errors using streaming, without treating them as unsupported tools", async () => {
    const { context, reviewInputs } = setup()
    const requests: string[] = []
    const invoke = vi.fn(async (messages: BaseMessage[]) => {
      requests.push(JSON.stringify(messages.map((m) => m.content)))
      if (requests.length === 1)
        throw Object.assign(new Error("maximum context length exceeded"), { status: 400 })
      return new AIMessage("分析完成")
    })
    const messages: BaseMessage[] = [
      new SystemMessage("只用本室数据"),
      new HumanMessage("旧记录".repeat(2000)),
      new HumanMessage("关注P2")
    ]
    context.pin([messages[0], messages[2]])
    const result = await context.run(mockStreamingModel({ invoke }), messages, "analysis", true)
    expect(result.content).toBe("分析完成")
    expect(requests).toHaveLength(2)
    expect(requests[1].length).toBeLessThan(requests[0].length)
    expect(reviewInputs.length).toBeGreaterThan(0)
    const failed = mockStreamingModel({
      invoke: async () => {
        throw Object.assign(new Error("context_length_exceeded"), { status: 400 })
      }
    })
    await expect(context.run(failed, messages, "analysis", true)).rejects.toBeInstanceOf(
      ProjectContextError
    )
  })
})
