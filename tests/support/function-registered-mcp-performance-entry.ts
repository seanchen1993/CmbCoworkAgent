import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { ModsManager } from "../../src/main/mods/manager"
import { FunctionSession, SESSION_CAPABILITIES } from "../../src/main/mods/v2/session"
import { FunctionGuestRuntime } from "../../src/main/mods/v2/guest-runtime"
import { FunctionRegisteredTools } from "../../src/main/mods/v2/registered-tools"
import { withFunctionExecution } from "../../src/main/mods/v2/execution-context"

declare const __MODS_REGISTERED_MCP__: boolean
const checkServer = __MODS_REGISTERED_MCP__
  ? (await import("../../src/main/mods/v2/mcp-names")).assertFunctionMcpServerAvailable
  : undefined
const workspace = mkdtempSync(join(tmpdir(), "mods-registered-mcp-perf-"))
if (
  dirname(resolve(workspace)) !== resolve(tmpdir()) ||
  !basename(workspace).startsWith("mods-registered-mcp-perf-")
)
  throw Error("Unexpected performance cleanup path")
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
  userInitiated: true,
  runtimeAuthority: manager.createRuntimeAuthority({
    workspace,
    threadId: "thread",
    turnId: "turn"
  }).authority
}
manager.bindThread(scope)
manager.bindFunctionToolCatalog(
  scope,
  Array.from({ length: 1000 }, (_, index) => ({
    name: `host_${index}`,
    description: "Host tool",
    mcp: false
  }))
)
const configured = Array.from({ length: 100 }, (_, index) => `Configured Server ${index}`)
const host = new FunctionRegisteredTools(manager.store, {
  assertScope: (workspace, threadId) => {
    manager.functionToolAgent(workspace, threadId)
  },
  admit: (...args) => manager.authorizeRegisteredTool(...args),
  publish: async (identity, value) => {
    manager.store.publication(identity.callId, "", [], "published")
    return value
  }
})
const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
  on("session.start",async($,e,next)=>{
    await $.tool.register({name:"echo",description:"Echo"});
    await $.command.register({name:"probe",description:"Probe"});return next(e);
  });
  on("tool.call",{tool:"mcp__perf__echo"},(_,e)=>({result:e.text}));
  on("command.run",{command:"probe"},async($)=>({text:JSON.stringify(${
    __MODS_REGISTERED_MCP__
      ? 'await $.mcp.call("perf","echo",{text:"same work"})'
      : 'await $.tool.call({tool:"mcp__perf__echo",text:"same work"})'
  })}));
}}`)
const session = new FunctionSession(
  [{ name: "perf", root: workspace, tier: "user", guest, capabilities: [...SESSION_CAPABILITIES] }],
  {
    workspace: scope.workspace,
    threadId: "thread",
    assertLive: () => manager.store.assertGrant(grant),
    publish: async (v) => v,
    assertToolNameAvailable: (_plugin, name) => {
      checkServer?.("perf", configured)
      if (__MODS_REGISTERED_MCP__)
        manager.assertFunctionToolNameAvailable(workspace, "thread", name)
    },
    registeredTool: (_owner, input, origin, signal, run, caller) =>
      host.call(scope.workspace, "thread", grant, input, origin, signal, run, caller)
  }
)
const samples: number[] = []
try {
  for (let index = 0; index < 140; index++) {
    const start = performance.now()
    const result = await withFunctionExecution(scope, () => session.run("probe", ""))
    assert.match(String(result.text), /same work/)
    if (index >= 40) samples.push(performance.now() - start)
  }
  assert.equal(
    manager.store.audit(scope.workspace, 200).filter((row) => row.status === "succeeded").length,
    140
  )
  process.stdout.write(JSON.stringify(samples))
} finally {
  await session.close()
  manager.close()
  rmSync(workspace, { recursive: true, force: true })
}
