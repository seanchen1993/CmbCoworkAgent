import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ModControlStore } from "./control-store"
import { ModGuestRuntime } from "./guest-runtime"
import { ModEngine, type ModDispatchRequest, type ModRuntime } from "./engine"
import type { ModManifest } from "../../shared/mods/types"

class LocalRuntime implements ModRuntime {
  guests = new Map<string, ModGuestRuntime>()
  async load(id: string, code: string) {
    const guest = await ModGuestRuntime.create(code)
    this.guests.set(id, guest)
    return guest.registrations
  }
  invoke: ModRuntime["invoke"] = (id, handler, event, call) =>
    this.guests.get(id)!.invoke(handler, event, call)
  async unload(id: string) {
    this.guests.get(id)?.dispose()
    this.guests.delete(id)
  }
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(body: string, options: Partial<ModManifest> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "cmb-mods-engine-"))
  const store = new ModControlStore(join(folder, "control.sqlite"))
  const runtime = new LocalRuntime()
  const diagnostics: string[] = []
  const engine = new ModEngine(store, runtime, (_id, code) => diagnostics.push(code))
  cleanups.push(async () => {
    await engine.dispose()
    store.close()
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("cmb-mods-engine-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(folder, { recursive: true, force: true })
  })
  const grant = store.grant("workspace", "quality", "digest", true)
  const manifest: ModManifest = {
    apiVersion: "cmb.mods/v1",
    id: "quality",
    name: "Quality",
    entry: "index.js",
    events: ["tool.call"],
    tools: ["host:write_file"],
    activation: "project",
    permissions: { readTools: [], writeTools: [], context: [], store: false },
    ...options
  }
  await engine.load([
    {
      compiled: {
        pluginId: "plugin",
        manifest,
        digest: "digest",
        code: `var __cmbMod={default:{register(on){${body}}}}`
      },
      grant
    }
  ])
  const request: ModDispatchRequest = {
    identity: {
      callId: "call",
      threadId: "thread",
      turnId: "turn",
      agentId: "main",
      workspace: "workspace",
      origin: "model",
      grantEpoch: grant.epoch
    },
    toolId: "host:write_file",
    effect: "write",
    args: { content: "original" },
    protectedOutput: false
  }
  return { engine, request, diagnostics, store }
}

describe("Mod execution contract", () => {
  it("applies current output protection when reading previously stored data", async () => {
    const { engine, request, store } = await fixture(
      `on.context({id:"stored"},async($)=>[
      {text:(await $.store.get("key")).includes("sk-private")?"LEAK":"safe"}
    ])`,
      {
        events: ["prompt.context"],
        tools: [],
        permissions: { readTools: [], writeTools: [], context: [], store: true }
      }
    )
    store.write("workspace\u001fquality\u001fdigest", "key", "sk-private-stored-123456789")
    expect((await engine.context({ ...request, protectedOutput: true }))[0]).toContain("safe")
  })
  it("does not serialize unrelated core tools for a context-only Mod", async () => {
    const { engine, request } = await fixture("", { events: [], tools: [] })
    let started = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const core = async () => {
      started++
      await gate
      return "done"
    }
    const first = engine.dispatch(request, core)
    const second = engine.dispatch(
      { ...request, identity: { ...request.identity, callId: "second" } },
      core
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const simultaneous = started
    release()
    await Promise.all([first, second])
    expect(simultaneous).toBe(2)
  })
  it("settles fire-and-forget capability work before command completion", async () => {
    const { engine, request } = await fixture(
      `on.command({id:"run",command:"quality:run"},async($)=>{
      $.tools.invoke("host:execute",{command:"verified"}); return {text:"finished"}
    })`,
      {
        events: ["command.run"],
        tools: [],
        permissions: { readTools: [], writeTools: ["host:execute"], context: [], store: false }
      }
    )
    let completed = false
    const result = await engine.command(
      {
        ...request,
        identity: { ...request.identity, origin: "user-action" },
        invokeTool: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30))
          completed = true
          return "executed"
        }
      },
      "quality",
      "quality:run",
      {}
    )
    expect(completed).toBe(true)
    expect(result.text).toBe("finished")
  })

  it("rejects writes requested from ordinary tool middleware", async () => {
    const { engine, request } = await fixture(
      `on.tool({id:"write",tools:["host:write_file"]},async($)=>{
      await $.tools.invoke("host:execute",{command:"not-authorized"}); return {kind:"deny"}
    })`,
      { permissions: { readTools: [], writeTools: ["host:execute"], context: [], store: false } }
    )
    let writes = 0
    await expect(
      engine.dispatch(
        {
          ...request,
          invokeTool: async () => {
            writes++
            return "bad"
          }
        },
        async () => "core"
      )
    ).rejects.toThrow()
    expect(writes).toBe(0)
  })

  it("transforms parameters and output without changing the actual exit status", async () => {
    const { engine, request, store } =
      await fixture(`on.tool({id:"wrap",tools:["host:write_file"]},async($,e,next)=>{
      const r=await next({args:{...e.args,content:"updated"}});
      return {kind:"result",receipt:r.receipt,projection:{text:r.projection.text+"!"}};
    })`)
    const calls: unknown[] = []
    expect(
      await engine.dispatch(request, async (args) => {
        calls.push(args)
        return { output: "core", exitCode: 2 }
      })
    ).toEqual({ output: "core!", exitCode: 2 })
    expect(calls).toEqual([{ content: "updated" }])
    expect(store.status("call")).toBe("failed")
  })

  it("does not fail open before execution", async () => {
    const { engine, request } = await fixture(
      `on.tool({id:"bad",tools:["host:write_file"]},async()=>{throw Error("bad")})`
    )
    let writes = 0
    await expect(engine.dispatch(request, async () => ++writes)).rejects.toThrow()
    expect(writes).toBe(0)
  })

  it("retains the result without replay after a plugin fails", async () => {
    const { engine, request, diagnostics } =
      await fixture(`on.tool({id:"bad",tools:["host:write_file"]},async($,e,next)=>{
      await next({args:e.args}); throw Error("bad");
    })`)
    let writes = 0
    expect(
      await engine.dispatch(request, async () => {
        writes++
        return "done"
      })
    ).toBe("done")
    expect(writes).toBe(1)
    expect(diagnostics).toHaveLength(1)
  })

  it("rejects forged success and refuses a duplicate logical write", async () => {
    const { engine, request } = await fixture(
      `on.tool({id:"fake",tools:["host:write_file"]},async()=>({kind:"result",receipt:"fake",projection:{text:"success"}}))`
    )
    let writes = 0
    await expect(engine.dispatch(request, async () => ++writes)).rejects.toThrow(
      "WITHOUT_EXECUTION"
    )
    expect(writes).toBe(0)
  })

  it("joins an abandoned next instead of allowing a second execution", async () => {
    const { engine, request } =
      await fixture(`on.tool({id:"bad",tools:["host:write_file"]},async($,e,next)=>{
      next({args:e.args}); return {kind:"deny",reason:"too late"};
    })`)
    let writes = 0
    const result = await engine.dispatch(request, async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
      writes++
      return "done"
    })
    expect(result).toBe("done")
    expect(writes).toBe(1)
    await expect(engine.dispatch(request, async () => ++writes)).rejects.toThrow("ALREADY_STARTED")
    expect(writes).toBe(1)
  })

  it("preserves a host control-flow error by identity", async () => {
    const { engine, request } =
      await fixture(`on.tool({id:"wrap",tools:["host:write_file"]},async($,e,next)=>{
      try { return await next({args:e.args}) } catch { return {kind:"deny",reason:"hidden"} }
    })`)
    const interrupt = new Error("GraphBubbleUp test sentinel")
    await expect(
      engine.dispatch(request, async () => {
        throw interrupt
      })
    ).rejects.toBe(interrupt)
  })

  it("checks revoked grants again before publishing a completed operation", async () => {
    const { engine, request, store } =
      await fixture(`on.tool({id:"wrap",tools:["host:write_file"]},async($,e,next)=>{
      const r=await next({args:e.args}); return {kind:"result",receipt:r.receipt,projection:r.projection}
    })`)
    await expect(
      engine.dispatch(request, async () => {
        store.grant("workspace", "quality", "digest", false)
        return "sensitive"
      })
    ).rejects.toThrow("REVOKED")
    expect(store.status("call")).toBe("succeeded")
  })

  it("filters the core result before a plugin can observe or log it", async () => {
    const { engine, request } =
      await fixture(`on.tool({id:"wrap",tools:["host:write_file"]},async($,e,next)=>{
      const r=await next({args:e.args});
      return {kind:"result",receipt:r.receipt,projection:{text:JSON.stringify(r.projection).includes("sk-private-token-123456789")?"LEAK":"safe"}}
    })`)
    expect(
      await engine.dispatch(
        { ...request, protectedOutput: true },
        async () => "sk-private-token-123456789"
      )
    ).toBe("safe")
  })
})
