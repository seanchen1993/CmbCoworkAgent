import { afterEach, expect, it, vi } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { FunctionPlugin } from "./dispatcher"
import type { ModJson } from "../../../shared/mods/types"
import type {
  NativePlatformCallContext,
  NativePlatformCapabilityProvider
} from "./platform-capabilities-types"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close(true)))
})
const ref = { provider: "native.testing", id: "tasks", version: "1.0.0" }
const query = { ref, target: { kind: "current" } }
const object = { type: "object", additionalProperties: true }
function provider(
  override: Partial<NativePlatformCapabilityProvider> = {}
): NativePlatformCapabilityProvider {
  return {
    provider: ref.provider,
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: ref.id,
      version: ref.version,
      title: "Native tasks",
      scope: "conversation",
      stateSchema: object,
      actions: [
        {
          id: "complete",
          title: "Complete",
          inputSchema: object,
          outputSchema: object,
          requiredPermissions: ["platform.publish"],
          cancellable: true,
          idempotency: "keyed"
        }
      ]
    },
    read: () => ({ count: 0 }),
    act: async () => ({ completed: true }),
    ...override
  }
}
async function fixture(
  native: NativePlatformCapabilityProvider[],
  guard = () => {},
  source = "globalThis.__cmbFunctionMod={register(){}}",
  assertContent?: () => void
) {
  const caller: FunctionPlugin = {
    name: "consumer",
    root: "/consumer",
    tier: "user",
    capabilities: [...SESSION_CAPABILITIES],
    guest: await FunctionGuestRuntime.create(source)
  }
  const session = new FunctionSession([caller], {
    workspace: "/project",
    threadId: "thread",
    platformIncarnation: "incarnation",
    platformNativeProviders: native,
    assertContent,
    assertLive: guard,
    assertCapability: (_plugin, method) => {
      if (!caller.capabilities.includes(method)) throw Error("DENIED")
    },
    publish: async (value) => value
  })
  sessions.push(session)
  const signal = new AbortController().signal
  return {
    session,
    caller,
    signal,
    call: (method: string, value?: ModJson) =>
      session.platform.call(caller, method, value === undefined ? [] : [value], signal)
  }
}

it("discovers native descriptors without reading, watching, executing, or starting a guest", async () => {
  const read = vi.fn(() => ({ count: 0 })),
    watch = vi.fn(() => () => {}),
    act = vi.fn()
  const f = await fixture([provider({ read, watch, act })])
  const list = (await f.call("platform.list")) as { capabilities: Array<{ ref: typeof ref }> }
  expect(list.capabilities.map((entry) => entry.ref)).toContainEqual(ref)
  expect(read).not.toHaveBeenCalled()
  expect(watch).not.toHaveBeenCalled()
  expect(act).not.toHaveBeenCalled()
})

it("uses the native read and subscription bridge through actual guest SDK calls", async () => {
  const stop = vi.fn()
  const f = await fixture(
    [provider({ watch: () => stop })],
    () => {},
    `
    globalThis.__cmbFunctionMod={register(on){
      on("turn.complete",async($)=>{
        const query=${JSON.stringify(query)};
        const list=await $.platform.list();
        const state=await $.platform.read(query);
        const sub=await $.platform.subscribe(query);
        const packet=await $.platform.poll({subscriptionId:sub.subscriptionId,afterRevision:sub.revision});
        await $.platform.unsubscribe({subscriptionId:sub.subscriptionId});
        return {text:JSON.stringify({list,state,packet})};
      });
    }}
  `
  )
  const result = await f.session.turnComplete({
    turnId: "native-guest",
    answer: "answer",
    reason: "answer",
    isAborted: false,
    durationMs: 1
  })
  const actual = JSON.parse(result.text)
  expect(actual.list.capabilities.map((item: { ref: typeof ref }) => item.ref)).toContainEqual(ref)
  expect(actual.state).toMatchObject({ status: "ready", value: { count: 0 } })
  expect(stop).toHaveBeenCalledOnce()
  expect(f.session.platform.diagnostics().subscriptions).toBe(0)
})

it("reads authoritative state, subscribes to native changes and releases the original observer", async () => {
  let count = 0,
    context: NativePlatformCallContext | undefined
  const stop = vi.fn()
  const f = await fixture([
    provider({
      read: (ctx) => {
        expect([ctx.workspace, ctx.threadId, ctx.incarnation, ctx.caller.name]).toEqual([
          "/project",
          "thread",
          "incarnation",
          "consumer"
        ])
        return { count }
      },
      watch: (ctx) => {
        context = ctx
        return stop
      }
    })
  ])
  expect(await f.call("platform.read", query)).toMatchObject({
    status: "ready",
    value: { count: 0 }
  })
  const subscription = (await f.call("platform.subscribe", query)) as {
    subscriptionId: string
    revision: number
  }
  count = 2
  context!.publish({ count })
  expect(
    await f.call("platform.poll", {
      subscriptionId: subscription.subscriptionId,
      afterRevision: subscription.revision
    })
  ).toMatchObject({ events: [{ value: { count: 2 } }] })
  await f.call("platform.unsubscribe", { subscriptionId: subscription.subscriptionId })
  expect(stop).toHaveBeenCalledTimes(1)
  expect(context!.signal.aborted).toBe(true)
  expect(() => context!.publish({ count: 99 })).toThrow()
  expect(f.session.platform.diagnostics().subscriptions).toBe(0)
})

it("lets the actual guest cancel its owned native action after content becomes invalid", async () => {
  let entered!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  let contentValid = true
  const f = await fixture(
    [
      provider({
        act: (context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(context.signal.reason), {
              once: true
            })
            entered()
          })
      })
    ],
    () => {},
    `globalThis.__cmbFunctionMod={register(on){
    on("turn.complete",async($)=>({text:JSON.stringify(await $.platform.cancel({
      ...${JSON.stringify(query)},requestKey:"cancel-native"
    }))}));
  }}`,
    () => {
      if (!contentValid) throw Error("CONTENT_CHANGED")
    }
  )
  await f.session.start()
  const running = f.call("platform.act", {
    ...query,
    action: "complete",
    input: {},
    requestKey: "cancel-native"
  })
  await ready
  contentValid = false
  const cancelled = await f.session.turnComplete({
    turnId: "cancel-native-turn",
    answer: "cancel",
    reason: "answer",
    isAborted: false,
    durationMs: 1
  })
  expect(JSON.parse(cancelled.text)).toMatchObject({ status: "running" })
  expect(await running).toMatchObject({ status: "unknown" })
  expect(f.session.platform.diagnostics().inFlight).toBe(0)
})

it("does not publish a late read after the consumer is revoked and keeps targets host-owned", async () => {
  let live = true
  let finish!: (value: ModJson) => void
  const read = vi.fn(
    () =>
      new Promise<ModJson>((resolve) => {
        finish = resolve
      })
  )
  const f = await fixture([provider({ read })], () => {
    if (!live) throw Error("REVOKED")
  })
  await expect(
    f.call("platform.read", { ...query, target: { kind: "current", threadId: "other" } })
  ).rejects.toThrow()
  expect(read).not.toHaveBeenCalled()
  const pending = f.call("platform.read", query)
  live = false
  finish({ count: 42 })
  await expect(pending).rejects.toThrow("REVOKED")
})

it("executes through original caller authority and keyed result ledger without guest invocation", async () => {
  const act = vi.fn(async (context: NativePlatformCallContext) => {
    context.assertCurrent()
    return { completed: true }
  })
  const f = await fixture([provider({ act })])
  const input = { ...query, action: "complete", input: {}, requestKey: "once" }
  f.caller.capabilities = f.caller.capabilities.filter((method) => method !== "platform.publish")
  await expect(f.call("platform.act", input)).rejects.toThrow("DENIED")
  expect(act).not.toHaveBeenCalled()
  f.caller.capabilities.push("platform.publish")
  expect(await f.call("platform.act", input)).toMatchObject({
    status: "succeeded",
    value: { completed: true }
  })
  expect(await f.call("platform.act", input)).toMatchObject({ status: "succeeded" })
  expect(act).toHaveBeenCalledTimes(1)
  expect(act.mock.calls[0][0].caller.name).toBe("consumer")
})

it("allows several native capabilities per provider and closes each observer and provider", async () => {
  const stop = vi.fn(),
    close = vi.fn()
  const first = provider({ watch: () => stop, close })
  const second = provider({ descriptor: { ...first.descriptor, id: "queue" }, close })
  const f = await fixture([first, second])
  await f.call("platform.subscribe", query)
  await f.session.close(true)
  expect(stop).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(2)
})

it("does not grant effects to a native read context", async () => {
  const f = await fixture([
    provider({
      read: async (context) => {
        await context.invoke(ref, "complete", {}, "forbidden")
        return {}
      }
    })
  ])
  await expect(f.call("platform.read", query)).rejects.toThrow("MODS_PLATFORM_READ_ONLY")
})

it("does not let a native adapter escape its declared nested permissions", async () => {
  let entered = 0
  const first = provider({
    act: async (context) => {
      await context.invoke({ ...ref, id: "effect" }, "complete", {}, "nested")
      return {}
    }
  })
  const second = provider({
    descriptor: { ...first.descriptor, id: "effect" },
    act: async () => {
      entered++
      return {}
    }
  })
  const f = await fixture([first, second])
  const result = await f.call("platform.act", {
    ...query,
    action: "complete",
    input: {},
    requestKey: "outer"
  })
  expect(result).toMatchObject({ status: "unknown", error: "MODS_PLATFORM_UNDECLARED_PERMISSION" })
  expect(entered).toBe(0)
})

it("finishes other cleanup and guest disposal even when a native observer fails to close", async () => {
  const first = provider({
    watch: () => () => {
      throw Error("native cleanup failed")
    }
  })
  const stop = vi.fn()
  const second = provider({ descriptor: { ...first.descriptor, id: "other" }, watch: () => stop })
  const f = await fixture([first, second])
  await f.call("platform.subscribe", query)
  await f.call("platform.subscribe", { ...query, ref: { ...ref, id: "other" } })
  await expect(f.session.close(true)).rejects.toThrow("native cleanup failed")
  expect(stop).toHaveBeenCalledTimes(1)
  expect(f.caller.guest.stats.disposed).toBe(true)
  sessions.splice(sessions.indexOf(f.session), 1)
})
