import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, it } from "vitest"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession } from "./session"
import { analyzeFunctionSdk } from "../devtools/sdk-usage"
import { FunctionStateStore } from "./state-store"
import type { FunctionUiNode } from "../../../shared/mods/v2/ui"

it("the shipped consumer saves its real settings Form and redraws through the public invalidate API", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "workbench-consumer-"))
  const compiled = await compileFunctionPlugin(resolve("examples/sparks-task-workbench/consumer"), {
    captureSources: true
  })
  const review = await analyzeFunctionSdk(compiled)
  expect(review.usages.map((usage) => usage.method)).toContain("ui.invalidate")
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const db = new DatabaseSync(join(workspace, "state.sqlite")),
    store = new FunctionStateStore(db)
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        guest,
        tier: "user",
        capabilities: [...new Set(review.usages.map((usage) => usage.method))]
      }
    ],
    {
      workspace,
      threadId: randomUUID(),
      assertLive() {
        /* This isolated session has no mutable external grant authority. */
      },
      state: (plugin) => ({
        get: async (key, signal) => {
          signal.throwIfAborted()
          return store.get(plugin.name, key)
        },
        set: async (key, value, signal) => {
          signal.throwIfAborted()
          store.set(plugin.name, key, value)
        },
        delete: (key) => store.delete(plugin.name, key),
        keys: async (signal) => {
          signal.throwIfAborted()
          return store.keys(plugin.name)
        }
      }),
      publish: async (value) => value
    }
  )
  try {
    const catalog = session.platformSurfaces.list()
    const entry = catalog.entries.find((entry) => entry.placement === "settings")!
    expect(entry).toBeDefined()
    const initial = { key: entry.key, revision: catalog.revision }
    const opened = await session.platformSurfaces.open(
      initial,
      new AbortController().signal,
      "settings-open"
    )
    const address = { ...initial, openId: opened.openId },
      pane = opened.pane!
    const form = pane.tree as FunctionUiNode
    expect(form.type).toBe("Form")
    await session.platformSurfaces.act(address, {
      pane: pane.key,
      generation: pane.generation,
      intentId: randomUUID(),
      plugin: form.press!.plugin,
      handle: form.press!.handle,
      kind: "submit",
      value: JSON.stringify({ title: "用户实际保存的工作台" })
    })
    const refreshed = await session.platformSurfaces.read(address)
    expect((refreshed.pane!.tree as FunctionUiNode).props.values).toEqual({
      title: "用户实际保存的工作台"
    })
    expect(refreshed.pane!.generation).not.toBe(pane.generation)
    await session.platformSurfaces.closePage(address)
    expect(session.ownedResourceCount).toBe(0)
    expect(session.platform.diagnostics().subscriptions).toBe(0)
  } finally {
    await session.close(true)
    db.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
