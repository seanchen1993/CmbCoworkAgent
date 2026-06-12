import { describe, expect, it, vi } from "vitest"
import type { AgentTrace } from "./types"
import { buildTeamEvalTrace, buildTeamSkillEvalExtension } from "./team-eval"

vi.mock("../../storage", () => ({
  getResultEvalModelId: () => undefined,
  getResultEvalEnabled: () => false
}))

function makeTrace(overrides: Partial<AgentTrace> = {}): AgentTrace {
  return {
    traceId: "trace-main",
    threadId: "thread-main",
    startedAt: "2026-06-12T01:00:00.000Z",
    endedAt: "2026-06-12T01:00:02.000Z",
    durationMs: 2000,
    userMessage: "实现并验证功能",
    modelId: "test-model",
    steps: [
      {
        index: 0,
        startedAt: "2026-06-12T01:00:00.000Z",
        assistantText: "这是主 agent 的最终汇总，长度足够用于结果评分。",
        toolCalls: []
      }
    ],
    modelCalls: [],
    nodes: [
      {
        id: "root-main",
        type: "trace",
        parentId: null,
        startedAt: "2026-06-12T01:00:00.000Z",
        status: "success"
      },
      {
        id: "done-main",
        type: "message",
        parentId: "root-main",
        name: "Run Completed",
        status: "success",
        startedAt: "2026-06-12T01:00:02.000Z",
        output: "任务完成"
      }
    ],
    totalToolCalls: 0,
    outcome: "success",
    usedSkills: ["report-v1.0.0"],
    evolvedSkills: [],
    triggerSource: "chat",
    ...overrides
  }
}

describe("team eval aggregation", () => {
  it("keeps one skill eval record while counting worker tool and validation evidence", () => {
    const coordinator = makeTrace({ traceRole: "coordinator" })
    const worker = makeTrace({
      traceId: "trace-worker",
      threadId: "thread-main::worker-1",
      traceRole: "worker",
      parentTraceId: "trace-main",
      parentThreadId: "thread-main",
      workerId: "worker-1",
      workerThreadId: "thread-main::worker-1",
      workerRole: "implementer",
      startedAt: "2026-06-12T01:00:01.000Z",
      endedAt: "2026-06-12T01:00:05.000Z",
      durationMs: 4000,
      steps: [
        {
          index: 0,
          startedAt: "2026-06-12T01:00:01.000Z",
          assistantText: "worker 完成了文件修改和验证。",
          toolCalls: [
            { name: "apply_patch", args: { path: "src/app.ts" } },
            { name: "execute", args: { command: "npm run test" } }
          ]
        }
      ],
      modelCalls: [
        {
          startedAt: "2026-06-12T01:00:01.000Z",
          inputMessages: [],
          outputMessage: { role: "assistant", content: "worker 完成了文件修改和验证。" },
          toolCalls: [
            { name: "apply_patch", args: { path: "src/app.ts" } },
            { name: "execute", args: { command: "npm run test" } }
          ],
          tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
        }
      ],
      totalToolCalls: 2,
      usedSkills: ["report-v1.0.0"]
    })

    const teamTrace = buildTeamEvalTrace(coordinator, [worker])
    expect(teamTrace.traceId).toBe("trace-main")
    expect(teamTrace.totalToolCalls).toBe(2)
    expect(teamTrace.modelCalls).toHaveLength(1)

    const teamEval = buildTeamSkillEvalExtension(coordinator, [worker])
    expect(teamEval?.records).toHaveLength(1)
    const [record] = teamEval?.records ?? []
    expect(record.traceId).toBe("trace-main")
    expect(record.threadId).toBe("thread-main")
    expect(record.totalToolCalls).toBe(2)
    expect(record.modelCallCount).toBe(1)
    expect(record.evidence.changedFiles).toBe(1)
    expect(record.evidence.validationCommands).toBe(1)
    expect(record.skillEvalTraceIds).toEqual(["trace-main", "trace-worker"])
  })
})
