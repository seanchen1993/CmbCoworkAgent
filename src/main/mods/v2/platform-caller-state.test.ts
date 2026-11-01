import { afterEach, expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { PlatformCapabilityHub } from "./platform-capabilities-hub"
import type { FunctionPlugin } from "./dispatcher"
import type {
  NativePlatformCallContext,
  NativePlatformCapabilityProvider
} from "./platform-capabilities-types"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close(true)))
})
const ref = { provider: "native.private", id: "changes", version: "1.0.0" }
const query = { ref, target: { kind: "current" } }
const signal = () => new AbortController().signal

function hub() {
  const values = new Map<string, ModJson>()
  return new PlatformCapabilityHub({
    get: (namespace, key) => values.get(JSON.stringify([namespace, key])),
    set: (namespace, key, value) => {
      values.set(JSON.stringify([namespace, key]), value)
    },
    keys: (namespace) =>
      [...values.keys()]
        .map((key) => JSON.parse(key) as string[])
        .filter((parts) => parts[0] === namespace)
        .map((parts) => parts[1])
  })
}

async function fixture(
  options: {
    sharedHub?: PlatformCapabilityHub
    digest?: string
    generation?: string
    scoped?: boolean
    noRead?: boolean
    validate?: NativePlatformCapabilityProvider["validateStateAccess"]
    revokeOnPublish?: number
  } = {}
) {
  let revoked = false
  let reads = 0,
    publishes = 0
  const contexts = new Map<string, NativePlatformCallContext>()
  const callers: FunctionPlugin[] = []
  for (const name of ["alpha", "beta"])
    callers.push({
      name,
      root: `/${name}`,
      tier: "user",
      guest: await FunctionGuestRuntime.create("globalThis.__cmbFunctionMod={register(on){}}"),
      capabilities: [...SESSION_CAPABILITIES]
    })
  const provider: NativePlatformCapabilityProvider = {
    provider: ref.provider,
    callerScopedState: options.scoped !== false,
    queryRead: true,
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: ref.id,
      version: ref.version,
      title: "Authorized observations",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: []
    },
    ...(options.noRead
      ? {}
      : {
          read: (context: NativePlatformCallContext) => ({
            owner: context.caller.name,
            ...(options.revokeOnPublish ? { read: ++reads } : {})
          })
        }),
    watch(context) {
      contexts.set(context.caller.name, context)
      return () => {
        if (contexts.get(context.caller.name) === context) contexts.delete(context.caller.name)
      }
    },
    validateStateAccess: options.validate,
    async act() {
      throw Error("No actions")
    }
  }
  const session = new FunctionSession(callers, {
    workspace: "/project",
    threadId: "same-thread",
    platformIncarnation: "same-incarnation",
    platformHub: options.sharedHub,
    platformSource: (plugin) => ({
      provider: plugin.name,
      digest: options.digest ?? "digest-one",
      generation: options.generation ?? "generation-one"
    }),
    assertLive() {
      if (revoked) throw Error("CALLER_REVOKED")
    },
    platformChanged() {
      if (++publishes === options.revokeOnPublish) revoked = true
    },
    publish: async (value) => value,
    platformNativeProviders: [provider]
  })
  sessions.push(session)
  const call = (index: number, method: string, input: ModJson = query) =>
    session.platform.call(callers[index], method, [input], signal())
  const subscribe = async (index: number) => (await call(index, "platform.subscribe")) as ModObject
  const poll = (index: number, subscription: ModObject) =>
    call(index, "platform.poll", {
      subscriptionId: subscription.subscriptionId!,
      afterRevision: 0
    })
  return {
    session,
    call,
    subscribe,
    poll,
    contexts,
    revoke: () => {
      revoked = true
    }
  }
}

it("isolates native read snapshots and watch events between two actual guest callers", async () => {
  const f = await fixture()
  const a = await f.subscribe(0),
    b = await f.subscribe(1)
  f.contexts.get("alpha")!.publish({ owner: "alpha", path: "alpha-only.ts" })
  f.contexts.get("beta")!.publish({ owner: "beta", path: "beta-only.ts" })
  for (const [index, sub, name] of [
    [0, a, "alpha"],
    [1, b, "beta"]
  ] as const) {
    const result = (await f.poll(index, sub)) as ModObject
    const events = result.events as Array<{ value: ModObject }>
    expect(events.length).toBeGreaterThan(0)
    expect(events.every((event) => event.value.owner === name)).toBe(true)
    expect(await f.call(index, "platform.read")).toMatchObject({ value: { owner: name } })
  }
  await expect(f.poll(1, a)).rejects.toThrow("MODS_PLATFORM_SUBSCRIPTION_EXPIRED")
})

it.each(["digest", "generation"] as const)(
  "does not reuse a same-name caller's previous native state after %s changes",
  async (field) => {
    const sharedHub = hub()
    const first = await fixture({ sharedHub })
    await first.subscribe(0)
    first.contexts.get("alpha")!.publish({ owner: "alpha", path: "old.ts" })
    await first.session.close(true)
    const next = await fixture({ sharedHub, noRead: true, [field]: "changed" })
    expect(await next.call(0, "platform.read")).toMatchObject({ status: "unknown", revision: 0 })
  }
)

it("preserves shared state for native providers that do not opt in", async () => {
  const f = await fixture({ scoped: false })
  const a = await f.subscribe(0),
    b = await f.subscribe(1)
  f.contexts.get("alpha")!.publish({ owner: "shared" })
  for (const [index, sub] of [
    [0, a],
    [1, b]
  ] as const)
    expect(
      await f.call(index, "platform.poll", {
        subscriptionId: sub.subscriptionId!,
        afterRevision: sub.revision!
      })
    ).toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ value: { owner: "shared" } })])
    })
})

it("rejects revoked late publication and poll, and retires watches on unsubscribe", async () => {
  const f = await fixture()
  const a = await f.subscribe(0)
  const context = f.contexts.get("alpha")!
  await f.call(0, "platform.unsubscribe", { subscriptionId: a.subscriptionId! })
  expect(f.contexts.has("alpha")).toBe(false)
  expect(() => context.publish({ path: "late.ts" })).toThrow()
  const b = await f.subscribe(1)
  const late = f.contexts.get("beta")!
  f.revoke()
  expect(() => late.publish({ path: "revoked.ts" })).toThrow("CALLER_REVOKED")
  await expect(f.poll(1, b)).rejects.toThrow("CALLER_REVOKED")
})

it("revalidates all actual queued values and rejects a newly denied path without consuming events", async () => {
  let deny = false
  const seen: ModJson[][] = []
  const f = await fixture({
    validate: async (_context, values) => {
      seen.push([...values])
      if (deny && values.some((value) => (value as ModObject).path === "private.ts"))
        throw Error("DENIED_NOW")
    }
  })
  const a = await f.subscribe(0)
  f.contexts.get("alpha")!.publish({ path: "private.ts" })
  deny = true
  await expect(f.poll(0, a)).rejects.toThrow("DENIED_NOW")
  deny = false
  expect(await f.poll(0, a)).toMatchObject({
    events: expect.arrayContaining([expect.objectContaining({ value: { path: "private.ts" } })])
  })
  expect(seen).toHaveLength(2)
})

it.each(["unsubscribe", "revoke"] as const)(
  "rejects a poll whose authority changes during native validation: %s",
  async (change) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const f = await fixture({
      validate: async () => {
        entered.resolve()
        await release.promise
      }
    })
    const a = await f.subscribe(0)
    const pending = f.poll(0, a)
    const rejected = expect(pending).rejects.toThrow()
    await entered.promise
    if (change === "unsubscribe")
      await f.call(0, "platform.unsubscribe", { subscriptionId: a.subscriptionId! })
    else f.revoke()
    release.resolve()
    await rejected
  }
)

it("returns only the snapshot validated, excluding events arriving during validation", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const f = await fixture({
    validate: async () => {
      entered.resolve()
      await release.promise
    }
  })
  const a = await f.subscribe(0)
  const pending = f.poll(0, a)
  await entered.promise
  f.contexts.get("alpha")!.publish({ path: "later.ts" })
  release.resolve()
  const result = (await pending) as ModObject
  expect(
    (result.events as Array<{ value: ModObject }>).some((event) => event.value.path === "later.ts")
  ).toBe(false)
})

it("rechecks caller authority after native read publication synchronously revokes it", async () => {
  const f = await fixture({ revokeOnPublish: 1 })
  await expect(f.call(0, "platform.read")).rejects.toThrow("CALLER_REVOKED")
})

it("cleans an installed watch when the post-subscribe refresh revokes its caller", async () => {
  const f = await fixture({ revokeOnPublish: 2 })
  await expect(f.subscribe(0)).rejects.toThrow("CALLER_REVOKED")
  expect(f.contexts.size).toBe(0)
  expect(f.session.platform.diagnostics().subscriptions).toBe(0)
})
