import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { ModFunctionError, type FunctionGuest } from "../../../shared/mods/v2/contracts"
import type {
  FunctionClientSnapshot,
  FunctionUiElement,
  FunctionUiNode
} from "../../../shared/mods/v2/ui"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { FunctionClients, type FunctionClientReconcilePlan } from "./clients"
import { FunctionGuestRuntime } from "./guest-runtime"

const healthy = `var __cmbSurfaceMod={default(p,s){return s.elements.Button({
  key:"increment",label:(p?.label||"Before")+":"+(s.state||0),
  onPress(){s.setState((s.state||0)+1)}
})}}`
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

function descriptor(key = "surface", module = "a.js", label = "Before"): FunctionUiNode {
  return { type: "Client", props: { key, module, props: { label } }, client: { plugin: "p" } }
}
function fixture(
  options: {
    publish?: (value: ModJson) => Promise<ModJson>
    message?: () => Promise<ModJson>
    wrap?: (guest: FunctionGuestRuntime) => FunctionGuest
  } = {}
) {
  let live = true
  const sources = new Map([
    ["a.js", healthy],
    ["b.js", healthy],
    ["bad.js", `var __cmbSurfaceMod={default(){throw Error("module failed")}}`],
    ["engine.js", `var __cmbSurfaceMod={default(){return {type:"engine",ref:0}}}`]
  ])
  const guests: FunctionGuestRuntime[] = []
  const current = new Map<string, string>()
  const faultPhases: ModJson[] = []
  const assertLive = () => {
    if (!live) throw new ModFunctionError("MODS_TEST_REVOKED")
  }
  const receipt = (pane: string, generation: string) =>
    current.get(pane) === generation
      ? {
          component: "Pane",
          signal: new AbortController().signal,
          release() { return undefined },
          assertCurrent() {
            assertLive()
            if (current.get(pane) !== generation) throw new ModFunctionError("MODS_UI_FAULT_STALE")
          },
          async redraw() { return undefined }
        }
      : undefined
  const clients = new FunctionClients({
    assertLive,
    background: (run) => run(),
    changed() { return undefined },
    publish: options.publish ?? (async (value) => value),
    message: options.message ?? (async () => ({})),
    control: async (_, input, core) => core(input),
    checkModule(plugin, module) {
      assertLive()
      if (plugin !== "p" || !sources.has(module))
        throw new ModFunctionError("MODS_CLIENT_MODULE_UNAPPROVED")
    },
    captureDrawing: receipt,
    captureFault: receipt,
    async fault(_, input) {
      faultPhases.push(input.phase)
    },
    async load(plugin, module) {
      const guest = await FunctionGuestRuntime.create(
        CLIENT_BOOTSTRAP + "\n" + sources.get(module),
        { plugin }
      )
      guests.push(guest)
      return options.wrap?.(guest) ?? guest
    }
  })
  cleanups.push(async () => {
    clients.close()
    for (const guest of guests) await guest.dispose()
  })
  const prepare = (pane: string, generation: string, tree = descriptor(), guard?: () => void) =>
    clients.prepareReconcile(pane, pane, generation, tree, false, "Pane", guard)
  const commit = (plan: FunctionClientReconcilePlan, pane: string, generation: string) => {
    clients.commitReconcile(plan)
    current.set(pane, generation)
  }
  const adopt = async (pane: string, tree = descriptor(), generation = randomUUID()) => {
    const plan = prepare(pane, generation, tree)
    try {
      commit(plan, pane, generation)
      return await clients.reconcilePrepared(plan)
    } finally {
      clients.discardReconcile(plan)
    }
  }
  return {
    clients,
    guests,
    current,
    sources,
    prepare,
    commit,
    adopt,
    faultPhases,
    revoke: () => {
      live = false
    }
  }
}
async function press(clients: FunctionClients, pane: string, snapshot: FunctionClientSnapshot) {
  if (snapshot.tree.type !== "Button") throw Error("expected the actual Client button")
  await clients.act({
    pane,
    instance: snapshot.id,
    generation: snapshot.generation,
    intentId: randomUUID(),
    kind: "press",
    handle: snapshot.tree.press!.handle
  })
}

it("preflight failure and discard leave the actual old VM, props and callback usable", async () => {
  const f = fixture()
  const [old] = await f.adopt("pane")
  const oldTree = old.tree
  expect(() =>
    f.prepare("pane", randomUUID(), descriptor("surface", "unapproved.js", "Changed"))
  ).toThrow("MODS_CLIENT_MODULE_UNAPPROVED")
  const discarded = f.prepare("pane", randomUUID(), descriptor("surface", "a.js", "Changed"))
  f.clients.discardReconcile(discarded)
  f.clients.discardReconcile(discarded)
  expect(f.guests).toHaveLength(1)
  expect(f.guests[0].stats.disposed).toBe(false)
  await press(f.clients, "pane", old)
  const [still] = await f.clients.reconcile("pane", "pane", old.generation, descriptor())
  expect(still.id).toBe(old.id)
  expect(still.tree).not.toBe(oldTree)
  expect(still.tree.type === "Button" && still.tree.props.label).toBe("Before:1")
})

it("preflight copies the final descriptor and does not load or render before commit", async () => {
  const f = fixture()
  const tree = descriptor("surface", "a.js", "Approved")
  const generation = randomUUID()
  const plan = f.prepare("pane", generation, tree)
  ;(tree.props.props as ModObject).label = "Mutated after preparation"
  expect(f.guests).toHaveLength(0)
  f.commit(plan, "pane", generation)
  expect(f.guests).toHaveLength(0)
  const [snapshot] = await f.clients.reconcilePrepared(plan)
  expect(snapshot.tree.type === "Button" && snapshot.tree.props.label).toBe("Approved:0")
  f.clients.discardReconcile(plan)
  await expect(f.clients.reconcilePrepared(plan)).rejects.toThrow("MODS_CLIENT_PLAN_STALE")
})

it("reserves the final capacity slot across distinct Pane/site candidates", async () => {
  const f = fixture()
  for (let index = 0; index < 7; index++) await f.adopt("existing-" + index)
  const first = f.prepare("site:A", randomUUID())
  expect(() => f.prepare("site:B", randomUUID())).toThrow("MODS_CLIENT_LIMIT")
  expect(f.guests).toHaveLength(7)
  f.clients.discardReconcile(first)
  const generation = randomUUID()
  const second = f.prepare("site:B", generation)
  f.commit(second, "site:B", generation)
  await f.clients.reconcilePrepared(second)
  expect(f.guests).toHaveLength(8)
  expect(() => f.prepare("site:C", randomUUID())).toThrow("MODS_CLIENT_LIMIT")
})

it("cannot serialize a token, use another owner token, or reuse a committed token", async () => {
  const f = fixture()
  const other = fixture()
  const plan = f.prepare("pane", randomUUID())
  const fake = JSON.parse(JSON.stringify(plan)) as FunctionClientReconcilePlan
  expect(() => f.clients.commitReconcile(fake)).toThrow("MODS_CLIENT_PLAN_INVALID")
  expect(() => other.clients.commitReconcile(plan)).toThrow("MODS_CLIENT_PLAN_INVALID")
  f.clients.commitReconcile(plan)
  expect(() => f.clients.commitReconcile(plan)).toThrow("MODS_CLIENT_PLAN_STALE")
  f.clients.discardReconcile(plan)
})

it("rejects a competing same-pane plan and closure-based revoke/regrant ABA", async () => {
  const f = fixture()
  const a = f.prepare("pane", randomUUID())
  const b = f.prepare("pane", randomUUID())
  f.clients.commitReconcile(b)
  expect(() => f.clients.commitReconcile(a)).toThrow("MODS_CLIENT_PLAN_STALE")
  f.clients.discardReconcile(a)
  f.clients.discardReconcile(b)
  let epoch = 0
  const captured = epoch
  const guarded = f.prepare("pane", randomUUID(), descriptor(), () => {
    if (epoch !== captured) throw new ModFunctionError("MODS_OWNER_EXPIRED")
  })
  epoch++ // revoke
  epoch++ // reapprove the same visible source and descriptor
  expect(() => f.clients.commitReconcile(guarded)).toThrow("MODS_OWNER_EXPIRED")
  expect(f.guests).toHaveLength(0)
  f.clients.discardReconcile(guarded)
})

it("rejects an actual accepted Client props ABA even when the final bytes match", async () => {
  let messages = 0
  const f = fixture({
    message: async () => ({
      props: { label: ++messages === 1 ? "Different" : "Before" }
    })
  })
  f.sources.set(
    "a.js",
    `var __cmbSurfaceMod={default(p,s){
    s.onFocus(()=>s.post({}));return s.elements.Text({children:p.label});
  }}`
  )
  const [old] = await f.adopt("pane")
  const plan = f.prepare("pane", randomUUID())
  for (let turn = 1; turn <= 2; turn++) {
    await f.clients.act({
      pane: "pane",
      instance: old.id,
      generation: old.generation,
      intentId: randomUUID(),
      kind: "focus",
      value: { focused: turn === 1 }
    })
    await expect.poll(() => messages).toBe(turn)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(() => f.clients.commitReconcile(plan)).toThrow("MODS_CLIENT_PLAN_STALE")
  expect(f.guests).toHaveLength(1)
  f.clients.discardReconcile(plan)
})

it("rejects plans after pane close, complete close, or module approval changes", () => {
  const f = fixture()
  const closedPane = f.prepare("pane", randomUUID())
  f.clients.closePane("pane")
  expect(() => f.clients.commitReconcile(closedPane)).toThrow("MODS_CLIENT_PLAN_STALE")
  const sourceChanged = f.prepare("pane", randomUUID())
  f.sources.delete("a.js")
  expect(() => f.clients.commitReconcile(sourceChanged)).toThrow("MODS_CLIENT_MODULE_UNAPPROVED")
  f.clients.discardReconcile(sourceChanged)
  f.sources.set("a.js", healthy)
  const closed = f.prepare("pane", randomUUID())
  f.clients.close()
  expect(() => f.clients.commitReconcile(closed)).toThrow("MODS_CLIENT_PLAN_STALE")
})

it("keeps committed parent identity when a real Client draw fails and notifies its local fault", async () => {
  const f = fixture()
  const generation = randomUUID()
  const [failed] = await f.adopt("pane", descriptor("surface", "bad.js"), generation)
  expect(f.current.get("pane")).toBe(generation)
  expect(failed.generation).toBe(generation)
  expect(failed.error).toBe("MODS_CLIENT_FAILED")
  await expect.poll(() => f.faultPhases).toContain("render")
})

it("does not turn native identity retirement into a returned local Client fault", async () => {
  const f = fixture()
  const generation = randomUUID()
  const plan = f.prepare("pane", generation)
  f.commit(plan, "pane", generation)
  f.revoke()
  await expect(f.clients.reconcilePrepared(plan)).rejects.toThrow("MODS_TEST_REVOKED")
  expect(f.guests).toHaveLength(0)
  expect(f.faultPhases).toEqual([])
  f.clients.discardReconcile(plan)
})

it.each(["raw", "protected", "snapshot"])(
  "refuses engine at the %s Client boundary",
  async (stage) => {
    const f = fixture({
      publish: async (value) => {
        if (stage === "protected" && !Array.isArray(value)) return { type: "engine", ref: 0 }
        if (stage === "snapshot" && Array.isArray(value))
          return value.map((row) => ({ ...(row as ModObject), tree: { type: "engine", ref: 0 } }))
        return value
      }
    })
    if (stage === "snapshot") {
      await expect(f.adopt("pane")).rejects.toThrow("MODS_UI_CLIENT_ENGINE")
    } else {
      const [snapshot] = await f.adopt(
        "pane",
        descriptor("surface", stage === "raw" ? "engine.js" : "a.js")
      )
      expect(snapshot.error).toBe("MODS_CLIENT_FAILED")
      expect(snapshot.tree.type).not.toBe("engine")
    }
  }
)

it("retains capacity until the real old VM disposal completes", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = fixture({
    wrap: (guest) => ({
      registrations: guest.registrations,
      get stats() {
        return guest.stats
      },
      invoke: (...args) => guest.invoke(...args),
      matches: (...args) => guest.matches(...args),
      releaseUi: (generation) => guest.releaseUi(generation),
      async dispose() {
        await gate
        await guest.dispose()
      }
    })
  })
  try {
    for (let index = 0; index < 8; index++) await f.adopt("pane-" + index)
    f.clients.closePane("pane-0")
    expect(f.guests[0].stats.disposed).toBe(false)
    expect(() => f.prepare("new", randomUUID())).toThrow("MODS_CLIENT_LIMIT")
  } finally {
    release()
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  const plan = f.prepare("new", randomUUID())
  f.clients.discardReconcile(plan)
})

it("accepts parent engine leaves while checking every actual Client descriptor", async () => {
  const f = fixture()
  const tree: FunctionUiElement = {
    type: "Box",
    props: {},
    children: [{ type: "engine", ref: 0 }, descriptor()]
  }
  expect(await f.adopt("pane", tree)).toHaveLength(1)
})
