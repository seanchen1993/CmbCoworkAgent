import { AsyncLocalStorage } from "node:async_hooks"
import { afterEach, expect, it } from "vitest"
import type { ModObject } from "../../../shared/mods/types"
import { FunctionPluginPromptQueue, type FunctionPluginPromptScope } from "./plugin-prompt-queue"

const queues: FunctionPluginPromptQueue[] = []
afterEach(() => queues.splice(0).forEach((queue) => queue.close()))
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const origin = { kind: "plugin" as const, name: "actual" }
it("runs actual queue dispatch and terminal cleanup under the host owner, outside a child guard", async () => {
  const guards = new AsyncLocalStorage<() => void>()
  const started = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const queue = new FunctionPluginPromptQueue({
    busy: () => false,
    claim: () => ({
      assertCurrent: () => {},
      release: () => {
        expect(guards.getStore()).toBeUndefined()
        finished.resolve()
      }
    }),
    run: async (_, __, ___, ____, _____, announce) => {
      expect(guards.getStore()).toBeUndefined()
      announce()
      started.resolve()
    },
    onIdle: () => () => {}
  })
  queues.push(queue)
  const ticket = queue.reserve({
    workspace: "project",
    threadId: "thread",
    origin,
    signal: new AbortController().signal,
    assertLive: () => {}
  })
  guards.run(
    () => {
      throw Error("ACTUAL_OLD_CHILD_GUARD_EXPIRED")
    },
    () => {
      ticket.accept({ text: "words", origin, wait: false })
      ticket.finish({ text: "words", origin })
    }
  )
  await started.promise
  await finished.promise
  await expect(ticket.wait()).resolves.toMatchObject({ text: "words" })
  expect(queue.size).toBe(0)
})
function fixture() {
  let busy = true,
    collision = false,
    now = 0,
    valid = true,
    starts = true
  let releaseFails = false,
    busyFails = false
  const listeners = new Set<(thread: string) => void>()
  const runs: Array<{ input: ModObject; framed: boolean; start(): void; end(): void }> = []
  let releases = 0
  const queue = new FunctionPluginPromptQueue(
    {
      busy: () => {
        if (busyFails) throw Error("BUSY_FAILED")
        return busy
      },
      claim: () =>
        collision
          ? undefined
          : {
              assertCurrent: () => {
                if (!valid) throw Error("LEASE_CHANGED")
              },
              release: () => {
                releases++
                if (releaseFails) throw Error("RELEASE_FAILED")
              }
            },
      run: async (_, input, framed, __, signal, started) => {
        if (!starts) return
        let end!: () => void
        const completion = new Promise<void>((resolve, reject) => {
          end = resolve
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
        runs.push({ input, framed, start: started, end })
        await completion
      },
      onIdle: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      error: () => {
        throw Error("ERROR_LOG_FAILED")
      }
    },
    () => now
  )
  queues.push(queue)
  const controller = new AbortController()
  const scope: FunctionPluginPromptScope = {
    workspace: "project",
    threadId: "thread",
    origin,
    signal: controller.signal,
    assertLive: () => {
      if (!valid) throw Error("SCOPE_CHANGED")
    }
  }
  return {
    queue,
    scope,
    controller,
    runs,
    releases: () => releases,
    wake: () => listeners.forEach((listener) => listener("thread")),
    idle: () => {
      busy = false
      listeners.forEach((listener) => listener("thread"))
    },
    collision: (value: boolean) => {
      collision = value
    },
    expire: () => {
      valid = false
    },
    now: (value: number) => {
      now = value
    },
    noStart: () => {
      starts = false
    },
    releaseFails: () => {
      releaseFails = true
    },
    busyFails: () => {
      busyFails = true
    }
  }
}
function accepted(f: ReturnType<typeof fixture>, text = "actual words") {
  const ticket = f.queue.reserve(f.scope)
  const core = ticket.accept({ text, origin, wait: false, context: ["hidden"] })
  return { ticket, core }
}

it("keeps child admission, core acceptance and actual started separate", async () => {
  const f = fixture()
  const ticket = f.queue.reserve(f.scope)
  let settled = false
  void ticket.wait().then(() => {
    settled = true
  })
  f.idle()
  await flush()
  expect(f.runs).toHaveLength(0)
  const core = ticket.accept({ text: "words", origin, wait: false })
  await flush()
  expect(f.runs).toHaveLength(0)
  ticket.finish(core)
  await flush()
  expect(f.runs).toHaveLength(1)
  expect(settled).toBe(false)
  f.runs[0].start()
  await expect(ticket.wait()).resolves.toEqual(core)
  expect(f.queue.size).toBe(1)
  ticket.close()
  expect(ticket.signal.aborted).toBe(false)
  f.runs[0].end()
  await flush()
  expect(f.queue.size).toBe(0)
  expect(f.releases()).toBe(1)
})

it("does not replace accepted words or hidden context with a late rewrite", async () => {
  const f = fixture(),
    { ticket, core } = accepted(f)
  ticket.accept({ text: "duplicate next", origin, wait: false })
  ticket.finish({ text: "public final reply", context: ["late"] })
  f.idle()
  await flush()
  expect(f.runs).toHaveLength(1)
  expect(f.runs[0].input.text).toBe(core.text)
  expect(f.runs[0].input.context).toEqual(["hidden"])
  expect(f.runs[0].framed).toBe(false)
  f.runs[0].start()
  await expect(ticket.wait()).resolves.toEqual({ text: "public final reply", context: ["late"] })
  f.runs[0].end()
})

it("does not turn final drop after core into a rollback", async () => {
  const f = fixture(),
    { ticket } = accepted(f)
  ticket.finish({ drop: "final drop" })
  f.idle()
  await flush()
  expect(f.runs).toHaveLength(1)
  f.runs[0].start()
  await expect(ticket.wait()).resolves.toEqual({ drop: "final drop" })
  f.runs[0].end()
})

it("does not launch when no hook reaches core", async () => {
  const f = fixture(),
    ticket = f.queue.reserve(f.scope)
  ticket.finish({ text: "handled locally" })
  f.idle()
  await flush()
  await expect(ticket.wait()).resolves.toEqual({ text: "handled locally" })
  expect(f.runs).toHaveLength(0)
  expect(f.queue.size).toBe(0)
})

it("preserves FIFO core order and waits for real run settlement", async () => {
  const f = fixture(),
    first = accepted(f, "first"),
    second = accepted(f, "second")
  second.ticket.finish(second.core)
  f.idle()
  await flush()
  expect(f.runs).toHaveLength(0)
  first.ticket.finish(first.core)
  await flush()
  expect(f.runs.map((run) => run.input.text)).toEqual(["first"])
  f.runs[0].start()
  f.wake()
  await flush()
  expect(f.runs).toHaveLength(1)
  f.runs[0].end()
  await flush()
  expect(f.runs.map((run) => run.input.text)).toEqual(["first", "second"])
  f.runs[1].start()
  f.runs[1].end()
})

it("keeps queued work after a lost atomic lease race", async () => {
  const f = fixture(),
    { ticket, core } = accepted(f)
  ticket.finish(core)
  f.collision(true)
  f.idle()
  await flush()
  expect(f.queue.size).toBe(1)
  expect(f.runs).toHaveLength(0)
  f.collision(false)
  f.wake()
  await flush()
  expect(f.runs).toHaveLength(1)
  f.runs[0].start()
  f.runs[0].end()
})

it("removes an abandoned head and wakes its already-ready successor", async () => {
  const f = fixture(),
    controller = new AbortController()
  const firstTicket = f.queue.reserve({ ...f.scope, signal: controller.signal })
  firstTicket.accept({ text: "first", origin, wait: false })
  const second = accepted(f, "second")
  second.ticket.finish(second.core)
  f.idle()
  await flush()
  controller.abort(Error("SOURCE_RETIRED"))
  await flush()
  await expect(firstTicket.wait()).rejects.toThrow("SOURCE_RETIRED")
  expect(f.runs.map((run) => run.input.text)).toEqual(["second"])
  f.runs[0].start()
  f.runs[0].end()
})

it("rejects a revoked scope without native execution or automatic replay", async () => {
  const f = fixture(),
    { ticket, core } = accepted(f)
  ticket.finish(core)
  f.expire()
  f.idle()
  await flush()
  await expect(ticket.wait()).rejects.toThrow("SCOPE_CHANGED")
  expect(f.runs).toHaveLength(0)
  expect(f.queue.size).toBe(0)
})

it("terminates early no-start and true lifetime cancellation waiters", async () => {
  const f = fixture(),
    { ticket, core } = accepted(f)
  f.noStart()
  ticket.finish(core)
  f.idle()
  await expect(ticket.wait()).rejects.toThrow("MODS_PLUGIN_PROMPT_NOT_STARTED")
  const another = accepted(f)
  f.controller.abort(Error("SESSION_RETIRED"))
  await expect(another.ticket.wait()).rejects.toThrow("SESSION_RETIRED")
  expect(f.queue.size).toBe(0)
})

it("bounds pending child admissions before they ever reach core", () => {
  const f = fixture()
  for (let i = 0; i < 8; i++) f.queue.reserve(f.scope)
  expect(() => f.queue.reserve(f.scope)).toThrow("MODS_PLUGIN_PROMPT_CAPACITY")
  expect(f.queue.size).toBe(8)
})

it("preserves plugin rate budgets across resident scopes and clears them lazily", async () => {
  const f = fixture()
  f.noStart()
  f.idle()
  for (let i = 0; i < 20; i++) {
    const next = accepted(f)
    next.ticket.finish(next.core)
    await expect(next.ticket.wait()).rejects.toThrow("MODS_PLUGIN_PROMPT_NOT_STARTED")
    await flush()
  }
  const changedScope = { ...f.scope, signal: new AbortController().signal }
  const limited = f.queue.reserve(changedScope)
  expect(() => limited.accept({ text: "over budget", origin, wait: false })).toThrow(
    "MODS_PLUGIN_PROMPT_RATE_LIMIT"
  )
  limited.close()
  f.now(60000)
  const next = accepted(f)
  next.ticket.finish(next.core)
  await expect(next.ticket.wait()).rejects.toThrow("MODS_PLUGIN_PROMPT_NOT_STARTED")
})

it("closes all pending waiters and detaches idle admission", async () => {
  const f = fixture(),
    { ticket, core } = accepted(f)
  ticket.finish(core)
  f.queue.close()
  f.idle()
  await flush()
  await expect(ticket.wait()).rejects.toThrow("MODS_PLUGIN_PROMPT_CLOSED")
  expect(f.runs).toHaveLength(0)
  expect(f.queue.size).toBe(0)
})

it("validates final local replies even without a core commit", () => {
  const f = fixture(),
    ticket = f.queue.reserve(f.scope)
  expect(() => ticket.finish({ drop: "" })).toThrow("MODS_PROMPT_SUBMIT_RESULT")
  expect(() => ticket.finish({ text: "words", origin: { kind: "composer" } })).toThrow(
    "MODS_PROMPT_SUBMIT_RESULT"
  )
  expect(() => ticket.finish({ text: "words", forged: true })).toThrow("MODS_PROMPT_SUBMIT_INPUT")
  ticket.close()
})

it("keeps a committed effect when a failed public reply releases its SDK resource", async () => {
  const f = fixture(),
    { ticket } = accepted(f)
  ticket.fail(Error("FINAL_REPLY_FAILED"))
  await expect(ticket.wait()).rejects.toThrow("FINAL_REPLY_FAILED")
  ticket.close()
  f.idle()
  await flush()
  expect(f.runs).toHaveLength(1)
  expect(f.runs[0].input.text).toBe("actual words")
  f.runs[0].start()
  f.runs[0].end()
})

it("dispatches now but waits for actual Session startup before launching", async () => {
  const f = fixture(),
    { ticket, core } = accepted(f)
  let ready!: () => void
  ticket.deferUntil(
    new Promise<void>((resolve) => {
      ready = resolve
    })
  )
  ticket.finish(core)
  f.idle()
  await flush()
  expect(f.queue.size).toBe(1)
  expect(f.runs).toHaveLength(0)
  ready()
  await flush()
  expect(f.runs).toHaveLength(1)
  f.runs[0].start()
  f.runs[0].end()
})

it("retires an intent when startup fails instead of launching a partially loaded Session", async () => {
  const f = fixture(),
    { ticket, core } = accepted(f)
  ticket.deferUntil(Promise.reject(Error("STARTUP_FAILED")))
  ticket.finish(core)
  f.idle()
  await expect(ticket.wait()).rejects.toThrow("STARTUP_FAILED")
  await flush()
  expect(f.runs).toHaveLength(0)
  expect(f.queue.size).toBe(0)
})

it("releases capacity and advances FIFO even when native cleanup and its logger throw", async () => {
  const f = fixture(),
    first = accepted(f, "first"),
    second = accepted(f, "second")
  first.ticket.finish(first.core)
  second.ticket.finish(second.core)
  f.releaseFails()
  f.idle()
  await flush()
  f.runs[0].start()
  f.runs[0].end()
  await flush()
  expect(f.runs.map((run) => run.input.text)).toEqual(["first", "second"])
  expect(f.queue.size).toBe(1)
  f.runs[1].start()
  f.runs[1].end()
  await flush()
  expect(f.queue.size).toBe(0)
  expect(f.releases()).toBe(2)
})

it("fails a broken busy inspection without stranding its queued waiter", async () => {
  const f = fixture(),
    { ticket, core } = accepted(f)
  ticket.finish(core)
  f.busyFails()
  f.idle()
  await expect(ticket.wait()).rejects.toThrow("BUSY_FAILED")
  expect(f.queue.size).toBe(0)
  expect(f.runs).toHaveLength(0)
})
