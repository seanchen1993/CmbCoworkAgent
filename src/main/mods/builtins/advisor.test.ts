import { describe, it, expect, vi } from "vitest"
import { BuiltinProjectAdvisor, ADVISOR_LIMITS } from "./advisor"
import { projectBuiltinRunOverview } from "./overview"
const overview = projectBuiltinRunOverview({
  threadId: "thread",
  workspace: "workspace",
  capturedAt: 1,
  instructions: { status: "unknown", message: "not observed" },
  records: [],
  limited: false,
  policy: { required: false, denyTools: [] }
})
const scope = () => ({
  threadId: "thread",
  workspace: "workspace",
  incarnation: "incarnation",
  assertCurrent: vi.fn()
})
function fixture() {
  const values = new Map<string, string>()
  const store = {
    getSetting: (key: string, fallback = "") => values.get(key) ?? fallback,
    compareAndSetSetting: (key: string, expected: string | undefined, value: string) => {
      if (values.get(key) !== expected) return false
      values.set(key, value)
      return true
    }
  }
  let now = Date.UTC(2026, 9, 12)
  const make = () => new BuiltinProjectAdvisor(store, () => now)
  return {
    make,
    values,
    advance: () => {
      now += 60_000
    }
  }
}
describe("optional project advisor", () => {
  it("invalidates changed facts, deduplicates dismissed advice and limits concurrent scopes", async () => {
    const { make, advance } = fixture(),
      advisor = make()
    let facts = "initial"
    const access = { ...scope(), factsIdentity: () => facts }
    advisor.enable(access, true)
    let finish!: (result: { text: string }) => void
    const invoke = vi.fn(
      () =>
        new Promise<{ text: string }>((resolve) => {
          finish = resolve
        })
    )
    const pending = advisor.analyze(access, overview, invoke)
    const other = { ...scope(), threadId: "other" }
    advisor.enable(other, true)
    await expect(
      advisor.analyze(other, { ...overview, threadId: "other" }, invoke)
    ).rejects.toThrow("BUSY")
    facts = "changed-during-analysis"
    finish({ text: "stale" })
    await expect(pending).rejects.toThrow("FACTS_CHANGED")
    expect(advisor.view(access).result).toBeUndefined()
    advance()
    await advisor.analyze(access, overview, async () => ({ text: "current" }))
    expect(advisor.view(access).result?.text).toBe("current")
    advisor.dismiss(access)
    advance()
    await advisor.analyze(access, overview, invoke)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(advisor.view(access).result).toBeUndefined()
    facts = "next-run"
    await advisor.analyze(access, overview, async () => ({ text: "new" }))
    facts = "next-stage"
    expect(advisor.view(access).result).toBeUndefined()
  })
  it("defaults off, uses bounded facts, never admits text/file bodies, settles one result", async () => {
    const { make } = fixture(),
      advisor = make(),
      access = scope()
    const invoke = vi.fn(async (facts: string, signal: AbortSignal) => {
      expect(typeof facts).toBe("string")
      expect(signal.aborted).toBe(false)
      return { text: "先查看运行记录", inputTokens: 100, outputTokens: 10 }
    })
    expect(advisor.view(access).enabled).toBe(false)
    await expect(advisor.analyze(access, overview, invoke)).rejects.toThrow("DISABLED")
    expect(invoke).not.toHaveBeenCalled()
    advisor.enable(access, true)
    const result = await advisor.analyze(access, overview, invoke)
    expect(result.running).toBe(false)
    expect(result.result?.text).toBe("先查看运行记录")
    expect(JSON.parse(invoke.mock.calls[0][0])).not.toHaveProperty("workspace")
    await expect(advisor.analyze(access, overview, invoke)).rejects.toThrow("COOLDOWN")
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it("preserves the app-wide daily budget over restart and enable toggles", async () => {
    const { make, advance } = fixture(),
      access = scope()
    for (let index = 0; index < ADVISOR_LIMITS.dailyCalls; index++) {
      const advisor = make()
      advisor.enable(access, true)
      await advisor.analyze(access, overview, async () => ({ text: "建议" }))
      advance()
    }
    const advisor = make()
    advisor.enable(access, true)
    await expect(advisor.analyze(access, overview, async () => ({ text: "建议" }))).rejects.toThrow(
      "DAILY_LIMIT"
    )
  })
  it("cancels without publishing a late result and rejects parallel requests", async () => {
    const { make } = fixture(),
      advisor = make(),
      access = scope()
    advisor.enable(access, true)
    let finish!: (value: { text: string }) => void
    const running = advisor.analyze(access, overview, async (_facts, signal) => {
      expect(signal.aborted).toBe(false)
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    await expect(
      advisor.analyze(access, overview, async () => ({ text: "other" }))
    ).rejects.toThrow("BUSY")
    advisor.enable(access, false)
    let cancelled = false
    const stopping = advisor.cancel(access).then(() => {
      cancelled = true
    })
    await Promise.resolve()
    expect(cancelled).toBe(false)
    finish({ text: "late" })
    await expect(running).rejects.toThrow("CANCELLED")
    await stopping
    expect(cancelled).toBe(true)
    expect(advisor.view(access)).toMatchObject({ enabled: false, running: false })
    expect(advisor.view(access).result).toBeUndefined()
  })
  it("fences scope changes and never reports absent token usage as zero", async () => {
    const { make } = fixture(),
      advisor = make(),
      access = scope()
    advisor.enable(access, true)
    await expect(
      advisor.analyze(access, { ...overview, workspace: "other" }, async () => ({ text: "bad" }))
    ).rejects.toThrow("SCOPE_CHANGED")
    const result = await advisor.analyze(access, overview, async () => ({ text: "结果未知" }))
    expect(result.result).toMatchObject({ inputTokens: null, outputTokens: null })
    expect(advisor.view({ ...access, incarnation: "replacement" }).enabled).toBe(false)
  })
})
