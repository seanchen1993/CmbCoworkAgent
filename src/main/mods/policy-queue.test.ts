import { afterEach, expect, it, vi } from "vitest"
const control = vi.hoisted(() => ({ invoke: vi.fn(), stop: vi.fn(), load: vi.fn() }))
vi.mock("./runtime-client", () => ({
  ModRuntimeClient: class {
    version = 0
    load(...args: unknown[]) {
      return control.load(...args)
    }
    invoke(...args: unknown[]) {
      return control.invoke(...args)
    }
    stop() {
      control.stop()
    }
  }
}))
import { ManagedModPolicy } from "./policy"
const identity = {
  workspace: "workspace",
  threadId: "thread",
  turnId: "turn",
  agentId: "main",
  callId: "policy",
  origin: "mod" as const,
  grantEpoch: 1
}
afterEach(() => vi.resetAllMocks())

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

const filtered = (value: string) => ({ allow: true, value, ruleIds: [] })

it("cancels queued policy promptly without releasing an active predecessor or invoking the worker", async () => {
  const policy = new ManagedModPolicy()
  let release!: (value: { allow: boolean }) => void
  let entered!: () => void
  const active = new Promise<void>((resolve) => {
    entered = resolve
  })
  control.load.mockResolvedValue([])
  control.invoke
    .mockImplementationOnce(() => {
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    .mockResolvedValue({ allow: true })
  const first = policy.admit(identity, "first", {})
  await active
  const controller = new AbortController()
  const phases: string[] = []
  const cancelled = policy.admit(identity, "cancelled", {}, controller.signal, (phase) =>
    phases.push(phase)
  )
  const rejected = expect(cancelled).rejects.toThrow("MODS_CANCELLED")
  const finalPhases: string[] = []
  const last = policy.admit(identity, "last", {}, undefined, (phase) => finalPhases.push(phase))
  controller.abort()
  await rejected
  expect(phases).toEqual(["queued"])
  expect(finalPhases).toEqual(["queued"])
  expect(control.invoke).toHaveBeenCalledOnce()
  expect(control.stop).not.toHaveBeenCalled()
  release({ allow: true })
  await Promise.all([first, last])
  expect(control.invoke.mock.calls.map((call) => call[2].toolId)).toEqual(["first", "last"])
  expect(finalPhases).toEqual(["queued", "entered", "allowed"])
  policy.stop()
})

it("does not poison worker generation when an already-aborted admission arrives", async () => {
  const policy = new ManagedModPolicy()
  control.load.mockResolvedValue([])
  control.invoke.mockResolvedValue({ allow: true })
  await expect(policy.admit(identity, "cancelled", {}, AbortSignal.abort())).rejects.toThrow(
    "MODS_CANCELLED"
  )
  expect(control.load).not.toHaveBeenCalled()
  expect(control.stop).not.toHaveBeenCalled()
  await policy.admit(identity, "after", {})
  expect(control.invoke).toHaveBeenCalledOnce()
  policy.stop()
})

it("skips a cancelled filter after a healthy load and reuses that load", async () => {
  const policy = new ManagedModPolicy()
  const loading = deferred<void>()
  const load = deferred<unknown[]>()
  control.load.mockResolvedValue([]).mockImplementationOnce(() => {
    loading.resolve(undefined)
    return load.promise
  })
  control.invoke.mockImplementation(async (...args: unknown[]) => {
    // Match the legacy client's pre-dispatch abort check.
    if ((args[4] as AbortSignal | undefined)?.aborted) throw Error("MODS_CANCELLED")
    return filtered("retained")
  })
  const controller = new AbortController()
  const first = policy.filter("discard", controller.signal)
  void first.catch(() => {})
  let next: ReturnType<ManagedModPolicy["filter"]> | undefined
  try {
    await Promise.race([loading.promise, first])
    controller.abort()
    next = policy.filter("next")
    void next.catch(() => {})
    load.resolve([])
    await expect(first).rejects.toThrow("MODS_CANCELLED")
    await expect(next).resolves.toMatchObject({ value: "retained" })
    expect(control.load).toHaveBeenCalledOnce()
    expect(control.invoke).toHaveBeenCalledOnce()
    expect(control.invoke.mock.calls[0][2]).toMatchObject({ value: "next" })
    expect(control.stop).not.toHaveBeenCalled()
  } finally {
    load.resolve([])
    await Promise.allSettled([first, next])
    policy.stop()
  }
})

it("drains a cancelled publication before allowing its successor without caching the result", async () => {
  const policy = new ManagedModPolicy()
  const entered = deferred<void>()
  const response = deferred<unknown>()
  control.load.mockResolvedValue([])
  control.invoke.mockImplementationOnce(() => {
    entered.resolve(undefined)
    return response.promise
  }).mockResolvedValue(filtered("current-result"))
  const controller = new AbortController()
  const record = vi.fn()
  const first = policy.publish("same-input", undefined, controller.signal, record)
  void first.catch(() => {})
  let next: Promise<string> | undefined
  try {
    await Promise.race([entered.promise, first])
    let settled = false
    void first.then(() => { settled = true }, () => { settled = true })
    next = policy.publish("successor")
    void next.catch(() => {})
    controller.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    expect(control.invoke).toHaveBeenCalledOnce()
    expect(control.invoke.mock.calls[0][4]).toBeUndefined()
    expect(record).not.toHaveBeenCalled()
    expect(control.stop).not.toHaveBeenCalled()

    response.resolve(filtered("cancelled-result"))
    await expect(first).rejects.toThrow("MODS_CANCELLED")
    await expect(next).resolves.toBe("current-result")
    expect(record).not.toHaveBeenCalled()
    await expect(policy.filter("same-input")).resolves.toMatchObject({ value: "current-result" })
    expect(control.invoke.mock.calls.map(call => call[2].value)).toEqual([
      "same-input", "successor", "same-input"
    ])
    expect(control.load).toHaveBeenCalledOnce()
    expect(control.stop).not.toHaveBeenCalled()
  } finally {
    response.resolve(filtered("released"))
    await Promise.allSettled([first, next])
    policy.stop()
  }
})

it("checks publication cancellation after an already cached filter finishes", async () => {
  const policy = new ManagedModPolicy()
  control.load.mockResolvedValue([])
  control.invoke.mockResolvedValue(filtered("safe"))
  const controller = new AbortController()
  const record = vi.fn()
  try {
    await policy.filter("cached")
    const publication = policy.publish("cached", undefined, controller.signal, record)
    controller.abort()
    await expect(publication).rejects.toThrow("MODS_CANCELLED")
    expect(control.invoke).toHaveBeenCalledOnce()
    expect(record).not.toHaveBeenCalled()
    expect(control.stop).not.toHaveBeenCalled()
  } finally {
    policy.stop()
  }
})

it.each(["rejected invocation", "invalid generic result"] as const)(
  "still retires the policy worker for a %s during cancellation",
  async (failure) => {
    const policy = new ManagedModPolicy()
    const entered = deferred<void>()
    const response = deferred<unknown>()
    control.load.mockResolvedValue([])
    control.invoke.mockImplementationOnce(() => {
      entered.resolve(undefined)
      return response.promise
    }).mockResolvedValue(filtered("safe"))
    const controller = new AbortController()
    const first = policy.filter("discard", controller.signal)
    void first.catch(() => {})
    try {
      await Promise.race([entered.promise, first])
      controller.abort()
      if (failure === "rejected invocation") response.reject(Error("WORKER_FAILURE"))
      else response.resolve("not-an-object")
      await expect(first).rejects.toThrow("MODS_CANCELLED")
      expect(control.stop).toHaveBeenCalledOnce()
      await expect(policy.filter("next")).resolves.toMatchObject({ value: "safe" })
      expect(control.load).toHaveBeenCalledTimes(2)
    } finally {
      response.resolve(filtered("released"))
      await Promise.allSettled([first])
      policy.stop()
    }
  }
)

it("validates the filter-specific result before discarding a cancelled publication", async () => {
  const policy = new ManagedModPolicy()
  const entered = deferred<void>()
  const response = deferred<unknown>()
  control.load.mockResolvedValue([])
  control.invoke.mockImplementationOnce(() => {
    entered.resolve(undefined)
    return response.promise
  })
  const controller = new AbortController()
  const first = policy.filter("discard", controller.signal)
  void first.catch(() => {})
  try {
    await Promise.race([entered.promise, first])
    controller.abort()
    response.resolve({ allow: true, value: "unpublishable", ruleIds: ["invalid rule"] })
    await expect(first).rejects.toThrow("MODS_POLICY_RESULT")
    expect(control.stop).not.toHaveBeenCalled()
  } finally {
    response.resolve(filtered("released"))
    await Promise.allSettled([first])
    policy.stop()
  }
})

it("still forwards the exact abort signal for an admitted tool policy invocation", async () => {
  const policy = new ManagedModPolicy()
  const entered = deferred<void>()
  const response = deferred<unknown>()
  control.load.mockResolvedValue([])
  const controller = new AbortController()
  const onAbort = vi.fn(() => { response.reject(Error("MODS_CANCELLED")) })
  controller.signal.addEventListener("abort", onAbort, { once: true })
  control.invoke.mockImplementationOnce(() => {
    entered.resolve(undefined)
    return response.promise
  })
  const first = policy.admit(identity, "tool", {}, controller.signal)
  void first.catch(() => {})
  try {
    await Promise.race([entered.promise, first])
    expect(control.invoke.mock.calls[0][4]).toBe(controller.signal)
    controller.abort()
    await expect(first).rejects.toThrow("MODS_CANCELLED")
    expect(onAbort).toHaveBeenCalledOnce()
    expect(control.stop).toHaveBeenCalledOnce()
  } finally {
    controller.signal.removeEventListener("abort", onAbort)
    response.resolve({ allow: true })
    await Promise.allSettled([first])
    policy.stop()
  }
})
