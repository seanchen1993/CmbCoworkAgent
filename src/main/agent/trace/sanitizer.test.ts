import { describe, expect, it } from "vitest"
import { formatSkillUseBlock } from "../../../shared/skill-use-block"
import { sanitizeTraceForCloudUpload } from "./sanitizer"
import type { AgentTrace } from "./types"

function traceWithReasoning(reasoning: string, content = "done"): AgentTrace {
  return {
    traceId: "trace-reasoning",
    threadId: "thread-reasoning",
    startedAt: "2026-07-15T10:00:00.000Z",
    endedAt: "2026-07-15T10:00:01.000Z",
    durationMs: 1000,
    userMessage: "test",
    suspectedTechnicalDetailSupplement: true,
    modelId: "test-model",
    steps: [],
    modelCalls: [
      {
        startedAt: "2026-07-15T10:00:00.500Z",
        inputMessages: [],
        outputMessage: { role: "assistant", content, reasoning },
        toolCalls: []
      }
    ],
    nodes: [
      {
        id: "llm-1",
        type: "llm",
        parentId: null,
        startedAt: "2026-07-15T10:00:00.500Z",
        endedAt: "2026-07-15T10:00:01.000Z",
        output: content,
        metadata: { providerMessageId: "message-1", reasoning }
      }
    ],
    totalToolCalls: 0,
    outcome: "success",
    usedSkills: [],
    evolvedSkills: [],
    triggerSource: "chat"
  }
}

describe("trace reasoning sanitization", () => {
  it("bounds reasoning independently and keeps it addressable on the LLM node", () => {
    const sanitized = sanitizeTraceForCloudUpload(
      traceWithReasoning("r".repeat(5000), "c".repeat(5000))
    )
    const modelReasoning = sanitized.modelCalls?.[0]?.outputMessage.reasoning
    const modelContent = sanitized.modelCalls?.[0]?.outputMessage.content
    const rawNodeReasoning = sanitized.nodes?.[0]?.metadata?.reasoning
    const nodeReasoning = typeof rawNodeReasoning === "string" ? rawNodeReasoning : undefined
    const nodeContent = sanitized.nodes?.[0]?.output

    // The marker is shown to readers, so it is in the interface's language.
    expect(modelReasoning).toContain("已省略")
    expect(nodeReasoning).toContain("已省略")
    expect(sanitized.nodes?.[0]?.metadata?.providerMessageId).toBe("message-1")
    expect(modelReasoning).toHaveLength(modelContent?.length ?? 0)
    expect(nodeReasoning).toHaveLength(typeof nodeContent === "string" ? nodeContent.length : 0)
    expect(sanitized.modelCalls?.[0]?.outputMessage).not.toHaveProperty("reasoningSummary")
    expect(sanitized.nodes?.[0]?.metadata).not.toHaveProperty("reasoningSummary")
    expect(sanitized.suspectedTechnicalDetailSupplement).toBe(true)
  })
})

describe("显式技能传输块的上传压缩", () => {
  const skillBlock = formatSkillUseBlock({
    name: "autobiz-requirement-discuss",
    path: String.raw`D:\kanban\单据预审核\.autobizdevops\cmb_kanban_latest\skills\autobiz\autobiz-requirement-discuss\SKILL.md`,
    description: "逐步澄清需求并产出 PRD_DISCUSS.md 讨论稿",
    metadata: { whenToUse: "把模糊想法整理成可评审需求时使用" }
  })
  const prose = "请使用 /autobiz-requirement-discuss 继续推进当前 Feature。"

  function traceWithUserMessage(userMessage: string): AgentTrace {
    return {
      traceId: "trace-skill",
      threadId: "thread-skill",
      startedAt: "2026-09-11T14:21:00.000Z",
      endedAt: "2026-09-11T15:37:00.000Z",
      durationMs: 4_560_000,
      userMessage,
      suspectedTechnicalDetailSupplement: false,
      modelId: "test-model",
      steps: [],
      nodes: [
        {
          id: "trace-root",
          type: "trace",
          parentId: null,
          name: "Agent Trace",
          startedAt: "2026-09-11T14:21:00.000Z",
          input: { userMessage }
        }
      ],
      totalToolCalls: 0,
      outcome: "success",
      usedSkills: [],
      evolvedSkills: [],
      triggerSource: "chat"
    }
  }

  it("块换成一行标记，用户原话因此完整躲过截断", () => {
    const raw = `${prose}\n\n${skillBlock}`
    // The block alone is what carries this message past the limit.
    expect(raw.length).toBeGreaterThan(512)

    const sanitized = sanitizeTraceForCloudUpload(traceWithUserMessage(raw))

    expect(sanitized.userMessage).toBe(`${prose}\n[技能] autobiz-requirement-discuss`)
    expect(sanitized.userMessage).not.toContain("已省略")
    expect(sanitized.userMessage).not.toContain("<instruction>")
  })

  it("根节点的 input.userMessage 一起压，对话还原的回退路径才对得上", () => {
    const sanitized = sanitizeTraceForCloudUpload(traceWithUserMessage(`${prose}\n\n${skillBlock}`))
    const input = sanitized.nodes?.[0]?.input as { userMessage?: string } | undefined

    expect(input?.userMessage).toBe(`${prose}\n[技能] autobiz-requirement-discuss`)
  })

  it("没有技能块的消息一个字都不动", () => {
    const sanitized = sanitizeTraceForCloudUpload(traceWithUserMessage(prose))

    expect(sanitized.userMessage).toBe(prose)
  })
})
