import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import type { PlatformCapabilityInfo } from "../../../shared/mods/v2/platform-capabilities"
import type { FunctionUiAction, FunctionUiNode } from "../../../shared/mods/v2/ui"
import { FunctionGuestRuntime } from "./guest-runtime"
import { PlatformSurfaces } from "./platform-surfaces"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Real guest, native capability dispatch and pane runtime; only the data source is deferred. */
async function fixture(query = true, waitInGuest = false, redrawOnStart = false) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let selection=0,result="initial";
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"open",description:"open"});return next(e)
    });
    on("command.run",{command:"open"},async($)=>{
      await $.ui.open({id:"files",title:"Files"});return{}
    });
    on("ui.render",{component:"Pane",requestId:"files"},($,e)=>
      $.ui.resolve(e).Button({key:"select",label:result,onPress:async()=>{
        const chosen=++selection;
        if (${redrawOnStart}) $.ui.invalidate("ui.render");
        if (${waitInGuest} && chosen===1) await new Promise(()=>{});
        if (${waitInGuest} && chosen===2) {
          let total=0; for(let i=0;i<20000;i++) total+=i;
          if(total!==199990000) throw Error("CPU_CALLBACK_INCORRECT");
        }
        const answer=await $.platform.act({
          ref:{provider:"native.files",id:"files",version:"1.0.0"},target:{kind:"current"},
          action:"read",input:{selection:chosen},requestKey:"selection-"+chosen
        });
        result="selected:"+answer.value.selection;
        await $.ui.invalidate("ui.render");
      }})
    )
  }}`)
  const pending: { signal: AbortSignal; release: () => void; selection: number }[] = []
  const session = new FunctionSession(
    [
      {
        name: "files",
        root: "/files",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/work",
      threadId: "query-surface",
      assertLive() {
        /* This fixture keeps caller grants active. */
      },
      publish: async (value) => value,
      platformNativeProviders: [
        {
          provider: "native.files",
          queryActions: ["read"],
          descriptor: {
            apiVersion: "devclaw.capability/v1",
            id: "files",
            version: "1.0.0",
            title: "Files",
            scope: "conversation",
            stateSchema: { type: "object" },
            actions: [
              {
                id: "read",
                title: "Read",
                inputSchema: { type: "object" },
                outputSchema: { type: "object" },
                requiredPermissions: [],
                cancellable: true,
                idempotency: "keyed"
              }
            ]
          },
          async act(context, _action, input) {
            const gate = Promise.withResolvers<void>()
            pending.push({
              signal: context.signal,
              release: gate.resolve,
              selection: input.selection as number
            })
            // Deliberately ignore cancellation until release: late host completion must be fenced.
            await gate.promise
            return input
          }
        }
      ]
    }
  )
  const info: PlatformCapabilityInfo = {
    ref: { provider: "files", id: "files", version: "1.0.0" },
    source: { provider: "files", digest: "a".repeat(64), generation: "one" },
    available: true,
    descriptor: {
      apiVersion: "devclaw.capability/v1",
      id: "files",
      version: "1.0.0",
      title: "Files",
      scope: "conversation",
      stateSchema: { type: "object" },
      actions: [
        {
          id: "open",
          title: "Open",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          requiredPermissions: ["ui.open"],
          cancellable: true,
          idempotency: "keyed"
        }
      ],
      presentation: {
        type: "surface",
        apiVersion: query ? "devclaw.surface/v2" : "devclaw.surface/v1",
        ...(query ? { interaction: "query" } : {}),
        id: "files",
        title: "Files",
        placement: "page",
        paneId: "files",
        openAction: "open"
      }
    }
  }
  const surfaces = new PlatformSurfaces({
    capabilities: () => [info],
    assertCurrent() {
      /* Caller grants remain active in this fixture. */
    },
    paneOwner: () => "files",
    changed() {
      /* Assertions explicitly read the native pane snapshot. */
    },
    panes: session.panes,
    invoke: async (_ref, _action, _input, requestKey) => {
      await session.run("open", "")
      return { requestKey, status: "succeeded", value: {} }
    }
  })
  cleanups.push(async () => {
    surfaces.close()
    for (const request of pending) request.release()
    await session.close(true)
  })
  // Session preparation runs before entering the restricted query surface scope.
  await session.start()
  const catalog = surfaces.list()
  const opening = { key: catalog.entries[0].key, revision: catalog.revision }
  const frame = await surfaces.open(opening, new AbortController().signal)
  const address = { ...opening, openId: frame.openId }
  const action = (current = frame): FunctionUiAction => ({
    pane: current.pane!.key,
    generation: current.pane!.generation,
    intentId: randomUUID(),
    plugin: (current.pane!.tree as FunctionUiNode).press!.plugin,
    handle: (current.pane!.tree as FunctionUiNode).press!.handle,
    kind: "press"
  })
  return { session, guest, surfaces, address, pending, action }
}

it("keeps a redraw's new callback live when an older query frame is superseded", async () => {
  const f = await fixture(true, false, true)
  const first = f.surfaces.act(f.address, f.action()).catch((error) => error)
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  const redrawn = await f.surfaces.read(f.address)
  const second = f.surfaces.act(f.address, f.action(redrawn))
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  f.pending[1].release()
  await second
  f.pending[0].release()
  expect(await first).toBeInstanceOf(Error)
  expect((await f.surfaces.read(f.address)).pane!.tree).toMatchObject({
    props: { label: "selected:2" }
  })
})

it("cancels a suspended guest frame while the next same-generation CPU callback remains usable", async () => {
  const f = await fixture(true, true)
  let firstSettled = false
  const first = f.surfaces.act(f.address, f.action()).catch((error) => error)
    .finally(() => { firstSettled = true })
  await vi.waitFor(() => expect(f.guest.stats.frames).toBeGreaterThan(0))
  const second = f.surfaces.act(f.address, f.action())
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  await vi.waitFor(() => expect(firstSettled).toBe(true))
  expect(await first).toBeInstanceOf(Error)
  expect(f.guest.stats.disposed).toBe(false)
  expect(f.pending[0].selection).toBe(2)
  f.pending[0].release()
  await second
  expect((await f.surfaces.read(f.address)).pane!.tree).toMatchObject({
    props: { label: "selected:2" }
  })
})

it("admits a newer query through a pending guest callback and aborts the old native query", async () => {
  const f = await fixture()
  const first = f.surfaces.act(f.address, f.action()).catch((error) => error)
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  const second = f.surfaces.act(f.address, f.action())
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  expect(f.pending[0].signal.aborted).toBe(true)
  expect(f.pending[1].signal.aborted).toBe(false)
  f.pending[1].release()
  await second
  expect((await f.surfaces.read(f.address)).pane!.tree).toMatchObject({
    props: { label: "selected:2" }
  })
  f.pending[0].release()
  expect(await first).toBeInstanceOf(Error)
  expect((await f.surfaces.read(f.address)).pane!.tree).toMatchObject({
    props: { label: "selected:2" }
  })
})

it.each(["page", "session"] as const)(
  "cancels a native query on %s close and rejects late publication",
  async (close) => {
    const f = await fixture()
    const first = f.surfaces.act(f.address, f.action()).catch((error) => error)
    await vi.waitFor(() => expect(f.pending).toHaveLength(1))
    if (close === "page") await f.surfaces.closePage(f.address)
    else f.surfaces.close()
    expect(f.pending[0].signal.aborted).toBe(true)
    f.pending[0].release()
    expect(await first).toBeInstanceOf(Error)
    await expect(f.surfaces.read(f.address)).rejects.toThrow("MODS_PLATFORM_SURFACE_STALE")
    if (close === "page") expect(await f.session.panes.snapshot()).toEqual([])
  }
)

it("keeps v1 callbacks serialized and does not cancel their pending native effect", async () => {
  const f = await fixture(false)
  const first = f.surfaces.act(f.address, f.action())
  await vi.waitFor(() => expect(f.pending).toHaveLength(1))
  const second = f.surfaces.act(f.address, f.action())
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(f.pending).toHaveLength(1)
  expect(f.pending[0].signal.aborted).toBe(false)
  f.pending[0].release()
  await first
  await vi.waitFor(() => expect(f.pending).toHaveLength(2))
  f.pending[1].release()
  await second
  expect((await f.surfaces.read(f.address)).pane!.tree).toMatchObject({
    props: { label: "selected:2" }
  })
})
