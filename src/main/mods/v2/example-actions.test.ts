import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { ModObject } from "../../../shared/mods/types"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean()
})

it("runs the shipped Autobiz preparation and independent Review with real file input and an awaited model boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "claw-examples-"))
  const autobiz = join(root, "plugins", "autobiz")
  const review = join(root, "plugins", "review")
  await cp(resolve("examples/autobiz-kanban-mods"), autobiz, { recursive: true })
  await cp(resolve("examples/mods-review-agent"), review, { recursive: true })
  await writeFile(
    join(autobiz, "plugin.json"),
    JSON.stringify({
      name: "AutobizDevOps_Plugin_Kanban_Mods",
      mods: "mods/manifest.json"
    })
  )
  const native = JSON.parse(await readFile(join(autobiz, "mods/manifest.json"), "utf8"))
  native.claw.actions = JSON.parse(await readFile(join(autobiz, "claw-actions.json"), "utf8")).actions
  await writeFile(join(autobiz, "mods/manifest.json"), JSON.stringify(native))
  // A minimal workflow fixture tests this adapter, not the upstream Python validator.
  await writeFile(
    join(autobiz, "hooks", "kanban", "workflow.generated.ts"),
    'export const variants={"standard|standard|":[{label:"编码",checkpoints:["code_wip"],states:[]}]}'
  )
  await mkdir(join(root, ".autobizdevops"))
  await writeFile(
    join(root, ".autobizdevops", "state.json"),
    JSON.stringify({
      schemaVersion: "autobizdevops.state.v3",
      features: { "order-export": { checkpoint: "code_wip" } }
    })
  )
  await writeFile(
    join(root, "orders.ts"),
    "export const total = (prices) => prices.reduce((a,b) => a+b, 0)\n"
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  let captured: ModObject | undefined
  let release!: () => void
  let arrived!: () => void
  const entered = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const completed = new Promise<void>((resolve) => {
    release = resolve
  })
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [
        { id: "autobiz", name: "AutobizDevOps_Plugin_Kanban_Mods", path: autobiz, enabled: true },
        { id: "review", name: "review-agent", path: review, enabled: true }
      ],
      enabled: () => true,
      changed: () => {},
      publish: async (_, value) => value,
      completeModel: async (_workspace, _thread, _grant, input) => {
        captured = input
        arrived()
        await completed
        return "仅检视了给定文件；未执行测试。建议处理空值和非数字输入。"
      }
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          return guest
        },
        stop() {
          for (const guest of guests) guest.dispose()
        }
      }
    }
  )
  cleanups.push(async () => {
    release()
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  for (const entry of await manager.status(root)) {
    try {
      await manager.approve(root, entry.pluginId, entry.digest!)
    } catch (error) {
      throw new Error(`Example failed to load: ${entry.name}`, { cause: error })
    }
  }
  const actions = await manager.actionCatalog(root, "thread")
  const signal = new AbortController().signal
  const envelope = {
    version: 1 as const,
    input: { path: "orders.ts", feature: "order-export" },
    config: {},
    task: "检视订单导出",
    runId: "run",
    stepId: "prepare",
    executionId: "a"
  }
  const first = await manager.runAction(
    root,
    "thread",
    await manager.prepareAction(
      root,
      "thread",
      actions.find((item) => item.pluginId === "autobiz")!,
      signal
    ),
    envelope,
    signal
  )
  expect(first.output).toMatchObject({
    feature: "order-export",
    checkpoint: "code_wip",
    path: "orders.ts"
  })
  expect(first.output?.source).toContain("prices.reduce")
  const second = await manager.prepareAction(
    root,
    "thread",
    actions.find((item) => item.pluginId === "review")!,
    signal
  )
  let finished = false
  const running = manager
    .runAction(
      root,
      "thread",
      second,
      { ...envelope, input: first.output!, config: { model: "custom:review" }, stepId: "review" },
      signal
    )
    .then((value) => {
      finished = true
      return value
    })
  await entered
  expect(finished).toBe(false)
  expect(captured).toMatchObject({ model: "custom:review" })
  expect(captured?.prompt).toContain("prices.reduce")
  release()
  expect(await running).toMatchObject({
    output: { path: "orders.ts", scope: "single-file-no-tests", model: "custom:review" }
  })
  const state = JSON.parse(await readFile(join(root, ".autobizdevops/state.json"), "utf8"))
  expect(state.features["order-export"].checkpoint).toBe("code_wip")
})
