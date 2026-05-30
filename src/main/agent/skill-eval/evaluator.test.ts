import { describe, expect, it } from "vitest"
import type { AgentTrace } from "../trace/types"
import { getSkillEvalAssistantText } from "./assistant-text"
import { evaluateTraceSkills, stableJsonStringify } from "./evaluator"
import { evaluateTraceResults } from "./result-evaluator"
import { appendSkillEvalWindowTurn, resetSkillEvalWindow } from "./window"

function makeTrace(overrides: Partial<AgentTrace> = {}): AgentTrace {
  return {
    traceId: "trace-1",
    threadId: "thread-1",
    startedAt: "2026-05-30T01:00:00.000Z",
    endedAt: "2026-05-30T01:00:02.000Z",
    durationMs: 2000,
    userMessage: "生成报告",
    modelId: "test-model",
    steps: [
      {
        index: 0,
        startedAt: "2026-05-30T01:00:00.000Z",
        assistantText: "这是一个足够长的最终响应，用来覆盖结果评分。",
        toolCalls: []
      }
    ],
    modelCalls: [],
    nodes: [
      {
        id: "root",
        type: "trace",
        parentId: null,
        startedAt: "2026-05-30T01:00:00.000Z",
        status: "success"
      },
      {
        id: "done",
        type: "message",
        parentId: "root",
        name: "Run Completed",
        status: "success",
        startedAt: "2026-05-30T01:00:02.000Z",
        output: "任务完成"
      }
    ],
    totalToolCalls: 0,
    outcome: "success",
    usedSkills: ["report-v1.0.0"],
    ...overrides
  }
}

describe("skill eval scoring", () => {
  it("keeps result response and output signal checks independent", () => {
    const [record] = evaluateTraceResults(
      makeTrace({
        steps: [
          {
            index: 0,
            startedAt: "2026-05-30T01:00:00.000Z",
            assistantText: "",
            toolCalls: [{ name: "apply_patch", args: { path: "src/app.ts" } }]
          }
        ],
        totalToolCalls: 1
      })
    )

    const byName = new Map(record.checks.map((check) => [check.name, check]))
    expect(byName.get("final_response_substantive")?.ok).toBe(false)
    expect(byName.get("has_output_signal")?.ok).toBe(true)
  })

  it("requires validation only when a file was changed", () => {
    const [nonCodeRecord] = evaluateTraceResults(makeTrace())
    expect(nonCodeRecord.checks.find((check) => check.name === "has_validation_signal")?.ok).toBe(
      true
    )
    expect(nonCodeRecord.warnings).not.toContain("没有检测到验证动作")

    const [codeRecord] = evaluateTraceResults(
      makeTrace({
        steps: [
          {
            index: 0,
            startedAt: "2026-05-30T01:00:00.000Z",
            assistantText: "这是一个足够长的最终响应，用来覆盖结果评分。",
            toolCalls: [{ name: "apply_patch", args: { path: "src/app.ts" } }]
          }
        ],
        totalToolCalls: 1
      })
    )
    expect(codeRecord.checks.find((check) => check.name === "has_validation_signal")?.ok).toBe(
      false
    )
    expect(codeRecord.warnings).toContain("没有检测到验证动作")
  })

  it("uses terminal text as final response fallback for outcome scoring", () => {
    const [record] = evaluateTraceSkills(
      makeTrace({
        steps: [
          {
            index: 0,
            startedAt: "2026-05-30T01:00:00.000Z",
            assistantText: "",
            toolCalls: []
          }
        ]
      })
    )

    expect(record.outcomeChecks.find((check) => check.name === "final_response_present")?.ok).toBe(
      true
    )
  })

  it("uses model output before placeholder terminal output", () => {
    const trace = makeTrace({
      steps: [
        {
          index: 0,
          startedAt: "2026-05-30T01:00:00.000Z",
          assistantText: "",
          toolCalls: []
        }
      ],
      modelCalls: [
        {
          startedAt: "2026-05-30T01:00:00.000Z",
          inputMessages: [],
          outputMessage: {
            role: "assistant",
            content: "要按这个技能继续，我还缺少页面范围。请直接补充客户列表字段和筛选条件。"
          },
          toolCalls: []
        }
      ],
      nodes: [
        {
          id: "root",
          type: "trace",
          parentId: null,
          startedAt: "2026-05-30T01:00:00.000Z",
          status: "success"
        },
        {
          id: "done",
          type: "message",
          parentId: "root",
          name: "Run Completed",
          status: "success",
          startedAt: "2026-05-30T01:00:02.000Z",
          output: "Run completed"
        }
      ]
    })

    expect(getSkillEvalAssistantText(trace)).toContain("请直接补充")
    const [resultRecord] = evaluateTraceResults(trace)
    expect(
      resultRecord.checks.find((check) => check.name === "final_response_substantive")?.ok
    ).toBe(true)
  })

  it("inherits the pending skill when a follow-up answers a skill question", () => {
    const threadId = "thread-window-model-output"
    resetSkillEvalWindow(threadId)

    const firstTurn = appendSkillEvalWindowTurn({
      traceId: "trace-a",
      threadId,
      startedAt: "2026-05-30T01:00:00.000Z",
      endedAt: "2026-05-30T01:00:02.000Z",
      usedSkills: ["prd-to-frontend-v6.61.0"],
      userMessage: "生成客户列表页",
      assistantText: "要按这个技能继续，我还缺少页面范围。请直接补充客户列表字段和筛选条件。",
      outcome: "success"
    })
    expect(firstTurn.evalSkillNames).toEqual(["prd-to-frontend-v6.61.0"])

    const secondTurn = appendSkillEvalWindowTurn({
      traceId: "trace-b",
      threadId,
      startedAt: "2026-05-30T01:00:03.000Z",
      endedAt: "2026-05-30T01:00:04.000Z",
      usedSkills: [],
      userMessage: "我没有需求",
      assistantText: "",
      outcome: "success"
    })

    expect(secondTurn.inheritedContext).toBe(true)
    expect(secondTurn.evalSkillNames).toEqual(["prd-to-frontend-v6.61.0"])
    resetSkillEvalWindow(threadId)
  })

  it("flags peak input tokens even when average input tokens are reasonable", () => {
    const [record] = evaluateTraceSkills(
      makeTrace({
        modelCalls: Array.from({ length: 5 }, (_, index) => ({
          startedAt: `2026-05-30T01:00:0${index}.000Z`,
          inputMessages: [],
          outputMessage: { role: "assistant" as const, content: "ok" },
          toolCalls: [],
          tokenUsage: { inputTokens: index === 4 ? 121_000 : 1_000, outputTokens: 1 }
        }))
      })
    )

    expect(record.checks.find((check) => check.name === "input_tokens_reasonable")?.ok).toBe(true)
    expect(record.checks.find((check) => check.name === "peak_input_tokens_reasonable")?.ok).toBe(
      false
    )
  })

  it("uses a consistent total token definition that includes cache tokens", () => {
    const [record] = evaluateTraceSkills(
      makeTrace({
        modelCalls: [
          {
            startedAt: "2026-05-30T01:00:00.000Z",
            inputMessages: [],
            outputMessage: { role: "assistant", content: "ok" },
            toolCalls: [],
            tokenUsage: {
              inputTokens: 10,
              outputTokens: 5,
              totalTokens: 999,
              cacheReadTokens: 20,
              cacheCreationTokens: 30
            }
          }
        ]
      })
    )

    expect(record.totalTokens).toBe(65)
    expect(record.totalTokensIncludesCache).toBe(true)
  })

  it("normalizes object key order for repeated tool-call signatures", () => {
    expect(stableJsonStringify({ b: 2, a: 1 })).toBe(stableJsonStringify({ a: 1, b: 2 }))
  })
})
