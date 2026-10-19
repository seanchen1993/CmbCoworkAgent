import { afterEach, expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { PlatformCapabilityHub } from "./platform-capabilities-hub"
import type { FunctionPlugin } from "./dispatcher"
import { platformDescriptor } from "./platform-capabilities-validation"
import { FUNCTION_HOST_REVISION } from "../../../shared/mods/v2/contracts"
import { analyzeFunctionSdk } from "../devtools/sdk-usage"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close(true)))
})
const ref = { provider: "provider", id: "counter", version: "1.0.0" }
const query = { ref, target: { kind: "current" } }
const object = { type: "object", additionalProperties: true }
const descriptor = {
  apiVersion: "devclaw.capability/v1",
  id: "counter",
  version: "1.0.0",
  title: "Counter",
  scope: "conversation",
  stateSchema: object,
  actions: [
    {
      id: "increment",
      title: "Increment",
      inputSchema: object,
      outputSchema: object,
      requiredPermissions: ["platform.publish"],
      cancellable: true,
      idempotency: "keyed"
    }
  ]
}
function hub() {
  const data = new Map<string, ModJson>()
  return new PlatformCapabilityHub({
    get: (ns, key) => data.get(JSON.stringify([ns, key])),
    set: (ns, key, value) => {
      data.set(JSON.stringify([ns, key]), structuredClone(value))
    },
    keys: (ns) =>
      [...data.keys()]
        .map((key) => JSON.parse(key) as string[])
        .filter((parts) => parts[0] === ns)
        .map((parts) => parts[1])
  })
}
async function fixture(
  body = "",
  override: Partial<FunctionSessionHost> = {},
  permissions?: string[],
  declaration = descriptor,
  callerSource = ""
) {
  const guest = await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
    let count=0;
    on.capability(${JSON.stringify(declaration)},{act:async($,e,next)=>{
      ${body || `count++;await $.platform.publish({id:"counter",version:"1.0.0",target:{kind:"current"},value:{count}});return {count}`}
    }});
    on("session.start",()=>{throw Error("must not start")});
  }}`)
  const provider: FunctionPlugin = {
    name: "provider",
    root: "/provider",
    tier: "user",
    guest,
    capabilities: [...SESSION_CAPABILITIES]
  }
  const caller: FunctionPlugin = {
    name: "caller",
    root: "/caller",
    tier: "user",
    guest: await FunctionGuestRuntime.create(
      `globalThis.__cmbFunctionMod={register(on){${callerSource}}}`
    ),
    capabilities: permissions ?? [...SESSION_CAPABILITIES]
  }
  const session = new FunctionSession([provider, caller], {
    workspace: "/project",
    threadId: "t",
    platformIncarnation: "incarnation",
    assertLive() {
      /* No external grant mutation in this fixture. */
    },
    publish: async (value) => value,
    ...override
  })
  sessions.push(session)
  const signal = new AbortController().signal
  const call = (method: string, input?: ModJson) =>
    session.platform.call(caller, method, input === undefined ? [] : [input], signal)
  const act = (requestKey: string, input: ModObject = {}, action = "increment") =>
    session.platform.act(caller, { ...query, action, input, requestKey }, signal)
  return { session, provider, caller, signal, call, act }
}

it("discovers validated metadata without startup/matcher/action and keeps real versioned state", async () => {
  const f = await fixture()
  expect(f.session.hasStarted).toBe(false)
  expect(((await f.call("platform.list")) as ModObject).capabilities).toHaveLength(2)
  expect(await f.call("platform.read", query)).toMatchObject({ status: "unknown", revision: 0 })
  const first = await f.act("one")
  expect(first.error).toBeUndefined()
  expect(first).toMatchObject({ status: "succeeded", value: { count: 1 } })
  expect(await f.act("one")).toEqual(first)
  expect(await f.call("platform.read", query)).toMatchObject({
    status: "ready",
    revision: 1,
    value: { count: 1 }
  })
  expect(await f.act("two")).toMatchObject({ value: { count: 2 } })
  expect(f.session.hasStarted).toBe(false)
  await expect(f.act("one", { changed: true })).rejects.toThrow("MODS_PLATFORM_REQUEST_CONFLICT")
  await expect(
    f.call("platform.read", { ...query, target: { kind: "current", threadId: "other" } })
  ).rejects.toThrow()
  await expect(
    f.call("platform.publish", {
      id: "counter",
      version: "1.0.0",
      target: { kind: "current" },
      value: {}
    })
  ).rejects.toThrow("MODS_PLATFORM_CAPABILITY_UNKNOWN")
})

it("requires the original consumer to possess provider declared permissions", async () => {
  const f = await fixture("", {}, ["platform.act", "platform.read"])
  await expect(f.act("denied")).rejects.toThrow("MODS_CAPABILITY_DENIED")
  expect(await f.call("platform.read", query)).toMatchObject({ status: "unknown" })
})

it("rechecks original caller grants on nested effects and never replays an unknown action", async () => {
  let checks = 0
  const f = await fixture(
    "await $.platform.publish({id:'counter',version:'1.0.0',target:{kind:'current'},value:{count:1}});return {count:1}",
    {
      assertCapability: (plugin, method) => {
        if (plugin.name === "caller" && method === "platform.publish") {
          if (++checks >= 3) throw Error("revoked")
        }
      }
    }
  )
  expect(await f.act("unknown")).toMatchObject({ status: "unknown" })
  checks = 0
  expect(await f.act("unknown")).toMatchObject({ status: "unknown" })
  expect(await f.call("platform.read", query)).toMatchObject({ status: "unknown", revision: 0 })
})

it("bounds/deduplicates subscriptions, separates owners and requires resync after overflow", async () => {
  const f = await fixture()
  const sub = (await f.call("platform.subscribe", query)) as ModObject
  await f.act("a")
  const packet = (await f.call("platform.poll", {
    subscriptionId: sub.subscriptionId!,
    afterRevision: 0
  })) as ModObject
  expect(packet).toMatchObject({
    revision: 1,
    resync: false,
    events: [{ revision: 1, value: { count: 1 } }]
  })
  await expect(
    f.session.platform.call(
      f.provider,
      "platform.poll",
      [{ subscriptionId: sub.subscriptionId!, afterRevision: 0 }],
      f.signal
    )
  ).rejects.toThrow("MODS_PLATFORM_SUBSCRIPTION_EXPIRED")
  for (let i = 0; i < 35; i++) await f.act("burst" + i)
  expect(
    await f.call("platform.poll", { subscriptionId: sub.subscriptionId!, afterRevision: 0 })
  ).toMatchObject({ resync: true, events: [] })
  for (let i = 0; i < 15; i++) await f.call("platform.subscribe", query)
  await expect(f.call("platform.subscribe", query)).rejects.toThrow(
    "MODS_PLATFORM_SUBSCRIPTION_LIMIT"
  )
  await f.session.close(true)
  expect(f.session.platform.diagnostics()).toMatchObject({ subscriptions: 0, inFlight: 0 })
})

it("persists success/unknown fences across VM recreation and marks inactive state unknown", async () => {
  const broker = hub()
  const a = await fixture("", {
    platformHub: broker,
    platformSource: (plugin) => ({ provider: plugin.name, digest: "approved", generation: "old" })
  })
  await a.act("done")
  await a.session.close(true)
  const b = await fixture("throw Error('must not replay')", {
    platformHub: broker,
    platformSource: (plugin) => ({ provider: plugin.name, digest: "approved", generation: "new" })
  })
  expect(await b.call("platform.read", query)).toMatchObject({
    status: "unknown",
    revision: 1,
    reason: "source-inactive"
  })
  expect(await b.act("done")).toMatchObject({ status: "succeeded", value: { count: 1 } })
  expect(await b.act("failed")).toMatchObject({ status: "unknown" })
  await b.session.close(true)
  const c = await fixture("", {
    platformHub: broker,
    platformSource: (plugin) => ({ provider: plugin.name, digest: "approved", generation: "third" })
  })
  expect(await c.act("failed")).toMatchObject({ status: "unknown" })
})

it("coalesces identical in-flight intent and cancellation keeps an unknown non-replayable result", async () => {
  const f = await fixture("await new Promise(()=>{});return {}")
  const first = f.act("hang"),
    second = f.act("hang")
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(f.session.platform.diagnostics().inFlight).toBe(1)
  expect(await f.call("platform.cancel", { ...query, requestKey: "hang" })).toMatchObject({
    status: "running"
  })
  expect(await first).toMatchObject({ status: "unknown" })
  expect(await second).toMatchObject({ status: "unknown" })
  expect(await f.act("hang")).toMatchObject({ status: "unknown" })
})

it("cancelling an ordinary action drains its derived background timers before returning unknown", async () => {
  const declaration = {
    ...descriptor,
    actions: [
      {
        ...descriptor.actions[0],
        requiredPermissions: ["clock.every", "platform.publish", "platform.subscribe"]
      }
    ]
  }
  const f = await fixture(
    `await $.platform.subscribe(${JSON.stringify(query)});$.clock.every(5,async()=>{
    await $.platform.publish({id:'counter',version:'1.0.0',target:{kind:'current'},value:{count:++count}})
  });await new Promise(()=>{});return {}`,
    { debugLog: () => undefined },
    undefined,
    declaration
  )
  const running = f.act("cancel-owned-background")
  for (let i = 0; f.session.ownedResourceCount === 0 && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(f.session.ownedResourceCount).toBe(1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await f.call("platform.cancel", { ...query, requestKey: "cancel-owned-background" })
  expect(await running).toMatchObject({ status: "unknown" })
  expect(f.session.ownedResourceCount).toBe(0)
  expect(f.session.platform.diagnostics().subscriptions).toBe(0)
  const state = await f.call("platform.read", query)
  await new Promise((resolve) => setTimeout(resolve, 35))
  expect(await f.call("platform.read", query)).toEqual(state)
  expect(await f.act("cancel-owned-background")).toMatchObject({ status: "unknown" })
})

it("a successful provider action retains its subscription for later actions by the same provider", async () => {
  const declaration = {
    ...descriptor,
    actions: [
      {
        ...descriptor.actions[0],
        requiredPermissions: ["platform.subscribe", "platform.poll", "platform.unsubscribe"]
      }
    ]
  }
  const f = await fixture(
    `if(e.input.poll){
    const packet=await $.platform.poll({subscriptionId:globalThis.sub,afterRevision:0});
    await $.platform.unsubscribe({subscriptionId:globalThis.sub});return {revision:packet.revision}
  }globalThis.sub=(await $.platform.subscribe(${JSON.stringify(query)})).subscriptionId;return {}`,
    {},
    undefined,
    declaration
  )
  expect(await f.act("subscribe-success")).toMatchObject({ status: "succeeded" })
  expect(f.session.platform.diagnostics().subscriptions).toBe(1)
  expect(await f.act("later-poll", { poll: true })).toMatchObject({
    status: "succeeded",
    value: { revision: 0 }
  })
  expect(f.session.platform.diagnostics().subscriptions).toBe(0)
})

it("accepts only native file completion facts for its bound incarnation", async () => {
  const f = await fixture()
  const fileQuery = {
    ref: { provider: "native.file-edits", id: "changes", version: "1.0.0" },
    target: { kind: "current" }
  }
  const facts = {
    workspace: "/project",
    threadId: "t",
    incarnation: "wrong",
    path: "/project/a",
    operation: "write_file" as const,
    requestId: "actual-1"
  }
  f.session.platform.publishHostFileEdit(facts)
  expect(await f.call("platform.read", fileQuery)).toMatchObject({ status: "unknown" })
  f.session.platform.publishHostFileEdit({ ...facts, incarnation: "incarnation" })
  expect(await f.call("platform.read", fileQuery)).toMatchObject({
    status: "ready",
    revision: 1,
    value: { path: "/project/a", requestId: "actual-1" }
  })
  expect(f.session.hasStarted).toBe(false)
})

it("strictly validates semantic version, permission declarations and object schema", () => {
  expect(() => platformDescriptor({ ...descriptor, version: "latest" })).toThrow(
    "MODS_PLATFORM_VERSION"
  )
  expect(() => platformDescriptor({ ...descriptor, stateSchema: { type: "string" } })).toThrow()
  expect(() =>
    platformDescriptor({
      ...descriptor,
      actions: [{ ...descriptor.actions[0], requiredPermissions: ["arbitrary.ipc"] }]
    })
  ).toThrow()
  expect(FUNCTION_HOST_REVISION).toBe("claude-295-tools-v91")
})

it("native cleanup frame denies new effects while still awaiting real timer cleanup ACK", async () => {
  const declaration = {
    ...descriptor,
    actions: [
      { ...descriptor.actions[0], requiredPermissions: ["clock.every", "platform.publish"] }
    ]
  }
  const f = await fixture(
    `if(e.input.close){await globalThis.watcher.cancel();return {closed:true}}
    globalThis.watcher=$.clock.every(100,async()=>{});return {opened:true}`,
    {},
    undefined,
    declaration
  )
  expect(await f.act("open")).toMatchObject({ status: "succeeded" })
  expect(f.session.ownedResourceCount).toBe(1)
  expect(
    await f.session.platform.nativeCleanupAct(ref, "increment", { close: true }, "close", f.signal)
  ).toMatchObject({ status: "succeeded", value: { closed: true } })
  expect(f.session.ownedResourceCount).toBe(0)
  expect(
    await f.session.platform.nativeCleanupAct(ref, "increment", {}, "malicious-close", f.signal)
  ).toMatchObject({
    status: "unknown",
    error: expect.stringContaining("MODS_PLATFORM_CLEANUP_ONLY")
  })
  expect(f.session.ownedResourceCount).toBe(0)
})

it("background callbacks retain original consumer grants and close instead of retrying revoked work", async () => {
  let revoked = false
  const declaration = {
    ...descriptor,
    actions: [
      { ...descriptor.actions[0], requiredPermissions: ["clock.every", "platform.publish"] }
    ]
  }
  const f = await fixture(
    `$.clock.every(10,async()=>{
    await $.platform.publish({id:'counter',version:'1.0.0',target:{kind:'current'},value:{count:++count}})
  });return {started:true}`,
    {
      assertCapability: (plugin, method) => {
        if (revoked && plugin.name === "caller" && method === "platform.publish")
          throw Error("caller revoked")
      }
    },
    undefined,
    declaration
  )
  expect(await f.act("background")).toMatchObject({ status: "succeeded" })
  await new Promise((resolve) => setTimeout(resolve, 35))
  expect(await f.call("platform.read", query)).toMatchObject({ status: "ready" })
  revoked = true
  await new Promise((resolve) => setTimeout(resolve, 35))
  expect(f.session.ownedResourceCount).toBe(0)
})

it("awaits the actual pending timer SDK tail and prevents publication after native close", async () => {
  let entered = false,
    release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const declaration = {
    ...descriptor,
    actions: [
      { ...descriptor.actions[0], requiredPermissions: ["clock.every", "platform.publish"] }
    ]
  }
  const f = await fixture(
    `if(e.input.close){await globalThis.watcher.cancel();return {closed:true}}
    globalThis.watcher=$.clock.every(5,async()=>{
      await $.platform.publish({id:'counter',version:'1.0.0',target:{kind:'current'},value:{pending:true}})
    });return {opened:true}`,
    {
      publish: async (value) => {
        if (value && typeof value === "object" && !Array.isArray(value) && value.pending) {
          entered = true
          await gate
        }
        return value
      }
    },
    undefined,
    declaration
  )
  await f.act("open-pending")
  for (let i = 0; !entered && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(entered).toBe(true)
  let closed = false
  const closing = f.session.platform
    .nativeCleanupAct(ref, "increment", { close: true }, "close-pending", f.signal)
    .then((value) => {
      closed = true
      return value
    })
  await new Promise((resolve) => setTimeout(resolve, 15))
  expect(closed).toBe(false)
  expect(f.session.ownedResourceCount).toBe(1)
  release()
  expect(await closing).toMatchObject({ status: "succeeded" })
  expect(f.session.ownedResourceCount).toBe(0)
  expect(await f.call("platform.read", query)).toMatchObject({ status: "unknown", revision: 0 })
})

it("keeps conversation targets isolated and workspace packets source-bound across sessions", async () => {
  const broker = hub()
  const a = await fixture("", { platformHub: broker, threadId: "a" })
  const b = await fixture("", { platformHub: broker, threadId: "b" })
  await a.act("conversation")
  expect(await b.call("platform.read", query)).toMatchObject({ status: "unknown", revision: 0 })
  const declaration = { ...descriptor, scope: "workspace" }
  const c = await fixture("", { platformHub: broker, threadId: "c" }, undefined, declaration)
  const d = await fixture("", { platformHub: broker, threadId: "d" }, undefined, declaration)
  const sub = (await d.call("platform.subscribe", query)) as ModObject
  await c.act("workspace")
  expect(await d.call("platform.read", query)).toMatchObject({
    status: "ready",
    revision: 1,
    value: { count: 1 }
  })
  await c.session.platform.call(
    c.provider,
    "platform.publish",
    [
      {
        id: "counter",
        version: "1.0.0",
        target: { kind: "current" },
        value: { count: 1 },
        expectedRevision: 1
      }
    ],
    c.signal
  )
  expect(await d.call("platform.read", query)).toMatchObject({ revision: 1 })
  await expect(
    c.session.platform.call(
      c.provider,
      "platform.publish",
      [
        {
          id: "counter",
          version: "1.0.0",
          target: { kind: "current" },
          value: { count: 2 },
          expectedRevision: 0
        }
      ],
      c.signal
    )
  ).rejects.toThrow("MODS_PLATFORM_STATE_CHANGED")
  await c.session.close(true)
  expect(
    await d.call("platform.poll", { subscriptionId: sub.subscriptionId!, afterRevision: 0 })
  ).toMatchObject({ resync: true, events: [] })
  expect(await d.call("platform.read", query)).toMatchObject({
    status: "unknown",
    reason: "source-inactive"
  })
})

it("rejects oversized UTF8 state and invalid exact action input/output schemas", async () => {
  const declaration = {
    ...descriptor,
    actions: [
      {
        ...descriptor.actions[0],
        inputSchema: {
          type: "object",
          properties: { amount: { type: "integer" } },
          required: ["amount"],
          additionalProperties: false
        },
        outputSchema: {
          type: "object",
          properties: { actual: { type: "integer" } },
          required: ["actual"],
          additionalProperties: false
        }
      }
    ]
  }
  const f = await fixture("return {wrong:true}", {}, undefined, declaration)
  await expect(f.act("invalid-input", { amount: "1" })).rejects.toThrow()
  expect(await f.act("invalid-output", { amount: 1 })).toMatchObject({ status: "unknown" })
  await expect(
    f.session.platform.call(
      f.provider,
      "platform.publish",
      [
        {
          id: "counter",
          version: "1.0.0",
          target: { kind: "current" },
          value: { text: "界".repeat(5500) }
        }
      ],
      f.signal
    )
  ).rejects.toThrow("MODS_PLATFORM_STATE_LIMIT")
})

it("native view lifecycle bypasses a full durable ledger while ordinary effects stay fail closed", async () => {
  const broker = hub()
  const f = await fixture("return {count:++count}", { platformHub: broker })
  for (let i = 0; i < 300; i++) {
    const owner = {}
    expect(
      await f.session.platform.nativeUiOpenAct(ref, "increment", {}, `view-${i}`, f.signal, owner)
    ).toMatchObject({ status: "succeeded" })
    const closed = await f.session.platform.nativeCleanupAct(
      ref,
      "increment",
      {},
      `close-${i}`,
      f.signal,
      owner
    )
    expect(closed.error).toBeUndefined()
    expect(closed).toMatchObject({ status: "succeeded" })
    f.session.platform.closeNativeOwner(owner)
  }
  const namespace = broker.namespace("/project", "t", "incarnation")
  const owner = {}
  for (let i = 0; i < 256; i++) broker.save(namespace, `full-${i}`, { retained: true })
  await expect(f.act("new-external-intent")).rejects.toThrow("MODS_PLATFORM_RECORD_LIMIT")
  expect(
    await f.session.platform.nativeUiOpenAct(ref, "increment", {}, "full-open", f.signal, owner)
  ).toMatchObject({ status: "succeeded" })
  expect(
    await f.session.platform.nativeCleanupAct(ref, "increment", {}, "full-close", f.signal, owner)
  ).toMatchObject({ status: "succeeded" })
  f.session.platform.closeNativeOwner(owner)
})

it("outer cancellation also closes subscriptions retained by its successful inner action", async () => {
  const declaration = {
    ...descriptor,
    actions: [
      { ...descriptor.actions[0], requiredPermissions: ["platform.act", "platform.subscribe"] }
    ]
  }
  const f = await fixture(
    `if(e.input.inner){await $.platform.subscribe(${JSON.stringify(query)});return {}}
    const result=await $.platform.act({...${JSON.stringify(query)},action:'increment',input:{inner:true},requestKey:'inner'});
    if(result.status!=='succeeded')throw Error(result.error);await new Promise(()=>{});return {}`,
    {
      debugLog: () => undefined
    },
    undefined,
    declaration
  )
  const running = f.act("outer")
  for (let i = 0; f.session.platform.diagnostics().subscriptions === 0 && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(f.session.platform.diagnostics().subscriptions).toBe(1)
  await f.call("platform.cancel", { ...query, requestKey: "outer" })
  expect(await running).toMatchObject({ status: "unknown" })
  expect(f.session.platform.diagnostics().subscriptions).toBe(0)
})

it("view initialization cannot issue a file effect or defer one to its timer", async () => {
  let writes = 0
  const declaration = {
    ...descriptor,
    actions: [
      {
        ...descriptor.actions[0],
        requiredPermissions: ["fs.write", "clock.after", "platform.publish"]
      }
    ]
  }
  const f = await fixture(
    `if(e.input.direct){await $.fs.write('forbidden','x');return {}}
    $.clock.after(0,async()=>{await $.fs.write('deferred-forbidden','x')});return {}`,
    {
      callTool: async () => {
        writes++
        return {}
      },
      debugLog: () => undefined
    },
    undefined,
    declaration
  )
  const owner = {}
  expect(
    await f.session.platform.nativeUiOpenAct(
      ref,
      "increment",
      { direct: true },
      "direct",
      f.signal,
      owner
    )
  ).toMatchObject({
    status: "unknown",
    error: expect.stringContaining("MODS_PLATFORM_CLEANUP_ONLY")
  })
  expect(
    await f.session.platform.nativeUiOpenAct(ref, "increment", {}, "deferred", f.signal, owner)
  ).toMatchObject({ status: "succeeded" })
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(writes).toBe(0)
  expect(f.session.ownedResourceCount).toBe(0)
})

it("secondary ui.open middleware retains the native view-only frame for real guest effects", async () => {
  let writes = 0,
    approvals = 0
  const declaration = {
    ...descriptor,
    actions: [
      {
        ...descriptor.actions[0],
        requiredPermissions: ["ui.open", "fs.write", "process.run", "process.spawn"]
      }
    ]
  }
  const f = await fixture(
    `await $.ui.open({id:'secondary'});return {}`,
    {
      callTool: async () => {
        writes++
        return {}
      },
      authorizeProcess: async () => {
        approvals++
      }
    },
    undefined,
    declaration,
    `const seen=[];
    on('ui.open',async($,e,next)=>{
      try{await $.fs.write('forbidden','x');seen.push('write escaped')}catch(error){seen.push(String(error))}
      try{await $.process.run(['forbidden']);seen.push('process escaped')}catch(error){seen.push(String(error))}
      try{await $.process.spawn({argv:['forbidden']}).next();seen.push('stream escaped')}catch(error){seen.push(String(error))}
      return next(e)
    });on('inspect',()=>({seen}));`
  )
  const frames: boolean[] = [],
    invoke = f.caller.guest.invoke.bind(f.caller.guest)
  f.caller.guest.invoke = (id, event, host, options) => {
    if (options.event === "ui.open") frames.push(options.platformUiOpen === true)
    return invoke(id, event, host, options)
  }
  expect(
    await f.session.platform.nativeUiOpenAct(ref, "increment", {}, "secondary", f.signal, {})
  ).toMatchObject({ status: "succeeded" })
  const observed = await f.caller.guest.invoke("1", {}, async () => ({}), {
    event: "inspect",
    origin: { plugin: "engine", tier: "core" },
    capabilities: [],
    plugin: { name: f.caller.name, root: f.caller.root }
  })
  expect(frames).toEqual([true])
  expect((observed.value as ModObject).seen).toEqual(
    Array(3).fill(expect.stringContaining("MODS_PLATFORM_CLEANUP_ONLY"))
  )
  expect(writes).toBe(0)
  expect(approvals).toBe(0)
})

it("native view-only frame rejects a module-channel pull of an existing guest stream", async () => {
  const guest = await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
    let stream;
    on('setup',async($)=>{stream=$.process.spawn({argv:['native-fixture']});await stream.next();return {}});
    on('open',async()=>{try{await stream.next();return {escaped:true}}catch(error){return {error:String(error)}}});
  }}`)
  let pulls = 0
  guest.bindModuleHost(async (method) => {
    if (method === "resource.pull") {
      pulls++
      return { value: { done: false, value: { stream: "stdout", text: "fixture" } } }
    }
    return {}
  })
  try {
    const options = {
      event: "setup",
      origin: { plugin: "engine", tier: "core" } as const,
      capabilities: ["process.spawn"],
      plugin: { name: "native-fixture", root: "/fixture" }
    }
    await guest.invoke(
      "0",
      {},
      async (method) => {
        if (method !== "process.spawn") throw Error("unexpected SDK")
        return { value: { id: "existing-native-resource" } }
      },
      options
    )
    expect(pulls).toBe(1)
    const result = await guest.invoke("1", {}, async () => ({}), {
      ...options,
      event: "open",
      platformUiOpen: true
    })
    expect(result.value).toMatchObject({
      error: expect.stringContaining("MODS_PLATFORM_CLEANUP_ONLY")
    })
    expect(pulls).toBe(1)
  } finally {
    guest.dispose()
  }
})

it("native pane owner retires forgotten subscriptions/timers and still drains after revocation", async () => {
  let revoked = false
  const declaration = {
    ...descriptor,
    presentation: {
      type: "surface",
      apiVersion: "devclaw.surface/v1",
      id: "page",
      title: "Page",
      placement: "page",
      paneId: "page",
      openAction: "open",
      closeAction: "close"
    },
    actions: [
      {
        ...descriptor.actions[0],
        id: "open",
        requiredPermissions: ["platform.subscribe", "clock.every"]
      },
      { ...descriptor.actions[0], id: "close", requiredPermissions: [] }
    ]
  }
  const f = await fixture(
    `if(e.action==='close')return {};
    await $.platform.subscribe(${JSON.stringify(query)});$.clock.every(100,async()=>{});return {}`,
    {
      assertLive: (plugin) => {
        if (revoked && plugin?.name === "provider") throw Error("revoked")
      },
      debugLog: () => undefined
    },
    undefined,
    declaration
  )
  const list = f.session.platformSurfaces.list(),
    initial = { key: list.entries[0].key, revision: list.revision }
  const first = await f.session.platformSurfaces.open(initial, f.signal, "first")
  await expect(f.session.platformSurfaces.open(initial, f.signal, "duplicate")).rejects.toThrow(
    "MODS_PLATFORM_SURFACE_ALREADY_OPEN"
  )
  expect(f.session.platform.diagnostics().subscriptions).toBe(1)
  expect(f.session.ownedResourceCount).toBe(1)
  await f.session.platformSurfaces.closePage({ ...initial, openId: first.openId })
  expect(f.session.platform.diagnostics().subscriptions).toBe(0)
  expect(f.session.ownedResourceCount).toBe(0)
  const second = await f.session.platformSurfaces.open(initial, f.signal, "second")
  revoked = true
  await expect(
    f.session.platformSurfaces.closePage({ ...initial, openId: second.openId })
  ).rejects.toThrow()
  expect(f.session.platform.diagnostics().subscriptions).toBe(0)
  expect(f.session.ownedResourceCount).toBe(0)
})

it("statically reviews capability permissions and private action SDK without register execution", async () => {
  const result = await analyzeFunctionSdk({
    digest: "d",
    modelProtocol: "result-v1",
    authoringEntries: ["index.ts"],
    authoringSources: {
      "index.ts": `export function register(on){
      on.capability(${JSON.stringify(descriptor)},{async act($){await $.platform.publish({});return {}}});
      on('prompt.compose',($,e,next)=>next(e));
    }`
    }
  })
  expect(result.strictCompatible).toBe(true)
  expect(result.registrationEvents).toEqual(["prompt.compose"])
  expect(result.registrationEventsVerified).toBe(true)
  expect(result.usages.map((row) => row.method)).toEqual(
    expect.arrayContaining(["platform.act", "platform.publish"])
  )
})
