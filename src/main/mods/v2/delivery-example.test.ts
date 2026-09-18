import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionTurnComplete } from "../../../shared/mods/v2/turn"
import type { FunctionPaneSnapshot, FunctionUiAction, FunctionUiElement } from "../../../shared/mods/v2/ui"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

async function fixture(state = new Map<string, ModJson>()) {
  const compiled = await compileFunctionPlugin(resolve("examples/my-delivery-claw"))
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const session = new FunctionSession(
    [{
      name: compiled.name,
      root: compiled.root,
      tier: "user",
      guest,
      capabilities: [...SESSION_CAPABILITIES]
    }],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value,
      state: () => ({
        get: async (key) => state.get(key),
        keys: async () => [...state.keys()],
        set: async (key, value) => { state.set(key, value) },
        delete: (key) => { state.delete(key) }
      })
    }
  )
  sessions.push(session)
  await session.start()
  return { session, state }
}

function completion(overrides: Partial<FunctionTurnComplete> = {}): FunctionTurnComplete {
  return {
    turnId: randomUUID(), answer: "任务回复", durationMs: 4200,
    reason: "answer", isAborted: false, ...overrides
  } as FunctionTurnComplete
}

function control(pane: FunctionPaneSnapshot, key: string, kind: FunctionUiAction["kind"], value?: string) {
  let found: FunctionUiElement | undefined
  function visit(node: FunctionUiElement | string): void {
    if (typeof node === "string") return
    if (node.props.key === key) found = node
    node.children?.forEach(visit)
  }
  visit(pane.tree)
  if (!found?.press) throw Error(`missing control ${key}`)
  return {
    pane: pane.key, generation: pane.generation, intentId: randomUUID(),
    plugin: found.press.plugin, handle: found.press.handle, kind,
    ...(value === undefined ? {} : { value })
  }
}

it("loads the installable plugin and keeps bounded settings across runtime recreation", async () => {
  const { session, state } = await fixture()
  await session.run("my-claw", "name 招银研发搭子")
  await session.run("my-claw", "rule 检查异常处理，列出没有运行的测试。")
  expect((await session.run("my-claw", "name " + "x".repeat(31))).text).toContain("1–30")
  expect(state.get("name")).toBe("招银研发搭子")
  expect((await session.run("my-claw", "preview")).text).toContain("预览（未执行任务）")
  expect(state.has("last-report")).toBe(false)
  await session.close()
  const restored = await fixture(state)
  const preview = await restored.session.run("my-claw", "preview")
  expect(preview.text).toContain("招银研发搭子")
  expect(preview.text).toContain("检查异常处理")
})

it("adds a truthful main-turn reminder once and persists the last report", async () => {
  const { session, state } = await fixture()
  const event = completion()
  const result = await session.turnComplete(event)
  expect(result.text).toContain("阿牛 · 本轮已结束 · 4 秒")
  expect(result.text).toContain("不代表已经完成检视或测试")
  expect(state.get("last-report")).toBe(result.text)
  expect((await session.turnComplete(event)).text).toBe(event.answer)
  expect((await session.run("my-claw", "last")).text).toBe(result.text)
})

it("skips children, cancellation, errors, refusals and disabled reminders", async () => {
  const { session, state } = await fixture()
  for (const event of [
    completion({ agentId: "child" }),
    completion({ reason: "aborted", isAborted: true }),
    completion({ reason: "error" }),
    completion({ reason: "refusal", refusal: { category: null, explanation: null } })
  ]) expect((await session.turnComplete(event)).text).toBe(event.answer)
  expect(state.has("last-report")).toBe(false)
  await session.run("my-claw", "off")
  expect((await session.turnComplete(completion())).text).toBe("任务回复")
  await session.run("my-claw", "on")
  expect((await session.turnComplete(completion())).text).toContain("交付提醒")
})

it("renders the pane and applies input and toggle callbacks through the real guest SDK", async () => {
  const { session, state } = await fixture()
  await session.run("my-claw", "")
  let [pane] = await session.panes.snapshot()
  expect(pane.title).toBe("我的交付 Claw")
  await session.panes.act(control(pane, "name", "submit", "我的质量搭子"))
  ;[pane] = await session.panes.snapshot()
  expect(JSON.stringify(pane.tree)).toContain("我的质量搭子")
  await session.panes.act(control(pane, "rule", "submit", "特别关注权限边界"))
  ;[pane] = await session.panes.snapshot()
  expect(JSON.stringify(pane.tree)).toContain("特别关注权限边界")
  await session.panes.act(control(pane, "toggle", "press"))
  ;[pane] = await session.panes.snapshot()
  expect(state.get("enabled")).toBe(false)
  expect(JSON.stringify(pane.tree)).toContain("开启自动提醒")
})
