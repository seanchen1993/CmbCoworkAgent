import { expect, it, vi } from "vitest"
import { withFunctionCommandBinding } from "./command-binding"
import { withFunctionExecution } from "./execution-context"

const scope = {
  workspace: "/project",
  threadId: "thread",
  leased: true,
  immediate: false,
  userInitiated: true
}

it("serializes native adapters through asynchronous cleanup, including failed calls", async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const order: string[] = []
  const call = (id: string) =>
    withFunctionExecution(scope, () =>
      withFunctionCommandBinding(
        "native",
        scope.workspace,
        scope.threadId,
        new AbortController().signal,
        async () => {
          order.push(`bind:${id}`)
          return async () => {
            if (id === "1") await gate
            order.push(`release:${id}`)
          }
        },
        async () => {
          order.push(`run:${id}`)
          if (id === "1") throw Error("failed")
          return id
        }
      )
    )
  const first = call("1")
  const failed = expect(first).rejects.toThrow("failed")
  const second = call("2")
  await vi.waitFor(() => expect(order).toEqual(["bind:1", "run:1"]))
  finish()
  await failed
  expect(await second).toBe("2")
  expect(order).toEqual(["bind:1", "run:1", "release:1", "bind:2", "run:2", "release:2"])
})

it("bounds native pending calls and never binds cancelled queued requests", async () => {
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const release = vi.fn()
  const bind = vi.fn(async () => release)
  const run = vi.fn(async () => gate)
  const controller = new AbortController()
  const call = () =>
    withFunctionExecution(scope, () =>
      withFunctionCommandBinding(
        "native",
        scope.workspace,
        scope.threadId,
        controller.signal,
        bind,
        run
      )
    )
  const first = call()
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  const pending = Array.from({ length: 15 }, () => call())
  const settled = Promise.allSettled(pending)
  await expect(call()).rejects.toThrow("MODS_COMMAND_LIMIT")
  controller.abort()
  finish()
  await first
  expect((await settled).every((result) => result.status === "rejected")).toBe(true)
  expect(bind).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
})

it("releases an adapter when its caller expires during asynchronous setup", async () => {
  let finish!: () => void
  const release = vi.fn()
  const run = vi.fn(async () => 1)
  const bind = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return release
  })
  let pending!: Promise<number>
  await withFunctionExecution(scope, async () => {
    pending = withFunctionCommandBinding(
      "native",
      scope.workspace,
      scope.threadId,
      new AbortController().signal,
      bind,
      run
    )
    await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce())
  })
  const failed = expect(pending).rejects.toThrow("SCOPE_EXPIRED")
  finish()
  await failed
  expect(run).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
})
