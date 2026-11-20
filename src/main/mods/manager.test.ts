import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ModGuestRuntime } from "./guest-runtime"
import type { ModHostCall } from "./guest-runtime"
import type { ModObject, ModUiNode } from "../../shared/mods/types"

vi.mock("./runtime-client", () => ({
  ModRuntimeClient: class {
    version = 0
    guests = new Map<string, ModGuestRuntime>()
    async load(id: string, code: string) {
      const g = await ModGuestRuntime.create(code)
      this.guests.set(id, g)
      return g.registrations
    }
    invoke(id: string, handler: string, event: ModObject, call: ModHostCall) {
      return this.guests.get(id)!.invoke(handler, event, call)
    }
    async unload(id: string) {
      this.guests.get(id)?.dispose()
      this.guests.delete(id)
    }
    stop() {
      for (const g of this.guests.values()) g.dispose()
      this.guests.clear()
      this.version++
    }
  }
}))
import {
  ModsManager,
  authorizeCurrentModInput,
  hasModOperationApproval,
  getModsManager,
  setModsManager,
  setModsUnavailable
} from "./manager"
import { DEFAULT_MOD_POLICY, type ManagedModDeployment } from "./policy"
import { withScopedModMcp, withRawModMcp } from "./adapters"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

it("does not route a native v2 manifest into the v1 runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-mods-v2-routing-"))
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith("cmb-mods-v2-routing-")
  )
    throw Error("Unexpected cleanup path")
  mkdirSync(join(root, ".claude-plugin"))
  writeFileSync(
    join(root, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "v2", mods: "manifest.json" })
  )
  writeFileSync(
    join(root, "manifest.json"),
    JSON.stringify({ apiVersion: "cmb.mods/v2", id: "v2", entry: "register.ts" })
  )
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [{ id: "v2", name: "v2", path: root, enabled: true }],
    async () => true,
    () => undefined
  )
  try {
    expect((await manager.status(root)).mods).toEqual([])
  } finally {
    manager.close()
    rmSync(root, { recursive: true, force: true })
  }
})

async function fixture(deployment?: ManagedModDeployment) {
  const root = mkdtempSync(join(tmpdir(), "cmb-mods-manager-"))
  const plugin = join(root, "plugin")
  mkdirSync(join(plugin, ".codex-plugin"), { recursive: true })
  writeFileSync(
    join(plugin, ".codex-plugin/plugin.json"),
    JSON.stringify({ name: "Review", mods: "manifest.json" })
  )
  writeFileSync(
    join(plugin, "manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v1",
      id: "review",
      name: "Review",
      entry: "index.ts",
      activation: "project",
      events: ["tool.call", "command.run", "ui.render", "prompt.context"],
      tools: ["host:write_file"],
      permissions: {
        readTools: [],
        writeTools: ["host:execute"],
        context: ["project.name"],
        store: false
      }
    })
  )
  writeFileSync(
    join(plugin, "index.ts"),
    `export default { register(on) {
    on.tool({id:"tool",tools:["host:write_file"]},async($,e,next)=> {
      const r=await next({args:{...e.args,content:e.args.content+" checked"}});
      return {kind:"result",receipt:r.receipt,projection:r.projection}
    });
    on.context({id:"context"},async($)=>[{text:"Context "+await $.context.get("project.name")}]);
    on.command({id:"run",command:"review:run"},async($)=> {
      const r=await $.tools.invoke("host:execute",{command:"echo verified"}); return r.projection
    });
    on.ui({id:"card",slot:"tool.result.after"},async()=>[{type:"button",label:"Verify",command:"review:run",args:{}}]);
    on.ui({id:"summary",slot:"turn.summary"},async(e)=>[{type:"text",text:e.model.text}]);
  } }`
  )
  const confirm = vi.fn(async () => true)
  const notify = vi.fn()
  const plugins = [{ id: "plugin", name: "Review", path: plugin, enabled: true }]
  const control = join(root, "control.sqlite")
  const manager = new ModsManager(control, () => plugins, confirm, notify, undefined, deployment)
  cleanup.push(() => {
    manager.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("cmb-mods-manager-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(root, { recursive: true, force: true })
  })
  const scope = { workspace: root, threadId: "thread", turnId: "turn" }
  const executions: unknown[] = []
  manager.bindThread({
    ...scope,
    invokeTool: (id, args) =>
      manager.dispatch(scope, id, args, async (input) => {
        await authorizeCurrentModInput(id, input)
        expect(hasModOperationApproval(id, input)).toBe(true)
        expect(hasModOperationApproval(id, { command: "different" })).toBe(false)
        executions.push(input)
        return { output: "verified", exitCode: 0 }
      })
  })
  const digest = (await manager.status(root)).mods[0].digest!
  const enable = async () => {
    await manager.approve(root, "plugin", digest)
    manager.configure(root, true, false)
  }
  const dispatch = () =>
    manager.dispatch(scope, "host:write_file", { content: "text" }, async (args) =>
      String(args.content)
    )
  const button = (): Extract<ModUiNode, { type: "button" }> =>
    manager.listCards("thread", "", 7)[0].nodes[0] as Extract<ModUiNode, { type: "button" }>
  return {
    manager,
    root,
    plugin,
    scope,
    confirm,
    notify,
    enable,
    dispatch,
    button,
    executions,
    plugins,
    digest
  }
}

describe("project Mods lifecycle and UI authority", () => {
  it("consumes the MCP scoped route once before entering the raw service", async () => {
    const f = await fixture()
    await f.enable()
    setModsManager(f.manager)
    const tool = {
      capabilityId: "connector:test:echo",
      toolId: "mcp__test__echo",
      providerKey: "connector:test",
      providerAlias: "test",
      providerDisplayName: "Test",
      toolName: "echo",
      visibility: "eager" as const
    }
    let executions = 0
    try {
      await withScopedModMcp(f.scope, tool, { input: "one" }, (args) =>
        withRawModMcp(tool, args, async () => {
          executions++
          return {
            capabilityId: tool.capabilityId,
            raw: { text: "result" },
            text: "result",
            isError: false
          }
        })
      )
      expect(executions).toBe(1)
      expect(
        f.manager.store
          .audit(f.manager.workspaceKey(f.root))
          .filter((row) => row.toolId === `mcp:${tool.capabilityId}`)
      ).toHaveLength(1)
    } finally {
      setModsManager(undefined)
    }
  })
  it("discovers approved commands and rechecks queued permission snapshots", async () => {
    const f = await fixture()
    expect(await f.manager.commands(f.root, "thread")).toEqual([])
    await f.enable()
    const [command] = await f.manager.commands(f.root, "thread")
    expect(command.command).toBe("review:run")
    expect(
      (await f.manager.runCommand(f.root, "thread", command, {}, new AbortController().signal)).text
    ).toBe("verified")
    expect(f.executions).toHaveLength(1)
    f.manager.revoke(f.root, "review")
    await expect(
      f.manager.runCommand(f.root, "thread", command, {}, new AbortController().signal)
    ).rejects.toThrow("SCOPE_CHANGED")
    expect(f.executions).toHaveLength(1)
  })
  it("summarizes a settled turn once from execution facts", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    await f.manager.finishTurn("thread")
    await f.manager.finishTurn("thread")
    const cards = f.manager.listCards("thread", "turn:turn", 7)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      slot: "turn.summary",
      nodes: [{ type: "text", text: "本轮工具：成功 1，失败 0，待核查 0，未执行 0。" }]
    })
  })
  it("never transfers artifacts across workspaces, threads or code grants", async () => {
    const f = await fixture()
    await f.enable()
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    const workspace = f.manager.workspaceKey(f.root)
    f.manager.store.saveArtifact({
      id,
      workspace,
      threadId: "thread",
      modId: "review",
      digest: f.digest,
      label: "Report",
      text: "result",
      createdAt: Date.now()
    })
    expect(await f.manager.artifact(f.root, "thread", id)).toEqual({
      label: "Report",
      text: "result"
    })
    await expect(f.manager.artifact(f.root, "other", id)).rejects.toThrow("UNAVAILABLE")
    await expect(f.manager.artifact(f.plugin, "thread", id)).rejects.toThrow("UNAVAILABLE")
    const pending = f.manager.artifact(f.root, "thread", id)
    f.manager.revoke(f.root, "review")
    await expect(pending).rejects.toThrow("REVOKED")
    await expect(f.manager.artifact(f.root, "thread", id)).rejects.toThrow("UNAVAILABLE")
  })
  it("does not recreate a missing initialized control store or silently bypass unavailable policy", async () => {
    const f = await fixture()
    const path = join(f.root, "missing.sqlite")
    writeFileSync(`${path}.initialized`, "cmb.mods/v1")
    expect(
      () =>
        new ModsManager(
          path,
          () => [],
          async () => true,
          () => {}
        )
    ).toThrow("RECOVERY_REQUIRED")
    setModsUnavailable("MODS_CONTROL_RECOVERY_REQUIRED")
    try {
      expect(() => getModsManager()).toThrow("RECOVERY_REQUIRED")
    } finally {
      setModsManager(undefined)
    }
  })
  it("enforces mandatory deployment policy with ordinary Mods disabled", async () => {
    const f = await fixture({
      ...DEFAULT_MOD_POLICY,
      required: true,
      denyTools: ["host:write_file"],
      redactLiterals: ["private-value"]
    })
    expect(() => f.manager.configure(f.root, false, false)).toThrow("POLICY_REQUIRED")
    const core = vi.fn(async () => "private-value")
    await expect(f.manager.dispatch(f.scope, "host:write_file", {}, core)).rejects.toThrow(
      "POLICY_TOOL_DENIED"
    )
    expect(core).not.toHaveBeenCalled()
    expect(f.manager.store.audit(f.manager.workspaceKey(f.root))[0].status).toBe("not_started")
    expect(await f.manager.dispatch(f.scope, "host:read_file", {}, core)).toBe("[REDACTED]")
    expect(f.manager.store.audit(f.manager.workspaceKey(f.root))[0]).toMatchObject({
      status: "succeeded",
      publication: "published",
      policyDigest: f.manager.policy.digest
    })
  })
  it("keeps the disabled path unchanged and injects context only after approval", async () => {
    const f = await fixture()
    expect(await f.dispatch()).toBe("text")
    expect(await f.manager.context(f.scope)).toEqual([])
    await f.enable()
    expect(await f.dispatch()).toBe("text checked")
    expect((await f.manager.context(f.scope))[0]).toContain("Context cmb-mods-manager-")
  })
  it("binds a stable one-shot button to sender/thread and confirms final arguments", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    const id = f.button().actionId!
    expect(f.button().actionId).toBe(id)
    await expect(f.manager.act(8, "thread", id)).rejects.toThrow("ACTION_INVALID")
    await expect(f.manager.act(7, "other", id)).rejects.toThrow("ACTION_INVALID")
    expect((await f.manager.act(7, "thread", id)).text).toBe("verified")
    expect(f.confirm).toHaveBeenCalledWith(
      "thread",
      "review",
      "host:execute",
      {
        command: "echo verified"
      },
      expect.any(AbortSignal)
    )
    expect(f.executions).toHaveLength(1)
    expect(f.button().actionId).toBeUndefined()
    await expect(f.manager.act(7, "thread", id)).rejects.toThrow()
  })
  it("does not execute after rejection or revive a button after reapproval", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    f.confirm.mockResolvedValueOnce(false)
    await expect(f.manager.act(7, "thread", f.button().actionId!)).rejects.toThrow()
    expect(f.executions).toHaveLength(0)
    f.manager.revoke(f.root, "review")
    await f.manager.approve(f.root, "plugin", f.digest)
    expect(f.button().actionId).toBeUndefined()
    expect(await f.dispatch()).toBe("text checked")
  })
  it("revokes active sessions when the plugin is disabled", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    const id = f.button().actionId!
    f.plugins[0].enabled = false
    f.manager.pluginsChanged()
    await expect(f.manager.act(7, "thread", id)).rejects.toThrow()
    expect(await f.dispatch()).toBe("text")
    expect(f.button().actionId).toBeUndefined()
  })
  it("rejects stale code grants and cancelled scopes", async () => {
    const f = await fixture()
    writeFileSync(join(f.plugin, "index.ts"), "export default { register() {} }")
    await expect(f.manager.approve(f.root, "plugin", f.digest)).rejects.toThrow("CODE_CHANGED")
    f.manager.configure(f.root, true, false)
    const signal = AbortSignal.abort()
    let invoked = false
    await expect(
      f.manager.dispatch({ ...f.scope, signal }, "host:write_file", {}, async () => {
        invoked = true
      })
    ).rejects.toThrow("CANCELLED")
    expect(invoked).toBe(false)
  })

  it("does not transfer a previously minted action into another turn", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    const id = f.button().actionId!
    f.manager.bindThread({ ...f.scope, turnId: "next-turn" })
    await expect(f.manager.act(7, "thread", id)).rejects.toThrow("ACTION_STALE")
    expect(f.executions).toHaveLength(0)
  })

  it("does not enter the disabled fast path with an in-flight revoked capability", async () => {
    const f = await fixture()
    await f.enable()
    await f.dispatch()
    const id = f.button().actionId!
    let executions = 0
    f.manager.bindThread({
      ...f.scope,
      invokeTool: async (tool, args) => {
        await Promise.resolve()
        f.manager.configure(f.root, false, false)
        return f.manager.dispatch(f.scope, tool, args, async () => ++executions)
      }
    })
    await expect(f.manager.act(7, "thread", id)).rejects.toThrow()
    expect(executions).toBe(0)
    expect(f.confirm).not.toHaveBeenCalled()
  })

  it("applies current policy to historical cards even without a live agent binding", async () => {
    const f = await fixture()
    await f.enable()
    const workspace = f.manager.workspaceKey(f.root)
    f.manager.store.saveCard("historical", "archive", {
      card: {
        id: "historical",
        agentId: "main",
        modId: "review",
        name: "Review",
        threadId: "archive",
        callId: "past",
        nodes: [{ type: "text", text: "sk-private-old-card-123456789" }]
      },
      grant: f.manager.store.getGrant(workspace, "review"),
      workspaceEpoch: 1,
      turnId: "past"
    })
    f.manager.configure(f.root, true, true)
    const cards = f.manager.listCards("archive", "past", 7)
    expect(JSON.stringify(cards)).not.toContain("sk-private")
    expect(JSON.stringify(cards)).toContain("[REDACTED]")
  })

  it("validates declared registrations before persisting approval", async () => {
    const f = await fixture()
    writeFileSync(
      join(f.plugin, "index.ts"),
      'export default { register(on) { on.tool({id:"bad",tools:["host:delete_file"]},async()=>({kind:"deny"})) } }'
    )
    const candidate = (await f.manager.status(f.root)).mods[0]
    await expect(f.manager.approve(f.root, "plugin", candidate.digest!)).rejects.toThrow(
      "UNDECLARED_TOOL"
    )
    expect(f.manager.store.getGrant(f.manager.workspaceKey(f.root), "review")).toBeNull()
  })
})
