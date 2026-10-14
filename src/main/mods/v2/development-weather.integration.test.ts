import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { DEVELOPMENT_EVENT_CAPABILITIES } from "./development-session"

it.each([false, true])(
  "keeps candidate state private and revokes on stop (failed cleanup: %s)",
  async (failCleanup) => {
    const root = await mkdtemp(join(tmpdir(), "mods-development-weather-"))
    const control = new ModControlStore(join(root, "control.sqlite"))
    const scope = {
      workspace: root,
      threadId: randomUUID(),
      incarnation: { token: randomUUID(), legacyCreatedAt: 1 }
    }
    const weatherRoot = join(root, "weather")
    const create = async (path: string, name: string, code: string) => {
      await mkdir(join(path, "hooks"), { recursive: true })
      await writeFile(join(path, "plugin.json"), JSON.stringify({ name }))
      await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
      await writeFile(join(path, "hooks/register.ts"), code)
      return compileFunctionPlugin(path)
    }
    const weather = await create(
      weatherRoot,
      "token-weather",
      await readFile(
        resolve("resources/mods/community-originals/token-weather/hooks/token-weather.mjs"),
        "utf8"
      )
    )
    control.grant(root, "function:token-weather", weather.digest, true)
    const changed = vi.fn()
    const developmentChanged = vi.fn()
    let usageGate: { entered: () => void; wait: Promise<void> } | undefined
    let cleanupFailure = false
    const manager = new FunctionModsManager(
      control,
      {
        plugins: () => [{ id: "weather", name: "token-weather", path: weatherRoot, enabled: true }],
        enabled: () => true,
        publish: async (_workspace, value) => value,
        changed,
        readSession: async () => {
          usageGate?.entered()
          await usageGate?.wait
          return { context: { tokens: 100, window: 1000, percent: 10 }, rateLimits: [] }
        }
      },
      () => {
        const guests: FunctionGuestRuntime[] = []
        return {
          load: async (code, options) => {
            const guest = await FunctionGuestRuntime.create(code, options)
            guests.push(guest)
            return guest
          },
          stop: () => {
            for (const guest of guests) void guest.dispose()
          },
          stopAndDrain: async () => {
            await Promise.all(guests.map((guest) => guest.dispose()))
            if (cleanupFailure) throw Error("owned cleanup unconfirmed")
          }
        }
      }
    )
    manager.configureDevelopmentAccess({ assertScope: () => {}, changed: developmentChanged })
    try {
      await manager.commands(root, scope.threadId)
      let oldOwner = await manager.siteMount(root, scope.threadId, "AbovePrompt")
      expect(
        JSON.stringify(
          await manager.siteRender(root, scope.threadId, oldOwner!, {
            isWorking: false,
            bodyColumns: 80,
            maxRows: 8
          })
        )
      ).toContain("Clear")
      for (const revision of [1, 2]) {
        const path = join(root, `revision-${revision}`)
        const compiled = await create(
          path,
          "dev-panel",
          `export function register(on) {
        on("ui.render", {component:"Spinner"}, ($,e) => {
          const {Text}=$.ui.resolve(e);return Text({children:"revision-${revision}"})
        })
      }`
        )
        const input = {
          componentId: "panel",
          draftId: "panel",
          revision,
          bundleDigest: "a".repeat(64),
          compiledDigest: compiled.digest,
          sourcePath: path,
          turnId: `turn-${revision}`,
          capabilities: ["ui.resolve", ...DEVELOPMENT_EVENT_CAPABILITIES]
        }
        await new Promise((resolve) => setTimeout(resolve, 150))
        changed.mockClear()
        const entered = Promise.withResolvers<void>(),
          resume = Promise.withResolvers<void>()
        usageGate = { entered: entered.resolve, wait: resume.promise }
        manager.stageDevelopment(scope, input, () => {})
        manager.approveDevelopment(
          scope,
          "panel",
          input.compiledDigest,
          input.capabilities,
          () => {}
        )
        manager.noteDevelopmentTurnSettled(scope, input.turnId, "completed")
        await entered.promise
        try {
          expect(manager.developmentStatus(scope)[0].phase).toBe("preflight")
          expect(changed.mock.calls.length).toBeGreaterThan(0)
          expect(
            changed.mock.calls.every(
              ([threadId, eventScope]) => threadId === scope.threadId && eventScope === "records"
            )
          ).toBe(true)
          expect(
            JSON.stringify(
              await manager.siteRender(root, scope.threadId, oldOwner!, {
                isWorking: false,
                bodyColumns: 80,
                maxRows: 8
              })
            )
          ).toContain("Clear")
          changed.mockClear()
        } finally {
          usageGate = undefined
          resume.resolve()
        }
        await vi.waitFor(() => {
          const status = manager.developmentStatus(scope)[0]
          expect(status.phase, status.error).toBe("active")
        })
        expect(changed.mock.calls.some(([, eventScope]) =>
          eventScope?.startsWith("source-retiring:"))).toBe(true)
        expect(changed.mock.calls.some(([, eventScope]) =>
          eventScope?.startsWith("source-replaced:"))).toBe(true)
        await expect(
          manager.siteRender(root, scope.threadId, oldOwner!, {
            isWorking: false,
            bodyColumns: 80,
            maxRows: 8
          })
        ).rejects.toThrow()
        const owner = await manager.siteMount(root, scope.threadId, "AbovePrompt")
        oldOwner = owner
        expect(
          JSON.stringify(
            await manager.siteRender(root, scope.threadId, owner!, {
              isWorking: false,
              bodyColumns: 80,
              maxRows: 8
            })
          )
        ).toContain("Clear")
        const spinner = await manager.siteMount(root, scope.threadId, "Spinner")
        expect(
          JSON.stringify(
            await manager.siteRender(root, scope.threadId, spinner!, {
              word: "working",
              message: null,
              suffix: "",
              mode: "responding"
            })
          )
        ).toContain(`revision-${revision}`)
      }
      // A rejected candidate must leave the previously published version and its owner live.
      const failedPath = join(root, "failed-revision")
      const failed = await create(
        failedPath,
        "dev-panel",
        `export function register(on) {
      on("session.start",async($,e,next)=>{await $.store.set("forbidden",true);return next(e)})
    }`
      )
      const failedInput = {
        componentId: "panel",
        draftId: "panel",
        revision: 3,
        bundleDigest: "a".repeat(64),
        compiledDigest: failed.digest,
        sourcePath: failedPath,
        turnId: "turn-3",
        capabilities: ["store.set", ...DEVELOPMENT_EVENT_CAPABILITIES]
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
      changed.mockClear()
      manager.stageDevelopment(scope, failedInput, () => {})
      manager.approveDevelopment(scope, "panel", failed.digest, failedInput.capabilities, () => {})
      manager.noteDevelopmentTurnSettled(scope, "turn-3", "completed")
      await vi.waitFor(() => expect(manager.developmentStatus(scope)[0].phase).toBe("failed"))
      expect(manager.developmentStatus(scope)[0].activeRevision).toBe(2)
      expect(changed.mock.calls.every(([, eventScope]) => eventScope === "records")).toBe(true)
      expect(
        JSON.stringify(
          await manager.siteRender(root, scope.threadId, oldOwner!, {
            isWorking: false,
            bodyColumns: 80,
            maxRows: 8
          })
        )
      ).toContain("Clear")
      changed.mockClear()
      cleanupFailure = failCleanup
      const stopping = manager.stopDevelopment(scope, "panel", () => {})
      expect(changed.mock.calls.some(([, eventScope]) => eventScope?.startsWith("source-retiring:"))).toBe(true)
      await expect(
        manager.siteRender(root, scope.threadId, oldOwner!, {
          isWorking: false,
          bodyColumns: 80,
          maxRows: 8
        })
      ).rejects.toThrow()
      await stopping
      expect(manager.developmentStatus(scope)[0].phase).toBe(failCleanup ? "unknown" : "stopped")
      expect(changed.mock.calls.at(-1)?.[1]).toBeUndefined()
      expect(developmentChanged.mock.calls.at(-1)?.[1].phase).toBe(
        failCleanup ? "unknown" : "stopped"
      )
    } finally {
      manager.close()
      await new Promise((resolve) => setTimeout(resolve, 30))
      control.close()
      expect(dirname(resolve(root))).toBe(resolve(tmpdir()))
      expect(basename(root)).toMatch(/^mods-development-weather-/)
      await rm(root, { recursive: true, force: true })
    }
  }
)
