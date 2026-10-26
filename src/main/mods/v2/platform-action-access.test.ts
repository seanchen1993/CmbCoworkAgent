import { afterEach, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionPlugin } from "./dispatcher"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { PlatformCapabilityHub } from "./platform-capabilities-hub"
import type { NativePlatformCapabilityProvider } from "./platform-capabilities-types"
const sessions: FunctionSession[] = []
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close(true))) })
const ref = { provider: "native.evidence-test", id: "evidence", version: "1.0.0" }
const query = { ref, target: { kind: "current" } }
async function fixture() {
  let revision = "original", live = true
  const records = new Map<string, ModJson>()
  const hub = new PlatformCapabilityHub({
    get: (namespace, key) => records.get(JSON.stringify([namespace, key])),
    set: (namespace, key, value) => { records.set(JSON.stringify([namespace, key]), structuredClone(value)) },
    keys: namespace => [...records.keys()].map(key => JSON.parse(key) as string[])
      .filter(parts => parts[0] === namespace).map(parts => parts[1])
  })
  const act = vi.fn<NativePlatformCapabilityProvider["act"]>(async () => ({ original: true }))
  const native: NativePlatformCapabilityProvider = {
    provider: ref.provider, descriptor: { apiVersion: "devclaw.capability/v1", id: ref.id,
      version: ref.version, title: "Native evidence", scope: "conversation",
      stateSchema: { type: "object" }, actions: [{ id: "inspect", title: "Inspect",
        inputSchema: { type: "object", additionalProperties: true }, outputSchema: { type: "object" },
        requiredPermissions: ["platform.read"], cancellable: true, idempotency: "keyed" }] },
    actionSelector: (_action, input) => ({ runId: input.runId }),
    prepareActionAccess: async (context, _action, selector) => {
      if (!selector || typeof selector !== "object" || Array.isArray(selector) ||
        JSON.stringify(Object.keys(selector)) !== '["runId"]' ||
        (selector as ModObject).runId !== "original-run") throw Error("SELECTOR_INVALID")
      context.assertCurrent()
      const identity = revision
      return { identity, assertCurrent() {
        context.assertCurrent()
        if (revision !== identity) throw Error("EVIDENCE_CHANGED")
      } }
    }, act
  }
  const caller: FunctionPlugin = { name: "consumer", root: "/consumer", tier: "user",
    capabilities: [...SESSION_CAPABILITIES],
    guest: await FunctionGuestRuntime.create("globalThis.__cmbFunctionMod={register(){}}") }
  const session = new FunctionSession([caller], { workspace: "/project", threadId: "thread",
    platformIncarnation: "incarnation", platformHub: hub, platformNativeProviders: [native],
    assertLive() { if (!live) throw Error("AUTHORITY_REVOKED") }, publish: async value => value })
  sessions.push(session)
  const call = (key = "same", signal = new AbortController().signal) => session.platform.act(caller,
    { ...query, action: "inspect", input: { runId: "original-run", secret: "fixture-not-to-persist" }, requestKey: key }, signal)
  const status = (key = "same") => session.platform.call(caller, "platform.status", [{ ...query, requestKey: key }], new AbortController().signal)
  return { native, records, act, call, status, session, caller,
    change() { revision = "changed" }, revoke() { live = false } }
}

it("persists only the native allowlisted selector and revalidates the original cached receipt", async () => {
  const f = await fixture()
  const first = await f.call()
  expect(first.status).toBe("succeeded")
  expect(await f.call()).toEqual(first)
  expect(f.act).toHaveBeenCalledOnce()
  expect(JSON.stringify([...f.records.values()])).not.toContain("fixture-not-to-persist")
  const saved = [...f.records.values()].find(row => row && typeof row === "object" && !Array.isArray(row) && row.action === "inspect") as ModObject
  expect(saved.nativeActionSelector).toEqual({ runId: "original-run" })
  f.change()
  await expect(f.call()).rejects.toThrow(/CONFLICT|CHANGED/)
  await expect(f.status()).rejects.toThrow("CHANGED")
  expect(f.act).toHaveBeenCalledOnce()
})

it("does not interpret an old or tampered receipt with no selector as legacy unguarded evidence", async () => {
  const f = await fixture()
  await f.call()
  const saved = [...f.records.values()].find(row => row && typeof row === "object" && !Array.isArray(row) && row.action === "inspect") as ModObject
  delete saved.nativeActionSelector
  await expect(f.status()).rejects.toThrow("SELECTOR_INVALID")
  expect(f.act).toHaveBeenCalledOnce()
})

it("rechecks the second caller after sharing an already-running original action", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.act.mockImplementation(async () => { entered.resolve(); await release.promise; return { original: true } })
  const first = f.call()
  await entered.promise
  const cancelled = new AbortController()
  const second = f.call("same", cancelled.signal)
  const rejected = expect(second).rejects.toThrow()
  await Promise.resolve()
  cancelled.abort(Error("SECOND_CALLER_CANCELLED"))
  release.resolve()
  expect((await first).status).toBe("succeeded")
  await rejected
  expect(f.act).toHaveBeenCalledOnce()
})

it("does not publish success when evidence changes during the original action", async () => {
  const f = await fixture()
  f.act.mockImplementation(async () => { f.change(); return { original: true } })
  expect(await f.call()).toMatchObject({ status: "unknown" })
  expect(f.act).toHaveBeenCalledOnce()
})

it.each(["cancel", "revoke"])("does not cancel an existing legacy owner after receipt await %s", async change => {
  const f = await fixture()
  delete f.native.actionSelector
  delete f.native.prepareActionAccess
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let originalSignal: AbortSignal | undefined
  f.act.mockImplementation(async context => {
    originalSignal = context.signal
    entered.resolve()
    await release.promise
    return { original: true }
  })
  const first = f.call()
  await entered.promise
  const cancelController = new AbortController()
  const cancelled = f.session.platform.call(f.caller, "platform.cancel", [{ ...query, requestKey: "same" }], cancelController.signal)
  const rejected = expect(cancelled).rejects.toThrow()
  if (change === "cancel") cancelController.abort(Error("LATE_CALLER_CANCEL"))
  else f.revoke()
  await rejected
  expect(originalSignal?.aborted).toBe(false)
  release.resolve()
  await first
})


it.each(["initial", "cached", "receipt", "publication"])(
  "checks full evidence after the final prepare await for %s acceptance", async mode => {
    const f = await fixture()
    if (mode === "cached" || mode === "receipt") await f.call()
    const prepare = f.native.prepareActionAccess!
    let currentBytes = true, calls = 0
    f.native.prepareActionAccess = async (...args) => {
      const prepared = await prepare(...args)
      calls++
      // The mutation is queued after the lower prepare has returned valid evidence,
      // before the platform's outer await continuation can consume that evidence.
      if (calls === (mode === "publication" ? 3 : 1))
        queueMicrotask(() => { currentBytes = false })
      return { ...prepared!, assertContentCurrent() {
        if (!currentBytes) throw Error("INPUT_BYTES_CHANGED")
      } }
    }
    if (mode === "publication") {
      expect(await f.call()).toMatchObject({ status: "unknown", error: "INPUT_BYTES_CHANGED" })
    } else {
      await expect(mode === "receipt" ? f.status() : f.call()).rejects.toThrow("INPUT_BYTES_CHANGED")
    }
    expect(calls).toBeGreaterThan(0)
  }
)
