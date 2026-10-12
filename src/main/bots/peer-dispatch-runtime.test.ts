import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { writeBotModelSnapshot } from "./model-config"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"
import { ownedShellMaintenanceOwner } from "./owned-shell-maintenance-fence"
import { createBotPeerDispatchAdmission } from "./peer-dispatch-admission"
import type { BotRun } from "../../shared/bot-types"
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
it.each(["automatic", "explicit"] as const)(
  "real graph + authenticated RPC + loopback SSE %s response starts exactly one source fresh turn",
  async (mode) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-peer-turn-runtime-")))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const lock = BotHostLock.acquire(directory)!
    cleanup.push(() => lock.release())
    const store = new BotStore(join(directory, "bots.sqlite"))
    cleanup.push(() => store.close())
    const a = store.createBot({ nonce: "a", name: "Planner" }),
      b = store.createBot({ nonce: "b", name: "Specialist" })
    const requests: TestModelRequest[] = []
    const model = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
      requests.push(body)
      const last = body.messages.filter((m) => m.role === "user").at(-1),
        content = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content)
      const peer = content.includes("[bot] A message just arrived"),
        fresh = peer && content.includes("PEER_ACTUAL_RESULT")
      const tools = body.messages.some((m) => m.role === "tool")
      const result = fresh
        ? { content: "SOURCE_FRESH_RESULT_OBSERVED" }
        : peer
          ? mode === "explicit" && !tools
            ? {
                tool_calls: [
                  {
                    id: "explicit-reply",
                    type: "function",
                    function: {
                      name: "message_bot",
                      arguments: JSON.stringify({
                        bot_id: a.bot.id,
                        message: "PEER_ACTUAL_RESULT"
                      })
                    }
                  }
                ]
              }
            : {
                content: mode === "explicit" ? "CHILD_LOCAL_FINAL_NOT_SENT" : "PEER_ACTUAL_RESULT"
              }
          : tools
            ? { content: "SOURCE_INDEPENDENTLY_FINISHED" }
            : {
                tool_calls: [
                  {
                    id: "async-send",
                    type: "function",
                    function: {
                      name: "message_bot",
                      arguments: JSON.stringify({
                        bot_id: b.bot.id,
                        message: "DO_ASSIGNED_WORK"
                      })
                    }
                  }
                ]
              }
      res.setHeader("Content-Type", "text/event-stream")
      const delta = (value: unknown, finish: string | null = null) =>
        res.write(
          `data: ${JSON.stringify({ id: `real-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`
        )
      delta({
        role: "assistant",
        ...(result.tool_calls
          ? {
              tool_calls: result.tool_calls.map((call, index) => ({
                index,
                ...call
              }))
            }
          : { content: result.content })
      })
      delta({}, result.tool_calls ? "tool_calls" : "stop")
      res.end("data: [DONE]\n\n")
    })
    await new Promise<void>((done) => model.listen(0, "127.0.0.1", done))
    cleanup.push(
      () =>
        new Promise<void>((done) => {
          model.closeAllConnections()
          model.close(() => done())
        })
    )
    const { port } = model.address() as { port: number },
      modelFile = join(directory, "models.private")
    await writeBotModelSnapshot(modelFile, {
      version: 1,
      defaultRef: "probe",
      models: [
        {
          ref: "probe",
          id: "probe",
          name: "probe",
          model: "gpt-test",
          apiKey: "loopback-fixture-only",
          baseUrl: `http://127.0.0.1:${port}/v1`
        }
      ]
    })
    const computer = new LocalBotComputerProvider(join(directory, "browser"))
    cleanup.push(() => computer.shutdown())
    const runtime = new CmbBotRuntime(modelFile, computer),
      host = new BotHost(store, runtime, 1, computer)
    host.bindOwnership(lock)
    if ("bindPeerDispatchAdmission" in host)
      host.bindPeerDispatchAdmission(
        createBotPeerDispatchAdmission(store, directory, ownedShellMaintenanceOwner(lock), () =>
          lock.assertCurrent()
        )
      )
    cleanup.push(() => host.stop())
    const token = randomBytes(32).toString("hex"),
      socketPath =
        process.platform === "win32"
          ? `\\\\.\\pipe\\peer-${token.slice(0, 16)}`
          : join(directory, "peer.sock")
    const rpc = new BotRpcServer(host, token)
    await rpc.listen(socketPath)
    cleanup.push(() => rpc.close())
    const client = new BotTransportClient({
      version: 1,
      pid: process.pid,
      hostId: host.id,
      socketPath,
      token
    })
    cleanup.push(() => client.close())
    const settled = new Map<string, (run: BotRun) => void>(),
      finish = store.finish.bind(store)
    const observer = vi.spyOn(store, "finish").mockImplementation((...args) => {
      const run = finish(...args)
      settled.get(run.id)?.(run)
      settled.delete(run.id)
      return run
    })
    cleanup.push(() => observer.mockRestore())
    const wait = (id: string) => {
      const run = store.getRun(id)
      return ["succeeded", "failed", "cancelled", "needs_review"].includes(run.status)
        ? Promise.resolve(run)
        : new Promise<BotRun>((resolve) => settled.set(id, resolve))
    }
    const receipt = await client.call("send", {
      nonce: "original",
      conversationId: a.conversationId,
      text: "Delegate and finish independently"
    })
    host.start()
    expect((await wait(receipt.runIds[0])).status).toBe("succeeded")
    const childId = String(
      store.db.exec("SELECT id FROM bot_runs WHERE parent_run_id=? AND source='peer'", [
        receipt.runIds[0]
      ])[0].values[0][0]
    )
    expect((await wait(childId)).status).toBe("succeeded")
    const sourceRuns = store.db.exec(
      "SELECT id,status FROM bot_runs WHERE bot_id=? ORDER BY rowid",
      [a.bot.id]
    )[0].values
    expect(sourceRuns).toHaveLength(2)
    const freshId = String(sourceRuns[1][0])
    expect((await wait(freshId)).status).toBe("succeeded")
    expect(requests).toHaveLength(mode === "automatic" ? 4 : 5)
    const freshRequest = requests.at(-1)!,
      lastUser = freshRequest.messages.filter((m) => m.role === "user").at(-1)!
    expect(lastUser.content).toContain("PEER_ACTUAL_RESULT")
    expect(lastUser.content).toContain("another bot reaching out, not the user")
    const messages = await client.call("messages", {
      conversationId: a.conversationId
    })
    expect(messages.filter((m) => m.text === "PEER_ACTUAL_RESULT")).toHaveLength(1)
    expect(messages.filter((m) => m.text === "CHILD_LOCAL_FINAL_NOT_SENT")).toHaveLength(0)
    expect(messages.filter((m) => m.text === "SOURCE_FRESH_RESULT_OBSERVED")).toHaveLength(1)
    expect(store.claim("afterwards")).toBeNull()
  },
  20_000
)
