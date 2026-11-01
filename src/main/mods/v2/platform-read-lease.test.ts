import { afterEach, expect, it, vi } from "vitest"
import type {
  DeveloperEditorEvent,
  DeveloperEditorIntent
} from "../../../shared/mods/v2/developer-editor"
import type { FunctionPlugin } from "./dispatcher"
import type { ModObject } from "../../../shared/mods/types"
import type {
  NativePlatformCallContext,
  NativePlatformReadLease
} from "./platform-capabilities-types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { EditorNavigationBroker } from "./platform-editor-navigation"
import { withPlatformQuery } from "./platform-query-scope"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close(true)))
})
async function fixture() {
  const revoked = new Set<string>()
  const sources = new Map(
    ["ancestor", "middle"].map((name) => [
      name,
      { provider: name, digest: name + "-source", generation: "generation-1" }
    ])
  )
  let now = 0,
    scopeIdentity = "scope-1",
    accessIdentity = "access-1",
    nativeCalls = 0
  let original: NativePlatformCallContext | undefined, lease: NativePlatformReadLease | undefined
  let offer: DeveloperEditorIntent | undefined
  const events: DeveloperEditorEvent[] = []
  const broker = new EditorNavigationBroker(
    () => 7,
    (_sender, event) => {
      events.push(event)
      if (event.kind === "offer") offer = event.intent
    },
    () => now
  )
  const object = { type: "object", additionalProperties: false }
  const nativeRef = {
    provider: "native.preview-test",
    id: "source",
    version: "1.0.0"
  }
  const middleRef = { provider: "middle", id: "delegate", version: "1.0.0" }
  const middleDescriptor = {
    apiVersion: "devclaw.capability/v1",
    id: "delegate",
    version: "1.0.0",
    title: "Delegate",
    scope: "conversation",
    stateSchema: object,
    actions: [
      {
        id: "open",
        title: "Open",
        inputSchema: object,
        outputSchema: { type: "object" },
        requiredPermissions: ["platform.act", "platform.read"],
        cancellable: true,
        idempotency: "keyed"
      }
    ]
  }
  const ancestor: FunctionPlugin = {
    name: "ancestor",
    root: "/ancestor",
    tier: "user",
    capabilities: [...SESSION_CAPABILITIES],
    guest: await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:"preview",description:"Preview"});return next(e)});
      on("command.run",{command:"preview"},async($)=>{
        const result=await $.platform.act({ref:${JSON.stringify(middleRef)},target:{kind:"current"},
          action:"open",input:{},requestKey:"command-to-middle"});
        if(result.status!=="succeeded")throw Error(String(result.error));return {text:"command completed"};
      });
    }}`)
  }
  const middle: FunctionPlugin = {
    name: "middle",
    root: "/middle",
    tier: "user",
    capabilities: [...SESSION_CAPABILITIES],
    guest: await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
      on.capability(${JSON.stringify(middleDescriptor)},{act:async($)=>{
        const result=await $.platform.act({ref:${JSON.stringify(nativeRef)},target:{kind:"current"},
          action:"preview",input:{},requestKey:"middle-to-native"});
        if(result.status!=="succeeded")throw Error(String(result.error));return result.value;
      }});
    }}`)
  }
  const session = new FunctionSession([ancestor, middle], {
    workspace: "/project",
    threadId: "lease-thread",
    platformIncarnation: "lease-birth",
    assertLive(plugin) {
      if (plugin && revoked.has(plugin.name)) throw Error("FIXTURE_SOURCE_REVOKED:" + plugin.name)
    },
    platformSource(plugin) {
      const source = sources.get(plugin.name)
      if (!source) throw Error("FIXTURE_SOURCE_MISSING")
      return { ...source }
    },
    publish: async (value) => value,
    platformNativeProviders: [
      {
        provider: nativeRef.provider,
        digest: "native-preview-implementation",
        queryActions: ["preview"],
        accessScope(context) {
          context.assertCurrent()
          return scopeIdentity
        },
        actionSelector: () => ({ path: "Main.java" }),
        async prepareActionAccess(context) {
          const identity = accessIdentity
          context.assertCurrent()
          return {
            identity,
            assertCurrent() {
              context.assertCurrent()
              if (accessIdentity !== identity) throw Error("FIXTURE_NATIVE_ACCESS_CHANGED")
            }
          }
        },
        descriptor: {
          apiVersion: "devclaw.capability/v1",
          id: nativeRef.id,
          version: nativeRef.version,
          title: "Native preview",
          scope: "conversation",
          stateSchema: object,
          actions: [
            {
              id: "preview",
              title: "Preview",
              inputSchema: object,
              outputSchema: { type: "object" },
              requiredPermissions: ["platform.read"],
              cancellable: true,
              idempotency: "keyed"
            }
          ]
        },
        async act(context) {
          nativeCalls++
          original = context
          const receipt = await broker.open({
            owner: session,
            intent: {
              threadId: context.threadId,
              workspace: context.workspace,
              scopeKey: "birth",
              path: "Main.java",
              line: 1,
              column: 1,
              source: context.caller,
              externalAvailable: false
            },
            text: "class Main {}",
            fingerprint: "a".repeat(64),
            signal: context.signal,
            assertCurrent: () => context.assertCurrent(),
            verify: async () => context.assertCurrent(),
            retain: async () => {
              if (!context.captureReadLease) throw Error("READ_LEASE_UNAVAILABLE")
              const captured = context.captureReadLease()
              lease = captured
              await captured.validate()
              return {
                signal: captured.context.signal,
                assertCurrent: () => captured.context.assertCurrent(),
                verify: () => captured.validate(),
                close: () => captured.close()
              }
            }
          })
          return JSON.parse(JSON.stringify(receipt)) as ModObject
        },
        close: () => broker.retireOwner(session)
      }
    ]
  })
  sessions.push(session)
  const commandController = new AbortController()
  const start = () => session.run("preview", "", commandController.signal)
  const acknowledge = async () => {
    await vi.waitFor(() => expect(offer).toBeDefined())
    if (!offer) throw Error("NO_NATIVE_OFFER")
    const frame = await broker.accept(7, offer.id)
    await broker.acknowledge(7, {
      id: frame.id,
      fingerprint: frame.fingerprint,
      status: "preview-loaded",
      line: 1,
      column: 1
    })
    return frame
  }
  return {
    session,
    broker,
    start,
    acknowledge,
    revoked,
    sources,
    events,
    ancestor,
    nativeRef,
    offer: () => offer,
    cancel: () => commandController.abort(),
    context: () => original,
    lease: () => lease,
    calls: () => nativeCalls,
    advance: () => {
      now = 31_000
    },
    changeScope: () => {
      scopeIdentity = "scope-2"
    },
    changeAccess: () => {
      accessIdentity = "access-2"
    }
  }
}

it("retains exact read authority after a real ordinary command's Guest RPC physically ends", async () => {
  const f = await fixture(),
    pending = f.start()
  const frame = await f.acknowledge()
  await expect(pending).resolves.toMatchObject({ text: "command completed" })
  await vi.waitFor(() => expect(f.context()?.signal.aborted).toBe(true))
  const lease = f.lease()
  expect(lease).toBeDefined()
  if (!lease) throw Error("NO_READ_LEASE")
  expect(lease.context.signal.aborted).toBe(false)
  f.advance()
  await expect(lease.validate()).resolves.toBeUndefined()
  await expect(f.broker.accept(7, frame.id)).rejects.toThrow("ALREADY_ACCEPTED")
  expect(() => lease.context.publish({})).toThrow("READ_ONLY")
  expect(() =>
    lease.context.invoke(
      { provider: "middle", id: "delegate", version: "1.0.0" },
      "open",
      {},
      "forbidden"
    )
  ).toThrow("READ_ONLY")
  expect(() => lease.context.captureReadLease?.()).toThrow("READ_ONLY")
  expect(f.calls()).toBe(1)
  f.broker.close(7, frame.id)
  expect(lease.context.signal.aborted).toBe(true)
})
it.each(["ancestor", "middle"])(
  "rejects an existing lease when %s authority is revoked",
  async (name) => {
    const f = await fixture(),
      pending = f.start()
    await f.acknowledge()
    await pending
    f.revoked.add(name)
    await expect(f.lease()?.validate()).rejects.toThrow("FIXTURE_SOURCE_REVOKED")
    expect(f.lease()?.context.signal.aborted).toBe(true)
    expect(f.calls()).toBe(1)
  }
)
it.each(["source", "scope", "access"])(
  "rejects a changed %s identity without replay",
  async (kind) => {
    const f = await fixture(),
      pending = f.start()
    await f.acknowledge()
    await pending
    if (kind === "source")
      f.sources.set("ancestor", {
        provider: "ancestor",
        digest: "replacement-source",
        generation: "generation-2"
      })
    else if (kind === "scope") f.changeScope()
    else f.changeAccess()
    await expect(f.lease()?.validate()).rejects.toThrow()
    expect(f.calls()).toBe(1)
  }
)
it("aborts a retained lease on actual runtime close", async () => {
  const f = await fixture(),
    pending = f.start()
  await f.acknowledge()
  await pending
  await f.session.close(true)
  expect(f.lease()?.context.signal.aborted).toBe(true)
  expect(f.events.some((event) => event.kind === "retire")).toBe(true)
})
it("keeps pre-ACK cancellation on the original operation lifetime without retaining", async () => {
  const f = await fixture(),
    pending = f.start()
  const outcome = pending.catch((error) => error)
  await vi.waitFor(() => expect(f.offer()).toBeDefined())
  f.cancel()
  await outcome
  await vi.waitFor(() => expect(f.context()?.signal.aborted).toBe(true))
  expect(f.lease()).toBeUndefined()
  expect(f.events.some((event) => event.kind === "retire")).toBe(true)
})
it("does not issue a lease for an expired pending handshake", async () => {
  const f = await fixture(),
    pending = f.start()
  const outcome = pending.catch((error) => error)
  await vi.waitFor(() => expect(f.offer()).toBeDefined())
  const offer = f.offer()
  if (!offer) throw Error("NO_OFFER")
  f.advance()
  await expect(f.broker.accept(7, offer.id)).rejects.toThrow("EXPIRED")
  await outcome
  expect(f.lease()).toBeUndefined()
})
it("captures and rejects the original query restriction after ACK enters a different ALS scope", async () => {
  const f = await fixture(),
    controller = new AbortController()
  const pending = withPlatformQuery(controller.signal, () =>
    f.session.platform.act(
      f.ancestor,
      {
        ref: f.nativeRef,
        target: { kind: "current" },
        action: "preview",
        input: {},
        requestKey: "query-native-preview"
      },
      controller.signal
    )
  )
  const outcome = pending.catch((error) => error)
  await vi.waitFor(() => expect(f.offer()).toBeDefined())
  await expect(f.acknowledge()).rejects.toThrow("READ_LEASE_UNAVAILABLE")
  await outcome
  expect(f.lease()).toBeUndefined()
})
it("rechecks all fresh ancestor native fences after a descendant validation await", async () => {
  let parentScope = "parent-scope-1",
    captured: NativePlatformReadLease | undefined,
    parentCalls = 0
  let paused = false,
    entered = false,
    release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  const parentRef = {
    provider: "native.parent-test",
    id: "parent",
    version: "1.0.0"
  }
  const leafRef = {
    provider: "native.leaf-test",
    id: "leaf",
    version: "1.0.0"
  }
  const caller: FunctionPlugin = {
    name: "native-chain-caller",
    root: "/caller",
    tier: "user",
    capabilities: [...SESSION_CAPABILITIES],
    guest: await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:"capture",description:"capture"});return next(e)});
      on("command.run",{command:"capture"},async($)=>{
        const result=await $.platform.act({ref:${JSON.stringify(parentRef)},target:{kind:"current"},
          action:"capture",input:{},requestKey:"parent-capture"});
        if(result.status!=="succeeded")throw Error(String(result.error));return {text:"captured"};
      });
    }}`)
  }
  const descriptor = (id: string, permissions: string[]) => ({
    apiVersion: "devclaw.capability/v1" as const,
    id,
    version: "1.0.0",
    title: id,
    scope: "conversation" as const,
    stateSchema: { type: "object" },
    actions: [
      {
        id: "capture",
        title: "Capture",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        requiredPermissions: permissions,
        cancellable: true,
        idempotency: "keyed" as const
      }
    ]
  })
  const session = new FunctionSession([caller], {
    workspace: "/project",
    threadId: "native-chain",
    assertLive() {
      /* This controlled fixture mutates native scope identities instead of source grants. */
    },
    publish: async (value) => value,
    platformNativeProviders: [
      {
        provider: parentRef.provider,
        descriptor: descriptor(parentRef.id, ["platform.act", "platform.read"]),
        accessScope(context) {
          context.assertCurrent()
          return parentScope
        },
        async act(context) {
          const result = await context.invoke(
            leafRef,
            "capture",
            {},
            "leaf-capture-" + ++parentCalls
          )
          if (result.status !== "succeeded") throw Error(String(result.error))
          return { captured: true }
        }
      },
      {
        provider: leafRef.provider,
        descriptor: descriptor(leafRef.id, ["platform.read"]),
        async prepareActionAccess(context) {
          if (paused) {
            entered = true
            await gate
          }
          context.assertCurrent()
          return {
            identity: "leaf-file-1",
            assertCurrent: () => context.assertCurrent()
          }
        },
        async act(context) {
          if (!context.captureReadLease) throw Error("READ_LEASE_UNAVAILABLE")
          captured = context.captureReadLease()
          return { captured: true }
        }
      }
    ]
  })
  sessions.push(session)
  const restrictedLeaf = await session.platform.act(
    caller,
    {
      ref: leafRef,
      target: { kind: "current" },
      action: "capture",
      input: {},
      requestKey: "restricted-native-leaf"
    },
    new AbortController().signal,
    undefined,
    "open",
    {}
  )
  expect(restrictedLeaf.status).toBe("unknown")
  expect(restrictedLeaf.error).toContain("READ_LEASE_UNAVAILABLE")
  const restricted = await session.platform.act(
    caller,
    {
      ref: parentRef,
      target: { kind: "current" },
      action: "capture",
      input: {},
      requestKey: "restricted-native-parent"
    },
    new AbortController().signal,
    undefined,
    "open",
    {}
  )
  expect(restricted.status).toBe("unknown")
  // Existing open-mode delegates already forbid nested platform.act; do not bypass that fence.
  expect(restricted.error).toContain("CLEANUP_ONLY")
  expect(captured).toBeUndefined()
  await expect(session.run("capture", "")).resolves.toMatchObject({
    text: "captured"
  })
  if (!captured) throw Error("NO_LEASE")
  const lease = captured
  paused = true
  const validation = lease.validate()
  const rejection = expect(validation).rejects.toThrow("ACCESS_SCOPE_CHANGED")
  await vi.waitFor(() => expect(entered).toBe(true))
  parentScope = "parent-scope-2"
  release()
  await rejection
  expect(lease.context.signal.aborted).toBe(true)
})
