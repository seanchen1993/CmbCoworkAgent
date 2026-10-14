import { beforeEach, expect, it, vi } from "vitest"
import { withFunctionMcpCommand } from "./mcp-command"
import { withFunctionExecution } from "./execution-context"
import type { McpCapabilityService } from "../../mcp/capability-types"
import type { ClawProfile } from "../../../shared/mods/claw"

const { bind, release, profile, invoke, tools, sources } = vi.hoisted(() => ({
  bind: vi.fn(),
  release: vi.fn(),
  profile: vi.fn<() => ClawProfile | null>(),
  invoke: vi.fn(),
  sources: ["a", "b"].map((id) => ({ id, name: id, digest: id.repeat(64) })),
  tools: ["a", "b"].map((id) => ({
    capabilityId: `${id}:echo`,
    providerKey: id,
    providerDisplayName: id,
    providerAlias: id,
    toolName: "echo",
    toolId: `mcp__${id}__echo`,
    visibility: "eager" as const
  }))
}))
vi.mock("../manager", () => ({ getModsManager: () => ({ clawProfile: profile }) }))
vi.mock("../../mcp/capability-service", () => ({
  getGlobalMcpCapabilityService: () => ({
    listTools: async () => tools,
    peekTools: () => tools,
    invoke
  }),
  readConfiguredClawMcpSources: () => sources
}))
vi.mock("../../hooks/scope", () => ({
  createHookScope: () => ({}),
  resolveEnabledHooksForRun: () => []
}))
vi.mock("../../agent/runtime", () => ({
  createScopedMcpCapabilityService: (...args: unknown[]) => {
    bind(args[0])
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
  profile.mockReturnValue(null)
  invoke
    .mockReset()
    .mockImplementation(async (id) => ({ capabilityId: id, text: id, raw: {}, isError: false }))
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

it("constrains standalone cold command SDK discovery and execution to its thread selection", async () => {
  profile.mockReturnValue({
    id: "selected",
    name: "selected",
    capabilities: [],
    mcp: { mode: "selected", items: [sources[0]] }
  })
  await run(new AbortController().signal, async () => {
    const service = bind.mock.calls.at(-1)![0] as McpCapabilityService
    expect((await service.listTools()).map((tool) => tool.providerKey)).toEqual(["a"])
    await expect(service.invoke("b:echo", {})).rejects.toThrow("CLAW_MCP_TOOL_NOT_SELECTED")
    expect((await service.invoke("a:echo", {})).text).toBe("a:echo")
  })
  expect(profile).toHaveBeenCalledWith("/project", "thread")
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledOnce()
})
