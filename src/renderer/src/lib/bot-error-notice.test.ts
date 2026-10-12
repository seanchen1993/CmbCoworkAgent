import { describe, expect, it } from "vitest"
import { BotDomainError } from "../../../shared/bot-types"
import type { BotErrorTray, BotErrorTraySnapshot } from "../../../shared/bot-error-trays"
import {
  botErrorDiagnosticIds,
  botErrorNotice,
  botErrorTrayReceiptFeedback,
  botErrorTrayScopeKey,
  compactBotErrorSummary
} from "./bot-error-notice"

const diagnostic = {
  code: "rate_limit",
  status: 429,
  requestId: "req-provider-1",
  correlationId: "rpc-local-2",
  callId: "usage-call-3"
}
const tray: BotErrorTray = {
  kind: "error",
  id: "12345678-1234-4234-8234-123456789abc",
  revision: 10,
  title: "模型请求失败",
  detail: "请求频率超限",
  source: "run",
  diagnostic,
  count: 1,
  createdAt: 1,
  updatedAt: 1
}
const snapshot = (items: BotErrorTray[], revision = 10): BotErrorTraySnapshot => ({
  hostId: "host-A",
  dataEpoch: "data-A",
  revision,
  items
})

describe("safe Bot error notices", () => {
  it("does not announce a failed memory or backup operation as an incomplete task", () => {
    const memory = { source: "memory" as const, diagnostic: { code: "unknown" } }
    expect(compactBotErrorSummary(memory)).toEqual({
      title: "记忆整理未完成",
      message: "记忆整理未完成，查看错误详情"
    })
    expect(compactBotErrorSummary({ ...memory, source: "backup" }).title).toBe("备份未完成")
    expect(compactBotErrorSummary({ ...memory, source: "run" }).title).toBe("任务未完成")
    expect(
      compactBotErrorSummary({ source: "memory", diagnostic: { code: "rate_limit", status: 429 } })
    ).toEqual({
      title: "请求速率限制",
      message: "请稍后重试"
    })
  })
  it("keeps structured trusted diagnostics and distinguishes all three identities", () => {
    const error = Object.assign(new BotDomainError("model_failure", "请求频率超限"), {
      diagnostic,
      rawBody: "must-not-render",
      request_id: "untrusted-alias"
    })
    expect(botErrorNotice(error)).toEqual({ message: "请求频率超限", diagnostic })
    expect(botErrorDiagnosticIds(diagnostic)).toEqual([
      { kind: "requestId", label: "服务请求 ID", value: "req-provider-1" },
      { kind: "correlationId", label: "本地关联 ID", value: "rpc-local-2" },
      { kind: "callId", label: "模型调用 ID", value: "usage-call-3" }
    ])
  })

  it("does not present arbitrary error properties or text as provider diagnostics", () => {
    const error = Object.assign(new Error("request_id=fake-provider"), {
      requestID: "fake-provider",
      diagnostic
    })
    expect(botErrorNotice(error)).toEqual({ message: "request_id=fake-provider" })
    expect(botErrorNotice({ message: "untrusted-object", request_id: "fake" }, "读取失败")).toEqual(
      { message: "读取失败" }
    )
  })

  it("uses a bounded safe domain code when older or malformed diagnostics are absent", () => {
    const error = Object.assign(new BotDomainError("revision_conflict", "设置已更新"), {
      diagnostic: { ...diagnostic, requestId: "https://api.example/key?token=secret" }
    })
    expect(botErrorNotice(error)).toEqual({
      message: "设置已更新",
      diagnostic: { code: "revision_conflict" }
    })
    expect(botErrorNotice(new BotDomainError("not a safe code", "无法读取"))).toEqual({
      message: "无法读取"
    })
    expect(botErrorDiagnosticIds({ code: "invalid_input" })).toEqual([])
    expect(botErrorNotice("x".repeat(50_000)).message).toHaveLength(2_000)
  })
})

describe("notification acknowledgement feedback", () => {
  it("does not mistake a concurrently updated notice for a successful dismissal", () => {
    const before = snapshot([tray])
    const updated = { ...tray, revision: 11, count: 2, updatedAt: 2 }
    expect(
      botErrorTrayReceiptFeedback(before, snapshot([updated], 11), {
        kind: "dismiss",
        id: tray.id,
        revision: 10
      })
    ).toEqual({ tone: "info", notice: { message: "通知已更新，请查看后再关闭" } })
    expect(
      botErrorTrayReceiptFeedback(before, snapshot([tray]), {
        kind: "dismiss",
        id: tray.id,
        revision: 10
      })?.tone
    ).toBe("error")
    expect(
      botErrorTrayReceiptFeedback(before, snapshot([], 11), {
        kind: "dismiss",
        id: tray.id,
        revision: 10
      })
    ).toBeNull()
  })

  it("accepts a clear receipt that retains new errors and rejects a false clear", () => {
    const before = snapshot([tray])
    const newer = { ...tray, id: "12345678-1234-4234-8234-123456789abd", revision: 11 }
    expect(
      botErrorTrayReceiptFeedback(before, snapshot([newer], 12), {
        kind: "clear",
        throughRevision: 10
      })
    ).toBeNull()
    expect(
      botErrorTrayReceiptFeedback(before, snapshot([tray], 11), {
        kind: "clear",
        throughRevision: 10
      })?.tone
    ).toBe("error")
  })

  it("keeps restore/Host scope distinct from item revisions", () => {
    const before = snapshot([tray])
    const receipt = { ...snapshot([], 0), dataEpoch: "data-B" }
    expect(
      botErrorTrayReceiptFeedback(before, receipt, { kind: "clear", throughRevision: 10 })
    ).toEqual({ tone: "info", notice: { message: "后台已切换，请刷新通知后重试" } })
    expect(botErrorTrayScopeKey({ hostId: "a:b", dataEpoch: "c" })).not.toBe(
      botErrorTrayScopeKey({ hostId: "a", dataEpoch: "b:c" })
    )
  })
})
