import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { FunctionUserConfigValues } from "./user-config-values"
import { FunctionProcessHost } from "./process-sdk"
import * as loader from "./loader"
import { ClawStore } from "../claw-store"
import type { FunctionHostCall } from "../../../shared/mods/v2/contracts"
import {
  claimLocalThreadRunLease,
  getLocalThreadRunLease,
  releaseLocalThreadRunLease
} from "../../agent/thread-run-lease"
import type { ModJson, ModObject } from "../../../shared/mods/types"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(startup = 'await $.store.set("startup",options.tone)', hooks = "", physicalDrain = false) {
  const root = await mkdtemp(join(tmpdir(), "mods-config-reload-"))
  const path = join(root, "plugin"),
    source = join(path, "hooks/register.ts")
  const threadId = randomUUID(),
    signal = new AbortController().signal
  await mkdir(join(path, "hooks"), { recursive: true })
  await writeFile(
    join(path, "plugin.json"),
    JSON.stringify({
      name: "reload-demo",
      userConfig: {
        tone: { type: "string", title: "Tone", description: "Tone", default: "warm" }
      }
    })
  )
  await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(
    source,
    `export function register(on,options){
    on("session.start",async($,e,next)=>{${startup};
      await $.command.register({name:"probe",description:options.tone});return next(e)});
    ${hooks}
  }`
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  const values = new FunctionUserConfigValues(store)
  const state: { enabled: boolean; logical: boolean; writable: boolean; tail?: Promise<unknown> } =
    { enabled: true, logical: false, writable: true }
  const sources = [{ id: "p", name: "reload-demo", path, enabled: true }]
  const moduleHosts: FunctionHostCall[] = []
  const load = vi.fn(async (code: string, options: ModObject) => {
    const guest = await FunctionGuestRuntime.create(code, options)
    const bind = guest.bindModuleHost.bind(guest)
    guest.bindModuleHost = (host, dispose) => {
      moduleHosts.push(host)
      bind(host, dispose)
    }
    return guest
  })
  const publish = vi.fn(async (_workspace: string, value: ModJson) => value)
  const completeModel = vi.fn(async () => {
    await manager.classicEvent(root, threadId, "prompt.context", { text: "startup model" }, signal)
    return {
      isAnswered: true as const,
      text: "model",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    }
  })
  const authorizeProcess = vi.fn(async () => {})
  const drain = vi.fn()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => sources,
      clawApplicable: () => true,
      enabled: () => state.enabled,
      publish: async (workspace, value) => publish(workspace, value),
      changed: () => {},
      assertThread: () => {
        if (!state.writable) throw Error("OWNER_LOST")
      },
      configurationBusy: () => !!getLocalThreadRunLease(threadId) || state.logical,
      configurationLogicalBusy: () => state.logical,
      authorizeProcess,
      completeModelResult: completeModel,
      runEffect: async (_workspace, _thread, _grant, method, _input, _signal, run) => {
        try {
          return await run()
        } finally {
          if (method === "process.spawn") await state.tail
        }
      }
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        load: async (...args) => {
          const guest = await load(...args)
          guests.push(guest)
          return guest
        },
        stop: () => {
          for (const guest of guests) void guest.dispose()
        },
        ...(physicalDrain ? {
          stopAndDrain: async () => {
            drain()
            await Promise.all(guests.map(guest => guest.dispose()))
          }
        } : {})
      }
    }
  )
  const compiled = await compileFunctionPlugin(path)
  store.grant(root, "function:reload-demo", compiled.digest, true)
  cleanup.push(async () => {
    manager.close()
    await new Promise((resolve) => setTimeout(resolve, 80))
    store.close()
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mods-config-reload-/)
    await rm(root, { recursive: true, force: true })
  })
  const view = () => manager.userConfig(root, threadId, "p", signal, () => {})
  const save = (tone: string) =>
    values.save(
      root,
      compiled.name,
      compiled.userConfig!,
      "tone",
      tone,
      values.read(root, compiled.name).revision,
      () => {}
    )
  const reload = async () => {
    const current = await view()
    return manager.reloadUserConfig(
      root,
      threadId,
      "p",
      current.digest,
      current.savedRevision,
      signal,
      () => {}
    )
  }
  return {
    root,
    path,
    source,
    threadId,
    signal,
    store,
    manager,
    state,
    load,
    publish,
    completeModel,
    authorizeProcess,
    drain,
    compiled,
    values,
    sources,
    moduleHosts,
    save,
    view,
    reload
  }
}

async function secondPlugin(f: Awaited<ReturnType<typeof fixture>>, startup = "") {
  const path = join(f.root, "second")
  await mkdir(join(path, "hooks"), { recursive: true })
  await writeFile(
    join(path, "plugin.json"),
    JSON.stringify({
      name: "reload-second",
      userConfig: {
        tone: { type: "string", title: "Second", description: "Second", default: "warm" }
      }
    })
  )
  await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(
    join(path, "hooks/register.ts"),
    `export function register(on,options){
    on("session.start",async($,e,next)=>{${startup};return next(e)})
  }`
  )
  const compiled = await compileFunctionPlugin(path)
  f.sources.push({ id: "q", name: compiled.name, path, enabled: true })
  f.store.grant(f.root, "function:" + compiled.name, compiled.digest, true)
  new ClawStore(f.store).write(
    f.root,
    {
      revision: 0,
      profiles: [],
      active: {
        id: "complete-reload",
        name: "Complete reload",
        capabilities: [
          { pluginId: "p", name: f.compiled.name, digest: f.compiled.digest },
          { pluginId: "q", name: compiled.name, digest: compiled.digest }
        ]
      }
    },
    0
  )
  f.manager.invalidate(f.root)
  return compiled
}

it("stopped retry cannot silently omit an unavailable member of the applied composition", async () => {
  const f = await fixture(`await $.store.set("startup",options.tone);
    if(options.tone==="bad")try{await $.tool.call({name:"missing",input:{}})}catch{}`)
  const second = await secondPlugin(f)
  await f.manager.commands(f.root, f.threadId)
  f.save("bad")
  expect((await f.reload()).state).toBe("stopped")
  f.manager.revoke(f.root, second.name)
  f.save("formal")
  const count = f.load.mock.calls.length
  expect((await f.reload()).state).toBe("stopped")
  expect(f.load).toHaveBeenCalledTimes(count)
})

it("another plugin's saved version changes during startup block subsequent effects immediately", async () => {
  const f = await fixture('await $.store.set("startup",options.tone)')
  const second = await secondPlugin(f, 'await $.store.set("second-effect",options.tone)')
  await f.manager.commands(f.root, f.threadId)
  f.save("formal")
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  const actual = f.publish.getMockImplementation()!
  f.publish.mockImplementation(async (...args) => {
    if (args[1] === "formal") {
      entered.resolve()
      await finish.promise
    }
    return actual(...args)
  })
  const pending = f.reload()
  await entered.promise
  f.values.save(f.root, second.name, second.userConfig!, "tone", "changed", 0, () => {})
  finish.resolve()
  expect(await pending).toMatchObject({ state: "stopped", error: "MODS_CONFIG_VALUE_CHANGED" })
  expect(
    f.store.functionState.get(JSON.stringify([f.root, "reload-second"]), "second-effect")
  ).toBe("warm")
}, 8000)

it("retirement rejects actual paused module RPCs before waiting a real process task tail", async () => {
  const f = await fixture(
    `await $.store.set("startup",options.tone);if(options.tone==="warm"){${daemon}}`,
    'on("process.spawn",async function*($,e,next){return yield* next(e)})'
  )
  await f.manager.commands(f.root, f.threadId)
  f.save("formal")
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  const actualCompile = loader.compileFunctionPlugin
  let blocked = false
  vi.spyOn(loader, "compileFunctionPlugin").mockImplementation(async (...args) => {
    if (!blocked && getLocalThreadRunLease(f.threadId)?.owner === "mods") {
      blocked = true
      entered.resolve()
      await finish.promise
    }
    return actualCompile(...args)
  })
  const pending = f.reload()
  await entered.promise
  const queued = f.moduleHosts[0](
    "resource.ui",
    { method: "ui.log", args: ["must not publish"] },
    f.signal
  )
  const rejected = expect(queued).rejects.toThrow("MODS_SESSION_CLOSED")
  f.state.tail = queued.catch(() => {})
  await Promise.resolve()
  finish.resolve()
  expect((await pending).state).toBe("applied")
  await rejected
  expect(f.publish.mock.calls.some(([, value]) => value === "must not publish")).toBe(false)
}, 8000)

it("explicit native reload uses actual saved options and adopts a startup state-writing component", async () => {
  const f = await fixture()
  expect((await f.manager.commands(f.root, f.threadId))[0].name).toBe("warm")
  f.save("formal")
  const result = await f.reload()
  expect(result).toMatchObject({ state: "applied", effectiveRevision: 1, savedRevision: 1 })
  expect(f.store.functionState.get(JSON.stringify([f.root, "reload-demo"]), "startup")).toBe(
    "formal"
  )
  expect((await f.manager.commands(f.root, f.threadId))[0].name).toBe("formal")
  expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
})

it("a real physical or logical task returns pending without restarting or stealing its lease", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, f.threadId)
  f.save("formal")
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "running" })
  try {
    expect(await f.reload()).toMatchObject({ state: "pending" })
    expect(f.load).toHaveBeenCalledTimes(1)
    expect(getLocalThreadRunLease(f.threadId)?.runId).toBe("running")
  } finally {
    releaseLocalThreadRunLease(f.threadId, "desktop", "running")
  }
  f.state.logical = true
  expect(await f.reload()).toMatchObject({ state: "pending" })
  expect(f.load).toHaveBeenCalledTimes(1)
})

it("an optional schema upgrade migrates the original save revision while the actual run keeps its guest until native reload is idle", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, f.threadId)
  f.save("formal")
  const oldGrant = f.store.getGrant(f.root, "function:reload-demo")!
  await writeFile(join(f.path, "plugin.json"), JSON.stringify({ name: "reload-demo", version: "2.0.0",
    userConfig: f.compiled.userConfig,
    cmbCompatibility: { modelProtocol: "result-v1", userConfigMigrations: "v1" },
    userConfigSchema: { version: 1, migrations: [{ fromVersion: 0, toVersion: 1, changes: [] }] } }))
  const view = await f.view()
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "schema-upgrade-running" })
  try {
    const migrated = await f.manager.migrateUserConfig(f.root, f.threadId, "p", view.digest,
      view.savedRevision, view.migration!.digest, f.signal, () => {})
    expect(migrated.savedRevision).toBe(2)
    expect(migrated.migration).toBeUndefined()
    expect(f.store.getGrant(f.root, "function:reload-demo")).toEqual(oldGrant)
    expect(await f.reload()).not.toMatchObject({ state: "applied" })
    expect(f.load).toHaveBeenCalledTimes(1)
    expect(getLocalThreadRunLease(f.threadId)?.runId).toBe("schema-upgrade-running")
  } finally { releaseLocalThreadRunLease(f.threadId, "desktop", "schema-upgrade-running") }
  // Independent native code approval remains necessary after the source/schema digest changed.
  f.store.grant(f.root, "function:reload-demo", view.digest, true)
  expect((await f.reload()).state).toBe("applied")
  // A changed source uses the original registration preflight and then the active worker.
  expect(f.load).toHaveBeenCalledTimes(3)
  expect(f.load.mock.calls.slice(1).map(call => call[1].tone)).toEqual(["formal", "formal"])
  expect((await f.manager.commands(f.root, f.threadId)).map(row => row.name)).toEqual(["formal"])
})

it("readonly source preflight failure retains the old guest and produces zero new startup effects", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, f.threadId)
  f.save("formal")
  const current = await f.view()
  await writeFile(f.source, "export function register(){}")
  await expect(
    f.manager.reloadUserConfig(
      f.root,
      f.threadId,
      "p",
      current.digest,
      current.savedRevision,
      f.signal,
      () => {}
    )
  ).rejects.toThrow("MODS_CONFIG_VALUE_CHANGED")
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.store.functionState.get(JSON.stringify([f.root, "reload-demo"]), "startup")).toBe("warm")
})

it("a caught startup failure stops effects until an explicit retry, even across runtime invalidation", async () => {
  const f = await fixture(`await $.store.set("startup",options.tone);
    if(options.tone==="bad")try{await $.tool.call({name:"missing",input:{}})}catch{}`)
  await f.manager.commands(f.root, f.threadId)
  f.save("bad")
  expect(await f.reload()).toMatchObject({ state: "stopped" })
  const count = f.load.mock.calls.length
  f.manager.invalidate(f.root)
  f.manager.closeThread(f.threadId)
  f.save("formal")
  expect(await f.manager.runtimeReady(f.root, f.threadId)).toBe(false)
  expect(await f.manager.commands(f.root, f.threadId)).toEqual([])
  expect(
    await f.manager.classicEvent(
      f.root,
      f.threadId,
      "prompt.context",
      { text: "chat" },
      f.signal,
      async (value) => value
    )
  ).toEqual({ text: "chat" })
  expect(f.load).toHaveBeenCalledTimes(count)
  expect((await f.reload()).state).toBe("applied")
  expect((await f.manager.commands(f.root, f.threadId))[0].name).toBe("formal")
})

it("a startup model reentry fails immediately and cannot await its own reload or session.start", async () => {
  const f = await fixture(
    `if(options.tone==="model")try{await $.model.complete({model:"fixture",prompt:"test"})}catch{}`
  )
  await f.manager.commands(f.root, f.threadId)
  f.save("model")
  const result = await f.reload()
  expect(result.state).toBe("stopped")
  expect(result.error).toContain("组件启动期间不能再次进入")
  expect(f.completeModel).toHaveBeenCalledOnce()
}, 5000)

it("losing the original owner during preflight cancels before retiring the old instance", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, f.threadId)
  f.save("formal")
  let calls = 0
  const guard = () => {
    if (++calls > 3) throw Error("window lost")
  }
  await expect(
    f.manager.reloadUserConfig(f.root, f.threadId, "p", f.compiled.digest, 1, f.signal, guard)
  ).rejects.toThrow("window lost")
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
})

const daemon = `try{const service=$.process.spawn({argv:${JSON.stringify([
  process.execPath,
  "-e",
  "process.stdout.write('ready');setInterval(()=>{},1000)"
])}});await service[Symbol.asyncIterator]().next()}catch(error){await $.store.set("daemonError",String(error));throw error}`

it("a real long timer can be retired without waiting for its next tick", async () => {
  const f = await fixture(`await $.store.set("startup",options.tone);
    $.clock.every(60000,()=>{})`)
  await f.manager.commands(f.root, f.threadId)
  f.save("formal")
  expect(await f.reload()).toMatchObject({ state: "applied" })
  expect((await f.manager.commands(f.root, f.threadId))[0].name).toBe("formal")
}, 5000)

it("an entered timer Hook remains foreground and cannot be cancelled to manufacture idle", async () => {
  const f = await fixture(
    `await $.store.set("startup",options.tone);
    $.clock.every(60000,()=>{})`,
    'on("clock.every",async($,e,next)=>{await $.ui.log("timer-entered");return next(e)})'
  )
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  f.publish.mockImplementation(async (_workspace, value) => {
    if (
      value &&
      !Array.isArray(value) &&
      typeof value === "object" &&
      value.text === "timer-entered"
    ) {
      entered.resolve()
      await finish.promise
    }
    return value
  })
  await f.manager.commands(f.root, f.threadId)
  await entered.promise
  f.save("formal")
  expect(await f.reload()).toMatchObject({ state: "pending" })
  expect(f.load).toHaveBeenCalledTimes(1)
  finish.resolve()
  expect(await f.reload()).toMatchObject({ state: "pending" })
  expect(f.load).toHaveBeenCalledTimes(1)
}, 5000)

it("an actual started daemon is retired once, with delayed cleanup blocking any new load", async () => {
  const f = await fixture(`if(options.tone==="warm"){${daemon}}`)
  const cleanupStarted = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  const actual = FunctionProcessHost.prototype.spawn
  const close = vi.fn()
  vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(function (
    this: FunctionProcessHost,
    ...args
  ) {
    const backend = actual.apply(this, args)
    return {
      ...backend,
      close: async () => {
        close()
        cleanupStarted.resolve()
        await finish.promise
        await backend.close()
      }
    }
  })
  await f.manager.commands(f.root, f.threadId)
  expect(
    f.store.functionState.get(JSON.stringify([f.root, "reload-demo"]), "daemonError")
  ).toBeUndefined()
  expect(f.authorizeProcess).toHaveBeenCalledOnce()
  f.save("formal")
  const pending = f.reload()
  await cleanupStarted.promise
  expect(getLocalThreadRunLease(f.threadId)?.owner).toBe("mods")
  expect(f.load).toHaveBeenCalledTimes(1)
  finish.resolve()
  expect(await pending).toMatchObject({ state: "applied" })
  expect(close).toHaveBeenCalledOnce()
  expect((await f.manager.commands(f.root, f.threadId))[0].name).toBe("formal")
}, 8000)

it("actual backend cleanup rejection stops the combination with zero replacement loads", async () => {
  const f = await fixture(`if(options.tone==="warm"){${daemon}}`)
  const actual = FunctionProcessHost.prototype.spawn
  vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(function (
    this: FunctionProcessHost,
    ...args
  ) {
    const backend = actual.apply(this, args)
    return {
      ...backend,
      close: async () => {
        await backend.close()
        throw Error("backend close rejected")
      }
    }
  })
  await f.manager.commands(f.root, f.threadId)
  expect(
    f.store.functionState.get(JSON.stringify([f.root, "reload-demo"]), "daemonError")
  ).toBeUndefined()
  expect(f.authorizeProcess).toHaveBeenCalledOnce()
  f.save("formal")
  expect(await f.reload()).toMatchObject({ state: "stopped", error: "backend close rejected" })
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
}, 8000)

it("a cleanup failure already swallowed by the author cannot disappear before explicit retirement", async () => {
  const argv = JSON.stringify([
    process.execPath,
    "-e",
    "process.stdout.write('ready');setInterval(()=>{},1000)"
  ])
  const f = await fixture(`const service=$.process.spawn({argv:${argv}});
    await service[Symbol.asyncIterator]().next();try{await service.return()}catch{}`)
  const actual = FunctionProcessHost.prototype.spawn
  const close = vi.fn()
  vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(function (
    this: FunctionProcessHost,
    ...args
  ) {
    const backend = actual.apply(this, args)
    return {
      ...backend,
      close: async () => {
        close()
        await backend.close()
        throw Error("previous cleanup rejected")
      }
    }
  })
  await f.manager.commands(f.root, f.threadId)
  expect(close).toHaveBeenCalledOnce()
  f.save("formal")
  expect(await f.reload()).toMatchObject({ state: "stopped", error: "previous cleanup rejected" })
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledOnce()
}, 8000)

it("actual foreground process opening remains busy before the native started ACK", async () => {
  const f = await fixture("", `on("command.run",async($)=>{${daemon};return {text:"opened"}})`)
  const descriptors = await f.manager.commands(f.root, f.threadId)
  const opening = Promise.withResolvers<void>(),
    authorized = Promise.withResolvers<void>()
  f.authorizeProcess.mockImplementation(async () => {
    opening.resolve()
    await authorized.promise
  })
  const run = f.manager.runCommand(f.root, f.threadId, descriptors[0], "", f.signal)
  await opening.promise
  f.save("formal")
  expect(await f.reload()).toMatchObject({ state: "pending" })
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
  authorized.resolve()
  expect(await run).toEqual({ text: "opened" })
}, 8000)

it("protected native feedback publication retains activity until its receipt can be issued", async () => {
  const f = await fixture()
  await f.manager.commands(f.root, f.threadId)
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  f.publish.mockImplementationOnce(async (_workspace, value) => {
    entered.resolve()
    await finish.promise
    return value
  })
  const pending = f.manager.feedbackPresentation(f.root, f.threadId)
  try {
    await entered.promise
    f.save("formal")
    expect(await f.reload()).toMatchObject({ state: "pending" })
    expect(f.load).toHaveBeenCalledTimes(1)
    finish.resolve()
    const binding = await pending
    expect(binding).toBeDefined()
    expect(await f.reload()).toMatchObject({ state: "applied" })
    expect((await f.manager.commands(f.root, f.threadId))[0].name).toBe("formal")
    expect(() => binding!.assertLive()).toThrow()
  } finally {
    finish.resolve()
    await pending.catch(() => {})
  }
}, 8000)


it("strict resource cleanup rejection keeps the source referenced even after real guest drain", async () => {
  const f = await fixture(`if(options.tone==="warm"){${daemon}}`, "", true)
  const actual = FunctionProcessHost.prototype.spawn
  const close = vi.fn()
  vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(function (
    this: FunctionProcessHost,
    ...args
  ) {
    const backend = actual.apply(this, args)
    return {
      ...backend,
      close: async () => {
        close()
        await backend.close()
        throw Error("resource retirement unconfirmed after guest drain")
      }
    }
  })
  await f.manager.commands(f.root, f.threadId)
  expect(f.authorizeProcess).toHaveBeenCalledOnce()
  expect(f.manager.referencesSourceDirectory(f.path)).toBe(true)
  f.save("formal")
  expect(await f.reload()).toMatchObject({
    state: "stopped", error: "resource retirement unconfirmed after guest drain"
  })
  // A successful VM drain does not erase a separately failed native-resource cleanup.
  expect(f.drain).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.manager.referencesSourceDirectory(f.path)).toBe(true)
  expect(getLocalThreadRunLease(f.threadId)).toBeUndefined()
  // Readonly inspection and global invalidation neither replay cleanup nor lose its owner.
  expect(await f.view()).toMatchObject({ state: "stopped" })
  f.manager.invalidate(f.root)
  expect(f.manager.referencesSourceDirectory(f.path)).toBe(true)
  expect(f.drain).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
  expect(f.load).toHaveBeenCalledTimes(1)
}, 8000)


it("ordinary invalidation retains source after controlled cleanup accounting failure and real drain", async () => {
  const f = await fixture(`if(options.tone==="warm"){${daemon}}`, "", true)
  const actual = FunctionProcessHost.prototype.spawn
  const close = vi.fn()
  vi.spyOn(FunctionProcessHost.prototype, "spawn").mockImplementation(function (
    this: FunctionProcessHost,
    ...args
  ) {
    const backend = actual.apply(this, args)
    return {
      ...backend,
      close: async () => {
        close()
        await backend.close()
        // Controlled failure accounting, not evidence that the native process is still alive.
        throw Error("controlled cleanup receipt rejected")
      }
    }
  })
  await f.manager.commands(f.root, f.threadId)
  expect(f.authorizeProcess).toHaveBeenCalledOnce()
  const owners = f.manager as unknown as {
    sessions: Map<string, object>
    entryDrains: WeakMap<object, Promise<void>>
  }
  const original = owners.sessions.get(JSON.stringify([f.root, f.threadId]))
  expect(original).toBeDefined()
  // Invalidate is the FIRST retirement entry, with the ordinary close(false) contract.
  expect(() => f.manager.invalidate(f.root)).not.toThrow()
  const drain = owners.entryDrains.get(original!)
  expect(drain).toBeDefined()
  // Joining the existing receipt only observes completion; it triggers no cleanup/retry.
  await expect(drain).resolves.toBeUndefined()
  expect(f.drain).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
  expect(f.load).toHaveBeenCalledTimes(1)
  expect(f.manager.referencesSourceDirectory(f.path)).toBe(true)
  f.manager.invalidate(f.root)
  expect(f.manager.referencesSourceDirectory(f.path)).toBe(true)
  expect(owners.entryDrains.get(original!)).toBe(drain)
  expect(f.drain).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
}, 8000)
