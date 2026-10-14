import { AsyncLocalStorage } from "node:async_hooks"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import {
  FunctionSessionMeasurements,
  measurementSnapshot,
  withinMeasurementBudget
} from "./session-measure"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})
const usage = (tokens?: number, window = 1000): ModJson => ({
  context: {
    window,
    ...(tokens === undefined ? {} : { tokens, percent: Math.round((tokens / window) * 100) })
  },
  rateLimits: []
})
async function fixture(
  hook: string,
  neighbor = "",
  publish: (value: ModJson) => Promise<ModJson> = async (value) => value
) {
  const plugins = await Promise.all(
    [hook, neighbor].filter(Boolean).map(async (body, index) => ({
      name: `measure-${index}`,
      root: "/measure",
      tier: "user" as const,
      capabilities: [...SESSION_CAPABILITIES],
      guest: await FunctionGuestRuntime.create(`var seen=[];
    var __cmbFunctionMod={register(on){
      on("session.start",async($,e,next)=>{await $.command.register({name:"measure-${index}",description:"inspect"});return next(e)});
      on("command.run",{command:"measure-${index}"},async()=>({text:JSON.stringify(seen)}));
      ${body}
    }}`)
    }))
  )
  const session = new FunctionSession(plugins, {
    workspace: "/measure",
    threadId: "thread",
    publish,
    assertLive: () => undefined,
    readSession: async () => usage(125)
  })
  sessions.push(session)
  await session.start()
  const records = async (index = 0) =>
    JSON.parse(String((await session.run(`measure-${index}`, "")).text))
  let live = true
  const check = () => {
    if (!live) throw Error("original binding gone")
  }
  return {
    session,
    records,
    check,
    replace: () => {
      live = false
    }
  }
}

it("uses native figures, not SDK hook rewrites, and emits only actual changes including unavailable fill", async () => {
  const f = await fixture(`on("session.measure",async($,e,next)=>{seen.push(e);return next(e)});
    on("session.usage",async()=>({value:{context:{window:42,tokens:42},rateLimits:[]}}));`)
  const signal = new AbortController().signal
  const readings: ModJson[] = [
    usage(100),
    usage(100),
    usage(101),
    usage(undefined),
    usage(undefined, 2000)
  ]
  for (const value of readings) await f.session.measure(async () => value, signal, f.check)
  const rows = await f.records()
  expect(rows).toHaveLength(4)
  expect(rows.map((row) => row.context)).toEqual([
    { window: 1000, tokens: 100, percent: 10 },
    { window: 1000, tokens: 101, percent: 10 },
    { window: 1000 },
    { window: 2000 }
  ])
  expect(
    rows.every(
      (row) =>
        JSON.stringify(row.changed) === '["context"]' &&
        row.cost === undefined &&
        row.context.breakdown === undefined &&
        row.rateLimits.length === 0
    )
  ).toBe(true)
})

it("pins observer facts and ignores its own undefined or forged return while next echoes original changes", async () => {
  const f = await fixture(
    `on("session.measure",async($,e,next)=>{
    return next({...e,context:{window:9,tokens:9},changed:["cost"]})
  });`,
    `on("session.measure",async($,e,next)=>{
    seen.push({input:e,echo:await next(e),queried:await $.session.usage()});
    return {changed:["cost"],context:{window:7}}
  });`
  )
  await f.session.measure(async () => usage(125), new AbortController().signal, f.check)
  const [record] = await f.records(1)
  expect(record.input.context).toEqual({ window: 1000, tokens: 125, percent: 13 })
  expect(record.echo).toEqual({ changed: ["context"] })
  expect(record.queried.context.window).toBe(1000)
  const voidHook = await fixture('on("session.measure",async($,e)=>{seen.push(e)});')
  await voidHook.session.measure(
    async () => usage(125),
    new AbortController().signal,
    voidHook.check
  )
  await voidHook.session.measure(
    async () => usage(125),
    new AbortController().signal,
    voidHook.check
  )
  expect(await voidHook.records()).toHaveLength(1)
})

it("unmatched data filters and failed publication do not consume the first measurement", async () => {
  let blocked = false
  const f = await fixture(
    'on("session.measure",{context:{tokens:100}},async($,e,next)=>{seen.push(e);return next(e)});',
    "",
    async (value) => {
      if (blocked) throw Error("publication unavailable")
      return value
    }
  )
  const signal = new AbortController().signal
  await f.session.measure(async () => usage(50), signal, f.check)
  blocked = true
  await f.session.measure(async () => usage(100), signal, f.check)
  blocked = false
  await f.session.measure(async () => usage(100), signal, f.check)
  expect(await f.records()).toHaveLength(1)
})

it("zero matching event registrations perform no reads or notifications", async () => {
  const f = await fixture('on("tool.call",async($,e,next)=>next(e));')
  const read = vi.fn(async () => usage(100))
  await f.session.measure(read, new AbortController().signal, f.check)
  expect(read).not.toHaveBeenCalled()
})

it("scope replacement during native read or protection cannot publish to a new binding", async () => {
  const f = await fixture('on("session.measure",async($,e,next)=>{seen.push(e);return next(e)});')
  await f.session.measure(
    async () => {
      f.replace()
      return usage(100)
    },
    new AbortController().signal,
    f.check
  )
  expect(await f.records()).toEqual([])
  let replaceOnMeasure = false
  const second: Awaited<ReturnType<typeof fixture>> = await fixture(
    'on("session.measure",async($,e,next)=>{seen.push(e);return next(e)});',
    "",
    async (value) => {
      if (replaceOnMeasure && value && typeof value === "object" && "changed" in value)
        second.replace()
      return value
    }
  )
  replaceOnMeasure = true
  await second.session.measure(async () => usage(100), new AbortController().signal, second.check)
  replaceOnMeasure = false
  expect(await second.records()).toEqual([])
})

it("a delivered error consumes its baseline and a notification timeout stops late SDK callbacks", async () => {
  const f = await fixture(
    'on("session.measure",async($,e)=>{seen.push(e);throw Error("observer failure")});'
  )
  const signal = new AbortController().signal
  await f.session.measure(async () => usage(100), signal, f.check)
  await f.session.measure(async () => usage(100), signal, f.check)
  expect(await f.records()).toHaveLength(1)
  const timed = await fixture(`on("session.measure",async($,e,next)=>{
    seen.push(e); await $.clock.after(100,async()=>{seen.push("late");await $.ui.log("late")});
    await $.clock.sleep(200);return next(e)
  });`)
  await timed.session.measure(async () => usage(100), signal, timed.check, 25)
  await new Promise((resolve) => setTimeout(resolve, 230))
  expect(await timed.records()).toHaveLength(1)
  expect(await timed.session.logSnapshot()).toEqual([])
})

it("coalesces latest pending requests while preserving each enqueue caller's context", async () => {
  const queue = new FunctionSessionMeasurements()
  const owners = new AsyncLocalStorage<string>()
  const seen: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = owners.run("first", () =>
    queue.enqueue(async () => {
      seen.push(owners.getStore()!)
      await gate
    })
  )
  await Promise.resolve()
  const skipped = owners.run("skipped", () =>
    queue.enqueue(async () => {
      seen.push(owners.getStore()!)
    })
  )
  const latest = owners.run("latest", () =>
    queue.enqueue(async () => {
      seen.push(owners.getStore()!)
    })
  )
  release()
  await Promise.all([first, skipped, latest])
  expect(seen).toEqual(["first", "latest"])
  queue.close()
})

it("a successful short notification cancels its long timers while leaving the original task live", async () => {
  const f = await fixture(`on("session.measure",async($,e,next)=>{
    seen.push(e);await $.clock.after(100,async()=>seen.push("late-after"));
    await $.clock.every(100,async()=>seen.push("late-every"));return next(e)
  });`)
  const parent = new AbortController()
  await f.session.measure(async () => usage(100), parent.signal, f.check)
  await new Promise((resolve) => setTimeout(resolve, 220))
  expect(parent.signal.aborted).toBe(false)
  expect(await f.records()).toHaveLength(1)
  let completed!: AbortSignal
  await withinMeasurementBudget(parent.signal, async (active) => {
    completed = active
  })
  expect(completed.aborted).toBe(true)
  expect(parent.signal.aborted).toBe(false)
})

it("native reentry only replaces pending and never awaits itself", async () => {
  const queue = new FunctionSessionMeasurements()
  const seen: string[] = []
  await queue.enqueue(async () => {
    seen.push("first")
    await queue.enqueue(async () => {
      seen.push("reentered")
    })
    seen.push("continued")
  })
  expect(seen).toEqual(["first", "continued", "reentered"])
  queue.close()
})

it("an enqueue at the final microtask boundary cannot lose its drainer", async () => {
  const queue = new FunctionSessionMeasurements()
  const seen: string[] = []
  let late!: Promise<void>
  await queue.enqueue(async () => {
    seen.push("first")
    queueMicrotask(() =>
      queueMicrotask(() => {
        late = queue.enqueue(async () => {
          seen.push("late")
        })
      })
    )
  })
  await late
  expect(seen).toEqual(["first", "late"])
  queue.close()
})

it("full real guest frame admission does not consume an unseen measurement", async () => {
  const f = await fixture(`on("session.measure",async($,e,next)=>{seen.push(e);return next(e)});
    on("probe.block",async()=>new Promise(()=>{}));`)
  const guest = f.session.plugins[0].guest as FunctionGuestRuntime
  const registration = guest.registrations.find((row) => row.pattern === "probe.block")!
  const hold = new AbortController()
  const pending = Array.from({ length: 32 }, () =>
    guest
      .invoke(registration.id, {}, async () => ({}), {
        event: "probe.block",
        origin: { plugin: "engine", tier: "core" },
        capabilities: [],
        plugin: { name: "measure-0", root: "/measure" },
        signal: hold.signal
      })
      .catch(() => undefined)
  )
  expect(guest.stats.frames).toBe(32)
  await f.session.measure(async () => usage(100), new AbortController().signal, f.check)
  hold.abort()
  await Promise.all(pending)
  await f.session.measure(async () => usage(100), new AbortController().signal, f.check)
  expect(await f.records()).toHaveLength(1)
})

it("cancellation after host admission does not claim callback execution or replay a raised measurement", async () => {
  const f = await fixture('on("session.measure",async($,e,next)=>{seen.push(e);return next(e)});')
  const parent = new AbortController()
  const guest = f.session.plugins[0].guest
  const original = guest.invoke.bind(guest)
  let cancelAck = true
  const bridge = vi.spyOn(guest, "invoke").mockImplementation((id, event, host, invocation) =>
    original(
      id,
      event,
      async (method, args, signal) => {
        const answer = await host(method, args, signal)
        if (method === "invoke.admitted" && cancelAck) {
          cancelAck = false
          parent.abort()
        }
        return answer
      },
      invocation
    )
  )
  try {
    await f.session.measure(async () => usage(100), parent.signal, f.check)
    expect(await f.records()).toEqual([])
    await f.session.measure(async () => usage(100), new AbortController().signal, f.check)
    expect(await f.records()).toEqual([])
    await f.session.measure(async () => usage(200), new AbortController().signal, f.check)
    const [record] = await f.records()
    expect(record.context.tokens).toBe(200)
  } finally {
    bridge.mockRestore()
  }
})

it("snapshots only verified usage fields, strips breakdown and rejects invalid numbers", () => {
  expect(
    measurementSnapshot({
      context: { window: 1000, breakdown: { secret: "category" } },
      rateLimits: []
    })
  ).toEqual({ context: { window: 1000 }, rateLimits: [] })
  const invalid: ModJson[] = [
    usage(1, 0),
    { context: { window: 10, tokens: -1 }, rateLimits: [] },
    { context: { window: 10 }, rateLimits: [], cost: { usd: -1 } }
  ]
  for (const value of invalid)
    expect(() => measurementSnapshot(value)).toThrow("MEASUREMENT_UNAVAILABLE")
})
