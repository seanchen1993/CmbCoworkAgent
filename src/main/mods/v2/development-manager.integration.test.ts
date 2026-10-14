import { randomUUID } from "node:crypto"
import { AsyncResource } from "node:async_hooks"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { ModCommandQueue } from "../command-queue"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { DEVELOPMENT_EVENT_CAPABILITIES, type DevelopmentScope } from "./development-session"
import { ModDevelopmentService } from "../devtools/development-service"
import { AuthoringDraftStore } from "../devtools/authoring-store"
import { withFunctionTransportExecution } from "./host-call"
import { currentFunctionExecution } from "./execution-context"
import { FunctionSessionActivity } from "./session-activity"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture(options: { drain?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mods-development-"))
  const store = new ModControlStore(join(root, "control.sqlite"))
  const scope: DevelopmentScope = {
    workspace: root,
    threadId: randomUUID(),
    incarnation: { token: randomUUID(), legacyCreatedAt: 1 }
  }
  let live = true, enabled = true
  const loads = vi.fn()
  const openConversationOwner = vi.fn(() => () => {})
  const activateConversationOwner = vi.fn()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [],
      enabled: () => enabled,
      publish: async (_workspace, value) => value,
      changed: () => {},
      openConversationOwner,
      activateConversationOwner,
      assertThread: () => {
        if (!live) throw Error("scope lost")
      }
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        load: async (code, options) => {
          loads()
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          return guest
        },
        stop: () => {
          for (const guest of guests) void guest.dispose()
        },
        stopAndDrain: async () => {
          await Promise.all(guests.map(guest => guest.dispose()))
          await options.drain?.()
        }
      }
    }
  )
  manager.configureDevelopmentAccess({
    assertScope: (value) => {
      if (
        !live ||
        value.threadId !== scope.threadId ||
        value.workspace !== root ||
        value.incarnation.token !== scope.incarnation.token
      )
        throw Error("scope lost")
    }
  })
  const componentId = randomUUID()
  const stage = async (revision: number, body: string) => {
    const path = join(root, String(revision))
    await mkdir(join(path, "hooks"), { recursive: true })
    await writeFile(join(path, "plugin.json"), JSON.stringify({ name: "dev-example" }))
    await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    await writeFile(join(path, "hooks/register.ts"), body)
    const compiled = await compileFunctionPlugin(path)
    const input = {
      componentId,
      draftId: "sample",
      revision,
      bundleDigest: "a".repeat(64),
      compiledDigest: compiled.digest,
      sourcePath: path,
      turnId: `turn-${revision}`,
      capabilities: [
        "ui.resolve",
        "store.get",
        "store.set",
        "command.register",
        ...DEVELOPMENT_EVENT_CAPABILITIES
      ]
    }
    manager.stageDevelopment(scope, input, () => {
      if (!live) throw Error("scope lost")
    })
    return input
  }
  cleanups.push(async () => {
    manager.close()
    await new Promise((resolve) => setTimeout(resolve, 30))
    store.close()
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mods-development-/)
    await rm(root, { recursive: true, force: true })
  })
  const activate = async (revision: number, body: string) => {
    const input = await stage(revision, body)
    if (manager.developmentStatus(scope)[0]?.phase === "needs-approval")
      manager.approveDevelopment(
        scope,
        componentId,
        input.compiledDigest,
        input.capabilities,
        () => {}
      )
    manager.noteDevelopmentTurnSettled(scope, input.turnId, "completed")
    await vi.waitFor(() => {
      const status = manager.developmentStatus(scope)[0]
      expect(status?.phase, status?.error).toBe("active")
    })
    return input
  }
  return {
    root,
    scope,
    manager,
    store,
    stage,
    activate,
    loads,
    openConversationOwner,
    activateConversationOwner,
    componentId,
    setEnabled: (value: boolean) => { enabled = value },
    revoke: () => {
      live = false
    }
  }
}
const source = (text: string) => `export function register(on) {
  on("ui.render", {component:"AbovePrompt"}, async ($,e) => {
    const {Text}=$.ui.resolve(e);return Text({children:${JSON.stringify(text)}})
  })
}`

it("loads a real guest only after approval/settlement and renders only in its session", async () => {
  const f = await fixture()
  const input = await f.stage(1, source("first version"))
  expect(f.loads).not.toHaveBeenCalled()
  f.manager.approveDevelopment(
    f.scope,
    f.componentId,
    input.compiledDigest,
    input.capabilities,
    () => {}
  )
  expect(f.loads).not.toHaveBeenCalled()
  f.manager.noteDevelopmentTurnSettled(f.scope, input.turnId, "completed")
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0]?.phase).toBe("active"))
  const owner = await f.manager.siteMount(f.root, f.scope.threadId, "AbovePrompt")
  expect(owner).toBeTruthy()
  const rendered = await f.manager.siteRender(f.root, f.scope.threadId, owner!, {
    isWorking: false,
    bodyColumns: 80,
    maxRows: 10
  })
  expect(JSON.stringify(rendered)).toContain("first version")
  expect(await f.manager.siteMount(f.root, "other-thread", "AbovePrompt")).toBeNull()
  expect(f.store.getGrant(f.root, "function:dev-example")).toBeNull()
  await f.activate(2, source("second version"))
  const next = await f.manager.siteMount(f.root, f.scope.threadId, "AbovePrompt")
  expect(
    JSON.stringify(
      await f.manager.siteRender(f.root, f.scope.threadId, next!, {
        isWorking: false,
        bodyColumns: 80,
        maxRows: 10
      })
    )
  ).toContain("second version")
  await expect(
    f.manager.siteRender(f.root, f.scope.threadId, owner!, {
      isWorking: false,
      bodyColumns: 80,
      maxRows: 10
    })
  ).rejects.toThrow()
  expect(f.openConversationOwner).not.toHaveBeenCalled()
  expect(f.activateConversationOwner).not.toHaveBeenCalled()
})

it("keeps conversation protection for a real tool.call development registration", async () => {
  const f = await fixture()
  await f.activate(1, `export function register(on) {
    on("tool.call", async ($, e, next) => next(e))
  }`)
  expect(f.openConversationOwner).toHaveBeenCalledOnce()
  expect(f.activateConversationOwner).toHaveBeenCalledOnce()
})

it("rejects startup effects without retiring the previous real guest", async () => {
  const f = await fixture()
  await f.activate(1, source("kept"))
  const input = await f.stage(
    2,
    `export function register(on) {
    on("session.start",async($,e,next)=>{await $.store.set("bad",true);return next(e)})
  }`
  )
  f.manager.noteDevelopmentTurnSettled(f.scope, input.turnId, "completed")
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0]?.phase).toBe("failed"))
  expect(f.manager.developmentStatus(f.scope)[0]?.activeRevision).toBe(1)
  const owner = await f.manager.siteMount(f.root, f.scope.threadId, "AbovePrompt")
  expect(
    JSON.stringify(
      await f.manager.siteRender(f.root, f.scope.threadId, owner!, {
        isWorking: false,
        bodyColumns: 80,
        maxRows: 10
      })
    )
  ).toContain("kept")
})

it("runs registered development commands through the real queue without a formal grant", async () => {
  const f = await fixture()
  const code = (label: string) => `export function register(on) {
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"dev-hello",description:"Development command",immediate:true});
      return next(e)
    })
    on("command.run",{command:"dev-hello"},async($)=>{
      const count=(await $.store.get("count")??0)+1;await $.store.set("count",count);
      return {text:${JSON.stringify(label)}+":"+count}
    })
  }`
  await f.activate(1, code("one"))
  const descriptor = (await f.manager.commands(f.root, f.scope.threadId))[0]
  expect(descriptor.modId).toBe(`development:${f.componentId}`)
  expect(descriptor.immediate).toBeUndefined()
  const queue = new ModCommandQueue(f.store, () => {})
  try {
    const run = queue.enqueue(f.root, f.scope.threadId, descriptor.command, (signal) =>
      f.manager.runCommand(f.root, f.scope.threadId, descriptor, "", signal)
    )
    expect(await run.completion).toEqual({ text: "one:1" })
    expect(f.store.getGrant(f.root, "function:dev-example")).toBeNull()
    expect(
      f.store.functionState.get(JSON.stringify([f.root, "dev-example"]), "count")
    ).toBeUndefined()
    const revision = await f.stage(2, code("two"))
    let settle!: () => void
    const oldActivity = new FunctionSessionActivity()
    await withFunctionTransportExecution({ workspace: f.root, threadId: f.scope.threadId,
      userInitiated: false, leased: false, immediate: true }, () => oldActivity.run(async () => {
      settle = AsyncResource.bind(() => {
        expect(() => currentFunctionExecution()).toThrow("MODS_CALL_SCOPE_EXPIRED")
        f.manager.noteDevelopmentTurnSettled(f.scope, revision.turnId, "completed")
      })
    }))
    settle()
    await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0]?.phase).toBe("active"))
    await expect(
      f.manager.runCommand(f.root, f.scope.threadId, descriptor, "", new AbortController().signal)
    ).rejects.toThrow("MODS_COMMAND_STALE")
    const next = (await f.manager.commands(f.root, f.scope.threadId))[0]
    const second = queue.enqueue(f.root, f.scope.threadId, next.command, (signal) =>
      f.manager.runCommand(f.root, f.scope.threadId, next, "", signal)
    )
    expect(await second.completion).toEqual({ text: "two:2" })
  } finally {
    queue.close()
  }
})

it.each(["*", "!ui.render", "prompt.context", "model.request"])(
  "rejects the actual candidate registration %s without retiring the prior guest",
  async (pattern) => {
    const f = await fixture()
    await f.activate(1, source("kept"))
    const input = await f.stage(
      2,
      `export function register(on){on(${JSON.stringify(pattern)},($,e,next)=>next(e))}`
    )
    f.manager.noteDevelopmentTurnSettled(f.scope, input.turnId, "completed")
    await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0]?.phase).toBe("failed"))
    expect(f.manager.developmentStatus(f.scope)[0]?.activeRevision).toBe(1)
    const owner = await f.manager.siteMount(f.root, f.scope.threadId, "AbovePrompt")
    expect(
      JSON.stringify(
        await f.manager.siteRender(f.root, f.scope.threadId, owner!, {
          isWorking: false,
          bodyColumns: 80,
          maxRows: 10
        })
      )
    ).toContain("kept")
  }
)

it("can disable a recreated authoring service with unknown history and never reloads its guest", async () => {
  const f = await fixture()
  await f.activate(1, source("previous process"))
  f.manager.close()
  const createClient = vi.fn(() => {
    throw Error("must not reload historical code")
  })
  const restarted = new FunctionModsManager(
    f.store,
    {
      plugins: () => [],
      enabled: () => true,
      publish: async (_workspace, value) => value,
      changed: () => {}
    },
    createClient
  )
  const service = new ModDevelopmentService({
    drafts: new AuthoringDraftStore(f.store),
    runtime: restarted,
    versionsRoot: join(f.root, "versions"),
    workerEntry: "not-used",
    context: () => ({ scope: f.scope, assertCurrent: () => {} }),
    changed: () => {}
  })
  restarted.configureDevelopmentAccess({ assertScope: (scope) => service.assertScope(scope) })
  try {
    expect(service.status(f.scope.threadId).trials[0].phase).toBe("unknown")
    await service.setEnabled(f.scope.threadId, f.root, true)
    await service.stop(f.scope.threadId, f.root, f.componentId)
    const disabled = await service.setEnabled(f.scope.threadId, f.root, false)
    expect(disabled.enabled).toBe(false)
    expect(disabled.trials[0].phase).toBe("unknown")
    expect(createClient).not.toHaveBeenCalled()
  } finally {
    restarted.close()
  }
})

it.each(["release", "demote"] as const)("waits for actual resident foreground %s before replacing a development guest", async (transition) => {
  const f = await fixture()
  await f.activate(1, source("one"))
  const sessions = (f.manager as unknown as {
    sessions: Map<string, { activity: FunctionSessionActivity }>
  }).sessions
  const entry = sessions.get(JSON.stringify([f.scope.workspace, f.scope.threadId]))!
  const resource = entry.activity.retainFreshResource()
  const input = await f.stage(2, source("two"))
  f.manager.noteDevelopmentTurnSettled(f.scope, input.turnId, "completed")
  await Promise.resolve()
  expect(f.manager.developmentStatus(f.scope)[0]?.phase).toBe("queued")
  expect(f.manager.developmentStatus(f.scope)[0]?.activeRevision).toBe(1)
  expect(f.loads).toHaveBeenCalledOnce()
  if (transition === "release") resource.release()
  else resource.ready()
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0]?.activeRevision).toBe(2))
  expect(f.loads).toHaveBeenCalledTimes(2)
  resource.release()
})

it("retains a deleted development guest until actual drain and does not touch a recreated incarnation", async () => {
  const oldDrain = Promise.withResolvers<void>()
  const drainStarted = Promise.withResolvers<void>()
  let hold = true
  const f = await fixture({ drain: () => {
    if (!hold) return Promise.resolve()
    drainStarted.resolve()
    return oldDrain.promise
  } })
  const service = new ModDevelopmentService({
    drafts: new AuthoringDraftStore(f.store), runtime: f.manager,
    versionsRoot: join(f.root, "versions"), workerEntry: "not-used", changed: () => {},
    context: () => {
      const scope = structuredClone(f.scope)
      return { scope, assertCurrent: () => {
        if (scope.incarnation.token !== f.scope.incarnation.token) throw Error("DEVELOPMENT_SCOPE_CHANGED")
      } }
    }
  })
  await service.setEnabled(f.scope.threadId, f.root, true)
  await f.activate(1, source("old"))
  const oldScope = structuredClone(f.scope)
  f.manager.closeThread(f.scope.threadId)
  expect(f.manager.developmentRetention(oldScope)).toMatchObject({ releasable: false, reason: "draining" })
  await drainStarted.promise
  f.scope.incarnation.token = randomUUID()
  hold = false
  await service.setEnabled(f.scope.threadId, f.root, true)
  const enabled = (service as unknown as { enabled: Map<string, unknown> }).enabled
  expect(enabled.size).toBe(2)
  await f.activate(1, source("new"))
  expect(f.manager.developmentStatus(f.scope)[0]?.phase).toBe("active")
  oldDrain.resolve()
  await vi.waitFor(() => expect(f.manager.developmentRetention(oldScope).releasable).toBe(true))
  expect(f.manager.developmentStatus(f.scope)[0]?.phase).toBe("active")
  await f.stage(2, source("next"))
  expect(f.manager.developmentRetention(oldScope).releasable).toBe(true)
  await service.setEnabled(f.scope.threadId, f.root, true)
  expect(enabled.size).toBe(1)
})

it("keeps failed physical development retirement unknown instead of releasing capacity", async () => {
  const f = await fixture({ drain: async () => { throw Error("physical drain failed") } })
  await f.activate(1, source("old"))
  f.manager.closeThread(f.scope.threadId)
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0]?.phase).toBe("unknown"))
  expect(f.manager.developmentRetention(f.scope)).toEqual({ releasable: false, revisions: null, reason: "unknown" })
})

it("releases a physically drained development instance even after its thread scope is revoked", async () => {
  const f = await fixture()
  await f.activate(1, source("old"))
  const entry = (f.manager as unknown as { sessions: Map<string, {
    session: { close(strict?: boolean): Promise<void> }
  }> }).sessions.get(JSON.stringify([f.scope.workspace, f.scope.threadId]))!
  let closeFailure: unknown
  const original = entry.session.close.bind(entry.session)
  vi.spyOn(entry.session, "close").mockImplementation(async strict => {
    try { await original(strict) } catch (error) { closeFailure = error; throw error }
  })
  f.revoke()
  f.manager.closeThread(f.scope.threadId)
  await vi.waitFor(() => expect(f.manager.developmentRetention(f.scope).releasable, String(closeFailure)).toBe(true))
})


it("drains after session close rejects and preserves both retirement failures", async () => {
  const closeFailure = Error("close failed")
  const drainFailure = Error("drain failed")
  const drain = vi.fn(async () => { throw drainFailure })
  const f = await fixture({ drain })
  await f.activate(1, source("old"))
  const manager = f.manager as unknown as {
    sessions: Map<string, { session: { close(strict?: boolean): Promise<void> } }>
    development: {
      retireExternal(activation: unknown, close: () => Promise<void>): void
    }
  }
  const entry = manager.sessions.get(JSON.stringify([f.scope.workspace, f.scope.threadId]))!
  vi.spyOn(entry.session, "close").mockRejectedValue(closeFailure)
  let observed: unknown
  const retire = manager.development.retireExternal.bind(manager.development)
  vi.spyOn(manager.development, "retireExternal").mockImplementation((activation, close) => {
    retire(activation, async () => {
      try { await close() } catch (error) { observed = error; throw error }
    })
  })
  f.manager.closeThread(f.scope.threadId)
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0]?.phase).toBe("unknown"))
  expect(drain).toHaveBeenCalledOnce()
  expect(observed).toBeInstanceOf(AggregateError)
  expect((observed as AggregateError).errors).toEqual([closeFailure, drainFailure])
  expect(f.manager.developmentRetention(f.scope).releasable).toBe(false)
})


it.each(["invalidate", "global-disable", "close-thread", "stop-race"])(
  "%s owns the exact trial drain after removing residency", async mode => {
    const gate = Promise.withResolvers<void>()
    const drain = vi.fn(() => gate.promise)
    const f = await fixture({ drain })
    try {
      const input = await f.activate(1, source("retire"))
      expect(f.manager.referencesSourceDirectory(input.sourcePath)).toBe(true)
      const early = mode === "stop-race"
        ? f.manager.stopDevelopment(f.scope, f.componentId, () => {}) : undefined
      if (mode === "global-disable") { f.setEnabled(false); f.manager.invalidateAll() }
      else if (mode === "close-thread") f.manager.closeThread(f.scope.threadId)
      else f.manager.invalidate(f.root)
      expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("retiring")
      let stopped = false
      const pending = f.manager.stopDevelopment(f.scope, f.componentId, () => {})
        .then(() => { stopped = true })
      await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
      expect(stopped).toBe(false)
      expect(f.manager.referencesSourceDirectory(input.sourcePath)).toBe(true)
      expect(f.manager.developmentRetention(f.scope).releasable).toBe(false)
      gate.resolve()
      await Promise.all([pending, early])
      expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("stopped")
      expect(f.manager.referencesSourceDirectory(input.sourcePath)).toBe(false)
      expect(drain).toHaveBeenCalledOnce()
      f.setEnabled(true)
      expect((await f.stage(2, source("fresh"))).revision).toBe(2)
    } finally { gate.resolve() }
  }, 20000
)

it("failed invalidation cleanup stays unknown and keeps immutable source referenced", async () => {
  const f = await fixture({ drain: async () => { throw Error("physical exit unknown") } })
  const input = await f.activate(1, source("unknown"))
  f.manager.invalidateAll()
  await f.manager.stopDevelopment(f.scope, f.componentId, () => {})
  expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("unknown")
  expect(f.manager.referencesSourceDirectory(input.sourcePath)).toBe(true)
  expect(f.manager.developmentRetention(f.scope).releasable).toBe(false)
  await expect(f.stage(2, source("forbidden"))).rejects.toThrow("RETIRE_UNCONFIRMED")
}, 20000)


it("invalidation during a foreground-blocked stop joins cleanup instead of inventing unknown", async () => {
  const gate = Promise.withResolvers<void>()
  const f = await fixture({ drain: () => gate.promise })
  const input = await f.activate(1, source("blocked"))
  const entries = (f.manager as unknown as {
    sessions: Map<string, { activity: FunctionSessionActivity }>
  }).sessions
  const activity = entries.get(JSON.stringify([f.root, f.scope.threadId]))!.activity
  const release = activity.retainFresh()
  try {
    const stopped = f.manager.stopDevelopment(f.scope, f.componentId, () => {})
    await vi.waitFor(() => expect(() => activity.retainFresh()).toThrow("MODS_CONFIG_APPLYING"))
    f.manager.invalidate(f.root)
    expect(f.manager.referencesSourceDirectory(input.sourcePath)).toBe(true)
    release()
    gate.resolve()
    await stopped
    expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("stopped")
  } finally { release(); gate.resolve() }
}, 20000)
