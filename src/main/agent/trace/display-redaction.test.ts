import { describe, expect, it } from "vitest"
import {
  redactTraceDetailForDisplay,
  redactTraceSkillEvalRecordForDisplay
} from "./display-redaction"
import type { TraceNode, TraceSkillEvalRecord } from "./types"

describe("trace display redaction", () => {
  it("redacts messages and node content without mutating the cloud-backed source", () => {
    const nodes: TraceNode[] = [
      {
        id: "tool-1",
        type: "tool",
        parentId: null,
        name: "联系 13800138000",
        status: "success",
        startedAt: "2026-07-30T10:00:00.000Z",
        input: {
          phone: "555-0100",
          password: "local-secret",
          note: "身份证 11010119900307123X"
        },
        output: "手机号 13912345678，邮箱 zhangsan@example.com",
        metadata: {
          reasoning: "回拨 13700001234",
          authorization: "Bearer abcdefghijklmnop"
        }
      }
    ]
    const source = {
      traceId: "trace-1",
      userMessage: "请联系 13800138000",
      nodes,
      rawError: "身份证 11010119900307123X"
    }

    const redacted = redactTraceDetailForDisplay(source)
    const input = redacted.nodes?.[0]?.input as Record<string, unknown>
    const metadata = redacted.nodes?.[0]?.metadata as Record<string, unknown>

    expect(redacted.traceId).toBe("trace-1")
    expect(redacted.userMessage).toBe("请联系 138****8000")
    expect(redacted.nodes?.[0]?.name).toBe("联系 138****8000")
    expect(input.phone).toBe("[REDACTED]")
    expect(input.password).toBe("[REDACTED]")
    expect(input.note).toBe("身份证 110101********123X")
    expect(redacted.nodes?.[0]?.output).toBe("手机号 139****5678，邮箱 z*******@example.com")
    expect(metadata.reasoning).toBe("回拨 137****1234")
    expect(metadata.authorization).toBe("[REDACTED]")
    expect(redacted.rawError).toBe("身份证 110101********123X")

    expect(source.userMessage).toContain("13800138000")
    expect(nodes[0].input).toEqual({
      phone: "555-0100",
      password: "local-secret",
      note: "身份证 11010119900307123X"
    })
  })

  it("redacts copied skill-eval messages and check details while preserving metrics", () => {
    const source = {
      traceId: "trace-eval-1",
      threadId: "thread-eval-1",
      userMessage: "用户手机 13800138000",
      score: 88,
      checks: [
        {
          name: "identity-check",
          label: "检查 zhangsan@example.com",
          category: "process",
          ok: false,
          weight: 1,
          detail: {
            idCard: "11010119900307123X",
            accessToken: "opaque-token"
          }
        }
      ],
      outcomeChecks: [],
      resultChecks: [],
      warnings: ["手机号 13912345678"],
      outcomeWarnings: ["token=internal-secret-token"],
      resultWarnings: [],
      resultIssues: ["联系 user@example.com"],
      artifacts: [{ type: "response", label: "响应包含 13700001234" }]
    } as unknown as TraceSkillEvalRecord

    const redacted = redactTraceSkillEvalRecordForDisplay(source)

    expect(redacted.traceId).toBe("trace-eval-1")
    expect(redacted.score).toBe(88)
    expect(redacted.userMessage).toBe("用户手机 138****8000")
    expect(redacted.checks[0].label).toBe("检查 z*******@example.com")
    expect(redacted.checks[0].detail).toEqual({
      idCard: "110101********123X",
      accessToken: "[REDACTED]"
    })
    expect(redacted.warnings[0]).toBe("手机号 139****5678")
    expect(redacted.outcomeWarnings[0]).toBe("token=[REDACTED]")
    expect(redacted.resultIssues[0]).toBe("联系 u***@example.com")
    expect(redacted.artifacts[0].label).toBe("响应包含 137****1234")

    expect(source.userMessage).toContain("13800138000")
    expect(source.checks[0].detail?.accessToken).toBe("opaque-token")
  })
})
