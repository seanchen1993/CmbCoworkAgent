import { expect, it, vi } from "vitest"
import type { BotDefinition } from "../../../shared/bots/contracts"
import {
  botChatRecipientKey,
  materializeBotChatRecipients,
  type BotChatRecipient
} from "./bot-chat-recipients"

const bot = (id: string, name = id): BotDefinition => ({
  id,
  name,
  hostId: "local",
  threadId: `${id}-thread`,
  modelRef: null,
  instructions: "",
  color: "#ed2040",
  archived: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1
})
const fresh = (name: string): BotChatRecipient => ({ kind: "new", name })
const known = (id: string): BotChatRecipient => ({ kind: "bot", id })

it("preserves mixed order and creates a distinct identity even when a display name already exists", async () => {
  const create = vi.fn().mockResolvedValue(bot("new-a", "A"))
  const cache = new Map<string, BotDefinition>()
  const result = await materializeBotChatRecipients(
    { hostId: "local", create },
    [known("a"), fresh("A"), known("b")],
    [bot("a", "A"), bot("b")],
    cache,
    () => true
  )
  expect(result.map((b) => b.id)).toEqual(["a", "new-a", "b"])
  expect(create).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ name: "A", instructions: "", modelRef: null })
  )
  expect(cache.get(botChatRecipientKey(fresh("A")))?.id).toBe("new-a")
})

it("retains only successful creates and retries the failed profile without creating the first again", async () => {
  const create = vi
    .fn()
    .mockResolvedValueOnce(bot("a"))
    .mockRejectedValueOnce(new Error("IPC unavailable"))
    .mockResolvedValueOnce(bot("b"))
  const client = { hostId: "local", create },
    cache = new Map<string, BotDefinition>(),
    recipients = [fresh("A"), fresh("B")]
  await expect(
    materializeBotChatRecipients(client, recipients, [], cache, () => true)
  ).rejects.toThrow("IPC unavailable")
  expect(cache.size).toBe(1)
  expect(
    (await materializeBotChatRecipients(client, recipients, [], cache, () => true)).map((b) => b.id)
  ).toEqual(["a", "b"])
  expect(create.mock.calls.map(([input]) => input.name)).toEqual(["A", "B", "B"])
})

it.each([{ archived: true }, { deleting: true }, { hostId: "remote" }])(
  "rejects an unavailable existing identity before creating anything: %j",
  async (patch) => {
    const create = vi.fn()
    await expect(
      materializeBotChatRecipients(
        { hostId: "local", create },
        [fresh("A"), known("old")],
        [{ ...bot("old"), ...patch }],
        new Map(),
        () => true
      )
    ).rejects.toThrow("不可用")
    expect(create).not.toHaveBeenCalled()
  }
)

it.each([
  { recipients: [], reason: "请选择" },
  { recipients: [known("same"), known("same")], reason: "不能重复" },
  { recipients: [fresh("Name"), fresh(" name ")], reason: "不能重复" },
  { recipients: Array.from({ length: 9 }, (_, i) => fresh(String(i))), reason: "请选择" }
])("rejects an invalid recipient set before IPC: %#", async ({ recipients, reason }) => {
  const create = vi.fn()
  await expect(
    materializeBotChatRecipients({ hostId: "local", create }, recipients, [], new Map(), () => true)
  ).rejects.toThrow(reason)
  expect(create).not.toHaveBeenCalled()
})

it("does not continue a switched-away creation or discard its committed identity", async () => {
  let current = true
  const create = vi
    .fn()
    .mockImplementationOnce(async () => {
      current = false
      return bot("a")
    })
    .mockResolvedValueOnce(bot("b"))
  const cache = new Map<string, BotDefinition>(),
    client = { hostId: "local", create },
    recipients = [fresh("A"), fresh("B")]
  await expect(
    materializeBotChatRecipients(client, recipients, [], cache, () => current)
  ).rejects.toThrow("已切换")
  expect(create).toHaveBeenCalledTimes(1)
  expect(cache.size).toBe(1)
  current = true
  expect(
    (await materializeBotChatRecipients(client, recipients, [], cache, () => current)).map(
      (b) => b.id
    )
  ).toEqual(["a", "b"])
  expect(create).toHaveBeenCalledTimes(2)
})

it("does not pass cross-host create results or cached identities to a group", async () => {
  const cache = new Map<string, BotDefinition>()
  const create = vi.fn().mockResolvedValue({ ...bot("foreign"), hostId: "remote" })
  await expect(
    materializeBotChatRecipients({ hostId: "local", create }, [fresh("A")], [], cache, () => true)
  ).rejects.toThrow("不属于当前主机")
  expect(cache.size).toBe(0)
  cache.set(botChatRecipientKey(fresh("A")), { ...bot("foreign"), hostId: "remote" })
  await expect(
    materializeBotChatRecipients({ hostId: "local", create }, [fresh("A")], [], cache, () => true)
  ).rejects.toThrow("主机已变化")
  expect(create).toHaveBeenCalledTimes(1)
})
