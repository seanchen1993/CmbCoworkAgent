import { randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { PlatformSurfaces } from "./platform-surfaces"
import type { PlatformCapabilityInfo } from "../../../shared/mods/v2/platform-capabilities"
import type { FunctionUiNode } from "../../../shared/mods/v2/ui"
import type { PlatformSurfacesHost } from "./platform-surfaces"

it("opens an author page through actual guest UI, routes real callback receipts and isolates stop", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){let count=0;
    on("session.start",async($,e,next)=>{await $.command.register({name:"open",description:"open"});return next(e)});
    on("command.run",{command:"open"},async($)=>{await $.ui.open({id:"workbench",title:"Author workbench"});return{}});
    on("ui.render",{component:"Pane",requestId:"workbench"},($,e)=>$.ui.resolve(e).Button({key:"increment",label:String(count),onPress(){count++;$.ui.invalidate("ui.render")}}))
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "consumer",
        root: "/consumer",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/work",
      threadId: "thread-A",
      assertLive: () => {},
      publish: async (value) => value
    }
  )
  const info: PlatformCapabilityInfo = {
    ref: { provider: "consumer", id: "board", version: "1.0.0" },
    source: { provider: "consumer", digest: "a".repeat(64), generation: "one" },
    available: true,
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: "board",
      title: "board",
      version: "1.0.0",
      scope: "conversation",
      stateSchema: {},
      actions: [
        {
          id: "open",
          title: "open",
          inputSchema: {},
          outputSchema: {},
          requiredPermissions: ["ui.open"],
          cancellable: true,
          idempotency: "keyed"
        }
      ],
      presentation: {
        type: "surface",
        apiVersion: "devclaw.surface/v1",
        id: "board",
        title: "My page",
        placement: "page",
        paneId: "workbench",
        openAction: "open"
      }
    }
  }
  const registry = new PlatformSurfaces({
    capabilities: () => [info],
    assertCurrent: () => {
      if (!info.available) throw Error("REVOKED")
    },
    paneOwner: () => "consumer",
    panes: session.panes,
    changed: () => {},
    invoke: async (_, __, ___, requestKey) => {
      await session.run("open", "")
      return { requestKey, status: "succeeded", value: {} }
    }
  })
  try {
    const list = registry.list()
    let address = {
      key: list.entries[0].key,
      revision: list.revision,
      openId: undefined as string | undefined
    }
    expect(await session.panes.snapshot()).toEqual([])
    let frame = await registry.open(address, new AbortController().signal)
    address = { ...address, openId: frame.openId }
    const button = frame.pane!.tree as FunctionUiNode
    expect(button.props.label).toBe("0")
    const action = {
      pane: frame.pane!.key,
      generation: frame.pane!.generation,
      intentId: randomUUID(),
      plugin: button.press!.plugin,
      handle: button.press!.handle,
      kind: "press" as const
    }
    await registry.act(address, action)
    frame = await registry.read(address)
    expect((frame.pane!.tree as FunctionUiNode).props.label).toBe("1")
    await expect(
      registry.act(address, { ...action, pane: "other-thread:workbench", intentId: randomUUID() })
    ).rejects.toThrow("MODS_PLATFORM_SURFACE_ACTION_DENIED")
    await registry.disable(address)
    await expect(registry.read(address)).rejects.toThrow("MODS_PLATFORM_SURFACE_STALE")
    expect(await session.panes.snapshot()).toEqual([])
    const disabled = registry.list(),
      next = { key: disabled.entries[0].key, revision: disabled.revision }
    registry.enable(next)
    const enabled = registry.list()
    await registry.open(
      { key: enabled.entries[0].key, revision: enabled.revision },
      new AbortController().signal
    )
    info.available = false
    await expect(
      registry.act({ key: enabled.entries[0].key, revision: enabled.revision }, action)
    ).rejects.toThrow()
  } finally {
    registry.close()
    await session.close()
  }
})

function lifecycleFixture() {
  const make = (id: string): PlatformCapabilityInfo => ({
    ref: { provider: "consumer", id, version: "1.0.0" },
    source: { provider: "consumer", digest: "a".repeat(64), generation: "one" },
    available: true,
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id,
      version: "1.0.0",
      title: id,
      scope: "conversation",
      stateSchema: {},
      actions: ["open", "close"].map((id) => ({
        id,
        title: id,
        inputSchema: {},
        outputSchema: {},
        requiredPermissions: [],
        cancellable: true,
        idempotency: "keyed"
      })),
      presentation: {
        type: "surface",
        apiVersion: "devclaw.surface/v1",
        id,
        title: id,
        placement: "page",
        paneId: "shared",
        openAction: "open",
        closeAction: "close"
      }
    }
  })
  const state = {
    gate: undefined as Promise<void> | undefined,
    closeGate: undefined as Promise<void> | undefined,
    unknown: false,
    opened: 0,
    closed: 0,
    cleanups: 0
  }
  const infos = [make("page"), make("navigation")]
  const host: PlatformSurfacesHost = {
    capabilities: () => infos,
    assertCurrent: () => {},
    paneOwner: () => "consumer",
    changed() {
      // This fixture reads state directly instead of subscribing a renderer.
    },
    invoke: async (_, __, ___, requestKey) => {
      state.opened++
      if (state.gate) await state.gate
      return { requestKey, status: "succeeded", value: {} }
    },
    cleanup: async (_, __, ___, requestKey) => {
      state.cleanups++
      if (state.closeGate) await state.closeGate
      return { requestKey, status: state.unknown ? "unknown" : "succeeded", value: {} }
    },
    panes: {
      snapshot: async () => [],
      act: async () => {},
      closePane: async () => {
        state.closed++
      }
    }
  }
  const registry = new PlatformSurfaces(host),
    catalog = registry.list()
  return {
    registry,
    state,
    infos,
    first: {
      key: catalog.entries.find((entry) => entry.id === "page")!.key,
      revision: catalog.revision
    },
    second: {
      key: catalog.entries.find((entry) => entry.id === "navigation")!.key,
      revision: catalog.revision
    },
    signal: new AbortController().signal
  }
}

it("fences shared-pane aliases throughout pending and unknown cleanup and permits exact-source recovery", async () => {
  const f = lifecycleFixture(),
    frame = await f.registry.open(f.first, f.signal)
  const address = { ...f.first, openId: frame.openId },
    gate = Promise.withResolvers<void>()
  f.state.closeGate = gate.promise
  f.state.unknown = true
  const closing = f.registry.closePage(address).catch((error) => error)
  await expect(f.registry.open(f.second, f.signal)).rejects.toThrow("MODS_PLATFORM_SURFACE_CLOSING")
  gate.resolve()
  expect(await closing).toBeInstanceOf(Error)
  expect(f.state.closed).toBe(1)
  await expect(f.registry.open(f.second, f.signal)).rejects.toThrow(
    "MODS_PLATFORM_SURFACE_CLEANUP_UNCONFIRMED"
  )
  expect(f.state.opened).toBe(1)
  // Explicit disable changes catalog revision, but the exact original source can still clean up.
  await expect(f.registry.disable(address)).rejects.toThrow(
    "MODS_PLATFORM_SURFACE_CLEANUP_UNCONFIRMED"
  )
  f.state.unknown = false
  await f.registry.closePage(address)
  const updated = f.registry.list(),
    current = { key: f.second.key, revision: updated.revision }
  const reopened = await f.registry.open(current, f.signal)
  await expect(f.registry.read(current)).rejects.toThrow("MODS_PLATFORM_SURFACE_STALE")
  expect(await f.registry.read({ ...current, openId: reopened.openId })).toHaveProperty(
    "openId",
    reopened.openId
  )
})

it("never closes a newer same-pane opening from a late old-scope receipt", async () => {
  const f = lifecycleFixture(),
    gate = Promise.withResolvers<void>()
  f.state.gate = gate.promise
  const first = f.registry.open(f.first, f.signal)
  await expect(f.registry.open(f.second, f.signal)).rejects.toThrow("MODS_PLATFORM_SURFACE_OPENING")
  gate.resolve()
  const old = await first
  f.state.gate = undefined
  await expect(f.registry.open(f.second, f.signal)).rejects.toThrow("MODS_PLATFORM_SURFACE_ALREADY_OPEN")
  await f.registry.closePage({ ...f.first, openId: old.openId })
  const current = await f.registry.open(f.second, f.signal)
  expect(current.openId).not.toBe(old.openId)
  await f.registry.closePage({ ...f.first, openId: old.openId })
  expect(f.state.closed).toBe(1)
  expect(f.state.cleanups).toBe(1)
  await expect(f.registry.read({ ...f.second, openId: old.openId })).rejects.toThrow(
    "MODS_PLATFORM_SURFACE_STALE"
  )
  await f.registry.closePage({ ...f.second, openId: current.openId })
  expect(f.state.closed).toBe(2)
})
