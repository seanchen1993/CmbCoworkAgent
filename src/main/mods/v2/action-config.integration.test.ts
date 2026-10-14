import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { functionModelResult } from "./model-sdk"
import type { ModObject } from "../../../shared/mods/types"

it.each([false, true])("checks real QuickJS action configuration (schema=%s)", async (declared) => {
  const root = await mkdtemp(join(tmpdir(), "claw-action-config-"))
  const source = join(root, "plugin")
  await mkdir(join(source, "hooks"), { recursive: true })
  const schema = {
    type: "object",
    properties: { count: { type: "integer", minimum: 1, default: 2 } },
    required: ["count"],
    additionalProperties: false
  }
  await writeFile(
    join(source, "plugin.json"),
    JSON.stringify({
      name: "config-probe",
      claw: {
        actions: [
          {
            id: "run",
            name: "Run",
            command: "config-run",
            inputSchema: {},
            ...(declared ? { configSchema: schema } : {})
          }
        ]
      }
    })
  )
  await writeFile(join(source, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  await writeFile(
    join(source, "hooks/register.ts"),
    `export function register(on) {
    on("session.start", {}, async ($, event, next) => {
      await $.command.register({ name: "config-run", description: "Configuration probe" })
      return next(event)
    })
    on("command.run", { command: "config-run" }, async ($, event) => {
      await $.model.complete({ model: "default", prompt: "Invocation marker" })
      return { output: JSON.parse(event.args).config }
    })
  }`
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  const completeModel = vi.fn(async () => functionModelResult({ text: "marker" }))
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [{ id: "source", name: "config-probe", path: source, enabled: true }],
      enabled: () => true,
      changed: () => {},
      publish: async (_, value) => value,
      completeModelResult: completeModel
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          return guest
        },
        stop() {
          for (const guest of guests) guest.dispose()
        }
      }
    }
  )
  try {
    const [status] = await manager.status(root)
    await manager.approve(root, status.pluginId, status.digest!)
    const [action] = await manager.actionCatalog(root, "thread")
    expect(action.configSchema).toEqual(declared ? schema : undefined)
    const signal = new AbortController().signal
    const prepared = await manager.prepareAction(root, "thread", action, signal)
    expect(prepared.action.configSchema).toEqual(declared ? schema : undefined)
    const envelope = {
      version: 1 as const,
      input: {},
      task: "Test",
      runId: "run",
      stepId: "step",
      executionId: "e"
    }
    if (declared) {
      // A direct host call skips Flow preparation and still cannot enter the guest handler.
      for (const config of [
        {},
        { count: "2" },
        { count: 0 },
        { count: 2, extra: true }
      ] as ModObject[]) {
        await expect(
          manager.runAction(root, "thread", prepared, { ...envelope, config }, signal)
        ).rejects.toMatchObject({ code: "CLAW_ACTION_CONFIG_INVALID" })
      }
      expect(completeModel).not.toHaveBeenCalled()
      // Renderer-provided declarations cannot weaken the approved compiled schema.
      await expect(
        manager.runAction(
          root,
          "thread",
          {
            ...prepared,
            action: { ...prepared.action, configSchema: {} }
          },
          { ...envelope, config: {} },
          signal
        )
      ).rejects.toMatchObject({ code: "CLAW_ACTION_CHANGED" })
      expect(completeModel).not.toHaveBeenCalled()
    }
    const config: ModObject = declared ? { count: 2 } : { arbitrary: { nested: true } }
    expect(
      await manager.runAction(root, "thread", prepared, { ...envelope, config }, signal)
    ).toMatchObject({ output: config })
    expect(completeModel).toHaveBeenCalledTimes(1)
    const [fresh] = await manager.actionCatalog(root, "thread")
    if (action.configSchema) action.configSchema.properties = {}
    expect(fresh.configSchema).toEqual(declared ? schema : undefined)
  } finally {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
