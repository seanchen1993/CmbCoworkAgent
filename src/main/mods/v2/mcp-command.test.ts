import { beforeEach, expect, it, vi } from "vitest"
import { withFunctionMcpCommand } from "./mcp-command"
import { withFunctionExecution } from "./execution-context"

const { bind, release } = vi.hoisted(() => ({ bind: vi.fn(), release: vi.fn() }))
vi.mock("../../mcp/capability-service", () => ({ getGlobalMcpCapabilityService: () => ({}) }))
vi.mock("../../hooks/scope", () => ({
  createHookScope: () => ({}),
  resolveEnabledHooksForRun: () => []
}))
vi.mock("../../agent/runtime", () => ({
  createScopedMcpCapabilityService: (...args: unknown[]) => {
    bind()
    ;(args[5] as { onModBinding(release: () => void): void }).onModBinding(release)
  }
}))
const scope = {
  workspace: "/project",
  threadId: "thread",
  userInitiated: true,
  immediate: false,
  leased: true
}
beforeEach(() => {
  bind.mockClear()
  release.mockClear()
})
const run = <T>(signal: AbortSignal, invoke: () => Promise<T>) =>
  withFunctionExecution(scope, () =>
    withFunctionMcpCommand("/project", "thread", "turn", signal, invoke)
  )

it("serializes concurrent cold MCP calls and releases a failed binding before the next call", async () => {
  let unblock!: () => void
  const gate = new Promise<void>((resolve) => {
    unblock = resolve
  })
  const first = run(new AbortController().signal, async () => {
    await gate
    throw Error("lost")
  })
  const failure = expect(first).rejects.toThrow("lost")
  await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce())
  const second = run(new AbortController().signal, async () => {
    expect(release).toHaveBeenCalledOnce()
    return "second"
  })
  expect(bind).toHaveBeenCalledOnce()
  unblock()
  await failure
  expect(await second).toBe("second")
  expect(release).toHaveBeenCalledTimes(2)
})

it.each(["cancel", "expired"])(
  "does not create a fresh binding for a %s queued caller",
  async (mode) => {
    let unblock!: () => void
    const first = run(
      new AbortController().signal,
      () =>
        new Promise<void>((resolve) => {
          unblock = resolve
        })
    )
    await vi.waitFor(() => expect(bind).toHaveBeenCalledOnce())
    const controller = new AbortController()
    const invoke = vi.fn(async () => "unexpected")
    let second!: Promise<string>
    if (mode === "expired") {
      await withFunctionExecution(scope, async () => {
        second = withFunctionMcpCommand("/project", "thread", "turn", controller.signal, invoke)
      })
    } else {
      second = run(controller.signal, invoke)
      controller.abort()
    }
    const rejected = expect(second).rejects.toThrow()
    unblock()
    await first
    await rejected
    expect(bind).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
    expect(await run(new AbortController().signal, async () => "recovered")).toBe("recovered")
    expect(release).toHaveBeenCalledTimes(2)
  }
)
