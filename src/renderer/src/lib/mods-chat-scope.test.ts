import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { afterEach, expect, it, vi } from "vitest"
const hooks = vi.hoisted(() => ({ index: 0, rendering: false, rerender: false, slots: [] as unknown[],
  effects: [] as Array<() => void>, rollbacks: [] as Array<() => void>, cleanups: [] as Array<() => void> }))
vi.mock("react", async importOriginal => {
  const memo = <T>(create: () => T, deps?: readonly unknown[]): T => {
    const index = hooks.index++
    const previous = hooks.slots[index] as { deps?: readonly unknown[]; value: T } | undefined
    if (previous?.deps && deps && deps.length === previous.deps.length &&
      deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return previous.value
    const value = create()
    hooks.slots[index] = { deps, value }
    return value
  }
  return ({
  ...(await importOriginal<typeof import("react")>()),
  useState: <T>(initial: T) => {
    const index = hooks.index++
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial
    return [hooks.slots[index], (value: T) => { hooks.slots[index] = value; if (hooks.rendering) hooks.rerender = true }]
  },
  useRef: <T>(initial: T) => {
    const index = hooks.index++
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }
    return hooks.slots[index]
  },
  useCallback: <T>(callback: T, deps?: readonly unknown[]) => memo(() => callback, deps),
  useMemo: memo,
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const index = hooks.index++
    const previous = hooks.slots[index] as { deps?: unknown[]; cleanup?: () => void } | undefined
    if (previous?.deps && deps && deps.every((value, i) => Object.is(value, previous.deps?.[i]))) return
    const slot: { deps?: unknown[]; cleanup?: () => void } = { deps }
    hooks.slots[index] = slot
    hooks.rollbacks.push(() => { hooks.slots[index] = previous })
    hooks.effects.push(() => {
      previous?.cleanup?.()
      slot.cleanup = effect() || undefined
      if (slot.cleanup) hooks.cleanups.push(slot.cleanup)
    })
  }
  })
})
import { useModsChatState } from "./mods-chat-scope"
const readState = useModsChatState // Explicit hook harness; no mounted React component.

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup() {
  const requests: ReturnType<typeof deferred<boolean>>[] = []
  const notifications = new Set<() => void>()
  const read = vi.fn(() => {
    const request = deferred<boolean>()
    requests.push(request)
    return request.promise
  })
  vi.stubGlobal("window", Object.assign(new EventTarget(), { api: { mods: {
    chatDisplayCapability: read,
    onConfigurationChanged: (notify: () => void) => {
      notifications.add(notify)
      return () => notifications.delete(notify)
    }
  } } }))
  const render = (thread = "thread", workspace = "workspace", effects = true):
    ReturnType<typeof useModsChatState> => {
    for (const rollback of hooks.rollbacks.splice(0).reverse()) rollback()
    hooks.effects.length = 0
    hooks.index = 0
    hooks.rerender = false
    hooks.rendering = true
    const state = readState(thread, workspace)
    hooks.rendering = false
    if (hooks.rerender) return render(thread, workspace, effects)
    if (effects) {
      hooks.rollbacks.length = 0
      for (const effect of hooks.effects.splice(0)) effect()
    }
    return state
  }
  return { requests, read, render, notify: () => { for (const notify of notifications) notify() } }
}
async function settle() { for (let i = 0; i < 5; i++) await Promise.resolve() }
afterEach(() => {
  for (const cleanup of hooks.cleanups.splice(0)) cleanup()
  hooks.slots.length = 0
  hooks.effects.length = 0
  hooks.rollbacks.length = 0
  hooks.index = 0
  vi.unstubAllGlobals()
})

it("requires one scoped host decision before admitting an inactive native display", async () => {
  const f = setup()
  expect(f.render().ready).toBe(false)
  expect(f.read).toHaveBeenCalledWith("thread", "workspace")
  f.requests[0].resolve(false)
  await settle()
  expect(f.render()).toMatchObject({ enabled: false, ready: true })
  expect(f.read).toHaveBeenCalledTimes(1)
})

it("keeps the admitted context stable across unrelated renders and revokes it synchronously", async () => {
  const f = setup()
  f.render()
  f.requests[0].resolve(true)
  await settle()
  const admitted = f.render()
  for (let i = 0; i < 30; i++) {
    expect(f.render()).toBe(admitted)
    expect(f.render().isCurrent).toBe(admitted.isCurrent)
  }
  expect(f.read).toHaveBeenCalledTimes(1)
  f.notify()
  expect(admitted.isCurrent()).toBe(false)
  expect(f.render()).not.toBe(admitted)
  expect(f.render().ready).toBe(false)
  f.requests[1].resolve(true)
  await settle()
  const replacement = f.render()
  expect(replacement.isCurrent).not.toBe(admitted.isCurrent)
  expect(replacement.isCurrent()).toBe(true)
  expect(admitted.isCurrent()).toBe(false)
})

it("keeps failures closed and exposes a read-only retry", async () => {
  const f = setup()
  f.render()
  f.requests[0].reject(Error("CONTROL_RECOVERY_REQUIRED"))
  await settle()
  const failed = f.render()
  expect(failed).toMatchObject({ enabled: false, ready: false })
  expect(failed.error).toBeTruthy()
  failed.retry()
  expect(f.render()).toMatchObject({ enabled: false, ready: false, error: undefined })
  f.requests[1].resolve(true)
  await settle()
  expect(f.render()).toMatchObject({ enabled: true, ready: true })
})

it("revokes a disabled result on configuration change and discards late prior reads", async () => {
  const f = setup()
  f.render()
  f.requests[0].resolve(false)
  await settle()
  expect(f.render().ready).toBe(true)
  const oldInactive = f.render()
  const click = vi.fn()
  const capturedClick = () => { if (oldInactive.isCurrent()) click() }
  f.notify()
  capturedClick()
  expect(click).not.toHaveBeenCalled()
  expect(oldInactive.isCurrent()).toBe(false)
  expect(f.render().ready).toBe(false)
  f.notify()
  f.requests[2].resolve(true)
  await settle()
  f.requests[1].resolve(false)
  await settle()
  expect(f.render()).toMatchObject({ enabled: true, ready: true })
})

it("never restores A's completed result or response across A-B-A renders", async () => {
  const f = setup()
  f.render("A", "workspace-A")
  f.requests[0].resolve(false)
  await settle()
  const original = f.render("A", "workspace-A")
  expect(original.ready).toBe(true)
  expect(original.isCurrent()).toBe(true)
  expect(f.render("B", "workspace-B", false).ready).toBe(false)
  expect(original.isCurrent()).toBe(false)
  expect(f.render("A", "workspace-A", false).ready).toBe(false)
  expect(original.isCurrent()).toBe(false)
  f.render("A", "workspace-A")
  f.requests[1].resolve(true)
  await settle()
  expect(f.render("A", "workspace-A")).toMatchObject({ enabled: true, ready: true })
})

it("does not admit a late result after the same thread changes workspace", async () => {
  const f = setup()
  f.render()
  f.render("thread", "new-workspace")
  f.requests[0].resolve(false)
  await settle()
  expect(f.render("thread", "new-workspace").ready).toBe(false)
  f.requests[1].resolve(true)
  await settle()
  expect(f.render("thread", "new-workspace")).toMatchObject({ ready: true, enabled: true })
})

it("keeps missing workspace unknown and never revives its captured callback", async () => {
  const f = setup()
  const missing = f.render("thread", "")
  expect(missing.ready).toBe(false)
  expect(missing.isCurrent()).toBe(false)
  expect(missing.error).toBeTruthy()
  expect(f.read).not.toHaveBeenCalled()
  f.render("thread", "resolved-workspace")
  f.requests[0].resolve(false)
  await settle()
  expect(f.render("thread", "resolved-workspace")).toMatchObject({ ready: true, enabled: false })
  expect(missing.isCurrent()).toBe(false)
})

it("the real ChatContainer provider carries revocation, error and retry contracts", async () => {
  const source = ts.createSourceFile("ChatContainer.tsx", readFileSync(
    new URL("../components/chat/ChatContainer.tsx", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let callback = ""
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "modsChatScope" &&
      node.initializer && ts.isCallExpression(node.initializer))
      callback = node.initializer.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  expect(callback).not.toBe("")
  const retry = vi.fn(), isCurrent = () => false
  const modsChatState = { enabled: false, ready: false, error: "denied", retry, isCurrent }
  const loadThreads = vi.fn(async () => {})
  const context = { threadId: "thread", modsChatState, hasCurrentThread: true,
    currentForkWorkspacePath: "workspace", reloadMissingThread: () => { void loadThreads() } }
  const read = () => runInNewContext(ts.transpileModule(`(${callback})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context) as typeof modsChatState
  expect(read()).toMatchObject(modsChatState)
  expect(read().isCurrent).toBe(isCurrent)
  expect(read().retry).toBe(retry)
  context.currentForkWorkspacePath = ""
  const missingWorkspace = read()
  expect(missingWorkspace.error).toBe("denied")
  missingWorkspace.retry()
  await settle()
  expect(loadThreads).toHaveBeenCalledOnce()
  context.hasCurrentThread = false
  expect(read().error).toBeUndefined()
  expect(read().ready).toBe(false)
})

it("re-reads a conservatively revoked decision after an abandoned scope render", async () => {
  const f = setup()
  f.render()
  f.requests[0].resolve(false)
  await settle()
  const original = f.render()
  // A concurrent abandoned render revoked this lifetime but did not commit its new identity.
  const lifetime = hooks.slots.find(value => value && typeof value === "object" &&
    "invalidate" in value && "capture" in value) as { invalidate(): void }
  lifetime.invalidate()
  expect(original.isCurrent()).toBe(false)
  expect(f.render().ready).toBe(false)
  expect(f.read).toHaveBeenCalledTimes(2)
  f.requests[1].resolve(true)
  await settle()
  expect(f.render()).toMatchObject({ ready: true, enabled: true })
  expect(original.isCurrent()).toBe(false)
})

it("re-reads an in-flight decision revoked by an abandoned scope render", async () => {
  const f = setup()
  expect(f.render().ready).toBe(false)
  const lifetime = hooks.slots.find(value => value && typeof value === "object" &&
    "invalidate" in value && "capture" in value) as { invalidate(): void }
  lifetime.invalidate()
  expect(f.render().ready).toBe(false)
  expect(f.read).toHaveBeenCalledTimes(2)
  f.requests[0].resolve(false)
  await settle()
  expect(f.render().ready).toBe(false)
  f.requests[1].resolve(true)
  await settle()
  expect(f.render()).toMatchObject({ ready: true, enabled: true })
})
