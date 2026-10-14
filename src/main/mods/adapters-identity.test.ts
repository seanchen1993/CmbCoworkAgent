import { afterEach, expect, it, vi } from "vitest"
import type { ModObject } from "../../shared/mods/types"
import {
  getCurrentHookAgentId,
  getHookAgentIdFromRequest,
  HOOK_AGENT_OWNER_METADATA_KEY,
  runWithHookAgentId
} from "../hooks/execution-context"
import type { ModThreadBinding } from "./manager"
import { getModCallContext } from "./context"
import { ModRuntimeAuthorities } from "./runtime-instance"
import { withModToolCall } from "./adapters"

const state = vi.hoisted(() => ({ manager: undefined as object | undefined }))
vi.mock("./manager", () => ({ getModsManager: () => state.manager }))

const owners: ModRuntimeAuthorities[] = []
afterEach(() => {
  state.manager = undefined
  for (const owner of owners.splice(0)) owner.close()
})

function fixture() {
  const registry = new ModRuntimeAuthorities()
  owners.push(registry)
  const instance = registry.create({
    workspace: "/host-workspace", threadId: "thread", turnId: "host-turn",
    agentId: "mod-task:host-authority"
  })
  const binding: ModThreadBinding = { ...instance.authority, runtimeAuthority: instance.authority }
  const intercept = vi.fn(async (
    _binding: ModThreadBinding,
    input: ModObject,
    core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>
  ) => core(input, new AbortController().signal))
  const manager = {
    isActive: vi.fn(() => true),
    workspaceKey: (workspace: string) => workspace,
    captureFunctionRuntimeGuard: (authority: typeof instance.authority) => () => authority.assertLive(),
    protects: () => false,
    getFunctionToolHandler: () => intercept,
    publish: vi.fn(async (_workspace: string, value: unknown) => value)
  }
  state.manager = manager
  return { registry, instance, binding, intercept, manager }
}

it("pins Mods to the host receipt while retaining classic trace and native colliding arguments", async () => {
  const f = fixture()
  const metadata = { [HOOK_AGENT_OWNER_METADATA_KEY]: "renderer-task" }
  const request = {
    metadata,
    runtime: { configurable: { [HOOK_AGENT_OWNER_METADATA_KEY]: "renderer-task" } },
    toolCall: {
      name: "read_file", id: "native-read",
      args: { agentId: "argument-agent", tool: "argument-tool", tool_use_id: "argument-id" }
    }
  }
  const handler = vi.fn(async (native: typeof request) => {
    expect(getModCallContext()).toMatchObject({
      runtimeAuthority: f.instance.authority,
      identity: { agentId: f.binding.agentId, turnId: "host-turn", toolCallId: "native-read" }
    })
    expect(getHookAgentIdFromRequest(native)).toBe("renderer-task")
    expect(getCurrentHookAgentId()).toBe("renderer-task")
    expect(native.metadata).toBe(metadata)
    expect(native.toolCall.args).toEqual(request.toolCall.args)
    return "native read"
  })
  await expect(runWithHookAgentId("renderer-task", () =>
    withModToolCall(f.binding, request, new Set(), handler)
  )).resolves.toBe("native read")
  expect(handler).toHaveBeenCalledOnce()
  expect(f.intercept.mock.calls[0][0]).toMatchObject({
    runtimeAuthority: f.instance.authority, agentId: "mod-task:host-authority"
  })
  expect(f.intercept.mock.calls[0][1]).toEqual({
    agentId: "mod-task:host-authority", tool: "read_file", tool_use_id: "native-read"
  })
  expect(request.metadata).toEqual({ [HOOK_AGENT_OWNER_METADATA_KEY]: "renderer-task" })
  expect(getModCallContext()).toBeUndefined()
})

it.each([
  { agentId: "host-child", metadataId: "main", expected: "host-child" },
  { agentId: undefined, metadataId: "forged-child", expected: "main" }
])("uses the host binding $expected when no runtime authority is attached", async (sample) => {
  const f = fixture()
  const binding = {
    workspace: f.binding.workspace, threadId: "thread", turnId: "host-turn",
    agentId: sample.agentId
  }
  const request = {
    metadata: { [HOOK_AGENT_OWNER_METADATA_KEY]: sample.metadataId },
    toolCall: { name: "read_file", id: "read", args: {} }
  }
  await withModToolCall(binding, request, new Set(), async (native) => {
    expect(getModCallContext()?.identity.agentId).toBe(sample.expected)
    expect(getModCallContext()?.runtimeAuthority).toBeUndefined()
    expect(getHookAgentIdFromRequest(native)).toBe(sample.metadataId)
    return "read"
  })
  expect(f.intercept.mock.calls[0][0].agentId).toBe(sample.expected)
})

it.each([
  { agentId: "main" },
  { turnId: "another-turn" },
  { threadId: "another-thread" },
  { workspace: "/another-workspace" }
])("rejects an incorrect host binding %j instead of repairing it from metadata", async (different) => {
  const f = fixture()
  const handler = vi.fn(async () => "must not execute")
  const request = {
    metadata: { [HOOK_AGENT_OWNER_METADATA_KEY]: f.binding.agentId },
    toolCall: { name: "read_file", id: "read", args: {} }
  }
  await expect((async () => withModToolCall(
    { ...f.binding, ...different }, request, new Set(), handler
  ))()).rejects.toThrow("MODS_RUNTIME_SCOPE_CHANGED")
  expect(handler).not.toHaveBeenCalled()
  expect(f.intercept).not.toHaveBeenCalled()
  expect(f.manager.publish).not.toHaveBeenCalled()
})

it("rejects an expired real receipt before interception or native execution", async () => {
  const f = fixture()
  f.instance.release()
  const handler = vi.fn(async () => "must not execute")
  await expect((async () => withModToolCall(
    f.binding, { toolCall: { name: "read_file", id: "read", args: {} } }, new Set(), handler
  ))()).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(handler).not.toHaveBeenCalled()
  expect(f.intercept).not.toHaveBeenCalled()
})

it("rejects an expired receipt before the inactive Mods native shortcut", async () => {
  const f = fixture()
  f.manager.isActive.mockReturnValue(false)
  f.instance.release()
  const handler = vi.fn(async () => "must not execute")
  await expect((async () => withModToolCall(
    f.binding, { toolCall: { name: "read_file", id: "read", args: {} } }, new Set(), handler
  ))()).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(handler).not.toHaveBeenCalled()
  expect(f.intercept).not.toHaveBeenCalled()
})

it.each(["missing-manager", "missing-tool-name"] as const)(
  "rejects a closed receipt before the %s native shortcut",
  async shortcut => {
    const f = fixture()
    f.registry.close()
    if (shortcut === "missing-manager") state.manager = undefined
    const handler = vi.fn(async () => "must not execute")
    const request = shortcut === "missing-manager"
      ? { toolCall: { name: "read_file", id: "read", args: {} } }
      : { toolCall: { id: "read", args: {} } }
    await expect((async () => withModToolCall(
      f.binding, request, new Set(), handler
    ))()).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    expect(handler).not.toHaveBeenCalled()
    expect(f.intercept).not.toHaveBeenCalled()
  }
)

it.each([true, false])("blocks a late native result after owner expiry with Mods active=%s", async active => {
  const f = fixture()
  f.manager.isActive.mockReturnValue(active)
  const handler = vi.fn(async () => {
    f.instance.release()
    return "late native result"
  })
  await expect(withModToolCall(
    f.binding, { toolCall: { name: "read_file", id: "read", args: {} } }, new Set(), handler
  )).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  expect(handler).toHaveBeenCalledOnce()
  expect(f.manager.publish).not.toHaveBeenCalled()
})

it("preserves the original request and trace on the cold native path", async () => {
  const f = fixture()
  f.manager.isActive.mockReturnValue(false)
  const request = {
    metadata: { [HOOK_AGENT_OWNER_METADATA_KEY]: "renderer-task" },
    toolCall: { name: "read_file", id: "read", args: {} }
  }
  const handler = vi.fn(async (native: typeof request) => {
    expect(native).toBe(request)
    expect(getHookAgentIdFromRequest(native)).toBe("renderer-task")
    expect(getModCallContext()).toBeUndefined()
    return "native"
  })
  await expect(withModToolCall(f.binding, request, new Set(), handler)).resolves.toBe("native")
  expect(handler).toHaveBeenCalledExactlyOnceWith(request)
  expect(f.intercept).not.toHaveBeenCalled()
})
