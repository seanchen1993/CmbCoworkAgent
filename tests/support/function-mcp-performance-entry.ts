import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { ModsManager, authorizeCurrentModInput } from "../../src/main/mods/manager"
import { getModCallContext } from "../../src/main/mods/context"
import { withFunctionExecution } from "../../src/main/mods/v2/execution-context"
import type { McpCapabilityTool } from "../../src/main/mcp/capability-types"

declare const __MODS_MCP_SDK__: boolean
declare const __MODS_MATCHED_PUBLICATION__: boolean
declare const __MODS_MCP_ROUTING__: boolean
const route = __MODS_MCP_ROUTING__
  ? (await import("../../src/main/mods/v2/mcp-tool-routing")).routeFunctionMcp
  : undefined
const workspace = mkdtempSync(join(tmpdir(), "mods-mcp-perf-"))
const manager = new ModsManager(
  join(workspace, "control.sqlite"),
  () => [],
  async () => true,
  () => {}
)
manager.configure(workspace, true, false)
const grant = manager.store.grant(
  manager.workspaceKey(workspace),
  "function:perf",
  "snapshot",
  true
)
const scope = {
  workspace: manager.workspaceKey(workspace),
  threadId: "thread",
  turnId: "turn",
  leased: true,
  immediate: false,
  userInitiated: true
}
const tool: McpCapabilityTool = {
  capabilityId: "perf:echo",
  providerKey: "perf",
  providerAlias: "perf",
  providerDisplayName: "Perf",
  toolName: "echo",
  toolId: "mcp__perf__echo",
  visibility: "lazy",
  connectionGeneration: "fixed-host-connection",
  inputSchema: { type: "object" }
}
const catalog = Array.from({ length: 999 }, (_, i) => ({ ...tool, toolName: `other${i}` })).concat(
  tool
)
let calls = 0
let actualCallId = ""
manager.bindThread({
  ...scope,
  invokeTool: async () => {
    throw Error("Unexpected native route")
  }
})
manager.bindMcp(
  scope,
  (id, args) =>
    manager.dispatch(scope, `mcp:${id}`, args, async (input) => {
      await authorizeCurrentModInput(`mcp:${id}`, input)
      getModCallContext()?.assertMcpTool?.(tool)
      actualCallId = getModCallContext()!.identity.callId
      calls++
      return {
        capabilityId: id,
        raw: { content: [{ type: "text", text: "echo" }] },
        text: "echo",
        isError: false
      }
    }),
  async () => catalog
)
const times: number[] = []
function removeWorkspace(): void {
  if (
    dirname(resolve(workspace)) !== resolve(tmpdir()) ||
    !basename(workspace).startsWith("mods-mcp-perf-")
  )
    throw Error("Unexpected performance cleanup path")
  rmSync(workspace, { recursive: true, force: true })
}
try {
  for (let i = 0; i < 140; i++) {
    const before = performance.now()
    const signal = new AbortController().signal
    const result = await withFunctionExecution(scope, () =>
      route
        ? route(
            { server: "Perf", tool: "echo", args: {} },
            signal,
            (input, signal, core) => core(input, signal),
            {
              resolve: (input, signal) =>
                manager.resolveFunctionMcp(workspace, "thread", grant, input, signal),
              invoke: (input, signal, fingerprint) =>
                manager.invokeFunctionMcp(
                  workspace,
                  "thread",
                  grant,
                  input,
                  signal,
                  false,
                  true,
                  fingerprint
                )
            }
          )
        : __MODS_MCP_SDK__
          ? manager.invokeFunctionMcp(
              workspace,
              "thread",
              grant,
              { server: "Perf", tool: "echo", args: {} },
              signal,
              false,
              true
            )
          : manager.invokeFunctionTool(
              workspace,
              "thread",
              grant,
              "mcp:perf:echo",
              {},
              signal,
              false,
              true
            )
    )
    assert(JSON.stringify(result).includes("echo"))
    if (!__MODS_MCP_SDK__ && __MODS_MATCHED_PUBLICATION__)
      manager.store.publication(actualCallId, "", [], "published")
    if (i >= 40) times.push(performance.now() - before)
  }
  assert.equal(calls, 140)
  assert.equal(
    manager.store.audit(scope.workspace, 200).filter((row) => row.status === "succeeded").length,
    140
  )
  process.stdout.write(JSON.stringify(times))
} finally {
  manager.close()
  removeWorkspace()
}
