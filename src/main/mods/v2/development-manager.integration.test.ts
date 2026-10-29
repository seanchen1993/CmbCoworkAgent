import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { AsyncResource } from "node:async_hooks"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { ModCommandQueue } from "../command-queue"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import * as functionLoader from "./loader"
import { assertFunctionSourcesCurrent } from "./source-adoption-fence"
import { DEVELOPMENT_EVENT_CAPABILITIES, type DevelopmentScope } from "./development-session"
import { ModDevelopmentService } from "../devtools/development-service"
import { AuthoringDraftStore } from "../devtools/authoring-store"
import { withFunctionTransportExecution } from "./host-call"
import { currentFunctionExecution, withFunctionExecution } from "./execution-context"
import { FunctionSessionActivity } from "./session-activity"
import { ModsManager, authorizeCurrentModInput } from "../manager"
import type { ModThreadBinding } from "../manager"
import { LocalSandbox } from "../../agent/local-sandbox"
import { functionSdkToolInput } from "./tool-sdk"
import { getModCallContext } from "../context"
import { ClawStore } from "../claw-store"
import type { ClawProfile } from "../../../shared/mods/claw"
import { claimConfigurationReload } from "./configuration-reload-lease"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture(options: {
  drain?: () => Promise<void>
  nativeWorkspace?: boolean
  realCapabilities?: string[]
  host?: Partial<ConstructorParameters<typeof FunctionModsManager>[1]>
} = {}) {
  const createdRoot = await mkdtemp(join(tmpdir(), "mods-development-"))
  const root = options.nativeWorkspace && process.platform === "win32"
    ? createdRoot.toLowerCase() : createdRoot
  const store = new ModControlStore(join(root, "control.sqlite"))
  const scope: DevelopmentScope = {
    workspace: root,
    threadId: randomUUID(),
    incarnation: { token: randomUUID(), legacyCreatedAt: 1 }
  }
  let live = true, enabled = true
  let plugins: Array<{ id: string; name: string; path: string; enabled: boolean }> = []
  const loads = vi.fn()
  const openConversationOwner = vi.fn(() => () => {})
  const activateConversationOwner = vi.fn()
  let configurationIdle: (threadId: string) => void = () => {}
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => plugins,
      enabled: () => enabled,
      publish: async (_workspace, value) => value,
      changed: () => {},
      onConfigurationIdle: listener => { configurationIdle = listener; return () => {} },
      openConversationOwner,
      activateConversationOwner,
      assertThread: () => {
        if (!live) throw Error("scope lost")
      },
      ...options.host
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
  const stage = async (revision: number, body: string, publish = true) => {
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
        ...options.realCapabilities ?? [],
        ...DEVELOPMENT_EVENT_CAPABILITIES
      ],
      ...(options.realCapabilities ? { validation: "authorized-real" as const } : {})
    }
    if (publish) manager.stageDevelopment(scope, input, () => {
      if (!live) throw Error("scope lost")
      assertFunctionSourcesCurrent(compiled)
    })
    return input
  }
  cleanups.push(async () => {
    manager.close()
    await new Promise((resolve) => setTimeout(resolve, 30))
    store.close()
    expect(dirname(resolve(createdRoot))).toBe(resolve(tmpdir()))
    expect(basename(createdRoot)).toMatch(/^mods-development-/)
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
    configurationIdle: () => configurationIdle(scope.threadId),
    setPlugins: (value: typeof plugins) => { plugins = value },
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

it("keeps old calls and display owners live through candidate save, compile, preflight and both queue barriers", async () => {
  const approval = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let pendingSignal: AbortSignal | undefined
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.end("old request completed")
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === "string") throw Error("HTTP fixture unavailable")
  const changes: Array<string | undefined> = []
  const f = await fixture({ realCapabilities: ["http.fetch"], host: {
    changed: (_thread, reason) => { changes.push(reason) },
    authorizeHttp: async (_workspace, _thread, _grant, _request, signal) => {
      pendingSignal = signal; entered.resolve(); await approval.promise; signal.throwIfAborted()
    },
    runEffect: async (_workspace, _thread, _grant, _method, _input, _signal, run) => run()
  } })
  const code = (version: string) => `export function register(on) {
    on("session.start",async($,event,next)=>{
      await $.command.register({name:"hold",description:"hold old call"});return next(event)
    });
    on("command.run",{command:"hold"},async($)=>{
      const response=await $.http.fetch("http://127.0.0.1:${address.port}/old");
      await $.store.set("completed",response.text);return{text:${JSON.stringify(version)}+":"+response.text}
    });
    on("ui.render",{component:"AbovePrompt"},($,event)=>{
      const {Text}=$.ui.resolve(event);return Text({children:${JSON.stringify(version)}})
    })
  }`
  const active = await f.activate(1, code("v1"))
  const owner = (await f.manager.siteMount(f.root, f.scope.threadId, "AbovePrompt"))!
  const descriptor = (await f.manager.commands(f.root, f.scope.threadId))[0]
  const queue = new ModCommandQueue(f.store, () => {})
  cleanups.push(async () => { queue.close() })
  const running = queue.enqueue(f.root, f.scope.threadId, descriptor.command, signal =>
    withFunctionExecution({ workspace: f.root, threadId: f.scope.threadId,
      leased: true, immediate: false, userInitiated: true }, () =>
      f.manager.runCommand(f.root, f.scope.threadId, descriptor, "", signal))).completion
  void running.catch(() => {})
  const renderOld = () => f.manager.siteRender(f.root, f.scope.threadId, owner, {
    isWorking: true, bodyColumns: 80, maxRows: 10
  })
  try {
    await Promise.race([entered.promise, running.then(() => {
      throw Error("Old command completed before reaching HTTP approval")
    })])
    changes.length = 0
    const candidate = await f.stage(2, code("v2"), false)
    expect(JSON.stringify(await renderOld())).toContain("v1")
    await f.manager.preflightDevelopment(f.scope, candidate, () => {})
    expect(JSON.stringify(await renderOld())).toContain("v1")
    f.manager.stageDevelopment(f.scope, candidate, () => {})
    expect(f.manager.developmentStatus(f.scope)[0]).toMatchObject({
      phase: "queued", activeRevision: 1, activeDigest: active.compiledDigest,
      waitingReason: "turn-finishing"
    })
    f.manager.noteDevelopmentTurnSettled(f.scope, candidate.turnId, "completed")
    expect(f.manager.developmentStatus(f.scope)[0]).toMatchObject({ phase: "queued", activeRevision: 1 })
    expect(JSON.stringify(await renderOld())).toContain("v1")
    expect(pendingSignal?.aborted).toBe(false)
    expect(requests).toBe(0)
    expect(changes.every(reason => reason === "records")).toBe(true)
    approval.resolve()
    expect(await running).toEqual({ text: "v1:old request completed" })
    expect(requests).toBe(1)
    f.configurationIdle()
    await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0])
      .toMatchObject({ phase: "active", activeRevision: 2 }))
    await expect(renderOld()).rejects.toThrow()
    await expect(f.manager.runCommand(f.root, f.scope.threadId, descriptor, "", new AbortController().signal))
      .rejects.toThrow("MODS_COMMAND_STALE")
  } finally { approval.resolve(); await running.catch(() => {}) }
}, 15_000)

it("preflights the actual startup protocol during the authoring turn without staging or retiring", async () => {
  const f = await fixture()
  const body = (next: boolean) => `export function register(on) {
    on("session.start", async ($,event,next) => {
      await $.command.register({name:"weather-refresh",description:"Refresh weather"});
      ${next ? "return next(event)" : ""}
    })
  }`
  const broken = await f.stage(1, body(false), false)
  await expect(f.manager.preflightDevelopment(f.scope, broken, () => {}))
    .rejects.toMatchObject({ code: "MODS_RETURN_UNDEFINED" })
  expect(f.manager.developmentStatus(f.scope)).toEqual([])
  expect(await f.manager.commands(f.root, f.scope.threadId)).toEqual([])
  const repaired = await f.stage(2, body(true), false)
  await expect(f.manager.preflightDevelopment(f.scope, repaired, () => {})).resolves.toBeUndefined()
  expect(f.manager.developmentStatus(f.scope)).toEqual([])
  expect(await f.manager.commands(f.root, f.scope.threadId)).toEqual([])
  expect(f.store.getGrant(f.root, "function:dev-example")).toBeNull()
})

it("preserves the active trial while a same-turn startup candidate fails", async () => {
  const f = await fixture()
  await f.activate(1, compositionCommand("counter-current"))
  const candidate = await f.stage(2, `export function register(on) {
    on("session.start", async ($) => { await $.store.get("counter") })
  }`, false)
  await expect(f.manager.preflightDevelopment(f.scope, candidate, () => {}))
    .rejects.toMatchObject({ code: "MODS_RETURN_UNDEFINED" })
  expect(f.manager.developmentStatus(f.scope)[0]).toMatchObject({ phase: "active", activeRevision: 1 })
  expect((await f.manager.commands(f.root, f.scope.threadId)).map(item => item.command))
    .toEqual(["counter-current"])
})

it("blocks startup HTTP before authorization and permits weather refresh after consent", async () => {
  const compilation = vi.spyOn(functionLoader, "compileFunctionPlugin")
  cleanups.push(async () => { compilation.mockRestore() })
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ temperature: 23, forecast: "晴" }))
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  if (!address || typeof address === "string") throw Error("HTTP fixture unavailable")
  const url = `http://127.0.0.1:${address.port}/weather`
  const approval = Promise.withResolvers<void>()
  const approvalEntered = Promise.withResolvers<void>()
  let authorizationSignal: AbortSignal | undefined
  const authorize = vi.fn(async (_workspace: string, _threadId: string, _grant: unknown,
    _request: unknown, signal: AbortSignal) => {
    authorizationSignal = signal
    approvalEntered.resolve()
    await approval.promise
    signal.throwIfAborted()
  })
  const f = await fixture({ realCapabilities: ["http.fetch", "ui.invalidate"],
    host: { authorizeHttp: authorize,
      runEffect: async (_workspace, _thread, _grant, _method, _input, _signal, run) => run() } })
  const eager = await f.stage(1, `export function register(on) {
    on("session.start",async($,event,next)=>{
      await $.http.fetch(${JSON.stringify(url)});return next(event)
    })
  }`, false)
  await expect(f.manager.preflightDevelopment(f.scope, eager, () => {}))
    .rejects.toMatchObject({ code: "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED" })
  expect(authorize).not.toHaveBeenCalled()
  expect(requests).toBe(0)
  const lazy = `export function register(on) {
    let weather="待更新",calls=0,loaded=false;
    on("session.start",async($,event,next)=>{
      weather=(await $.store.get("weather")) || "待更新";
      loaded=weather!=="待更新";
      await $.command.register({name:"weather-refresh",description:"更新天气"});
      return next(event)
    });
    on("command.run",{command:"weather-refresh"},async($)=>{
      const response=await $.http.fetch(${JSON.stringify(url)});
      const forecast=JSON.parse(response.text);
      weather=forecast.temperature+"° "+forecast.forecast;
      await $.store.set("weather",weather);$.ui.invalidate("ui.render");return {text:weather}
    });
    on("tool.call",async($,event,next)=>{calls++;$.ui.invalidate("ui.render");return next(event)});
    on("ui.render",{component:"AbovePrompt"},async($,event)=>{
      if(!loaded){
        loaded=true;
        const response=await $.http.fetch(${JSON.stringify(url)});
        const forecast=JSON.parse(response.text);
        weather=forecast.temperature+"° "+forecast.forecast;
        await $.store.set("weather",weather)
      }
      const {Text}=$.ui.resolve(event);return Text({children:"工具次数："+calls+" | 天气："+weather})
    })
  }`
  const candidate = await f.stage(2, lazy, false)
  await f.manager.preflightDevelopment(f.scope, candidate, () => {})
  const candidateCompilations = () => compilation.mock.calls.filter(
    ([path]) => path === candidate.sourcePath).length
  const preflightCompilations = candidateCompilations()
  expect(preflightCompilations).toBeGreaterThan(0)
  expect(authorize).not.toHaveBeenCalled()
  expect(requests).toBe(0)
  f.manager.stageDevelopment(f.scope, candidate, () => {})
  expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("needs-approval")
  f.manager.noteDevelopmentTurnSettled(f.scope, candidate.turnId, "completed")
  expect(requests).toBe(0)
  f.manager.approveDevelopment(f.scope, f.componentId, candidate.compiledDigest,
    candidate.capabilities, () => {})
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("active"))
  expect(candidateCompilations()).toBe(preflightCompilations)
  expect(requests).toBe(0)
  const owner = await f.manager.siteMount(f.root, f.scope.threadId, "AbovePrompt")
  const render = () => withFunctionExecution({ workspace: f.root, threadId: f.scope.threadId,
    userInitiated: false, leased: false, immediate: true }, () =>
    f.manager.siteRender(f.root, f.scope.threadId, owner!, {
      isWorking: false, bodyColumns: 80, maxRows: 10
    }))
  let completed = false
  const drawing = render().finally(() => { completed = true })
  void drawing.catch(() => {})
  try {
    await approvalEntered.promise
    // User permission waits must not spend the guest hook's 10-second own budget.
    await new Promise(resolve => setTimeout(resolve, 10_100))
    expect(authorizationSignal?.aborted).toBe(false)
    expect(completed).toBe(false)
    expect(requests).toBe(0)
  } finally { approval.resolve() }
  const rendered = await drawing
  expect(authorize).toHaveBeenCalledOnce()
  expect(requests).toBe(1)
  expect(JSON.stringify(rendered)).toContain("工具次数：0 | 天气：23° 晴")
  expect(JSON.stringify(await render())).toContain("天气：23° 晴")
  expect(requests).toBe(1)
}, 25_000)

async function compositionFixture(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture({ ...options, host: { ...options.host, clawApplicable: () => true } })
  const claws = new ClawStore(f.store)
  const identity = JSON.stringify([f.scope.threadId, "legacy"])
  const initial: ClawProfile = { id: "initial", name: "Initial", capabilities: [] }
  claws.apply(f.root, identity, initial, claws.read(f.root).revision)
  const installed = async (body: string) => {
    const path = join(f.root, "installed")
    await mkdir(join(path, "hooks"), { recursive: true })
    await writeFile(join(path, "plugin.json"), JSON.stringify({ name: "installed" }))
    await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    await writeFile(join(path, "hooks/register.ts"), body)
    const compiled = await compileFunctionPlugin(path)
    f.setPlugins([{ id: "installed", name: "installed", path, enabled: true }])
    f.store.grant(f.root, "function:installed", compiled.digest, true)
    const target: ClawProfile = { id: "combined", name: "Combined", capabilities: [
      { pluginId: "installed", name: "installed", digest: compiled.digest }
    ] }
    return { target, compiled }
  }
  const apply = async (target: ClawProfile | null, commit?: () => void) => {
    const revision = claws.read(f.root).revision
    const binding = claws.selection(f.root, identity)
    const lease = claimConfigurationReload(f.scope.threadId)!
    expect(lease).toBeTruthy()
    let committed = false
    const assertCurrent = () => {
      lease.assertLive()
      expect(claws.read(f.root).revision).toBe(revision + Number(committed))
      expect(claws.selection(f.root, identity).profile).toEqual(committed ? target : binding.profile)
    }
    try {
      await f.manager.reconfigureSelection(f.root, f.scope.threadId, target, () => {
        commit?.()
        claws.apply(f.root, identity, target, revision)
        committed = true
      }, assertCurrent)
    } finally { lease.release() }
  }
  const render = async (owner?: string) => {
    const current = owner ?? await f.manager.siteMount(f.root, f.scope.threadId, "AbovePrompt")
    return JSON.stringify(await f.manager.siteRender(f.root, f.scope.threadId, current!, {
      isWorking: false, bodyColumns: 80, maxRows: 10
    }))
  }
  return { ...f, claws, identity, initial, installed, apply, render }
}

const compositionCommand = (name: string) => `export function register(on) {
  on("session.start",async($,e,next)=>{
    await $.command.register({name:${JSON.stringify(name)},description:"Installed command"});return next(e)
  })
  on("command.run",{command:${JSON.stringify(name)}},()=>({text:"installed command ran"}))
}`

it("restores the actual inherited selection and its authorized commands", async () => {
  const f = await compositionFixture()
  await f.installed(compositionCommand("inherited-command"))
  await f.apply(f.initial)
  expect(await f.manager.commands(f.root, f.scope.threadId)).toEqual([])
  await f.apply(null)
  expect(f.claws.selection(f.root, f.identity).profile).toBeNull()
  expect(f.manager.selectionRuntimeReady(f.root, f.scope.threadId, null)).toBe(true)
  expect((await f.manager.commands(f.root, f.scope.threadId))[0].command)
    .toBe("inherited-command")
})

it("requires a live completed guest for the exact selection readiness proof", async () => {
  const f = await compositionFixture()
  const { target } = await f.installed(compositionCommand("live-command"))
  expect(f.manager.selectionRuntimeReady(f.root, f.scope.threadId, target)).toBe(false)
  await f.apply(target)
  expect(f.manager.selectionRuntimeReady(f.root, f.scope.threadId, target)).toBe(true)
  expect(f.manager.selectionRuntimeReady(f.root, f.scope.threadId, f.initial)).toBe(false)
  const entries = (f.manager as unknown as { sessions: Map<string, {
    session: { plugins: Array<{ guest: FunctionGuestRuntime }> }
  }> }).sessions
  await entries.get(JSON.stringify([f.root, f.scope.threadId]))!.session.plugins[0].guest.dispose()
  expect(f.manager.selectionRuntimeReady(f.root, f.scope.threadId, target)).toBe(false)
})

it("publishes physical foreground idle even while a resident background resource remains", async () => {
  const f = await compositionFixture()
  await f.apply(f.initial)
  const entries = (f.manager as unknown as {
    sessions: Map<string, { activity: FunctionSessionActivity }>
  }).sessions
  const activity = entries.get(JSON.stringify([f.root, f.scope.threadId]))!.activity
  const resource = activity.retainFreshResource()
  resource.ready()
  const release = activity.retainFresh()
  const idle = vi.fn()
  const unsubscribe = f.manager.onConfigurationIdle(idle)
  try {
    expect(f.manager.configurationBusy(f.scope.threadId)).toBe(true)
    release()
    await vi.waitFor(() => expect(idle).toHaveBeenCalledWith(f.scope.threadId))
    expect(activity.size).toBe(1)
    expect(f.manager.configurationBusy(f.scope.threadId)).toBe(false)
  } finally { unsubscribe(); release(); resource.release() }
})

it("composes an installed Mod while preserving the active trial, consent and pending revision", async () => {
  const f = await compositionFixture()
  const active = await f.activate(1, source("kept trial"))
  const oldOwner = await f.manager.siteMount(f.root, f.scope.threadId, "AbovePrompt")
  const pending = await f.stage(2, source("pending trial"))
  const { target } = await f.installed(compositionCommand("installed-command"))
  await f.apply(target)
  expect(f.manager.developmentStatus(f.scope)[0]).toMatchObject({
    phase: "queued", revision: 2, activeRevision: 1, activeDigest: active.compiledDigest,
    addedCapabilities: [], waitingReason: "turn-finishing"
  })
  expect(await f.render()).toContain("kept trial")
  await expect(f.render(oldOwner!)).rejects.toThrow()
  const command = (await f.manager.commands(f.root, f.scope.threadId))[0]
  expect(command.command).toBe("installed-command")
  expect(await f.manager.runCommand(f.root, f.scope.threadId, command, "", new AbortController().signal))
    .toEqual({ text: "installed command ran" })
  expect(f.store.getGrant(f.root, "function:dev-example")).toBeNull()
  f.manager.noteDevelopmentTurnSettled(f.scope, pending.turnId, "completed")
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0]).toMatchObject({
    phase: "active", activeRevision: 2
  }))
  expect(await f.render()).toContain("pending trial")
  expect((await f.manager.commands(f.root, f.scope.threadId))[0].command).toBe("installed-command")
})

it("keeps the exact old trial and selection when composition preparation or CAS fails", async () => {
  const f = await compositionFixture()
  await f.activate(1, source("untouched trial"))
  const owner = await f.manager.siteMount(f.root, f.scope.threadId, "AbovePrompt")
  const { target } = await f.installed(`export function register(on) {
    on("session.start",async($,e,next)=>{await $.store.set("external-start",true);return next(e)})
  }`)
  const commit = vi.fn()
  const before = f.claws.read(f.root).revision
  await expect(f.apply(target, commit)).rejects.toMatchObject({ code: "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED" })
  expect(commit).not.toHaveBeenCalled()
  expect(f.claws.read(f.root).revision).toBe(before)
  expect(f.manager.developmentStatus(f.scope)[0]).toMatchObject({ phase: "active", activeRevision: 1 })
  expect(await f.render(owner!)).toContain("untouched trial")
  const next = await f.installed(compositionCommand("safe-command"))
  await expect(f.apply(next.target, () => { throw Error("CAS changed") })).rejects.toThrow("CAS changed")
  expect(f.claws.selection(f.root, f.identity).profile).toEqual(f.initial)
  expect(await f.render(owner!)).toContain("untouched trial")
})

it("awaits the old physical guest drain without stopping the trial or publishing the candidate", async () => {
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const f = await compositionFixture({ drain: async () => { started.resolve(); await gate.promise } })
  await f.activate(1, source("same activation"))
  const { target } = await f.installed(compositionCommand("after-drain"))
  let finished = false
  const applying = f.apply(target).then(() => { finished = true })
  try {
    await started.promise
    f.configurationIdle()
    expect(finished).toBe(false)
    expect(f.manager.developmentStatus(f.scope)[0]).toMatchObject({ phase: "active", activeRevision: 1 })
    gate.resolve()
    await applying
    expect(await f.render()).toContain("same activation")
    expect((await f.manager.commands(f.root, f.scope.threadId))[0].command).toBe("after-drain")
  } finally { gate.resolve(); await applying.catch(() => {}) }
})

it("retains a not-yet-approved draft when composing before its first activation", async () => {
  const f = await compositionFixture()
  const pending = await f.stage(1, source("approved later"))
  const { target } = await f.installed(compositionCommand("already-installed"))
  await f.apply(target)
  expect(f.manager.developmentStatus(f.scope)[0]).toMatchObject({ phase: "needs-approval", revision: 1 })
  expect((await f.manager.commands(f.root, f.scope.threadId))[0].command).toBe("already-installed")
  f.manager.approveDevelopment(f.scope, f.componentId, pending.compiledDigest, pending.capabilities, () => {})
  f.manager.noteDevelopmentTurnSettled(f.scope, pending.turnId, "completed")
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("active"))
  expect(await f.render()).toContain("approved later")
  expect((await f.manager.commands(f.root, f.scope.threadId))[0].command).toBe("already-installed")
})

it.each(["drain-failure", "grant-revoked"] as const)(
  "fails closed after selection commit when %s prevents safe activation", async mode => {
    const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>()
    const f = await compositionFixture({ drain: async () => {
      started.resolve()
      await gate.promise
      if (mode === "drain-failure") throw Error("physical drain unconfirmed")
    } })
    await f.activate(1, source("cannot silently restart"))
    const { target, compiled } = await f.installed(compositionCommand("not-published"))
    const applying = f.apply(target)
    const failed = expect(applying).rejects.toMatchObject({ code: "MODS_COMPOSITION_APPLY_UNCONFIRMED" })
    try {
      await started.promise
      if (mode === "grant-revoked")
        f.store.grant(f.root, "function:installed", compiled.digest, false)
      gate.resolve()
      await failed
      expect(f.claws.selection(f.root, f.identity).profile).toEqual(target)
      await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("unknown"))
      const loaded = f.loads.mock.calls.length
      await expect(f.manager.commands(f.root, f.scope.threadId)).resolves.toEqual([])
      expect(f.loads).toHaveBeenCalledTimes(loaded)
    } finally { gate.resolve(); await applying.catch(() => {}) }
  }
)

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

it("runs edit-weather commands and edit-only effects during trial and after formal installation", async () => {
  const f = await fixture()
  const input = await f.stage(1, `export function register(on) {
    on("session.start", async ($, event, next) => {
      await $.command.register({name:"set-weather", description:"设置演示天气"})
      return next(event)
    })
    on("command.run", {command:"set-weather"}, async ($, event) => {
      await $.store.set("weather", event.args)
      return {text:"天气已设置："+event.args}
    })
    on("tool.call", {tool:"edit_file"}, async ($, event, next) => {
      const result = await next(event)
      return {...result, context:[await $.store.get("weather") ?? "请先设置天气"]}
    })
  }`)
  f.manager.approveDevelopment(f.scope, f.componentId, input.compiledDigest,
    input.capabilities, () => {})
  expect(f.manager.developmentStatus(f.scope)[0].waitingReason).toBe("turn-finishing")
  expect(await f.manager.commands(f.root, f.scope.threadId)).toEqual([])
  f.manager.noteDevelopmentTurnSettled(f.scope, input.turnId, "completed")
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("active"))
  const runWeather = async (text: string) => {
    const descriptor = (await f.manager.commands(f.root, f.scope.threadId))[0]
    expect(descriptor.command).toBe("set-weather")
    const result = await f.manager.runCommand(f.root, f.scope.threadId, descriptor,
      text, new AbortController().signal)
    expect(result.text).toBe(`天气已设置：${text}`)
    const edit = vi.fn(async () => ({result:"编辑完成"}))
    expect(await f.manager.interceptTool(f.root, f.scope.threadId,
      {tool:"edit_file", tool_use_id:randomUUID()}, undefined, edit))
      .toEqual({result:"编辑完成", context:[text]})
    expect(edit).toHaveBeenCalledOnce()
    expect(await f.manager.interceptTool(f.root, f.scope.threadId,
      {tool:"read_file", tool_use_id:randomUUID()}, undefined, async () => ({result:"读取完成"})))
      .toEqual({result:"读取完成"})
  }
  await runWeather("上海晴")
  await f.manager.stopDevelopment(f.scope, f.componentId, () => {})
  expect(await f.manager.commands(f.root, f.scope.threadId)).toEqual([])
  // The formal source still needs an independent digest grant and actual selection.
  f.setPlugins([{id:"formal-weather", name:"dev-example", path:input.sourcePath, enabled:true}])
  f.manager.invalidate(f.root)
  expect(await f.manager.commands(f.root, f.scope.threadId)).toEqual([])
  f.store.grant(f.root, "function:dev-example", input.compiledDigest, true)
  f.manager.invalidate(f.root)
  await runWeather("北京多云")
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

it("does not mark a deliberately draining trial as lost when configuration idle fires", async () => {
  let release!: () => void
  let entered!: () => void
  const draining = new Promise<void>(resolve => { entered = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const f = await fixture({ drain: async () => { entered(); await barrier } })
  const trial = await f.activate(1, `export function register(on) {
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"weather-city",description:"Weather city"});return next(e)
    })
  }`)
  const stopping = f.manager.stopDevelopment(f.scope, f.componentId, () => {})
  await draining
  f.configurationIdle()
  release()
  await stopping
  expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("stopped")
  await expect(f.manager.commands(f.root, f.scope.threadId)).resolves.toEqual([])
  f.setPlugins([{ id: "formal-weather", name: "dev-example", path: trial.sourcePath, enabled: true }])
  f.store.grant(f.root, "function:dev-example", trial.compiledDigest, true)
  expect((await f.manager.commands(f.root, f.scope.threadId))[0].command).toBe("weather-city")
})

it("reviews a same-name installed package update privately and restores the formal version on stop", async () => {
  const f = await fixture()
  const body = (label: string) => `export function register(on) {
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"same-package",description:"Same package",immediate:true});return next(e)
    });
    on("command.run",{command:"same-package"},()=>({text:${JSON.stringify(label)}}))
  }`
  const formal = await f.stage(1, body("formal"), false)
  f.setPlugins([{ id: "formal", name: "dev-example", path: formal.sourcePath, enabled: true }])
  f.store.grant(f.root, "function:dev-example", formal.compiledDigest, true)
  const run = async () => {
    const commands = await f.manager.commands(f.root, f.scope.threadId)
    expect(commands).toHaveLength(1)
    return f.manager.runCommand(f.root, f.scope.threadId, commands[0], "", new AbortController().signal)
  }
  expect(await run()).toMatchObject({ text: "formal" })
  const updated = await f.stage(2, body("trial"), false)
  await f.manager.preflightDevelopment(f.scope, updated, () => {})
  expect(await run()).toMatchObject({ text: "formal" })
  f.manager.stageDevelopment(f.scope, updated, () => {})
  f.manager.noteDevelopmentTurnSettled(f.scope, updated.turnId, "completed")
  expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("needs-approval")
  expect(await run()).toMatchObject({ text: "formal" })
  f.manager.approveDevelopment(f.scope, f.componentId, updated.compiledDigest, updated.capabilities, () => {})
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("active"))
  expect(await run()).toMatchObject({ text: "trial" })
  expect(f.store.getGrant(f.root, "function:dev-example")?.digest).toBe(formal.compiledDigest)
  await f.manager.stopDevelopment(f.scope, f.componentId, () => {})
  expect(await run()).toMatchObject({ text: "formal" })
})

it("reports a formal command conflict and permits explicit retry after that source is removed", async () => {
  const f = await fixture()
  const body = `export function register(on) {
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"weather-city",description:"Weather city"});
      return next(e)
    })
  }`
  const path = join(f.root, "formal-weather")
  await mkdir(join(path, "hooks"), { recursive: true })
  await writeFile(join(path, "plugin.json"), JSON.stringify({ name: "formal-weather" }))
  await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(join(path, "hooks/register.ts"), body)
  const compiled = await compileFunctionPlugin(path)
  f.setPlugins([{ id: "formal-weather", name: "formal-weather", path, enabled: true }])
  f.store.grant(f.root, "function:formal-weather", compiled.digest, true)
  const input = await f.stage(1, body)
  f.manager.approveDevelopment(f.scope, f.componentId, input.compiledDigest, input.capabilities, () => {})
  f.manager.noteDevelopmentTurnSettled(f.scope, input.turnId, "completed")
  await vi.waitFor(() => {
    expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("failed")
    expect(f.manager.developmentStatus(f.scope)[0].error).toBe("MODS_COMMAND_CONFLICT")
  })
  f.setPlugins([])
  expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("failed")
  f.manager.approveDevelopment(f.scope, f.componentId, input.compiledDigest, input.capabilities, () => {})
  await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("active"))
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

async function realFileFixture() {
  const approval = vi.fn<ConstructorParameters<typeof ModsManager>[2]>(async () => true)
  const calls = vi.fn()
  const f = await fixture({
    nativeWorkspace: true,
    realCapabilities: ["fs.write", "tool.call"],
    host: {
      callDevelopmentTool: async (workspace, threadId, activation, capability, input, signal) => {
        const { target, args } = functionSdkToolInput(input)
        return native.invokeDevelopmentTool(workspace, threadId, activation, capability,
          target, args, signal, false, true, String(input.tool_use_id))
      }
    }
  })
  const native = new ModsManager(join(f.root, "native.sqlite"), () => [], approval, () => {})
  cleanups.push(async () => { native.close() })
  native.configure(f.root, true, false)
  const sandbox = new LocalSandbox({ rootDir: f.root, runId: f.scope.threadId })
  const binding: ModThreadBinding = { workspace: f.root, threadId: f.scope.threadId,
    turnId: `native:${f.scope.threadId}` }
  native.bindThread({ ...binding, invokeTool: (target, args) =>
    native.dispatch(binding, target, args, async input => {
      await authorizeCurrentModInput(target, input)
      getModCallContext()?.assertLive?.()
      calls(target, input)
      if (target !== "host:write_file") throw Error("UNEXPECTED_NATIVE_TOOL")
      return sandbox.write(String(input.file_path), String(input.content))
    }) })
  const target = join(f.root, "actual-native-output.txt")
  const source = `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"write",description:"write"});return next(e)});
    on("command.run",{command:"write"},async($,e)=>{
      if(e.args==="background")return{ text:JSON.stringify(await $.tool.call({tool:"Bash",command:"echo forbidden",run_in_background:true})) };
      await $.fs.write(${JSON.stringify(target)},"approved development bytes");return{text:"actual native write"}
    });
  }`
  const revision = await f.stage(1, source)
  const queue = new ModCommandQueue(f.store, () => {})
  cleanups.push(async () => { queue.close() })
  const activate = async () => {
    f.manager.approveDevelopment(f.scope, f.componentId, revision.compiledDigest,
      revision.capabilities, () => {})
    f.manager.noteDevelopmentTurnSettled(f.scope, revision.turnId, "completed")
    await vi.waitFor(() => expect(f.manager.developmentStatus(f.scope)[0].phase).toBe("active"))
  }
  const run = async (args = "") => {
    const descriptor = (await f.manager.commands(f.root, f.scope.threadId))[0]
    return queue.enqueue(f.root, f.scope.threadId, descriptor.command, signal =>
      withFunctionExecution({ ...binding, leased: true, immediate: false, userInitiated: true }, () =>
        f.manager.runCommand(f.root, f.scope.threadId, descriptor, args, signal))).completion
  }
  return { ...f, native, approval, calls, target, revision, activate, run }
}

it("runs approved development fs.write through real native approval and file creation without a formal grant", async () => {
  const f = await realFileFixture()
  expect(await f.manager.commands(f.root, f.scope.threadId)).toEqual([])
  expect(f.calls).not.toHaveBeenCalled()
  await f.activate()
  expect(await f.run()).toEqual({ text: "actual native write" })
  expect(await readFile(f.target, "utf8")).toBe("approved development bytes")
  expect(f.approval).toHaveBeenCalled()
  expect(f.approval.mock.calls.every(([threadId, modId, tool]) =>
    threadId === f.scope.threadId && modId.startsWith("development:") &&
    tool === "host:write_file")).toBe(true)
  expect(f.approval.mock.calls.map(([, , , input]) => input)).toEqual([
    { file_path: f.target, content: "approved development bytes" },
    { filePath: f.target, content: "approved development bytes" }
  ])
  expect(f.calls).toHaveBeenCalledExactlyOnceWith("host:write_file", {
    file_path: f.target, content: "approved development bytes"
  })
  expect(f.store.getGrant(f.root, "function:dev-example")).toBeNull()
  expect(f.native.store.getGrant(f.root, "function:dev-example")).toBeNull()
})

it("keeps denied and background development native effects from starting", async () => {
  const f = await realFileFixture()
  await f.activate()
  f.approval.mockResolvedValue(false)
  await expect(f.run()).rejects.toThrow()
  await expect(readFile(f.target)).rejects.toMatchObject({ code: "ENOENT" })
  expect(f.calls).not.toHaveBeenCalled()
  f.approval.mockResolvedValueOnce(true).mockResolvedValue(false)
  await expect(f.run()).rejects.toThrow()
  await expect(readFile(f.target)).rejects.toMatchObject({ code: "ENOENT" })
  f.approval.mockClear()
  f.calls.mockClear()
  await expect(f.run("background")).rejects.toThrow()
  expect(f.approval).not.toHaveBeenCalled()
  expect(f.calls).not.toHaveBeenCalled()
})

it.each(["stop", "source"] as const)("rechecks development %s after final native approval before actual writing", async kind => {
  const f = await realFileFixture()
  await f.activate()
  const gate = Promise.withResolvers<boolean>()
  f.approval.mockImplementation(() => gate.promise)
  const pending = f.run().catch(error => error)
  await vi.waitFor(() => expect(f.approval).toHaveBeenCalledOnce())
  let stopped: Promise<unknown> | undefined
  if (kind === "stop") stopped = f.manager.stopDevelopment(f.scope, f.componentId, () => {})
  else await writeFile(join(f.revision.sourcePath, "hooks/register.ts"), "export function register(){}")
  gate.resolve(true)
  expect(await pending).toBeInstanceOf(Error)
  await stopped
  expect(f.calls).not.toHaveBeenCalled()
  await expect(readFile(f.target)).rejects.toMatchObject({ code: "ENOENT" })
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
