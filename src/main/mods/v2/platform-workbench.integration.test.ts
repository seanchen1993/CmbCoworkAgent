import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionPlugin } from "./dispatcher"
import type { ModObject } from "../../../shared/mods/types"
import { withFunctionExecution } from "./execution-context"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { checkFunctionAuthorTypes } from "../devtools/authoring-check"
import { analyzeFunctionSdk } from "../devtools/sdk-usage"
import type { FunctionUiNode } from "../../../shared/mods/v2/ui"

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
const ref = { provider: "task-workbench-provider", id: "tasks", version: "1.0.0" }
const query = { ref, target: { kind: "current" } }
async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "platform-workbench-")),
    threadId = randomUUID()
  const compiled = await compileFunctionPlugin(resolve("examples/sparks-task-workbench/provider"))
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const provider: FunctionPlugin = {
    name: compiled.name,
    root: compiled.root,
    tier: "user",
    guest,
    capabilities: [...SESSION_CAPABILITIES]
  }
  const consumer: FunctionPlugin = {
    name: "independent-consumer",
    root: workspace,
    tier: "user",
    guest: await FunctionGuestRuntime.create("globalThis.__cmbFunctionMod={register(){}}"),
    capabilities: [...SESSION_CAPABILITIES]
  }
  let approvals = 0,
    notifications = 0,
    chats = 0
  const session = new FunctionSession([provider, consumer], {
    workspace,
    threadId,
    assertLive() {
      /* No external grant source in this temporary fixture. */
    },
    publish: async (value) => value,
    cwd: () => workspace,
    platformChanged: () => {
      notifications++
    },
    uiChanged: () => {
      chats++
    },
    authorizeProcess: async () => {
      approvals++
    },
    callTool: async (_plugin, input) => {
      if (input.tool !== "write_file") throw Error("unexpected tool")
      await writeFile(String(input.file_path), String(input.content))
      return { result: { path: String(input.file_path) } }
    }
  })
  closes.push(async () => {
    await session.close(true)
    await rm(workspace, { recursive: true, force: true })
  })
  const signal = new AbortController().signal
  const act = (action: string, input: ModObject, requestKey: string) =>
    session.platform.act(consumer, { ...query, action, input, requestKey }, signal)
  const tasks = async () => {
    const state = (await session.platform.call(
      consumer,
      "platform.read",
      [query],
      signal
    )) as ModObject
    return ((state.value as ModObject | undefined)?.tasks ?? []) as ModObject[]
  }
  return {
    workspace,
    threadId,
    session,
    consumer,
    act,
    tasks,
    facts: () => ({ approvals, notifications, chats })
  }
}
async function waitFor(check: () => Promise<boolean>, ms = 10000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw Error("task did not settle")
}

it("ships a strict typed provider whose declared real permissions are statically reviewable", async () => {
  const root = resolve("examples/sparks-task-workbench/provider")
  const types = await checkFunctionAuthorTypes(root)
  expect(types.diagnostics).toEqual([])
  const compiled = await compileFunctionPlugin(root, { captureSources: true })
  const review = await analyzeFunctionSdk(compiled)
  expect(review.diagnostics).toEqual([])
  expect(review.registrationEventsVerified).toBe(true)
  expect(review.usages.map((usage) => usage.method)).toEqual(
    expect.arrayContaining([
      "platform.act",
      "platform.publish",
      "clock.after",
      "process.spawn",
      "fs.write"
    ])
  )
})

it("ships the independent edit reminder as a typed, statically reviewable author package", async () => {
  const root = resolve("examples/sparks-edit-reminder")
  expect((await checkFunctionAuthorTypes(root)).diagnostics).toEqual([])
  const review = await analyzeFunctionSdk(
    await compileFunctionPlugin(root, { captureSources: true })
  )
  expect(review.diagnostics).toEqual([])
  expect(review.registrationEvents).toEqual(["ui.render"])
  expect(review.usages.map((usage) => usage.method)).toEqual(
    expect.arrayContaining([
      "platform.subscribe",
      "platform.poll",
      "platform.unsubscribe",
      "fs.write"
    ])
  )
})

it("edit reminder observes a successful real file action, redraws and releases its subscription/timer", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "platform-edit-reminder-")),
    threadId = randomUUID()
  const compiled = await compileFunctionPlugin(resolve("examples/sparks-edit-reminder"))
  const guest = await FunctionGuestRuntime.create(compiled.code, {
    path: join(workspace, "edit.txt"),
    text: "actual edit"
  })
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace,
      threadId,
      platformIncarnation: "bound",
      assertLive() {
        /* Native fixture scope. */
      },
      publish: async (value) => value,
      callTool: async (_plugin, input) => {
        const path = String(input.file_path)
        await writeFile(path, String(input.content))
        session.platform.publishHostFileEdit({
          workspace,
          threadId,
          incarnation: "bound",
          path,
          operation: "write_file",
          requestId: "actual-write-completed"
        })
        return { result: { path } }
      }
    }
  )
  closes.push(async () => {
    await session.close(true)
    await rm(workspace, { recursive: true, force: true })
  })
  const list = session.platformSurfaces.list(),
    initial = { key: list.entries[0].key, revision: list.revision }
  const opened = await session.platformSurfaces.open(
    initial,
    new AbortController().signal,
    "edit-open"
  )
  const address = { ...initial, openId: opened.openId }
  expect(session.hasStarted).toBe(false)
  expect(session.platform.diagnostics().subscriptions).toBe(1)
  expect(session.ownedResourceCount).toBe(1)
  const pane = opened.pane!,
    nodes = (pane.tree as FunctionUiNode).children as FunctionUiNode[]
  expect(JSON.stringify(pane.tree)).toContain("尚无可核对")
  const button = nodes.find((node) => node.type === "Button")!
  claimLocalThreadRunLease({ threadId, owner: "mods", runId: "write" })
  try {
    await withFunctionExecution(
      { workspace, threadId, userInitiated: true, leased: true, immediate: false },
      () =>
        session.platformSurfaces.act(address, {
          pane: pane.key,
          generation: pane.generation,
          plugin: button.press!.plugin,
          handle: button.press!.handle,
          intentId: randomUUID(),
          kind: "press"
        })
    )
  } finally {
    releaseLocalThreadRunLease(threadId, "mods", "write")
  }
  await waitFor(
    async () =>
      JSON.stringify((await session.platformSurfaces.read(address)).pane?.tree).includes(
        "actual-write-completed"
      ) ||
      JSON.stringify((await session.platformSurfaces.read(address)).pane?.tree).includes(
        "宿主已完成"
      )
  )
  expect(await readFile(join(workspace, "edit.txt"), "utf8")).toBe("actual edit")
  expect(JSON.stringify((await session.platformSurfaces.read(address)).pane?.tree)).toContain(
    "write_file"
  )
  await session.platformSurfaces.closePage(address)
  expect(session.platform.diagnostics()).toMatchObject({ subscriptions: 0, inFlight: 0 })
  expect(session.ownedResourceCount).toBe(0)
  expect(await session.panes.snapshot()).toEqual([])
})

it("independent consumer executes actual approved file/process work and observes progress without startup", async () => {
  const f = await fixture()
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "mods", runId: "platform" })
  try {
    const result = await withFunctionExecution(
      {
        workspace: f.workspace,
        threadId: f.threadId,
        userInitiated: true,
        leased: true,
        immediate: false
      },
      () =>
        f.act(
          "start",
          {
            taskId: "real",
            path: join(f.workspace, "written.txt"),
            text: "real file",
            argv: [process.execPath, "-e", "console.log('actual-child-output')"]
          },
          "start-real"
        )
    )
    expect(result).toMatchObject({
      status: "succeeded",
      value: { taskId: "real", status: "running" }
    })
  } finally {
    releaseLocalThreadRunLease(f.threadId, "mods", "platform")
  }
  await waitFor(async () => (await f.tasks())[0]?.status === "succeeded")
  expect(await readFile(join(f.workspace, "written.txt"), "utf8")).toBe("real file")
  expect((await f.tasks())[0].output).toContain("actual-child-output")
  expect(f.facts()).toMatchObject({ approvals: 1, chats: 0 })
  expect(f.facts().notifications).toBeGreaterThan(1)
  expect(f.session.hasStarted).toBe(false)
})

it("returns promptly from start and cancels a real child before reporting cancelled", async () => {
  const f = await fixture()
  const pidPath = join(f.workspace, "child-pid")
  const result = await f.act(
    "start",
    {
      taskId: "long",
      argv: [
        process.execPath,
        "-e",
        "require('fs').writeFileSync(process.argv[1],String(process.pid));console.log('ready');setInterval(()=>{},1000)",
        pidPath
      ]
    },
    "start-long"
  )
  expect(result).toMatchObject({ status: "succeeded", value: { status: "running" } })
  await waitFor(async () => String((await f.tasks())[0]?.output).includes("ready"))
  const pid = Number(await readFile(pidPath, "utf8"))
  expect(() => process.kill(pid, 0)).not.toThrow()
  expect(await f.act("cancel", { taskId: "long" }, "cancel-long")).toMatchObject({
    status: "succeeded",
    value: { taskId: "long", status: "cancelled" }
  })
  expect(() => process.kill(pid, 0)).toThrow()
  expect((await f.tasks())[0].status).toBe("cancelled")
  await expect(
    f.act("start", { taskId: "long", argv: ["must-not-run"] }, "start-long")
  ).rejects.toThrow("MODS_PLATFORM_REQUEST_CONFLICT")
}, 20000)
