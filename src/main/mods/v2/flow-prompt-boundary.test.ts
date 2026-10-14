import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "flow-prompt-boundary-"))
  const workspace = join(root, "workspace")
  mkdirSync(workspace)
  const store = new ModControlStore(join(root, "control.sqlite"))
  let enabled = true
  const plugins: ReturnType<ConstructorParameters<typeof FunctionModsManager>[1]["plugins"]> = []
  const createClient = vi.fn(() => {
    throw Error("must not create a plugin VM")
  })
  const assertThread = vi.fn()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => plugins,
      enabled: () => enabled,
      assertThread,
      publish: async (_, value) => value,
      changed: () => {}
    },
    createClient
  )
  cleanups.push(() => {
    manager.close()
    store.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 })
  })
  const addSource = (isEnabled = true) => {
    const plugin = join(root, "plugin")
    mkdirSync(join(plugin, "mods"), { recursive: true })
    writeFileSync(join(plugin, "mods/manifest.json"), JSON.stringify({ apiVersion: "cmb.mods/v2" }))
    plugins.push({ id: "function", name: "function", path: plugin, enabled: isEnabled })
  }
  return {
    manager,
    workspace,
    createClient,
    assertThread,
    addSource,
    disable: () => {
      enabled = false
    }
  }
}

describe("closed text function boundary", () => {
  it("captures and rechecks policy without creating or compiling a plugin VM", () => {
    const f = fixture(),
      boundary = f.manager.capturePromptOnlyBoundary(f.workspace, "thread")
    expect(boundary.policyDigest).toMatch(/^[a-f0-9]{64}$/)
    boundary.assertCurrent()
    expect(f.createClient).not.toHaveBeenCalled()
    expect(f.assertThread).toHaveBeenCalledTimes(2)
  })
  it("rejects an enabled function source before its approval or startup", () => {
    const f = fixture()
    f.addSource()
    expect(() => f.manager.capturePromptOnlyBoundary(f.workspace, "thread")).toThrow(
      "可恢复文本模式暂不支持动态 Mods 组件"
    )
    expect(f.createClient).not.toHaveBeenCalled()
  })
  it("fences a newly available source even without an epoch notification", () => {
    const f = fixture(),
      boundary = f.manager.capturePromptOnlyBoundary(f.workspace, "thread")
    f.addSource()
    expect(boundary.assertCurrent).toThrow()
    expect(f.createClient).not.toHaveBeenCalled()
  })
  it("refuses revocation and configuration generation changes", () => {
    for (const revoke of [
      (f: ReturnType<typeof fixture>) => f.disable(),
      (f: ReturnType<typeof fixture>) => f.manager.invalidate(f.workspace)
    ]) {
      const f = fixture(),
        boundary = f.manager.capturePromptOnlyBoundary(f.workspace, "thread")
      revoke(f)
      expect(boundary.assertCurrent).toThrow("FLOW_PROMPT_POLICY_CHANGED")
    }
  })
  it("allows a disabled source but never starts it", () => {
    const f = fixture()
    f.addSource(false)
    f.manager.capturePromptOnlyBoundary(f.workspace, "thread").assertCurrent()
    expect(f.createClient).not.toHaveBeenCalled()
  })
  it("uses native completion fingerprints without constructing an empty function session", async () => {
    const f = fixture(),
      controller = new AbortController()
    const scope = f.manager.preparePromptOnlyFlowScope(
      f.workspace,
      "thread",
      "run",
      "definition",
      controller.signal
    )
    const binding = await scope.captureBinding(controller.signal)
    expect(binding).toMatchObject({
      workspace: f.workspace,
      threadId: "thread",
      runId: "run",
      pluginDigests: {}
    })
    expect(await scope.fingerprint(controller.signal)).toMatch(/^[a-f0-9]{64}$/)
    expect(f.createClient).not.toHaveBeenCalled()
    scope.dispose()
    expect(scope.assertLive).toThrow("FLOW_EXECUTION_DISPOSED")
  })
})
