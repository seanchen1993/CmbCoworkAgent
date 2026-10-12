import { describe, expect, it } from "vitest"
import { BotErrorTrays, type BotErrorTrayNotice } from "./error-trays"
import { safeBotErrorDiagnostic, safeBotErrorText } from "./error-diagnostic"
import { botErrorTraySnapshotSchema } from "../../shared/bot-error-trays"

const authority = { hostId: "host-one", dataEpoch: "epoch-one" }
function notice(episodeId: string, extra: Partial<BotErrorTrayNotice> = {}): BotErrorTrayNotice {
  return {
    episodeId,
    source: "run",
    botId: "bot-one",
    conversationId: "conversation-one",
    runId: "run-one",
    title: "任务执行失败",
    detail: "模型暂时不可用，请检查连接后重试。",
    diagnostic: { code: "model_unavailable", status: 503, requestId: "req_one" },
    ...extra
  }
}

describe("Host transient error trays", () => {
  it("retains at most 20 notices with one monotonic revision and no execution history mutation", () => {
    let time = 1000
    const manager = new BotErrorTrays(authority, () => ++time)
    for (let index = 0; index < 24; index++) manager.push(notice(`failure-${index}`))
    const snapshot = manager.snapshot()
    expect(snapshot.revision).toBe(24)
    expect(snapshot.items).toHaveLength(20)
    expect(snapshot.items.map((item) => item.revision)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 5)
    )
    expect(botErrorTraySnapshotSchema.safeParse(snapshot).success).toBe(true)
  })

  it("copies every exposed notice and diagnostic so clients cannot mutate Host state", () => {
    const manager = new BotErrorTrays(authority, () => 1000)
    const snapshot = manager.push(notice("failure"))
    snapshot.items[0]!.detail = "Changed outside the Host"
    snapshot.items[0]!.diagnostic.requestId = "req_changed"
    snapshot.items.length = 0
    expect(manager.snapshot().items[0]).toMatchObject({
      detail: "模型暂时不可用，请检查连接后重试。",
      diagnostic: { requestId: "req_one" }
    })
  })

  it("acknowledges repeated transitions without reviving a dismissed notice", () => {
    const manager = new BotErrorTrays(authority, () => 1000)
    const first = manager.push(notice("failure"))
    const item = first.items[0]!
    const ack = manager.dismiss({ ...authority, id: item.id, revision: item.revision })
    expect(ack.items).toEqual([])
    expect(ack.revision).toBe(2)
    expect(manager.push(notice("failure"))).toEqual(ack)
    expect(manager.dismiss({ ...authority, id: item.id, revision: item.revision })).toEqual(ack)
  })

  it("preserves an updated notification when dismiss carries the old item revision", () => {
    let time = 1000
    const manager = new BotErrorTrays(authority, () => ++time)
    const old = manager.push(notice("failure-one", { groupKey: "provider-unavailable" })).items[0]!
    const updated = manager.push(notice("failure-two", { groupKey: "provider-unavailable" }))
    expect(updated.items[0]).toMatchObject({
      id: old.id,
      revision: 2,
      count: 2,
      createdAt: old.createdAt
    })
    const ack = manager.dismiss({ ...authority, id: old.id, revision: old.revision })
    expect(ack).toEqual(updated)
    expect(manager.push(notice("failure-two", { groupKey: "provider-unavailable" }))).toEqual(ack)
    expect(manager.dismiss({ ...authority, id: old.id, revision: 2 }).items).toEqual([])
  })

  it("clears only notices at the seen revision and preserves new and concurrently updated notices", () => {
    const manager = new BotErrorTrays(authority, () => 1000)
    const old = manager.push(notice("old", { groupKey: "provider" }))
    manager.push(notice("new", { runId: "run-two" }))
    manager.push(notice("updated", { groupKey: "provider" }))
    const ack = manager.clear({ ...authority, throughRevision: old.revision })
    expect(ack.items).toHaveLength(2)
    expect(ack.items.map((item) => item.revision)).toEqual([2, 3])
    expect(ack.revision).toBe(3)
    expect(manager.clear({ ...authority, throughRevision: 2 }).items).toHaveLength(1)
    const last = manager.snapshot()
    expect(last.revision).toBe(4)
    expect(manager.clear({ ...authority, throughRevision: 2 })).toEqual(last)
  })

  it("rejects stale authority and future clear cutoffs without deleting unseen notices", () => {
    const manager = new BotErrorTrays(authority, () => 1000)
    const snapshot = manager.push(notice("failure"))
    const item = snapshot.items[0]!
    for (const stale of [
      { ...authority, hostId: "old-host" },
      { ...authority, dataEpoch: "old-epoch" }
    ]) {
      expect(manager.dismiss({ ...stale, id: item.id, revision: item.revision })).toEqual(snapshot)
      expect(manager.clear({ ...stale, throughRevision: snapshot.revision })).toEqual(snapshot)
    }
    expect(manager.clear({ ...authority, throughRevision: 999 })).toEqual(snapshot)
  })

  it("retires prior workspace trays and commands on restore without retaining old episodes", () => {
    const manager = new BotErrorTrays(authority, () => 1000)
    const previous = manager.push(notice("failure"))
    manager.setDataEpoch("epoch-two")
    expect(manager.snapshot()).toEqual({
      ...authority,
      dataEpoch: "epoch-two",
      revision: 0,
      items: []
    })
    const current = manager.push(notice("failure"))
    expect(current.revision).toBe(1)
    expect(current.items[0]!.id).not.toBe(previous.items[0]!.id)
    expect(manager.clear({ ...authority, throughRevision: 100 })).toEqual(current)
  })

  it("does not group another Bot's or task's failures under a producer's same group label", () => {
    const manager = new BotErrorTrays(authority, () => 1000)
    manager.push(notice("one", { groupKey: "provider" }))
    manager.push(notice("two", { groupKey: "provider", botId: "bot-two" }))
    manager.push(notice("three", { groupKey: "provider", runId: "run-two" }))
    expect(manager.snapshot().items.map((item) => item.count)).toEqual([1, 1, 1])
  })

  it("validates before committing any revision, episode or notice", () => {
    const manager = new BotErrorTrays(authority, () => 1000)
    expect(() =>
      manager.push(notice("failure", { threadRootId: "thread-one", conversationId: undefined }))
    ).toThrow()
    expect(manager.snapshot().revision).toBe(0)
    expect(manager.push(notice("failure")).revision).toBe(1)
  })
})

describe("bounded safe diagnostic display", () => {
  it("caps titles, detail and hints, redacting opaque raw/JSON/URL credentials before wire", () => {
    const secret = 'opaque-credential-"\\suffix'
    const payload = `Failure ${secret} ${JSON.stringify(secret)} ${encodeURIComponent(secret)} `
    const manager = new BotErrorTrays(authority, () => 1000)
    const snapshot = manager.push(
      notice("failure", {
        title: payload.repeat(20),
        detail: payload.repeat(100),
        hint: payload.repeat(20)
      }),
      [secret]
    )
    const item = snapshot.items[0]!
    expect(item.title.length).toBeLessThanOrEqual(160)
    expect(item.detail.length).toBeLessThanOrEqual(2000)
    expect(item.hint!.length).toBeLessThanOrEqual(500)
    const wire = JSON.stringify(snapshot)
    expect(wire).not.toContain(JSON.stringify(secret).slice(1, -1))
    expect(wire).not.toContain(encodeURIComponent(secret))
    expect(wire).toContain("已隐藏凭据")
  })

  it("masks a credential straddling the display boundary and handles malformed Unicode", () => {
    const secret = "opaque-token-for-this-invocation"
    const text = `${"x".repeat(145)} ${secret} tail`
    const safe = safeBotErrorText(text, 160, [secret])
    expect(safe.length).toBeLessThanOrEqual(160)
    expect(safe).not.toContain("opaque-token")
    expect(safeBotErrorText(text.slice(0, 160), 160, [secret])).not.toContain("opaque-token")
    expect(() => safeBotErrorText("bad credential \ud800", 100, ["\ud800"])).not.toThrow()
    expect(safeBotErrorText("invalid limit", Number.NaN)).toBe("")
  })

  it("keeps numeric provider IDs but never keeps URLs, invalid IDs or a known credential", () => {
    expect(
      safeBotErrorDiagnostic({ code: "runtime_failed", requestId: "1234567890123456" }).requestId
    ).toBe("1234567890123456")
    expect(
      safeBotErrorDiagnostic({ code: "runtime_failed", requestId: "https://model.invalid/key" })
        .requestId
    ).toBeUndefined()
    expect(
      safeBotErrorDiagnostic({ code: "runtime_failed", requestId: "opaque-secret" }, [
        "opaque-secret"
      ]).requestId
    ).toBeUndefined()
    expect(
      safeBotErrorDiagnostic({ code: "runtime_failed", requestId: "opaque-secret" }, [
        "opaque-secret-with-private-tail"
      ]).requestId
    ).toBeUndefined()
    expect(
      safeBotErrorDiagnostic({
        code: "runtime_failed",
        callId: "call_one",
        correlationId: "rpc_one"
      })
    ).toEqual({ code: "runtime_failed", callId: "call_one", correlationId: "rpc_one" })
  })
})
