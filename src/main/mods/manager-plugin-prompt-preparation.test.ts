import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModObject } from "../../shared/mods/types"
import { isModObject } from "../../shared/mods/v2/contracts"
import { ModsManager } from "./manager"
import type { ModRuntimeAuthority } from "./runtime-instance"
import { functionCallAuthority } from "./v2/host-call"
import { FunctionGuestRuntime } from "./v2/guest-runtime"
import { FunctionPluginPromptQueue } from "./v2/plugin-prompt-queue"
import { FunctionSession, SESSION_CAPABILITIES } from "./v2/session"

const native = vi.hoisted(() => ({ mode: "none" }))

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: () => {} }
}))
vi.mock("../storage", async original => ({
  ...(await original<typeof import("../storage")>()),
  getWindowsSandboxMode: () => native.mode
}))
vi.mock("../agent/local-sandbox", () => ({
  LocalSandbox: {
    createPermissionProbe: () => async () => ({ decision: "deny", reason: "NO_TEST_FILE" })
  }
}))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  native.mode = "none"
})

async function fixture(phase: "before-core" | "after-core") {
  const folder = mkdtempSync(join(tmpdir(), "mods-plugin-prompt-preparation-"))
  const manager = new ModsManager(join(folder, "control.sqlite"), () => [], async () => true,
    () => {})
  manager.configure(folder, true, false)
  const workspace = manager.workspaceKey(folder)
  const threadId = "plugin-prompt-preparation"
  const entered = Promise.withResolvers<ModRuntimeAuthority>()
  const proceed = Promise.withResolvers<void>()
  const finished = Promise.withResolvers<void>()
  const accepted: ModObject[] = []
  const listeners = new Set<(threadId: string) => void>()
  let busy = true
  let launches = 0
  let held = false
  let replacement: (() => void) | undefined
  const queue = new FunctionPluginPromptQueue({
    busy: () => busy,
    claim: () => ({ assertCurrent: () => {}, release: () => {} }),
    run: async (_, __, ___, ____, _____, started) => {
      launches++
      started()
    },
    onIdle: listener => { listeners.add(listener); return () => listeners.delete(listener) }
  })
  const barrier = async () => {
    const authority = functionCallAuthority(workspace, threadId)
    if (!authority) throw Error("Expected the real private preparation authority")
    entered.resolve(authority)
    await proceed.promise
  }
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.complete",($,e,next)=>{
      void $.prompt.submit({text:"native queued words"});return next(e);
    });
    on("prompt.submit",async($,e,next)=>{
      ${phase === "before-core" ? 'await $.store.get("pre-core-barrier");' : ""}
      return next(e);
    });
  }}`)
  const session = new FunctionSession([{
    name: "actual",
    root: workspace,
    tier: "user",
    guest,
    capabilities: [...SESSION_CAPABILITIES]
  }], {
    workspace,
    threadId,
    assertLive: () => {},
    publish: async value => {
      if (phase === "after-core" && !held && isModObject(value) &&
        value.text === "native queued words" && value.wait === undefined) {
        held = true
        await barrier()
      }
      return value
    },
    reservePluginPrompt: (_, origin, lifetime) => {
      const ticket = queue.reserve({ workspace, threadId, origin, signal: lifetime,
        assertLive: () => lifetime.throwIfAborted() })
      return { ...ticket, accept: (input: ModObject) => {
        const result = ticket.accept(input)
        accepted.push(structuredClone(input))
        return result
      } }
    },
    preparePluginPrompt: async (_, signal, assertAdmission, cancelAdmission, run) => {
      try {
        return await manager.withPluginPromptPreparation(workspace, threadId, signal,
          assertAdmission, cancelAdmission, run)
      } finally { finished.resolve() }
    },
    state: () => ({
      get: async key => {
        if (key === "pre-core-barrier") await barrier()
        return undefined
      },
      keys: async () => [],
      set: async () => {},
      delete: () => {}
    })
  })
  cleanup.push(async () => {
    proceed.resolve()
    queue.close()
    await session.close()
    replacement?.()
    manager.close()
    if (dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("mods-plugin-prompt-preparation-"))
      throw Error("Unexpected test cleanup path")
    rmSync(folder, { recursive: true, force: true })
  })
  await session.start()
  await session.turnComplete({ turnId: "source-turn", answer: "done", reason: "answer",
    durationMs: 1, isAborted: false })
  return { manager, workspace, threadId, queue, entered, proceed, finished, accepted,
    launches: () => launches,
    replaceBinding: (authority: ModRuntimeAuthority) => {
      replacement = manager.bindThread({ workspace, threadId, turnId: authority.turnId,
        agentId: authority.agentId, runtimeAuthority: authority, commandOnly: true,
        readOnly: true, allowedToolNames: new Set(),
        queryTool: async () => ({ decision: "deny", reason: "REPLACED_BINDING" }) })
    },
    idle: () => { busy = false; listeners.forEach(listener => listener(threadId)) }
  }
}

for (const phase of ["before-core", "after-core"] as const) {
  for (const change of ["sandbox", "binding"] as const) {
    it.skipIf(change === "sandbox" && process.platform !== "win32")(
      `cancels an actual private preparer after ${change} changes ${phase}`,
      async () => {
        const f = await fixture(phase)
        const authority = await f.entered.promise
        expect(authority.agentId).toMatch(/^plugin-prompt:/)
        expect(f.accepted).toHaveLength(phase === "before-core" ? 0 : 1)
        if (change === "sandbox") native.mode = "elevated"
        else f.replaceBinding(authority)
        f.proceed.resolve()
        await f.finished.promise
        await expect.poll(() => f.queue.size).toBe(0)
        f.idle()
        await new Promise(resolve => setTimeout(resolve, 0))
        expect(f.launches()).toBe(0)
        expect(f.accepted).toHaveLength(phase === "before-core" ? 0 : 1)
        expect(() => authority.assertLive()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
      }
    )
  }
}
