import { EventEmitter } from "node:events"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as flush } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { beginSideThreadClose, unregisterSideThread } from "../ipc/btw-chat"
import { hasRunningSideHooks, sideThreads, waitForSideHooksOnQuit } from "../side-thread-registry"
import { runHooksEnriched } from "./required-skill"
import { runHooks, type HookContext } from "./runner"
import { createHookScope, filterScopedHooks, type HookScopeController } from "./scope"
import { fireSessionEnd, fireSessionEndAll, fireSessionStartOnce, hasActiveSessions } from "./session-lifecycle"
import { hasWorkspaceBeenInitialised } from "../services/setup-state"
import type { HookConfig, HookEvent } from "./types"

const { enabledHooks, initialisedWorkspaces, markInitialised, resolveStage, spawnCommand } = vi.hoisted(() => ({
  enabledHooks: vi.fn(),
  initialisedWorkspaces: new Set<string>(),
  markInitialised: vi.fn(),
  resolveStage: vi.fn(),
  spawnCommand: vi.fn()
}))

vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>()
  return {
    ...childProcess,
    spawn: (...args: Parameters<typeof childProcess.spawn>) =>
      spawnCommand(...args) ?? childProcess.spawn(...args)
  }
})

vi.mock("./scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scope")>()),
  resolveEnabledHooksForRun: enabledHooks
}))

vi.mock("../services/setup-state", () => ({
  hasWorkspaceBeenInitialised: vi.fn(async (workspacePath: string) => initialisedWorkspaces.has(workspacePath)),
  markWorkspaceInitialised: async (workspacePath: string) => {
    if (await markInitialised(workspacePath) !== false) initialisedWorkspaces.add(workspacePath)
  }
}))

vi.mock("../services/harness-stage-attribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/harness-stage-attribution")>()),
  resolveHarnessExecutionStage: resolveStage
}))

const mainThreadId = "00000000-0000-4000-8000-000000000001"
const sideThreadId = `btw-${mainThreadId}-00000000-0000-4000-8000-000000000002`
const siblingThreadId = `btw-${mainThreadId}-00000000-0000-4000-8000-000000000003`
const unrelatedThreadId = "00000000-0000-4000-8000-000000000004"

function registerSideThread(id = sideThreadId) {
  sideThreads.set(id, {
    ordinal: 1,
    context: [],
    lifetime: new AbortController(),
    owner: { ids: new Set([id]), document: new AbortController() }
  })
}

function hook(event: HookEvent, id: string, async = false): HookConfig {
  return {
    id,
    event,
    async,
    enabled: true,
    type: "http",
    url: `https://hooks.invalid/${id}`,
    createdAt: "",
    updatedAt: ""
  }
}

function holdFirstHook() {
  const entered = Promise.withResolvers<void>()
  const pending = Promise.withResolvers<Response>()
  const request = vi.fn()
    .mockImplementationOnce(() => {
      entered.resolve()
      return pending.promise
    })
    .mockImplementation(async () => Response.json({}))
  vi.stubGlobal("fetch", request)
  return { entered, pending, request }
}

function commandHook(event: HookEvent, id: string, detached = false): HookConfig {
  return { ...hook(event, id, detached), type: "command", command: `echo ${id}`, timeout: 15_000 }
}

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: { end: vi.fn() },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn()
  })
}

beforeEach(() => { enabledHooks.mockReturnValue([]) })

afterEach(async () => {
  unregisterSideThread(sideThreadId)
  unregisterSideThread(siblingThreadId)
  enabledHooks.mockReturnValue([])
  await fireSessionEnd(sideThreadId)
  await fireSessionEnd(siblingThreadId)
  await fireSessionEnd(mainThreadId)
  await fireSessionEnd(unrelatedThreadId)
  enabledHooks.mockReset()
  initialisedWorkspaces.clear()
  markInitialised.mockReset()
  resolveStage.mockReset()
  spawnCommand.mockReset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("side thread Hook lifetime", () => {
  it.each([true, false])("ignores a slow marker read after its session was replaced (initialised: %s)", async initialised => {
    const read = Promise.withResolvers<boolean>()
    vi.mocked(hasWorkspaceBeenInitialised).mockReturnValueOnce(read.promise)
    const old = fireSessionStartOnce(mainThreadId, "/workspace")
    await fireSessionEnd(mainThreadId)
    expect(enabledHooks).not.toHaveBeenCalled()
    await fireSessionStartOnce(mainThreadId)
    enabledHooks.mockClear()
    read.resolve(initialised)
    await old
    expect(enabledHooks).not.toHaveBeenCalled()
  })

  it("lets a stopped main turn retry while the first marker read is outstanding", async () => {
    const read = Promise.withResolvers<boolean>()
    vi.mocked(hasWorkspaceBeenInitialised).mockReturnValueOnce(read.promise)
    const stop = new AbortController()
    const start = fireSessionStartOnce(mainThreadId, "/workspace", undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, stop.signal)
    stop.abort()
    await start
    expect(hasActiveSessions()).toBe(false)
    expect(enabledHooks).not.toHaveBeenCalled()
    await fireSessionStartOnce(mainThreadId, "/workspace")
    read.resolve(false)
    await flush()
    expect(enabledHooks.mock.calls.map(([, event]) => event)).toEqual(["Setup", "SessionStart"])
  })

  it("rechecks a stale missing marker after the closing side finished Setup", async () => {
    registerSideThread()
    const { entered, pending, request } = holdFirstHook()
    enabledHooks.mockImplementation((_workspace, event) => event === "Setup" ? [hook(event, event)] : [])
    const side = fireSessionStartOnce(sideThreadId, "/workspace")
    await entered.promise
    beginSideThreadClose(sideThreadId)
    await side

    const stale = Promise.withResolvers<boolean>()
    vi.mocked(hasWorkspaceBeenInitialised).mockReturnValueOnce(stale.promise)
    const main = fireSessionStartOnce(mainThreadId, "/workspace")
    pending.resolve(Response.json({}))
    await vi.waitFor(() => expect(initialisedWorkspaces.has("/workspace")).toBe(true))
    stale.resolve(false)
    await main
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([true, false])("joins a side that started during the parent's marker read (finished: %s)", async finished => {
    registerSideThread()
    const stale = Promise.withResolvers<boolean>()
    vi.mocked(hasWorkspaceBeenInitialised).mockReturnValueOnce(stale.promise)
    const main = fireSessionStartOnce(mainThreadId, "/workspace")
    const { entered, pending, request } = holdFirstHook()
    enabledHooks.mockImplementation((_workspace, event) => event === "Setup" ? [hook(event, event)] : [])
    const side = fireSessionStartOnce(sideThreadId, "/workspace")
    await entered.promise
    beginSideThreadClose(sideThreadId)
    await side
    if (finished) {
      pending.resolve(Response.json({}))
      await vi.waitFor(() => expect(initialisedWorkspaces.has("/workspace")).toBe(true))
    }
    stale.resolve(false)
    await flush()
    pending.resolve(Response.json({}))
    await main
    expect(request).toHaveBeenCalledOnce()
  })

  it("joins a second closing side while checking an unsuccessful handoff", async () => {
    registerSideThread()
    registerSideThread(siblingThreadId)
    const first = Promise.withResolvers<Response>()
    const second = Promise.withResolvers<Response>()
    const request = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    vi.stubGlobal("fetch", request)
    enabledHooks.mockImplementation((_workspace, event) => event === "Setup" ? [{ ...hook(event, event), fallback: "block" }] : [])
    const side = fireSessionStartOnce(sideThreadId, "/workspace")
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    beginSideThreadClose(sideThreadId)
    await side
    const main = fireSessionStartOnce(mainThreadId, "/workspace")
    await flush()
    const stale = Promise.withResolvers<boolean>()
    const reading = Promise.withResolvers<void>()
    vi.mocked(hasWorkspaceBeenInitialised).mockImplementationOnce(() => { reading.resolve(); return stale.promise })
    first.resolve(Response.json({}, { status: 500 }))
    await reading.promise
    const sibling = fireSessionStartOnce(siblingThreadId, "/workspace")
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    beginSideThreadClose(siblingThreadId)
    await sibling
    stale.resolve(false)
    await flush()
    second.resolve(Response.json({}))
    await main
    expect(request).toHaveBeenCalledTimes(2)
  })

  it("dispatches SessionStart only after the marker write settles", async () => {
    const write = Promise.withResolvers<void>()
    markInitialised.mockReturnValueOnce(write.promise)
    const main = fireSessionStartOnce(mainThreadId, "/workspace")
    await vi.waitFor(() => expect(markInitialised).toHaveBeenCalledOnce())
    expect(enabledHooks.mock.calls.map(([, event]) => event)).toEqual(["Setup"])
    write.resolve()
    await main
    expect(enabledHooks.mock.calls.map(([, event]) => event)).toEqual(["Setup", "SessionStart"])
  })

  it.each(["UserPromptSubmit", "PreSkillUse", "PostSkillUse", "Stop"] as const)(
    "stops waiting for %s and fences remaining hooks when the registered side closes",
    async (event) => {
      registerSideThread()
      const { entered, pending, request } = holdFirstHook()
      const onHookResult = vi.fn()
      const result = expect(
        runHooksEnriched(
          [hook(event, "first"), hook(event, "second")],
          event,
          { sessionId: sideThreadId },
          onHookResult
        )
      ).rejects.toMatchObject({ name: "AbortError" })

      await entered.promise
      beginSideThreadClose(sideThreadId)
      await result
      expect(onHookResult).not.toHaveBeenCalled()
      pending.resolve(Response.json({}))
      await flush()
      expect(request).toHaveBeenCalledOnce()
      expect(onHookResult).toHaveBeenCalledExactlyOnceWith(
        event,
        expect.objectContaining({ id: "first" }),
        expect.objectContaining({ exitCode: 0 })
      )
    }
  )

  it.each([
    { mode: "synchronous", detached: false },
    { mode: "detached", detached: true }
  ])(
    "uses the declared $mode HTTP mode when the app quits after the side closes",
    async ({ detached }) => {
      registerSideThread()
      const { entered, pending } = holdFirstHook()
      const onHookResult = vi.fn()
      const run = runHooks(
        [hook("UserPromptSubmit", "active", detached)],
        "UserPromptSubmit",
        { sessionId: sideThreadId },
        onHookResult
      )
      const closeOutcome = detached
        ? undefined
        : expect(run).rejects.toMatchObject({ name: "AbortError" })
      await entered.promise
      if (detached) {
        await run
        expect(onHookResult).toHaveBeenLastCalledWith(
          "UserPromptSubmit",
          expect.objectContaining({ id: "active" }),
          expect.objectContaining({ asyncStatus: "pending" })
        )
      }
      unregisterSideThread(sideThreadId)
      await closeOutcome

      let quitFinished = false
      const quit = waitForSideHooksOnQuit().then(() => { quitFinished = true })
      try {
        await flush()
        expect(hasRunningSideHooks()).toBe(!detached)
        expect(quitFinished).toBe(detached)
      } finally {
        pending.resolve(Response.json({}))
        await quit
        await flush()
      }
      expect(hasRunningSideHooks()).toBe(false)
      expect(onHookResult).toHaveBeenLastCalledWith(
        "UserPromptSubmit",
        expect.objectContaining({ id: "active" }),
        expect.objectContaining({ exitCode: 0, stdout: "{}" })
      )
    }
  )

  it("does not dispatch an async side hook after closing while its shared scope lookup is pending", async () => {
    registerSideThread()
    const stage = Promise.withResolvers<undefined>()
    resolveStage.mockReturnValue(stage.promise)
    const request = vi.fn()
    vi.stubGlobal("fetch", request)
    const onHookResult = vi.fn()

    await runHooks(
      [hook("SessionStart", "async-start", true)],
      "SessionStart",
      { sessionId: sideThreadId, harnessProjectId: "project", featureId: "feature" },
      onHookResult
    )
    expect(resolveStage).toHaveBeenCalledOnce()
    unregisterSideThread(sideThreadId)
    stage.resolve(undefined)
    await flush()
    expect(request).not.toHaveBeenCalled()
    expect(onHookResult).toHaveBeenCalledExactlyOnceWith(
      "SessionStart",
      expect.objectContaining({ id: "async-start" }),
      expect.objectContaining({ asyncStatus: "pending" })
    )
  })

  it.each([200, 500])("keeps ordinary Setup attempts parallel and scoped when HTTP returns %s", async (status) => {
    const workspace = "/workspace"
    const threads = Array.from({ length: 6 }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000010${index}`,
      scope: createHookScope()
    }))
    const release = Promise.withResolvers<void>()
    const request = vi.fn(async () => {
      await release.promise
      return Response.json({}, { status })
    })
    vi.stubGlobal("fetch", request)
    enabledHooks.mockImplementation((_workspace, event: HookEvent, context: HookContext) =>
      event === "Setup" ? [{ ...hook(event, context.sessionId ?? "unknown"), fallback: "block" }] : []
    )

    const starts = threads.map(({ id, scope }) => fireSessionStartOnce(id, workspace, undefined, scope))
    try {
      await flush()
      expect(request.mock.calls).toHaveLength(threads.length)
      const setupScopes = enabledHooks.mock.calls.filter(([, event]) => event === "Setup")
      expect(setupScopes.map(([, , context, scope]) => [context.sessionId, scope]))
        .toEqual(threads.map(({ id, scope }) => [id, scope]))
    } finally {
      release.resolve()
      await Promise.all(starts)
      await Promise.all(threads.map(({ id }) => fireSessionEnd(id, workspace)))
    }

    expect(request.mock.calls).toHaveLength(threads.length)
    expect(initialisedWorkspaces.has(workspace)).toBe(status === 200)
  })

  it.each([
    { name: "the parent while its side is open", id: mainThreadId, workspace: "/workspace", close: false },
    { name: "a sibling while the other side is open", id: siblingThreadId, workspace: "/workspace", close: false },
    { name: "an unrelated session after side close", id: unrelatedThreadId, workspace: "/workspace", close: true },
    { name: "the parent after moving to a different workspace", id: mainThreadId, workspace: "/elsewhere", close: true }
  ])("starts $name without waiting for the side's Setup", async ({ id, workspace, close }) => {
    registerSideThread()
    if (id === siblingThreadId) registerSideThread(id)
    const { entered, pending, request } = holdFirstHook()
    enabledHooks.mockImplementation((
      _workspace, event: HookEvent, context: HookContext, scope?: HookScopeController
    ) => event === "Setup"
      ? filterScopedHooks({ baseHooks: [hook(event, "init")], skillHooks: [], pluginHooks: [] }, context, scope)
      : [])

    const source = fireSessionStartOnce(sideThreadId, "/workspace")
    await entered.promise
    if (close) {
      beginSideThreadClose(sideThreadId)
      await source
    }
    const scope = createHookScope({ disabled: true })
    let started = false
    const next = fireSessionStartOnce(id, workspace, undefined, scope).then(() => { started = true })
    try {
      await vi.waitFor(() => expect(started).toBe(true))
      expect(enabledHooks).toHaveBeenCalledWith(workspace, "Setup", expect.objectContaining({ sessionId: id }), scope, undefined)
      expect(request).toHaveBeenCalledOnce()
    } finally {
      pending.resolve(Response.json({}))
      await Promise.all([source, next])
    }
  })

  it("joins a closed side's Setup after its parent reselects the directory through a link", async () => {
    registerSideThread()
    const directory = await mkdtemp(join(tmpdir(), "cmb-setup-"))
    const alias = join(directory, "alias")
    const { entered, pending, request } = holdFirstHook()
    try {
      await symlink(directory, alias, "junction")
      // Both paths see the same on-disk marker.
      markInitialised.mockImplementationOnce(() => initialisedWorkspaces.add(alias))
      enabledHooks.mockImplementation((_workspace, event: HookEvent) =>
        event === "Setup" ? [hook(event, event)] : []
      )
      const side = fireSessionStartOnce(sideThreadId, directory)
      await entered.promise
      beginSideThreadClose(sideThreadId)
      await side
      const main = fireSessionStartOnce(mainThreadId, alias)
      await flush()
      pending.resolve(Response.json({}))
      await main
      expect(request).toHaveBeenCalledOnce()
    } finally {
      pending.resolve(Response.json({}))
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([200, 500])("uses the first successful Setup among closed siblings (first HTTP status %s)", async status => {
    const ids = [sideThreadId, siblingThreadId]
    const replies = ids.map(() => Promise.withResolvers<Response>())
    const request = vi.fn()
    for (const reply of replies) request.mockImplementationOnce(() => reply.promise)
    request.mockImplementation(async () => Response.json({}))
    vi.stubGlobal("fetch", request)
    enabledHooks.mockImplementation((_workspace, event: HookEvent) =>
      event === "Setup" ? [{ ...hook(event, event), fallback: "block" }] : []
    )
    ids.forEach(registerSideThread)
    const sides = ids.map(id => fireSessionStartOnce(id, "/workspace"))
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    ids.forEach(id => beginSideThreadClose(id))
    await Promise.all(sides)
    const main = fireSessionStartOnce(mainThreadId, "/workspace")
    try {
      replies[0].resolve(Response.json({}, { status }))
      if (status === 200) await main
      else await flush()
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      replies[1].resolve(Response.json({}))
      await main
    }
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([
    { outcome: "success", status: 200, writeFailed: false },
    { outcome: "hook failure", status: 500, writeFailed: false },
    { outcome: "marker write failure", status: 200, writeFailed: true }
  ])(
    "releases the side and lets its parent join pending Setup ($outcome)",
    async ({ status, writeFailed }) => {
      registerSideThread()
      const { entered, pending, request } = holdFirstHook()
      if (writeFailed) markInitialised.mockReturnValueOnce(false)
      enabledHooks.mockImplementation((_workspace, event: HookEvent, context: HookContext) => {
        const id = event === "Setup" && context.sessionId === mainThreadId ? "Setup-retry" : event
        return [{ ...hook(event, id), fallback: "block" }]
      })
      const result = fireSessionStartOnce(sideThreadId, "/workspace")
      await entered.promise
      beginSideThreadClose(sideThreadId)
      await result
      expect(markInitialised).not.toHaveBeenCalled()
      expect(request).toHaveBeenCalledOnce()

      unregisterSideThread(sideThreadId)
      await fireSessionEnd(sideThreadId, "/workspace")
      const mainScope = createHookScope()
      let mainStarted = false
      const main = fireSessionStartOnce(mainThreadId, "/workspace", undefined, mainScope)
        .then(() => { mainStarted = true })
      try {
        await flush()
        expect(mainStarted).toBe(false)
        expect(request).toHaveBeenCalledTimes(2)
      } finally {
        pending.resolve(Response.json({}, { status }))
        await main
      }
      await flush()
      const retried = status === 500 || writeFailed
      expect(request.mock.calls.map(([url]) => String(url))).toEqual([
        "https://hooks.invalid/Setup",
        "https://hooks.invalid/SessionEnd",
        ...(retried ? ["https://hooks.invalid/Setup-retry"] : []),
        "https://hooks.invalid/SessionStart"
      ])
      expect(markInitialised).toHaveBeenCalledTimes(writeFailed ? 2 : 1)
      expect(initialisedWorkspaces.has("/workspace")).toBe(true)
      const setupScopes = enabledHooks.mock.calls.filter(([, event]) => event === "Setup")
      expect(setupScopes.map(([, , context, scope]) => [context.sessionId, scope])).toEqual(
        retried
          ? [[sideThreadId, undefined], [mainThreadId, mainScope]]
          : [[sideThreadId, undefined]]
      )
    }
  )

  it.each([false, true])("lets a new sibling join the closed side's Setup (sibling closes: %s)", async (closes) => {
    registerSideThread()
    const { entered, pending, request } = holdFirstHook()
    enabledHooks.mockImplementation((_workspace, event: HookEvent) =>
      event === "Setup" ? [{ ...hook(event, event), fallback: "block" }] : []
    )
    const source = fireSessionStartOnce(sideThreadId, "/workspace")
    await entered.promise
    unregisterSideThread(sideThreadId)
    await source

    registerSideThread(siblingThreadId)
    let started = false
    const side = fireSessionStartOnce(siblingThreadId, "/workspace").then(() => { started = true })
    try {
      await flush()
      expect(started).toBe(false)
      expect(request).toHaveBeenCalledOnce()
      if (closes) {
        beginSideThreadClose(siblingThreadId)
        await side
      }
    } finally {
      pending.resolve(Response.json({}, { status: closes ? 500 : 200 }))
      await side
    }
    await flush()
    expect(request).toHaveBeenCalledOnce()
    expect(initialisedWorkspaces.has("/workspace")).toBe(!closes)
  })

  it.each(["queued command", "batch timeout"])(
    "does not persist initialization after a closed side's incomplete Setup (%s)",
    async (reason) => {
      registerSideThread()
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const entered = Promise.withResolvers<void>()
      const finished = Promise.withResolvers<void>()
      const child = fakeChild()
      spawnCommand.mockImplementation(() => {
        entered.resolve()
        return child
      })
      const hooks: HookConfig[] = [{ ...commandHook("Setup", "active"), timeout: 45_000 }]
      if (reason === "queued command") hooks.push(commandHook("Setup", "queued"))
      enabledHooks.mockReturnValue(hooks)

      const result = fireSessionStartOnce(sideThreadId, process.cwd(), () => finished.resolve())
      try {
        await entered.promise
        beginSideThreadClose(sideThreadId)
        await result
        if (reason === "batch timeout") await vi.advanceTimersByTimeAsync(30_001)
      } finally {
        child.emit("close", 0)
        await finished.promise
        await flush()
      }
      expect(spawnCommand).toHaveBeenCalledOnce()
      expect(markInitialised).not.toHaveBeenCalled()
    }
  )

  it("lets app quit join an existing side close without dispatching a second SessionEnd", async () => {
    registerSideThread()
    enabledHooks.mockReturnValue([])
    await fireSessionStartOnce(sideThreadId)
    enabledHooks.mockReturnValue([hook("SessionEnd", "cleanup")])
    const { entered, pending, request } = holdFirstHook()
    beginSideThreadClose(sideThreadId)
    const close = fireSessionEnd(sideThreadId)
    await entered.promise
    let quitFinished = false
    const quit = fireSessionEndAll().then(() => { quitFinished = true })
    try {
      await flush()
      expect(hasActiveSessions()).toBe(true)
      expect(quitFinished).toBe(false)
      expect(request).toHaveBeenCalledOnce()
    } finally {
      pending.resolve(Response.json({}))
      await Promise.all([close, quit])
    }
    expect(hasActiveSessions()).toBe(false)
    expect(request).toHaveBeenCalledOnce()
  })

  it("lets a side close join cleanup already dispatched by app quit", async () => {
    registerSideThread()
    enabledHooks.mockReturnValue([])
    await fireSessionStartOnce(sideThreadId)
    enabledHooks.mockReturnValue([hook("SessionEnd", "cleanup")])
    const { entered, pending, request } = holdFirstHook()
    const quit = fireSessionEndAll()
    await entered.promise
    beginSideThreadClose(sideThreadId)
    let closeFinished = false
    const close = fireSessionEnd(sideThreadId).then(() => { closeFinished = true })
    try {
      await flush()
      expect(closeFinished).toBe(false)
      expect(request).toHaveBeenCalledOnce()
    } finally {
      pending.resolve(Response.json({}))
      await Promise.all([close, quit])
    }
    expect(request).toHaveBeenCalledOnce()
  })

  it("fences newly scheduled hooks for an unregistered side and keeps the main session active", async () => {
    const request = vi.fn(async () => Response.json({}))
    vi.stubGlobal("fetch", request)
    const hooks = [hook("Stop", "stop")]

    await expect(runHooks(hooks, "Stop", { sessionId: sideThreadId })).rejects.toMatchObject({
      name: "AbortError"
    })
    await expect(runHooks(hooks, "Stop", { sessionId: mainThreadId })).resolves.toBeNull()
    expect(request).toHaveBeenCalledOnce()
  })

  it.each(["workspace command", "mixed hooks", "HTTP", "detached command", "no matching hook"] as const)(
    "reserves the cleanup budget only for a matching SessionEnd workspace command (%s)",
    async (cleanup) => {
      registerSideThread()
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const workspacePath = process.cwd()
      const entered = Promise.withResolvers<void>()
      const activeFinished = Promise.withResolvers<void>()
      const activeChild = fakeChild()
      let rowExists = true
      const cleanupReads: boolean[] = []
      spawnCommand.mockImplementation((_command: string, args: string[]) => {
        const script = args.join(" ")
        if (script.includes("lock-holder")) {
          entered.resolve()
          return activeChild
        }
        if (script.includes("session-cleanup")) {
          cleanupReads.push(rowExists)
          const child = fakeChild()
          queueMicrotask(() => child.emit("close", 0))
          return child
        }
        return undefined
      })
      vi.stubGlobal("fetch", async () => {
        cleanupReads.push(rowExists)
        return Response.json({})
      })
      enabledHooks.mockReturnValue([])
      await fireSessionStartOnce(sideThreadId, workspacePath)
      const active = expect(
        runHooks(
          [commandHook("UserPromptSubmit", "lock-holder")],
          "UserPromptSubmit",
          { sessionId: sideThreadId, workspacePath },
          () => activeFinished.resolve()
        )
      ).rejects.toMatchObject({ name: "AbortError" })
      await entered.promise
      expect(hasRunningSideHooks()).toBe(true)

      // App quit can arrive before the close IPC registers its SessionEnd.
      let taskPhaseFinished = false
      const shutdownTasks = waitForSideHooksOnQuit().then(() => { taskPhaseFinished = true })
      await flush()
      expect(taskPhaseFinished).toBe(false)

      // A window can unregister the ID before the close path runs SessionEnd.
      unregisterSideThread(sideThreadId)
      await active
      enabledHooks.mockReturnValue(
        cleanup === "mixed hooks"
          ? [commandHook("SessionEnd", "session-cleanup"), hook("SessionEnd", "http-cleanup")]
          : cleanup === "HTTP"
          ? [hook("SessionEnd", "session-cleanup")]
          : cleanup === "no matching hook"
            ? [commandHook("Stop", "session-cleanup")]
            : [commandHook("SessionEnd", "session-cleanup", cleanup === "detached command")]
      )
      const ended = fireSessionEnd(sideThreadId, workspacePath).then(() => {
        rowExists = false
      })
      try {
        if (cleanup === "workspace command" || cleanup === "mixed hooks") {
          await vi.advanceTimersByTimeAsync(5_001)
          expect(rowExists).toBe(true)
          expect(taskPhaseFinished).toBe(false)
          expect(cleanupReads).toEqual(cleanup === "mixed hooks" ? [true] : [])
        } else {
          await flush()
          expect(rowExists).toBe(false)
          expect(taskPhaseFinished).toBe(false)
        }
      } finally {
        activeChild.emit("close", 0)
        await activeFinished.promise
        await Promise.all([ended, shutdownTasks])
      }
      expect(taskPhaseFinished).toBe(true)
      expect(hasRunningSideHooks()).toBe(false)
      expect(cleanupReads).toEqual(cleanup === "no matching hook" ? [] : cleanup === "mixed hooks" ? [true, true] : [true])
    }
  )
})
