import { afterEach, expect, it, vi } from "vitest"
import { BotStore } from "./store"
import { BotComputerHelpCompletion } from "./computer-help-completion"
import { botComputerHelpTool } from "./computer-help-tool"
import {
  writeBotComputerHelp,
  readBotComputerHelp,
  type BotComputerHelpReturn
} from "../../shared/bot-computer-help"
import { botWorkflowChildAllows } from "./workflow-child-policy"
import type { BotRuntimeRequest } from "./host"
import type { LocalBotComputerProvider } from "./computer-provider"

const uuid = "12345678-1234-4123-8123-123456789012"
const now = 1_800_000_000_000
const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
function fixture() {
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const { bot, conversationId } = store.createBot({
    nonce: "create",
    name: "Bot"
  })
  store.send({ nonce: "send", conversationId, text: "查询订单" })
  const { lease, run } = store.claim("host-a")!
  const card = {
    version: 1 as const,
    hostId: "host-a",
    dataEpoch: store.dataEpoch(),
    botId: bot.id,
    runId: run.id,
    runFence: lease.fence,
    conversationId,
    backend: "browser" as const,
    instruction: "请在浏览器中登录",
    reason: "auth" as const,
    generation: uuid,
    controlEpoch: 0
  }
  const interaction = store.requestInteraction(lease, {
    kind: "question",
    prompt: writeBotComputerHelp(card)
  })
  const returning: BotComputerHelpReturn = {
    backend: "browser",
    target: {
      botId: bot.id,
      generation: uuid,
      viewId: uuid,
      controlEpoch: 1,
      control: "human"
    }
  }
  const returned: BotComputerHelpReturn = {
    backend: "browser",
    target: { ...returning.target, controlEpoch: 2, control: "bot" }
  }
  const client = new AbortController()
  const ports = {
    hostId: "host-a",
    dataEpoch: card.dataEpoch,
    client: client.signal,
    interaction: () => store.getInteraction(interaction.id),
    validateRun: vi.fn(),
    release: vi.fn(async (): Promise<BotComputerHelpReturn> => returned),
    commit: vi.fn(
      (input: { id: string; revision: number; answer: string }, proof: BotComputerHelpReturn) =>
        store.answerComputerHelp(input, proof)
    )
  }
  const input = {
    id: interaction.id,
    revision: interaction.revision,
    answer: "done",
    computerHelpTarget: returning
  }
  return {
    store,
    lease,
    run,
    card,
    interaction,
    returning,
    returned,
    client,
    ports,
    input,
    service: new BotComputerHelpCompletion(() => now)
  }
}
it("pauses the actual run, rejects text Done/credentials, and commits one readable answer and receipt", async () => {
  const f = fixture()
  expect(f.store.getRun(f.run.id).status).toBe("waiting_input")
  expect(() => f.store.answerInteraction(f.input)).toThrow("归还电脑")
  expect(() => f.store.answerInteraction({ ...f.input, answer: "123456" })).toThrow(
    "勿在回答中填写凭据"
  )
  const accepted = await f.service.answer(f.input, f.ports)
  expect(accepted.status).toBe("answered")
  expect(f.store.getRun(f.run.id).status).toBe("running")
  expect(await f.service.answer(f.input, f.ports)).toEqual(accepted)
  expect(f.ports.release).toHaveBeenCalledTimes(1)
  const messages = f.store.messages(f.run.conversationId)
  expect(messages.some((message) => message.text.includes("人工操作已完成"))).toBe(true)
  expect(messages.some((message) => message.text.includes('"botComputerHelp"'))).toBe(false)
})
it("joins duplicate in-flight answers without dispatching a second grant", async () => {
  const f = fixture()
  let resolve!: (value: BotComputerHelpReturn) => void
  f.ports.release.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const first = f.service.answer(f.input, f.ports),
    second = f.service.answer(f.input, f.ports)
  await Promise.resolve()
  resolve(f.returned)
  expect(await first).toEqual(await second)
  expect(f.ports.release).toHaveBeenCalledTimes(1)
})
it("does not prune an in-flight physical handback when the short retry TTL passes", async () => {
  const f = fixture()
  let clock = now,
    resolve!: (value: BotComputerHelpReturn) => void
  const service = new BotComputerHelpCompletion(() => clock)
  f.ports.release.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const first = service.answer(f.input, f.ports)
  await Promise.resolve()
  clock += 120_000
  const second = service.answer(f.input, f.ports)
  resolve(f.returned)
  expect(await first).toEqual(await second)
  expect(f.ports.release).toHaveBeenCalledTimes(1)
})
it("bounds pending proof collection before admitting another physical handback", async () => {
  const f = fixture(),
    g = fixture(),
    service = new BotComputerHelpCompletion(() => now, 1)
  f.ports.commit.mockImplementationOnce(() => {
    throw new Error("disk unavailable")
  })
  await expect(service.answer(f.input, f.ports)).rejects.toThrow("disk unavailable")
  await expect(service.answer(g.input, g.ports)).rejects.toThrow("正在提交")
  expect(g.ports.release).not.toHaveBeenCalled()
  f.client.abort()
  await service.answer(g.input, g.ports)
  expect(g.ports.release).toHaveBeenCalledTimes(1)
})
it("collects an actual successful handback after DB failure without retrying the stale target", async () => {
  const f = fixture()
  f.ports.commit.mockImplementationOnce(() => {
    throw new Error("disk unavailable")
  })
  await expect(f.service.answer(f.input, f.ports)).rejects.toThrow("disk unavailable")
  expect(f.store.getInteraction(f.interaction.id).status).toBe("pending")
  await f.service.answer(f.input, f.ports)
  expect(f.ports.release).toHaveBeenCalledTimes(1)
})
it("releases the client listener on commit, release failure and client close", async () => {
  const f = fixture(),
    add = vi.spyOn(f.client.signal, "addEventListener"),
    remove = vi.spyOn(f.client.signal, "removeEventListener")
  await f.service.answer(f.input, f.ports)
  expect(add.mock.calls.filter(([name]) => name === "abort")).toHaveLength(1)
  expect(remove.mock.calls.filter(([name]) => name === "abort")).toHaveLength(1)
  const g = fixture(),
    drop = vi.spyOn(g.client.signal, "removeEventListener")
  g.ports.release.mockRejectedValueOnce(new Error("grant unknown"))
  await expect(g.service.answer(g.input, g.ports)).rejects.toThrow("grant unknown")
  expect(g.ports.commit).not.toHaveBeenCalled()
  expect(drop).toHaveBeenCalledTimes(1)
  const h = fixture(),
    closed = vi.spyOn(h.client.signal, "removeEventListener")
  h.ports.commit.mockImplementationOnce(() => {
    throw new Error("disk unavailable")
  })
  await expect(h.service.answer(h.input, h.ports)).rejects.toThrow()
  h.client.abort()
  expect(closed).toHaveBeenCalledTimes(1)
})
it("rejects wrong backend/generation/host/client and never interprets Bot control as completion", async () => {
  const f = fixture()
  await expect(
    f.service.answer(
      {
        ...f.input,
        computerHelpTarget: {
          ...f.returning,
          target: { ...f.returning.target, control: "bot" }
        }
      },
      f.ports
    )
  ).rejects.toThrow("对应的电脑")
  await expect(f.service.answer(f.input, { ...f.ports, hostId: "host-b" })).rejects.toThrow(
    "后台或工作区"
  )
  await expect(
    f.service.answer(
      {
        ...f.input,
        computerHelpTarget: {
          ...f.returning,
          target: {
            ...f.returning.target,
            generation: "22345678-1234-4123-8123-123456789012"
          }
        }
      },
      f.ports
    )
  ).rejects.toThrow("对应的电脑")
  f.ports.commit.mockImplementationOnce(() => {
    throw new Error("disk unavailable")
  })
  await expect(f.service.answer(f.input, f.ports)).rejects.toThrow()
  await expect(
    f.service.answer(f.input, {
      ...f.ports,
      client: new AbortController().signal
    })
  ).rejects.toThrow("另一控制权")
  expect(f.ports.release).toHaveBeenCalledTimes(1)
})
it("cancel/expiry stop the help without confirming a login or replaying input", async () => {
  const f = fixture()
  f.store.answerInteraction({ ...f.input, answer: "cancel" })
  await expect(f.service.answer(f.input, f.ports)).rejects.toThrow("已处理或过期")
  expect(f.ports.release).not.toHaveBeenCalled()
  const g = fixture()
  g.store.cancel(g.run.id)
  await expect(g.service.answer(g.input, g.ports)).rejects.toThrow("已处理或过期")
  const h = fixture()
  h.store.recoverAbandonedAtStartup()
  expect(h.store.getRun(h.run.id).status).toBe("needs_review")
  expect(h.store.getInteraction(h.interaction.id).status).toBe("expired")
  await expect(h.service.answer(h.input, h.ports)).rejects.toThrow("已处理或过期")
  expect(h.ports.release).not.toHaveBeenCalled()
})
it("keeps receipts compact and rejects malformed help cards", () => {
  const f = fixture()
  expect(readBotComputerHelp(writeBotComputerHelp(f.card))).toEqual(f.card)
  expect(readBotComputerHelp('{"botComputerHelp":{"version":2}}')).toBeNull()
  expect(readBotComputerHelp(writeBotComputerHelp(f.card) + " ".repeat(4096))).toBeNull()
})
it("allows help only for an explicitly authorized browser child and honors browser deny rules", () => {
  const role = { browserAccess: "page", shellAccess: "none" } as Parameters<
    typeof botWorkflowChildAllows
  >[0]
  expect(botWorkflowChildAllows(role, "request_computer_help")).toBe(true)
  expect(
    botWorkflowChildAllows({ ...role, browserAccess: undefined }, "request_computer_help")
  ).toBe(false)
  expect(
    botWorkflowChildAllows({ ...role, disallowedTools: ["browser"] }, "request_computer_help")
  ).toBe(false)
})
it("uses one existing interaction and returns a fresh browser screenshot after actual handback", async () => {
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const { bot, conversationId } = store.createBot({
    nonce: "create-tool",
    name: "Bot"
  })
  store.send({ nonce: "send-tool", conversationId, text: "查询订单" })
  const { lease, run } = store.claim("host-a")!
  const target = {
    botId: bot.id,
    generation: uuid,
    viewId: uuid,
    controlEpoch: 0,
    control: "bot" as const
  }
  const screenshot = vi.fn(async () => ({
    summary: "fresh signed-in view",
    image: "data:image/jpeg;base64,fresh"
  }))
  const broker = {
    ensure: vi.fn(async () => target),
    target: () => target,
    act: screenshot
  }
  const browser = {
    get: vi.fn(async () => broker)
  } as unknown as LocalBotComputerProvider
  const help = botComputerHelpTool({
    request: {
      bot,
      run,
      lease,
      store,
      signal: new AbortController().signal
    } as BotRuntimeRequest,
    browser,
    child: false,
    check: () => {},
    wait: async (id) => {
      const interaction = store.getInteraction(id)
      if (interaction.status === "answered") return interaction.answer!
      expect(store.getRun(run.id).status).toBe("waiting_input")
      store.answerComputerHelp(
        { id, revision: interaction.revision, answer: "done" },
        { backend: "browser", target: { ...target, controlEpoch: 2 } }
      )
      return "done"
    }
  })
  const result = await help.invoke({
    name: "request_computer_help",
    id: "help-1",
    type: "tool_call",
    args: { backend: "browser", instruction: "请登录", reason: "auth" }
  })
  expect(screenshot).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(result)).toContain("fresh signed-in view")
  expect(JSON.stringify(result)).toContain("data:image/jpeg;base64,fresh")
  expect(store.getRun(run.id).status).toBe("running")
  await help.invoke({
    name: "request_computer_help",
    id: "help-1",
    type: "tool_call",
    args: { backend: "browser", instruction: "请登录", reason: "auth" }
  })
  expect(broker.ensure).toHaveBeenCalledTimes(1)
  expect(store.events(0).filter((event) => event.kind === "interaction.requested")).toHaveLength(1)
})
it("never opens Native through child help or unauthorized Browser child help", async () => {
  const f = fixture(),
    get = vi.fn(),
    nativeEnsure = vi.fn()
  const help = botComputerHelpTool({
    request: {
      store: f.store,
      lease: f.lease,
      bot: { id: f.card.botId },
      run: f.run,
      signal: f.client.signal
    } as BotRuntimeRequest,
    browser: { get } as unknown as LocalBotComputerProvider,
    child: true,
    check: () => {},
    wait: async () => "done"
  })
  await expect(
    help.invoke({
      backend: "windows-native",
      instruction: "登录",
      reason: "auth"
    })
  ).rejects.toThrow("未获对应电脑权限")
  await expect(
    help.invoke({ backend: "browser", instruction: "登录", reason: "auth" })
  ).rejects.toThrow("未获对应电脑权限")
  expect(get).not.toHaveBeenCalled()
  expect(nativeEnsure).not.toHaveBeenCalled()
})
