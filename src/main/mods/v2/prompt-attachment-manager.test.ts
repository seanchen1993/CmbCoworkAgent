import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { ModsManager } from "../manager"
import { filterModData } from "../publication"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, ipcMain: { handle() {} }
}))

const secret = "sk-secret-token-123456789"
const input: ModObject = {
  type: "file", text: secret, origin: { kind: "engine" }, agentId: "attachment-data"
}
const protectedInput: ModObject = { ...input, text: "[REDACTED]" }

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-attachment-publication-"))
  const plugin = join(root, "plugin")
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true })
  mkdirSync(join(plugin, "hooks"))
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "attachment-hook", version: "1.0.0" }))
  writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  writeFileSync(join(plugin, "hooks/register.ts"), `export function register(on) {
    on("prompt.attachment", async ($, e, next) => {
      if(e.type!=="file"||e.origin.kind!=="engine"||e.text!=="[REDACTED]")
        throw Error("actual protected attachment input changed")
      return next(e)
    })
  }`)
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true,
    () => undefined)
  const workspace = manager.workspaceKey(root)
  manager.configure(workspace, true, true)
  const payloads: ModJson[] = []
  // This tests the actual preflight and Manager routes; full utilityProcess policy is a Desktop gate.
  const publisher = vi.spyOn(manager, "publish").mockImplementation(async <T>(
    _workspace: string, value: T, _callId?: string, signal?: AbortSignal
  ): Promise<T> => {
    signal?.throwIfAborted()
    payloads.push(filterModData(value, false))
    return filterModData(value, true) as T
  })
  const functions = new FunctionModsManager(manager.store, {
    plugins: () => [{ id: "attachment-source", name: "attachment-hook", path: plugin, enabled: true }],
    enabled: key => manager.isEnabled(key),
    publish: (key, value, signal) => manager.publish(key, value, undefined, signal),
    changed: () => undefined
  }, () => {
    const guests = new Set<FunctionGuestRuntime>()
    return {
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.add(guest)
        return guest
      },
      stop() { for (const guest of guests) guest.dispose() }
    }
  })
  manager.attachFunctions({
    invalidate: key => functions.invalidate(key), closeThread: id => functions.closeThread(id),
    close: () => functions.close(),
    classicEvent: (key, id, event, value, signal, core) =>
      functions.classicEvent(key, id, event, value, signal, core)
  })
  const close = () => {
    try { manager.close() } finally {
      publisher.mockRestore()
      if (dirname(resolve(root)) !== resolve(tmpdir()) ||
        !basename(root).startsWith("mods-attachment-publication-"))
        throw Error("Unexpected attachment fixture cleanup path")
      rmSync(root, { recursive: true, force: true })
    }
  }
  try {
    const [status] = await functions.status(workspace)
    if (!status?.digest) throw Error("Actual attachment source digest required")
    await functions.approve(workspace, "attachment-source", status.digest)
    await functions.commands(workspace, "attachment-thread")
    payloads.length = 0
    return { manager, functions, workspace, payloads, close }
  } catch (error) { close(); throw error }
}

it.each(["main-composition", "v2-classic"] as const)(
  "retains all original protected publications through genuine approved %s routes",
  async route => {
    const f = await fixture()
    const core = vi.fn(async (received: ModObject): Promise<ModObject> => {
      expect(received).toEqual(protectedInput)
      return { text: received.text }
    })
    try {
      expect(f.manager.protects(f.workspace)).toBe(true)
      const signal = new AbortController().signal
      expect(await (route === "main-composition"
        ? f.manager.promptComposition(f.workspace, "attachment-thread", "prompt.attachment",
            input, signal, core)
        : f.functions.classicEvent(f.workspace, "attachment-thread", "prompt.attachment",
            input, signal, core))).toEqual({ text: "[REDACTED]" })
      expect(core).toHaveBeenCalledOnce()
      expect(f.payloads).toHaveLength(route === "main-composition" ? 12 : 8)
      const inputs = f.payloads.filter(value => typeof value === "object" && value !== null &&
        !Array.isArray(value) && Object.hasOwn(value, "origin"))
      expect(inputs).toHaveLength(route === "main-composition" ? 6 : 4)
      expect(inputs[0]).toEqual({ text: secret, origin: { kind: "engine" }, agentId: "attachment-data" })
      for (const received of inputs.slice(1)) expect(received).toEqual({
        text: "[REDACTED]", origin: { kind: "engine" }, agentId: "attachment-data"
      })
      expect(input).toEqual({
        type: "file", text: secret, origin: { kind: "engine" }, agentId: "attachment-data"
      })
    } finally { f.close() }
  }
)
