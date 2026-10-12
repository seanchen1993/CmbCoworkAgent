import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotHost, closeBotHostBackgroundActivity } from "./host"
import { BotModelChecks } from "./model-check"
import { BotMemorySynthesis } from "./memory-synthesis"
import { botMemoryModels } from "./memory-model"
import { BotFunctionSessions } from "./function-sessions"
import * as modelConfig from "./model-config"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  vi.restoreAllMocks()
})

it("aborts memory, model checks and independent sessions before waiting for listeners after ownership loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "bot-owner-services-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let httpRequests = 0
  const server = createServer((_request, response) => {
    httpRequests++
    response.writeHead(500).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const port = (server.address() as { port: number }).port,
    snapshot: modelConfig.BotModelSnapshot = {
      version: 1,
      defaultRef: "fixture",
      models: [
        {
          ref: "fixture",
          id: "fixture",
          name: "Fixture",
          model: "fixture",
          apiKey: "fixture",
          baseUrl: `http://127.0.0.1:${port}/v1`
        }
      ]
    },
    pendingReads: ((value: modelConfig.BotModelSnapshot) => void)[] = []
  vi.spyOn(modelConfig, "readBotModelSnapshot").mockImplementation(
    () => new Promise((resolve) => pendingReads.push(resolve))
  )
  let now = 1_900_000_000_000
  const store = new BotStore(join(root, "bots.sqlite"), () => now)
  cleanup.push(() => store.close())
  const { conversationId } = store.createBot({ nonce: "bot", name: "Owned" })
  store.send({ nonce: "work", conversationId, text: "Project uses TypeScript" })
  const claimed = store.claim("fixture")!
  store.finish(claimed.lease, "succeeded", "Project method verified")
  now += 16_000
  const checks = new BotModelChecks(join(root, "models.private")),
    functions = new BotFunctionSessions(),
    closedFunctions = vi.spyOn(functions, "close"),
    memory = new BotMemorySynthesis(store, botMemoryModels(join(root, "models.private"), store)),
    host = new BotHost(store, {
      modelChecks: checks,
      functionSessions: functions,
      execute: async () => "unused"
    })
  cleanup.push(
    () => memory.close(),
    () => host.stop()
  )
  const memoryPass = memory.runNow(),
    check = checks.check(
      { nonce: randomUUID(), modelRef: null, kind: "text" },
      new AbortController().signal
    ),
    cancelled = expect(check).rejects.toMatchObject({ code: "model_check_cancelled" })
  await vi.waitFor(() => expect(pendingReads).toHaveLength(2))
  let lost = false,
    releaseListener!: () => void,
    shutdown: Promise<unknown> | undefined
  const slowListener = new Promise<void>((resolve) => {
    releaseListener = resolve
  })
  host.bindOwnership(
    {
      assertCurrent: () => {
        if (lost) throw new Error("physical lock changed")
      },
      checkCurrent: async () => {
        if (lost) throw new Error("physical lock changed")
      }
    },
    async () => {
      shutdown = closeBotHostBackgroundActivity(host, memory)
      await slowListener
      await shutdown
    }
  )
  lost = true
  expect(() => host.assertOwnership()).toThrow("锁")
  expect(closedFunctions).toHaveBeenCalledTimes(1)
  for (const resolve of pendingReads.splice(0)) resolve(snapshot)
  await Promise.all([cancelled, memoryPass, shutdown])
  expect(httpRequests).toBe(0)
  expect(store.memory.policy(claimed.run.botId)).toMatchObject({ pending: 1 })
  releaseListener()
})
