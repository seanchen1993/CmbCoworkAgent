import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { FunctionHostCall } from "../../../shared/mods/v2/contracts"
import { withPlatformQuery } from "./platform-query-scope"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

async function fixture(hooks = "") {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${hooks}}}`)
  let moduleHost!: FunctionHostCall
  const bind = guest.bindModuleHost.bind(guest)
  guest.bindModuleHost = (host, dispose) => {
    moduleHost = host
    bind(host, dispose)
  }
  let revoked = false
  let capabilityDenied = false
  const changed = vi.fn()
  const assertCapability = vi.fn((_plugin, method) => {
    if (capabilityDenied && method === "ui.invalidate") throw Error("CAPABILITY_REVOKED")
  })
  const session = new FunctionSession(
    [
      {
        name: "background-ui",
        root: "/background-ui",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      assertLive() {
        if (revoked) throw Error("SOURCE_REVOKED")
      },
      assertCapability,
      publish: async (value) => value,
      uiChanged: changed
    }
  )
  sessions.push(session)
  await session.start()
  const call = (method = "ui.invalidate", args: unknown = ["ui.render"]) =>
    moduleHost(
      "resource.ui",
      { method, args } as Parameters<FunctionHostCall>[1],
      new AbortController().signal
    )
  return {
    session,
    call,
    changed,
    assertCapability,
    revoke() {
      revoked = true
    },
    denyCapability() {
      capabilityDenied = true
    }
  }
}

it("refreshes rendering after a background reply through the normal capability boundary", async () => {
  const f = await fixture()
  await expect(f.call()).resolves.toEqual({})
  expect(f.assertCapability).toHaveBeenCalledWith(
    expect.objectContaining({ name: "background-ui" }),
    "ui.invalidate"
  )
  expect(f.changed).toHaveBeenCalled()
})

it.each(["prompt.context", "prompt.attachment", "tool.describe", "config.describe"])(
  "does not turn background UI completion into %s invalidation authority",
  async (event) => {
    const f = await fixture()
    f.changed.mockClear()
    await expect(f.call("ui.invalidate", [event])).rejects.toThrow()
    expect(f.changed).not.toHaveBeenCalled()
  }
)

it.each(["prompt.submit", "process.run", "store.set", "tool.call"])(
  "does not expose %s through resource.ui",
  async (method) => {
    const f = await fixture()
    await expect(f.call(method, ["ui.render"])).rejects.toThrow()
    expect(f.assertCapability).not.toHaveBeenCalledWith(expect.anything(), method)
  }
)

it("keeps malformed render arguments and forged component hints invalid", async () => {
  const f = await fixture()
  for (const args of [
    ["ui.render", "extra"],
    ["ui.render", { components: ["Unknown"] }],
    "ui.render"
  ])
    await expect(f.call("ui.invalidate", args)).rejects.toThrow()
})

it("does not let middleware rewrite background redraw into a different invalidation", async () => {
  const f = await fixture(`on("ui.invalidate", async ($, event, next) =>
    next({...event, event:"config.describe"}));`)
  f.changed.mockClear()
  await expect(f.call()).rejects.toThrow("MODS_UI_INVALIDATE_UNAVAILABLE")
  expect(f.changed).not.toHaveBeenCalled()
})

it("rejects revoked source and revoked capability without publishing a refresh", async () => {
  const source = await fixture()
  source.revoke()
  source.changed.mockClear()
  await expect(source.call()).rejects.toThrow("SOURCE_REVOKED")
  expect(source.changed).not.toHaveBeenCalled()
  const permission = await fixture()
  permission.denyCapability()
  permission.changed.mockClear()
  await expect(permission.call()).rejects.toThrow("CAPABILITY_REVOKED")
  expect(permission.changed).not.toHaveBeenCalled()
})

it("cannot use an ended session or query scope as a background refresh source", async () => {
  const f = await fixture()
  await expect(withPlatformQuery(new AbortController().signal, () => f.call())).rejects.toThrow()
  await f.session.close()
  f.changed.mockClear()
  await expect(f.call()).rejects.toThrow()
  expect(f.changed).not.toHaveBeenCalled()
})
