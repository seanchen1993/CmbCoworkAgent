import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import {
  assertPlatformQueryMethod,
  platformQuerySignal,
  withPlatformQuery
} from "./platform-query-scope"
import { parsePlatformSurface } from "../../../shared/mods/v2/platform-surfaces"
import type { ModObject } from "../../../shared/mods/types"
import type { NativePlatformCapabilityProvider } from "./platform-capabilities-types"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close(true)))
})
const signal = () => new AbortController().signal

it("restricts inherited asynchronous work and expires the original query authority", async () => {
  let later!: Promise<unknown>
  const ready = Promise.withResolvers<void>()
  await withPlatformQuery(signal(), async () => {
    expect(platformQuerySignal()).toBeDefined()
    assertPlatformQueryMethod("fs.read")
    for (const method of [
      "fs.write",
      "model.complete",
      "process.run",
      "http.fetch",
      "store.set",
      "state.set",
      "prompt.submit",
      "clock.every",
      "platform.publish",
      "platform.cancel"
    ])
      expect(() => assertPlatformQueryMethod(method)).toThrow("MODS_QUERY_EFFECT_DENIED")
    later = ready.promise.then(() => assertPlatformQueryMethod("fs.read")).catch((error) => error)
  })
  ready.resolve()
  expect(await later).toMatchObject({ message: "MODS_QUERY_EXPIRED" })
  expect(platformQuerySignal()).toBeUndefined()
})

it("expires nested queries when their original parent returns without awaiting them", async () => {
  const release = Promise.withResolvers<void>()
  let nested!: Promise<unknown>
  await withPlatformQuery(signal(), async () => {
    nested = withPlatformQuery(signal(), async () => {
      await release.promise
      assertPlatformQueryMethod("fs.read")
    }).catch((error) => error)
  })
  release.resolve()
  expect(await nested).toMatchObject({ message: "MODS_QUERY_EXPIRED" })
})

it("aborts native work retained by a query after its callback returns", async () => {
  let retained!: AbortSignal
  await withPlatformQuery(signal(), async () => {
    retained = platformQuerySignal()!
    expect(retained.aborted).toBe(false)
  })
  expect(retained.aborted).toBe(true)
  expect(retained.reason.message).toBe("MODS_QUERY_EXPIRED")
})

async function nativeQueryFixture(readAllowed = false, deferRead = false) {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let runs = 0,
    reads = 0,
    revoked = false
  let readSignal: AbortSignal | undefined
  const guest = await FunctionGuestRuntime.create("globalThis.__cmbFunctionMod={register(on){}}")
  const plugin = {
    name: "query-caller",
    root: "/query-caller",
    tier: "user" as const,
    guest,
    capabilities: [...SESSION_CAPABILITIES]
  }
  const ref = { provider: "native.query", id: "query", version: "1.0.0" }
  const provider: NativePlatformCapabilityProvider = {
    provider: ref.provider,
    queryRead: readAllowed,
    queryActions: ["read"],
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: ref.id,
      version: ref.version,
      title: "Query",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
        {
          id: "read",
          title: "Read",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          requiredPermissions: ["platform.read"],
          cancellable: true,
          idempotency: "keyed"
        }
      ]
    },
    async read(context) {
      reads++
      readSignal = context.signal
      if (deferRead) {
        entered.resolve()
        await release.promise
      }
      return { reads }
    },
    async act(_context, _action, input) {
      runs++
      entered.resolve()
      await release.promise
      return { ...input, runs }
    }
  }
  const session = new FunctionSession([plugin], {
    workspace: "/work",
    threadId: "query",
    assertLive() {
      if (revoked) throw Error("QUERY_CALLER_REVOKED")
    },
    publish: async (value) => value,
    platformNativeProviders: [provider]
  })
  sessions.push(session)
  return {
    session,
    plugin,
    ref,
    entered,
    readSignal: () => readSignal,
    release,
    runs: () => runs,
    reads: () => reads,
    revoke: () => {
      revoked = true
    },
    act: (input: ModObject, controller = new AbortController()) =>
      withPlatformQuery(controller.signal, () =>
        session.platform.act(
          plugin,
          { ref, target: { kind: "current" }, action: "read", input, requestKey: "same-query" },
          signal()
        )
      )
  }
}

it("cancels a retained native read and rejects publication after its query expires", async () => {
  const f = await nativeQueryFixture(true, true)
  let read!: Promise<unknown>
  await withPlatformQuery(signal(), async () => {
    read = f.session.platform.call(f.plugin, "platform.read", [
      { ref: f.ref, target: { kind: "current" } }
    ], signal()).catch((error) => error)
    await f.entered.promise
  })
  const wasAborted = f.readSignal()!.aborted
  f.release.resolve()
  const result = await read
  expect(wasAborted).toBe(true)
  expect(result).toBeInstanceOf(Error)
})

it("rejects concurrent query request-key reuse for different inputs without invoking again", async () => {
  const f = await nativeQueryFixture()
  const first = f.act({ path: "first.txt" })
  await f.entered.promise
  try {
    await expect(f.act({ path: "second.txt" })).rejects.toThrow("MODS_PLATFORM_REQUEST_CONFLICT")
    expect(f.runs()).toBe(1)
  } finally {
    f.release.resolve()
  }
  expect(await first).toMatchObject({ status: "succeeded", value: { path: "first.txt", runs: 1 } })
})

it.each(["cancel", "revoke"] as const)(
  "rechecks each pending query waiter after %s",
  async (mode) => {
    const f = await nativeQueryFixture(),
      waiter = new AbortController()
    const first = f.act({ path: "same.txt" })
    await f.entered.promise
    const second = f.act({ path: "same.txt" }, waiter)
    const rejected = expect(second).rejects.toThrow(
      mode === "cancel" ? "QUERY_WAITER_CANCELLED" : "QUERY_CALLER_REVOKED"
    )
    if (mode === "cancel") waiter.abort(Error("QUERY_WAITER_CANCELLED"))
    else f.revoke()
    f.release.resolve()
    await rejected
    expect((await first).status).toBe(mode === "cancel" ? "succeeded" : "unknown")
    expect(f.runs()).toBe(1)
  }
)

it("rejects non-query native subscriptions through poll as well as direct reads", async () => {
  const f = await nativeQueryFixture()
  const subscribed = (await f.session.platform.call(
    f.plugin,
    "platform.subscribe",
    [{ ref: f.ref, target: { kind: "current" } }],
    signal()
  )) as ModObject
  const reads = f.reads()
  for (const method of ["platform.read", "platform.poll"]) {
    const args: ModObject =
      method === "platform.read"
        ? { ref: f.ref, target: { kind: "current" } }
        : { subscriptionId: subscribed.subscriptionId, afterRevision: 0 }
    await expect(
      withPlatformQuery(signal(), () => f.session.platform.call(f.plugin, method, [args], signal()))
    ).rejects.toThrow("MODS_QUERY_NATIVE_DENIED")
  }
  expect(f.reads()).toBe(reads)
})

it("requires the v2 query declaration and leaves old surfaces unchanged", () => {
  const base = {
    type: "surface",
    apiVersion: "devclaw.surface/v1",
    id: "changes",
    title: "Changes",
    placement: "sidebar",
    paneId: "changes",
    openAction: "open"
  }
  expect(parsePlatformSurface(base).interaction).toBeUndefined()
  expect(() => parsePlatformSurface({ ...base, interaction: "query" })).toThrow()
  expect(() => parsePlatformSurface({ ...base, apiVersion: "devclaw.surface/v2" })).toThrow()
  expect(
    parsePlatformSurface({ ...base, apiVersion: "devclaw.surface/v2", interaction: "query" })
      .interaction
  ).toBe("query")
})

it("enforces query restrictions through real guest capability composition and native dispatch", async () => {
  const descriptor = {
    apiVersion: "devclaw.capability/v1",
    id: "query",
    version: "1.0.0",
    title: "query",
    scope: "conversation",
    stateSchema: { type: "object" },
    actions: [
      {
        id: "run",
        title: "run",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        requiredPermissions: ["platform.act", "process.run", "fs.write"],
        cancellable: true,
        idempotency: "keyed"
      }
    ]
  }
  const guest = await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
    on.capability(${JSON.stringify(descriptor)},{act:async($,e)=>{
      if(e.input.effect) {
        try {
          if(e.input.effect==="fs") await $.fs.write("query-must-not-create.txt","forbidden");
          else await $.process.run(["node","-e","process.exit(1)"]);
          return {escaped:true};
        } catch(error) {return {error:String(error)}}
      }
      return await $.platform.act({ref:{provider:"native.query-test",id:"query",version:"1.0.0"},
        target:{kind:"current"},action:e.input.action,input:{},requestKey:"nested"});
    }})
  }}`)
  let nativeRuns = 0
  const plugin = {
    name: "query-test",
    root: "/query-test",
    tier: "user" as const,
    guest,
    capabilities: [...SESSION_CAPABILITIES]
  }
  const nativeDescriptor = {
    ...descriptor,
    apiVersion: "devclaw.capability/v1" as const,
    scope: "conversation" as const,
    actions: ["read", "write"].map((id) => ({
      ...descriptor.actions[0],
      id,
      requiredPermissions: ["platform.read"],
      idempotency: "keyed" as const
    }))
  }
  const session = new FunctionSession([plugin], {
    workspace: "/work",
    threadId: "query",
    assertLive() {
      /* This fixture keeps its caller grant active. */
    },
    publish: async (value) => value,
    platformNativeProviders: [
      {
        provider: "native.query-test",
        descriptor: nativeDescriptor,
        queryActions: ["read"],
        act: async () => ({ count: ++nativeRuns })
      }
    ]
  })
  sessions.push(session)
  const call = (input: Record<string, string | boolean>) =>
    withPlatformQuery(signal(), () =>
      session.platform.act(
        plugin,
        {
          ref: { provider: plugin.name, id: "query", version: "1.0.0" },
          target: { kind: "current" },
          action: "run",
          input,
          requestKey: "view-query"
        },
        signal()
      )
    )
  expect(await call({ action: "read" })).toMatchObject({
    status: "succeeded",
    value: { status: "succeeded", value: { count: 1 } }
  })
  // Reusing a query key must obtain fresh state, not replay a durable effect receipt.
  expect(await call({ action: "read" })).toMatchObject({ value: { value: { count: 2 } } })
  expect((await call({ action: "write" })).status).not.toBe("succeeded")
  for (const effect of ["fs", "process"])
    expect(await call({ effect })).toMatchObject({
      value: { error: expect.stringContaining("MODS_QUERY_EFFECT_DENIED") }
    })
  expect(nativeRuns).toBe(2)
})
