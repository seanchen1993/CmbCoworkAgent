import { expect, it } from "vitest"
import { resolve } from "node:path"
import { checkFunctionAuthorTypes } from "../devtools/authoring-check"
import { analyzeFunctionSdk } from "../devtools/sdk-usage"
import { compileFunctionPlugin } from "./loader"
import { argv, settings } from "../../../../examples/developer-workbench/hooks/settings"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { FunctionStateStore } from "./state-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionPlugin } from "./dispatcher"
import type { FunctionUiNode } from "../../../shared/mods/v2/ui"
import type { ModObject } from "../../../shared/mods/types"
import type {
  NativePlatformCapabilityProvider,
  NativePlatformCallContext
} from "./platform-capabilities-types"
import { withFunctionExecution } from "./execution-context"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"

async function fixture(denyProcess = false) {
  const workspace = await mkdtemp(join(tmpdir(), "developer-workbench-")),
    threadId = randomUUID()
  const compiled = await compileFunctionPlugin(resolve("examples/developer-workbench"), {
    captureSources: true
  })
  const review = await analyzeFunctionSdk(compiled)
  const db = new DatabaseSync(join(workspace, "state.sqlite")),
    store = new FunctionStateStore(db)
  const plugin: FunctionPlugin = {
    name: compiled.name,
    root: compiled.root,
    tier: "user",
    guest: await FunctionGuestRuntime.create(compiled.code, compiled.options),
    capabilities: [...new Set(review.usages.map((usage) => usage.method))]
  }
  const consumer: FunctionPlugin = {
    name: "independent-consumer",
    root: workspace,
    tier: "user",
    guest: await FunctionGuestRuntime.create("globalThis.__cmbFunctionMod={register(){}}"),
    capabilities: [...SESSION_CAPABILITIES]
  }
  const calls: string[] = []
  const reads: string[] = []
  let approvals = 0,
    observed: NativePlatformCallContext | undefined,
    stops = 0
  let gate: { wait: Promise<void>; entered(): void; skip: number } | undefined
  let blockedSignal: AbortSignal | undefined
  const facade = (
    provider: string,
    id: string,
    actions: string[]
  ): NativePlatformCapabilityProvider => ({
    provider,
    queryActions: actions,
    queryRead: true,
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id,
      version: "1.0.0",
      title: id,
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: actions.map((action) => ({
        id: action,
        title: action,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        requiredPermissions: [],
        cancellable: true,
        idempotency: "keyed"
      }))
    },
    async read(context) {
      reads.push(provider)
      if (provider === "native.workspace" && gate) {
        if (gate.skip > 0) gate.skip--
        else {
          const current = gate
          gate = undefined
          blockedSignal = context.signal
          current.entered()
          await current.wait
        }
      }
      return { status: provider === "native.code" ? "unavailable" : "ready", observing: false }
    },
    watch(context) {
      observed = context
      return () => {
        stops++
      }
    },
    async act(_context, action, input) {
      calls.push(provider + ":" + action)
      return { action, input, status: "observed" }
    }
  })
  const session = new FunctionSession([plugin, consumer], {
    workspace,
    threadId,
    platformIncarnation: "fixture",
    assertLive() {
      /* isolated fixture */
    },
    publish: async (value) => value,
    cwd: () => workspace,
    authorizeProcess: async () => {
      approvals++
      if (denyProcess) throw Error("fixture-native-policy-denied")
    },
    state: (p) => ({
      get: async (key) => store.get(p.name, key),
      set: async (key, value) => {
        store.set(p.name, key, value)
      },
      delete: (key) => store.delete(p.name, key),
      keys: async () => store.keys(p.name)
    }),
    platformNativeProviders: [
      facade("native.code", "java", ["diagnostics"]),
      facade("native.editor", "navigation", ["preview"]),
      facade("native.workspace", "changes", []),
      facade("native.git", "inspection", ["bind", "list"]),
      facade("native.workflow", "runs", [])
    ]
  })
  const signal = new AbortController().signal
  const user = async <T>(work: () => Promise<T>) => {
    const runId = randomUUID()
    claimLocalThreadRunLease({ threadId, owner: "mods", runId })
    try {
      return await withFunctionExecution(
        { workspace, threadId, userInitiated: true, leased: true, immediate: false },
        work
      )
    } finally {
      releaseLocalThreadRunLease(threadId, "mods", runId)
    }
  }
  const catalog = session.platformSurfaces.list()
  const open = async (placement: string) => {
    const entry = catalog.entries.find((item) => item.placement === placement)!
    const initial = { key: entry.key, revision: catalog.revision }
    const opened = await session.platformSurfaces.open(initial, signal, randomUUID())
    return { ...initial, openId: opened.openId }
  }
  const readTasks = async () => {
    const state = (await session.platform.call(
      consumer,
      "platform.read",
      [
        {
          ref: { provider: plugin.name, id: "tasks", version: "1.0.0" },
          target: { kind: "current" }
        }
      ],
      signal
    )) as ModObject
    return ((state.value as ModObject)?.tasks || []) as ModObject[]
  }
  const act = (action: string, input: ModObject) =>
    user(() =>
      session.platform.act(
        consumer,
        {
          ref: { provider: plugin.name, id: "tasks", version: "1.0.0" },
          target: { kind: "current" },
          action,
          input,
          requestKey: randomUUID()
        },
        signal
      )
    )
  return {
    session,
    catalog,
    open,
    user,
    store,
    plugin,
    act,
    readTasks,
    facts: () => ({
      approvals,
      calls,
      reads: [...reads],
      stops,
      blockedSignalAborted: blockedSignal?.aborted
    }),
    publishChange: () => observed!.publish({ kind: "invalidate", reason: "fixture-change" }),
    pauseWorkspaceRead(skip = 0) {
      let release!: () => void, entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      gate = {
        wait: new Promise<void>((resolve) => {
          release = resolve
        }),
        entered,
        skip
      }
      return { started, release }
    },
    async close() {
      await session.close(true)
      db.close()
      await rm(workspace, { recursive: true, force: true })
    }
  }
}

function find(node: FunctionUiNode, key: string): FunctionUiNode | undefined {
  if (node.props?.key === key) return node
  for (const child of node.children || []) {
    if (typeof child !== "object") continue
    const found = find(child as FunctionUiNode, key)
    if (found) return found
  }
  return undefined
}
function textChildren(node: FunctionUiNode): string[] {
  return (node.children || []).flatMap((child) =>
    typeof child === "string" ? [child] : textChildren(child as FunctionUiNode)
  )
}
async function waitFor(check: () => Promise<boolean>) {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw Error("workbench condition did not settle")
}

it("ships a typed, statically auditable workbench with no private host bridge", async () => {
  const root = resolve("examples/developer-workbench")
  expect((await checkFunctionAuthorTypes(root)).diagnostics).toEqual([])
  const review = await analyzeFunctionSdk(
    await compileFunctionPlugin(root, { captureSources: true })
  )
  expect(review.diagnostics).toEqual([])
  expect(review.registrationEventsVerified).toBe(true)
})

it("bounds argv and position settings without converting text to a shell command", () => {
  expect(settings(null).argv).toBe('["node","--version"]')
  expect(argv('["node","a b"]')).toEqual(["node", "a b"])
  for (const invalid of ['"node --version"', "[]", '[" "]', '["node","\\u0000"]'])
    expect(() => argv(invalid)).toThrow()
  expect(() => settings({ line: "0" })).toThrow()
  expect(() => settings({ column: "1.5" })).toThrow()
  for (const path of ["x".repeat(513), "../Main.java", "C:/Main.java", "/Main.java", "a\\b.java"])
    expect(() => settings({ path })).toThrow()
  for (const field of ["line", "column"]) expect(() => settings({ [field]: "100001" })).toThrow()
})

it("opens five real surfaces, saves settings and dispatches native queries only on explicit buttons", async () => {
  const f = await fixture()
  try {
    expect(f.catalog.entries.map((entry) => entry.placement).sort()).toEqual([
      "navigation",
      "page",
      "settings",
      "sidebar",
      "toolbar"
    ])
    const address = await f.open("page")
    const press = async (key: string) => {
      const pane = (await f.session.platformSurfaces.read(address)).pane!
      const button = find(pane.tree as FunctionUiNode, key)!
      await f.user(() =>
        f.session.platformSurfaces.act(address, {
          pane: pane.key,
          generation: pane.generation,
          intentId: randomUUID(),
          plugin: button.press!.plugin,
          handle: button.press!.handle,
          kind: "press"
        })
      )
    }
    expect(f.facts()).toMatchObject({ approvals: 0, calls: [] })
    await press("refresh")
    const readText = async () =>
      textChildren((await f.session.platformSurfaces.read(address)).pane!.tree as FunctionUiNode)
    const actualLabels = await readText()
    for (const label of [
      "Java服务：未启动",
      "文件变化：未观察",
      "工作流：状态未知",
      "源码预览：状态未知",
      "Git检查：状态未知"
    ])
      expect(actualLabels).toContain(label)
    expect(actualLabels.some((text) => text.startsWith("开发信息："))).toBe(false)
    const beforeToggle = f.facts()
    const beforeResources = f.session.platform.diagnostics()
    await press("developer-info")
    const details = (await readText()).filter((text) => text.startsWith("开发信息："))
    expect(details).toHaveLength(5)
    expect(details.map((text) => JSON.parse(text.slice("开发信息：".length)).ref.provider)).toEqual(
      ["native.code", "native.editor", "native.workspace", "native.git", "native.workflow"]
    )
    for (const text of details) {
      expect(text.length).toBeLessThan(4500)
      expect(text).not.toContain("stateSchema")
    }
    expect(await readText()).toContain("工作流：状态未知")
    expect(f.facts()).toEqual(beforeToggle)
    expect(f.session.platform.diagnostics()).toEqual(beforeResources)
    await press("developer-info")
    expect((await readText()).some((text) => text.startsWith("开发信息："))).toBe(false)
    expect(f.facts()).toEqual(beforeToggle)
    await press("refresh")
    expect((await readText()).some((text) => text.startsWith("开发信息："))).toBe(false)
    expect(f.facts().calls).toEqual([])
    await press("diagnostics")
    await press("preview")
    expect(f.facts().calls).toEqual(["native.code:diagnostics", "native.editor:preview"])
    await press("observe")
    expect(f.session.platform.diagnostics().subscriptions).toBe(1)
    f.publishChange()
    await waitFor(async () =>
      JSON.stringify((await f.session.platformSurfaces.read(address)).pane?.tree).includes(
        "fixture-change"
      )
    )
    await f.session.platformSurfaces.closePage(address)
    expect(f.session.platform.diagnostics().subscriptions).toBe(0)
    expect(f.facts().stops).toBe(1)
    const settingsAddress = await f.open("settings")
    const pane = (await f.session.platformSurfaces.read(settingsAddress)).pane!
    const form = find(pane.tree as FunctionUiNode, "settings")!
    await f.session.platformSurfaces.act(settingsAddress, {
      pane: pane.key,
      generation: pane.generation,
      intentId: randomUUID(),
      plugin: form.press!.plugin,
      handle: form.press!.handle,
      kind: "submit",
      value: JSON.stringify({
        argv: '["node","--version"]',
        path: "src/Main.java",
        line: "2",
        column: "3"
      })
    })
    expect(f.store.get(f.plugin.name, "settings")).toMatchObject({
      path: "src/Main.java",
      line: "2"
    })
    expect(f.facts().approvals).toBe(0)
    await f.session.platformSurfaces.closePage(settingsAddress)
    expect(f.session.ownedResourceCount).toBe(0)
  } finally {
    await f.close()
  }
})

it("observes an actual process exit without interpreting stdout PASS as success", async () => {
  const f = await fixture()
  try {
    f.store.set(f.plugin.name, "settings", {
      argv: JSON.stringify([process.execPath, "-e", "console.log('PASS');process.exitCode=7"]),
      path: "Main.java",
      line: "1",
      column: "1"
    })
    const address = await f.open("page")
    const pane = (await f.session.platformSurfaces.read(address)).pane!
    const button = find(pane.tree as FunctionUiNode, "run")!
    await f.user(() =>
      f.session.platformSurfaces.act(address, {
        pane: pane.key,
        generation: pane.generation,
        intentId: randomUUID(),
        plugin: button.press!.plugin,
        handle: button.press!.handle,
        kind: "press"
      })
    )
    await waitFor(async () => (await f.readTasks())[0]?.phase === "closed-with-result")
    expect((await f.readTasks())[0]).toMatchObject({
      code: 7,
      signal: null,
      exitObserved: true,
      closeConfirmed: true,
      startEvidence: "sdk-result-observed"
    })
    expect(f.facts().approvals).toBe(1)
  } finally {
    await f.close()
  }
})

it("retains cancellation as distinct from an exit result and never replays historical tasks", async () => {
  const f = await fixture()
  try {
    f.store.set(f.plugin.name, "task-history", [
      { id: "old", phase: "output-observed", output: "old" }
    ])
    await f.act("start", {
      taskId: "cancel-me",
      argv: [process.execPath, "-e", "console.log('ready');setTimeout(()=>{},20000)"]
    })
    await waitFor(async () =>
      (await f.readTasks()).some(
        (task) => task.id === "cancel-me" && task.startEvidence === "sdk-output-observed"
      )
    )
    const cancelled = await f.act("cancel", { taskId: "cancel-me" })
    expect(cancelled.status).toBe("succeeded")
    const tasks = await f.readTasks()
    expect(tasks.find((task) => task.id === "old")).toMatchObject({ phase: "historical-unknown" })
    expect(tasks.find((task) => task.id === "cancel-me")).toMatchObject({
      phase: "closed-after-cancel",
      closeConfirmed: true,
      exitObserved: false
    })
    expect(f.facts().approvals).toBe(1)
  } finally {
    await f.close()
  }
})

it("exposes original commands and cleans observation when the original pane close event fires", async () => {
  const f = await fixture()
  try {
    expect((await f.session.commands()).map((command) => command.name)).toEqual(
      expect.arrayContaining(["dev-workbench", "dev-workbench-settings"])
    )
    await f.session.run("dev-workbench", "")
    const pane = (await f.session.panes.snapshot()).find(
      (item) => item.id === "developer-workbench"
    )!
    const button = find(pane.tree as FunctionUiNode, "observe")!
    await f.user(() =>
      f.session.panes.act({
        pane: pane.key,
        generation: pane.generation,
        plugin: button.press!.plugin,
        handle: button.press!.handle,
        intentId: randomUUID(),
        kind: "press"
      })
    )
    expect(f.session.platform.diagnostics().subscriptions).toBe(1)
    const current = (await f.session.panes.snapshot()).find(
      (item) => item.id === "developer-workbench"
    )!
    await f.session.panes.act({
      pane: current.key,
      generation: current.generation,
      plugin: current.plugin,
      handle: 0,
      intentId: randomUUID(),
      kind: "close"
    })
    expect(f.session.platform.diagnostics().subscriptions).toBe(0)
    expect(f.session.ownedResourceCount).toBe(0)
    expect(f.facts().approvals).toBe(0)
  } finally {
    await f.close()
  }
})

it("preserves original process denial as unknown without invented start, exit or retry", async () => {
  const f = await fixture(true)
  try {
    await f.act("start", { taskId: "denied", argv: [process.execPath, "--version"] })
    await waitFor(async () => (await f.readTasks())[0]?.phase === "unknown")
    expect((await f.readTasks())[0]).toMatchObject({
      startEvidence: "none",
      closeConfirmed: false,
      exitObserved: false,
      error: expect.stringContaining("fixture-native-policy-denied")
    })
    expect(f.facts().approvals).toBe(1)
    await f.act("start", { taskId: "denied", argv: [process.execPath, "--version"] })
    expect(f.facts().approvals).toBe(1)
  } finally {
    await f.close()
  }
})

it.each([0, 2])(
  "retires observation during pending read/subscribe (read offset %s) without late resources",
  async (skip) => {
    const f = await fixture()
    try {
      const address = await f.open("page")
      const pane = (await f.session.platformSurfaces.read(address)).pane!
      const button = find(pane.tree as FunctionUiNode, "observe")!
      const gate = f.pauseWorkspaceRead(skip)
      const pending = f.user(() =>
        f.session.platformSurfaces.act(address, {
          pane: pane.key,
          generation: pane.generation,
          intentId: randomUUID(),
          plugin: button.press!.plugin,
          handle: button.press!.handle,
          kind: "press"
        })
      )
      const outcome = pending.catch(() => undefined)
      await gate.started
      const closed = f.session.platformSurfaces.closePage(address)
      // Observe actual native cancellation before releasing the blocked read.
      await waitFor(async () => f.facts().blockedSignalAborted === true)
      expect(f.facts().blockedSignalAborted).toBe(true)
      gate.release()
      await outcome
      await closed
      // Guest cancellation finishes before the blocked native continuation physically settles.
      // Require bounded eventual native cleanup instead of equating the two completion points.
      await waitFor(
        async () =>
          f.session.platform.diagnostics().subscriptions === 0 &&
          f.facts().stops === (skip === 2 ? 1 : 0)
      )
      expect(f.session.platform.diagnostics().subscriptions).toBe(0)
      expect(f.facts().stops).toBe(skip === 2 ? 1 : 0)
      expect(f.session.ownedResourceCount).toBe(0)
      expect(f.facts().approvals).toBe(0)
    } finally {
      await f.close()
    }
  }
)
