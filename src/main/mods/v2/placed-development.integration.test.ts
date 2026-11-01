import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { assertFunctionSourcesCurrent } from "./source-adoption-fence"
import type { DevelopmentScope } from "./development-session"
import { compileFunctionPlugin } from "./loader"
import { withFunctionExecution } from "./execution-context"
import { analyzeAuthoringPreview } from "../devtools/authoring-preflight"
import {
  developmentCatalog,
  developmentCatalogPage,
  DEVELOPMENT_PLACED_EXAMPLE
} from "../devtools/development-catalog"

it("takes the published Placed example through real creator preflight, consent, activation and explicit display command", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-placed-development-"))
  const store = new ModControlStore(join(root, "control.sqlite"))
  const scope: DevelopmentScope = {
    workspace: root,
    threadId: randomUUID(),
    incarnation: { token: randomUUID(), legacyCreatedAt: 1 }
  }
  const captureAnchor = vi.fn(() => ({ kind: "start" as const }))
  const changed = vi.fn()
  const guests: FunctionGuestRuntime[] = []
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [],
      enabled: () => true,
      publish: async (_workspace, value) => value,
      changed,
      assertThread: () => {
        /* The fixture owns this exact ordinary chat scope. */
      },
      captureDisplayScope: () => ({
        database: store,
        workspace: root,
        threadId: scope.threadId,
        incarnation: scope.incarnation,
        assertCurrent() {
          /* Same fixture database and thread. */
        }
      }),
      capturePlacedAnchor: captureAnchor
    },
    () => ({
      load: async (code, options) => {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.push(guest)
        return guest
      },
      stop: () => {
        for (const guest of guests) guest.dispose()
      },
      stopAndDrain: async () => {
        for (const guest of guests) guest.dispose()
      }
    })
  )
  manager.configureDevelopmentAccess({
    assertScope(value) {
      expect(value).toEqual(scope)
    }
  })
  try {
    const discovery = developmentCatalogPage("types", 0, "ui.place")
    if (!("usageExample" in discovery) || typeof discovery.usageExample !== "string")
      throw Error("Placed targeted discovery must include its actual example")
    expect(discovery.usageExample).toBe(DEVELOPMENT_PLACED_EXAMPLE)
    expect(JSON.stringify(discovery).length).toBeLessThan(8000)
    for (const [path, value] of Object.entries(developmentCatalog().package)) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await writeFile(
        join(root, path),
        path === "mods/main.ts"
          ? `import type {Register} from "devclaw-mods"\nexport const register:Register=(on)=>{\n${discovery.usageExample}\n}`
          : typeof value === "string"
            ? value
            : JSON.stringify(value)
      )
    }
    const preview = await analyzeAuthoringPreview(root)
    expect(preview.typecheck.diagnostics).toEqual([])
    expect(preview.sdk.strictCompatible).toBe(true)
    expect(preview.sdk.usages.map((usage) => usage.method)).toContain("ui.place")
    const compiled = await compileFunctionPlugin(root)
    const capabilities = [
      "command.register",
      "ui.place",
      "ui.resolve",
      "ui.invalidate",
      "event:session.start",
      "event:command.run",
      "event:ui.render"
    ]
    const revision = {
      componentId: randomUUID(),
      draftId: "placed-example",
      revision: 1,
      bundleDigest: "a".repeat(64),
      compiledDigest: compiled.digest,
      sourcePath: root,
      turnId: "creator-turn",
      capabilities,
      validation: "authorized-real" as const
    }
    const checkSource = () => assertFunctionSourcesCurrent(compiled)
    await manager.preflightDevelopment(scope, revision, checkSource)
    expect(captureAnchor).not.toHaveBeenCalled()
    expect(await manager.placedRows(root, scope.threadId)).toEqual([])
    expect(changed.mock.calls.some((call) => call[1] === "placed")).toBe(false)
    manager.stageDevelopment(scope, revision, checkSource)
    expect(manager.developmentStatus(scope)[0].phase).toBe("needs-approval")
    manager.approveDevelopment(
      scope,
      revision.componentId,
      revision.compiledDigest,
      capabilities,
      checkSource
    )
    expect(manager.developmentStatus(scope)[0].waitingReason).toBe("turn-finishing")
    expect(captureAnchor).not.toHaveBeenCalled()
    manager.noteDevelopmentTurnSettled(scope, revision.turnId, "completed")
    await vi.waitFor(() =>
      expect(manager.developmentStatus(scope)[0]).toMatchObject({
        phase: "active",
        activeDigest: compiled.digest
      })
    )
    expect(captureAnchor).not.toHaveBeenCalled()
    expect(await manager.placedRows(root, scope.threadId)).toEqual([])
    const command = (await manager.commands(root, scope.threadId)).find(
      (value) => value.command === "show-checklist"
    )
    if (!command) throw Error("Active creator trial must expose its registered display command")
    const result = await withFunctionExecution(
      {
        workspace: root,
        threadId: scope.threadId,
        leased: false,
        immediate: false,
        userInitiated: true
      },
      () => manager.runCommand(root, scope.threadId, command, "", new AbortController().signal)
    )
    expect(result).toEqual({ text: "检查卡片已准备，返回当前聊天后显示。" })
    expect(captureAnchor).toHaveBeenCalledOnce()
    const rows = await manager.placedRows(root, scope.threadId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "checklist", anchor: { kind: "start" } })
    expect(rows[0].requestId).toMatch(/^[a-f0-9-]{36}$/)
    const drawing = await manager.placedRead(
      root,
      scope.threadId,
      rows[0].requestId,
      randomUUID(),
      checkSource
    )
    expect(JSON.stringify(drawing.tree)).toContain("这是一张可交互的插件卡片")
    expect(store.getGrant(root, `function:${compiled.name}`)).toBeNull()
    await manager.stopDevelopment(scope, revision.componentId, checkSource)
    expect(await manager.placedRows(root, scope.threadId)).toEqual([])
  } finally {
    manager.close()
    await new Promise((resolve) => setTimeout(resolve, 30))
    store.close()
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
    expect(basename(root)).toMatch(/^mods-placed-development-/)
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
