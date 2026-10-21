import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { ModControlStore } from "../control-store"
import type { FunctionPlugin } from "./dispatcher"
import { FunctionGuestRuntime } from "./guest-runtime"
import { PlatformCapabilityHub } from "./platform-capabilities-hub"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const ref = { provider: "native.persistence", id: "delivery", version: "1.0.0" }
const query = { ref, target: { kind: "current" } }
const schema = { type: "object", additionalProperties: false, properties: {} }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-platform-persistence-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "platform.sqlite")
  const effects = join(root, "effects.txt")
  async function open(
    callerDigest = "caller-v1",
    providerDigest = "provider-v1",
    generation = "one"
  ) {
    const store = new ModControlStore(file)
    let closed = false
    const caller: FunctionPlugin = {
      name: "consumer",
      root,
      tier: "user",
      capabilities: [...SESSION_CAPABILITIES],
      guest: await FunctionGuestRuntime.create("globalThis.__cmbFunctionMod={register(){}}")
    }
    const session = new FunctionSession([caller], {
      workspace: root,
      threadId: "actual-native-thread",
      platformIncarnation: "same-native-incarnation",
      platformHub: new PlatformCapabilityHub(store.functionState),
      platformSource: (plugin) => ({ provider: plugin.name, digest: callerDigest, generation }),
      platformNativeProviders: [
        {
          provider: ref.provider,
          digest: providerDigest,
          descriptor: {
            apiVersion: "devclaw.capability/v1",
            id: ref.id,
            version: ref.version,
            title: "Native delivery",
            scope: "conversation",
            stateSchema: schema,
            actions: [
              {
                id: "deliver",
                title: "Deliver",
                inputSchema: schema,
                outputSchema: schema,
                requiredPermissions: [],
                cancellable: true,
                idempotency: "keyed"
              }
            ]
          },
          act: async (context) => {
            context.assertCurrent()
            appendFileSync(effects, "actual-effect\n")
            return {}
          }
        }
      ],
      assertLive() {
        // The fixture owns this session until explicit close; source identity varies separately.
      },
      publish: async (value) => value
    })
    const signal = new AbortController().signal
    const call = (method: string, value: ModJson) =>
      session.platform.call(caller, method, [value], signal)
    const close = async () => {
      if (closed) return
      closed = true
      await session.close(true)
      store.close()
    }
    cleanups.push(close)
    return {
      store,
      close,
      act: (requestKey: string) =>
        call("platform.act", { ...query, action: "deliver", input: {}, requestKey }),
      status: (requestKey: string) => call("platform.status", { ...query, requestKey }),
      cancel: (requestKey: string) => call("platform.cancel", { ...query, requestKey }),
      records: () => {
        const namespace = new PlatformCapabilityHub(store.functionState).namespace(
          root,
          "actual-native-thread",
          "same-native-incarnation"
        )
        return { namespace, keys: store.functionState.keys(namespace) }
      }
    }
  }
  return { open, effects: () => readFileSync(effects, "utf8").trim().split("\n") }
}

it("retains exact successful results after closing and reopening the real SQLite store without replay", async () => {
  const f = fixture(),
    first = await f.open()
  expect(await first.act("one")).toMatchObject({ status: "succeeded" })
  await first.close()
  const cold = await f.open("caller-v1", "provider-v1", "two")
  expect(await cold.status("one")).toMatchObject({ requestKey: "one", status: "succeeded" })
  expect(await cold.act("one")).toMatchObject({ requestKey: "one", status: "succeeded" })
  expect(f.effects()).toEqual(["actual-effect"])
  await expect(cold.status("different-key")).rejects.toThrow("MODS_PLATFORM_REQUEST_UNKNOWN")
})

it("keeps a physically completed action unknown after settlement publication is lost, even on a cold store", async () => {
  const f = fixture(),
    first = await f.open()
  const persist = first.store.functionState.set.bind(first.store.functionState)
  const failure = vi
    .spyOn(first.store.functionState, "set")
    .mockImplementation((namespace, key, value) => {
      if (
        key.startsWith("action:") &&
        (value as ModObject).result &&
        ((value as ModObject).result as ModObject).status !== "running"
      )
        throw Error("SIMULATED_LOST_SETTLEMENT")
      persist(namespace, key, value)
    })
  await expect(first.act("lost")).rejects.toThrow("SIMULATED_LOST_SETTLEMENT")
  failure.mockRestore()
  expect(f.effects()).toEqual(["actual-effect"])
  await first.close()
  const cold = await f.open("caller-v1", "provider-v1", "two")
  expect(await cold.status("lost")).toMatchObject({ status: "unknown" })
  expect(await cold.act("lost")).toMatchObject({ status: "unknown" })
  expect(f.effects()).toEqual(["actual-effect"])
})

it.each(["caller", "provider"])(
  "does not attribute an older %s source's success to replacement code",
  async (changed) => {
    const f = fixture(),
      first = await f.open()
    await first.act("one")
    await first.close()
    const cold = await f.open(
      changed === "caller" ? "caller-v2" : "caller-v1",
      changed === "provider" ? "provider-v2" : "provider-v1",
      "two"
    )
    expect(await cold.status("one")).toMatchObject({
      status: "unknown",
      error: "动作来自不同源码版本，请核对原始结果"
    })
    expect(await cold.cancel("one")).toMatchObject({ status: "unknown" })
    await expect(cold.act("one")).rejects.toThrow("MODS_PLATFORM_REQUEST_CONFLICT")
    expect(f.effects()).toEqual(["actual-effect"])
  }
)

it("keeps legacy records without source identity read-only and unknown without rewriting or replay", async () => {
  const f = fixture(),
    first = await f.open()
  await first.act("legacy")
  const { namespace, keys } = first.records()
  const key = keys.find((key) => key.startsWith("action:"))!
  const legacy = first.store.functionState.get(namespace, key) as ModObject
  delete legacy.callerDigest
  delete legacy.providerDigest
  first.store.functionState.set(namespace, key, legacy)
  await first.close()
  const cold = await f.open("caller-v1", "provider-v1", "two")
  expect(await cold.status("legacy")).toMatchObject({
    status: "unknown",
    error: "历史动作缺少源码版本记录，请核对原始结果"
  })
  expect(await cold.act("legacy")).toMatchObject({ status: "unknown" })
  expect(await cold.cancel("legacy")).toMatchObject({ status: "unknown" })
  expect(cold.store.functionState.get(namespace, key)).toEqual(legacy)
  expect(f.effects()).toEqual(["actual-effect"])
})
