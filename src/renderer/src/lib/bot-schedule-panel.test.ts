import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactElement } from "react"
import type { BotClient, BotDesktopWorkScheduleBinding, BotSchedule, BotScheduleEditInput, BotScheduleInput } from "../../../shared/bots/contracts"
import { parseSchedule } from "../../../shared/bots/validation"

// Exercise the real editor callbacks without mounting a portaled Dialog in the Node suite.
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[] }))
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState(initial: unknown) {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = initial
    return [
      hooks.slots[index],
      (next: unknown) => {
        hooks.slots[index] = typeof next === "function" ? next(hooks.slots[index]) : next
      }
    ]
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }
    return hooks.slots[index]
  }
}))
import { BotSchedulePanel } from "../components/bots/BotSchedulePanel"

type Node = ReactElement<{
  children?: unknown
  type?: string
  maxLength?: number
  "aria-label"?: string
  disabled?: boolean
  role?: string
  value: string | number
  defaultValue?: string
  onClick(event: { currentTarget: object }): void
  onChange(event: { target: { value: string } }): void
  onSubmit(event: { preventDefault(): void }): void
  onValueChange(value: string): void
}>
function flatten(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(flatten)
  if (!node || typeof node !== "object" || !("props" in node)) return []
  const element = node as Node
  return [element, ...flatten(element.props.children)]
}
const daily: BotScheduleInput = {
  name: "Synthetic routine",
  message: "Read a report",
  enabled: true,
  frequency: "daily",
  runAtTime: "14:25"
}
const once: BotScheduleInput = {
  ...daily,
  frequency: "once",
  runAt: "2099-11-01T01:00:00.000Z"
}
function fixture(source: BotScheduleInput | "new", work?: { id: string; title: string }, loseFirstResponse = false,
  state?: Partial<BotSchedule>, openEditor = true) {
  const schedule =
    source === "new"
      ? undefined
      : ({
          ...parseSchedule(source),
          id: "routine",
          botId: "bot",
          version: 3,
          nextRunAt: null,
          ...state
        } as BotSchedule)
  const saved: BotScheduleInput[] = []
  const failures: string[] = []
  const saveSchedule = vi.fn(async (_botId: string, input: BotScheduleInput,
    _existing?: BotScheduleEditInput, _desktopWork?: BotDesktopWorkScheduleBinding) => {
    try {
      saved.push(parseSchedule(input))
      if (loseFirstResponse && saved.length === 1) throw new Error("回复未到达")
    } catch (error) {
      failures.push((error as Error).message)
      throw error
    }
  })
  const render = () => {
    hooks.cursor = 0
    return flatten(
      BotSchedulePanel({
        botId: "bot",
        work,
        schedules: schedule ? [schedule] : [],
        client: { saveSchedule } as unknown as BotClient
      })
    )
  }
  const find = (predicate: (node: Node) => boolean) => {
    const node = render().find(predicate)
    if (!node) throw new Error("Missing editor control")
    return node
  }
  if (openEditor) find(
    (node) => node.props["aria-label"] === (schedule ? "编辑例行任务" : "创建例行任务")
  ).props.onClick({ currentTarget: {} })
  return {
    saved,
    failures,
    saveSchedule,
    render,
    find,
    frequency(next: BotScheduleInput["frequency"]) {
      find(
        (node) =>
          typeof node.props.onValueChange === "function" &&
          ["daily", "weekly", "interval", "once"].includes(String(node.props.value))
      ).props.onValueChange(next)
    },
    field(type: string) {
      return find((node) => node.type === "input" && node.props.type === type)
    },
    weekday() {
      return find(
        (node) =>
          typeof node.props.onValueChange === "function" && /^[0-6]$/.test(String(node.props.value))
      )
    },
    async submit() {
      find((node) => node.type === "form").props.onSubmit({ preventDefault: vi.fn() })
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}
beforeEach(() => {
  hooks.cursor = 0
  hooks.slots = []
})

describe("routine editor frequency changes", () => {
  it("exposes an exact queued occurrence on the card and withdraws it without deleting the routine", () => {
    const editor = fixture({ ...once, enabled: false }, undefined, false,
      { desktopWork: true, lastTriggeredAt: once.runAt, pendingOccurrenceId: "occurrence" }, false)
    expect(editor.render().some(node => Array.isArray(node.props.children) && node.props.children.includes("已入队，等待执行"))).toBe(true)
    editor.find(node => node.props["aria-label"] === "撤回本次执行").props.onClick({ currentTarget: {} })
    expect(editor.saveSchedule).toHaveBeenCalledExactlyOnceWith("bot", expect.objectContaining({ enabled: false }),
      { id: "routine", version: 3, withdrawTaskId: "occurrence" })
  })

  it("renews the same expired reminder with an explicitly selected trigger and deadline", async () => {
    const expired = { ...once, enabled: false }
    const state = { fixedReminder: { kind: "fixed_reminder" as const, ended: "expired" as const,
      expiresAt: "2099-11-01T01:01:00.000Z" } }
    const editor = fixture(expired, undefined, false, state, false)
    const renew = editor.find(node => node.props["aria-label"] === "续期例行任务")
    expect(renew.props.disabled).toBe(false)
    renew.props.onClick({ currentTarget: {} })
    expect(editor.field("datetime-local").props.defaultValue).toBe("")
    const expiry = () => editor.find(node => node.props["aria-label"] === "失效时间")
    expect(expiry().props.value).toBe("")
    editor.field("datetime-local").props.onChange({ target: { value: "2099-11-01T09:00" } })
    expiry().props.onChange({ target: { value: "2099-11-01T09:30" } })
    await editor.submit()
    expect(editor.saveSchedule).toHaveBeenCalledExactlyOnceWith("bot",
      expect.objectContaining({ enabled: true, runAt: new Date("2099-11-01T09:00").toISOString() }),
      { id: "routine", version: 3, expiresAt: new Date("2099-11-01T09:30").toISOString() })
  })

  it("preserves an expired observation and its exact existing deadline on a name edit", async () => {
    const editor = fixture({ ...daily, enabled: false }, undefined, false,
      { workMonitor: { workId: "work", mode: "report", generation: 1, ended: "expired",
        expiresAt: "2099-11-01T01:01:59.000Z" } })
    await editor.submit()
    expect(editor.saveSchedule).toHaveBeenCalledExactlyOnceWith("bot", expect.objectContaining({ enabled: false }),
      { id: "routine", version: 3 })
  })

  it("binds an explicit work creation and reuses its request identity if the reply is lost", async () => {
    const editor = fixture("new", { id: "report-work", title: "Report" }, true)
    editor.find(node => node.type === "input" && node.props.maxLength === 120)
      .props.onChange({ target: { value: "Review report" } })
    editor.find(node => node.type === "textarea").props.onChange({ target: { value: "Update the existing report" } })
    await editor.submit()
    expect(editor.failures).toEqual(["回复未到达"])
    await editor.submit()
    const [first, second] = editor.saveSchedule.mock.calls
    expect(first[2]).toBeUndefined()
    expect(first[3]).toEqual({ workId: "report-work", operationId: expect.any(String) })
    expect(second[3]).toEqual(first[3])
  })

  it.each([
    [daily, "weekly", { frequency: "weekly", runAtTime: "14:25", weekday: 1 }],
    [daily, "interval", { frequency: "interval", intervalMinutes: 60 }],
    [once, "daily", { frequency: "daily", runAtTime: "09:00" }],
    [once, "weekly", { frequency: "weekly", runAtTime: "09:00", weekday: 1 }]
  ] as const)(
    "submits the visible defaults when changing %j to %s",
    async (source, target, expected) => {
      const editor = fixture(source)
      editor.frequency(target)
      if (target === "weekly") expect(editor.weekday().props.value).toBe("1")
      if (target === "interval") expect(editor.field("number").props.value).toBe(60)
      else expect(editor.field("time").props.value).toBe(expected.runAtTime)
      await editor.submit()
      expect(editor.failures).toEqual([])
      expect(editor.saved).toEqual([
        { name: daily.name, message: daily.message, enabled: true, ...expected }
      ])
      expect(editor.saveSchedule).toHaveBeenCalledWith("bot", expect.anything(), {
        id: "routine",
        version: 3
      })
    }
  )
  it("preserves explicit time, weekday and interval input across frequency round trips", async () => {
    const editor = fixture({ ...daily, frequency: "weekly", weekday: 0 })
    editor.frequency("interval")
    editor.field("number").props.onChange({ target: { value: "75" } })
    editor.frequency("once")
    editor.frequency("daily")
    editor.field("time").props.onChange({ target: { value: "06:45" } })
    editor.frequency("weekly")
    expect(editor.field("time").props.value).toBe("06:45")
    expect(editor.weekday().props.value).toBe("0")
    editor.frequency("interval")
    expect(editor.field("number").props.value).toBe(75)
    await editor.submit()
    expect(editor.saved[0]).toMatchObject({ frequency: "interval", intervalMinutes: 75 })
  })
  it.each(["interval", "daily"] as const)(
    "does not replace invalid explicit %s input with a default",
    async (frequency) => {
      const editor = fixture(daily)
      editor.frequency(frequency)
      editor.field(frequency === "interval" ? "number" : "time").props.onChange({
        target: { value: frequency === "interval" ? "0" : "" }
      })
      editor.frequency("weekly")
      editor.frequency(frequency)
      await editor.submit()
      expect(editor.saved).toEqual([])
      expect(editor.failures).toHaveLength(1)
      expect(editor.render().some((node) => node.props.role === "alert")).toBe(true)
    }
  )
  it("keeps new daily form defaults valid", async () => {
    const editor = fixture("new")
    editor
      .find((node) => node.type === "input" && node.props.maxLength === 120)
      .props.onChange({ target: { value: daily.name } })
    editor
      .find((node) => node.type === "textarea")
      .props.onChange({ target: { value: daily.message } })
    expect(editor.field("time").props.value).toBe("09:00")
    await editor.submit()
    expect(editor.saved).toEqual([{ ...daily, runAtTime: "09:00" }])
    expect(editor.saveSchedule).toHaveBeenLastCalledWith("bot", expect.anything(), undefined)
  })
  it.each(["new", daily] as const)(
    "keeps once requiring an explicit valid date from %j",
    async (source) => {
      const editor = fixture(source)
      if (source === "new") {
        editor
          .find((node) => node.type === "input" && node.props.maxLength === 120)
          .props.onChange({ target: { value: daily.name } })
        editor
          .find((node) => node.type === "textarea")
          .props.onChange({ target: { value: daily.message } })
      }
      editor.frequency("once")
      expect(editor.field("datetime-local").props.defaultValue).toBe("")
      await editor.submit()
      expect(editor.saved).toEqual([])
      editor.field("datetime-local").props.onChange({ target: { value: "not-a-date" } })
      await editor.submit()
      expect(editor.saved).toEqual([])
      editor.field("datetime-local").props.onChange({ target: { value: "2099-11-01T09:00" } })
      await editor.submit()
      expect(editor.saved[0]).toMatchObject({
        frequency: "once",
        runAt: new Date("2099-11-01T09:00").toISOString()
      })
      expect(editor.saveSchedule).toHaveBeenLastCalledWith(
        "bot",
        expect.anything(),
        source === "new" ? undefined : { id: "routine", version: 3 }
      )
    }
  )
})
