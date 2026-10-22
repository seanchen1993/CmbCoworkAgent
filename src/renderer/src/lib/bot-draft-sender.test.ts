import { webcrypto } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { NativeSqliteAdapter } from "../../../main/db/native-sqlite-adapter"
import { BotStore } from "../../../main/bots/store"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BotDraftSender, queueBotChatDraft } from "./bot-draft-sender"
import { getQueuedModelContent } from "./queued-message-content"
import { BOT_REQUEST_RECEIPT_RETENTION_MS, type BotTask } from "../../../shared/bots/contracts"
import type { QueuedMessage } from "../types"

afterEach(() => vi.unstubAllGlobals())

describe("new-chat queue ownership", () => {
  function queue(error: string | null = null) {
    vi.stubGlobal("crypto", webcrypto)
    let queued: QueuedMessage | undefined
    return {
      get: () => queued,
      addQueuedMessage: vi.fn<Parameters<typeof queueBotChatDraft>[0]["addQueuedMessage"]>(
        (draft, persist) => {
          queued = draft
          persist?.(error)
        }
      ),
      deleteQueuedMessage: vi.fn<Parameters<typeof queueBotChatDraft>[0]["deleteQueuedMessage"]>(
        () => {
          queued = undefined
        }
      )
    }
  }
  it("persists only the new text and retained attachment without reading or clearing the target draft", () => {
    const q = queue()
    const attachment = {
      filename: "核验.csv",
      filePath: "shared/a/核验.csv",
      content: "amount\n43",
      mimeType: "text/csv",
      size: 9,
      truncated: false
    }
    const draft = queueBotChatDraft(q, " 核对附件 ", [attachment])
    expect(q.get()).toBe(draft)
    expect(draft.text).toBe("核对附件")
    expect(getQueuedModelContent(draft, "bot")).toContain('path="shared/a/核验.csv"')
    expect(getQueuedModelContent(draft, "bot")).toContain("amount\n43")
    expect(draft.botReplyTo).toBeUndefined()
    expect(q.deleteQueuedMessage).not.toHaveBeenCalled()
  })
  it("rolls back the newly queued item when persistence fails", () => {
    const q = queue("storage full")
    expect(() => queueBotChatDraft(q, "只发送本条", [])).toThrow("storage full")
    expect(q.get()).toBeUndefined()
    expect(q.deleteQueuedMessage).toHaveBeenCalledExactlyOnceWith(expect.any(String))
  })
  it.each(["", " ", "x".repeat(64_001), "bad\0input"])(
    "rejects invalid new content before persisting: %#",
    (text) => {
      const q = queue()
      expect(() => queueBotChatDraft(q, text, [])).toThrow("超出发送限制")
      expect(q.addQueuedMessage).not.toHaveBeenCalled()
    }
  )
})

function fixture() {
  vi.stubGlobal("crypto", webcrypto)
  const date = new Date(1000)
  let draft: QueuedMessage | undefined = {
    id: "request-1",
    text: "请核对附件",
    attachmentModelBlocks: "\n<file path='/retained/核验.csv'>38.55</file>",
    attachmentDisplayPrefix: "📎 核验.csv",
    builtinBrowser: true,
    skillBlock: "<skill>Reviewed skill</skill>",
    created_at: date,
    updated_at: date
  }
  let saved = JSON.stringify(draft)
  let persistenceError: string | null = null
  const queue: ConstructorParameters<typeof BotDraftSender>[2] = {
    getQueuedMessage: () => draft,
    updateQueuedMessage: (_id, patch, onPersist) => {
      draft = draft
        ? { ...draft, ...patch, updated_at: new Date(draft.updated_at.getTime() + 1) }
        : undefined
      if (!persistenceError) saved = JSON.stringify(draft)
      onPersist?.(persistenceError)
    },
    deleteQueuedMessage: (_id, onPersist) => {
      draft = undefined
      if (!persistenceError) saved = ""
      onPersist?.(persistenceError)
    }
  }
  const report = vi.fn()
  const changed = vi.fn()
  let accepted = false
  const client = {
    send: vi.fn(async (input) => {
      accepted = true
      return { ...input, id: "task-1", state: "queued" } as BotTask
    }),
    requestReceipts: vi.fn(async (_botId, checks) =>
      checks.map(({ requestId }) => ({
        requestId,
        state: accepted ? ("accepted" as const) : ("absent" as const)
      }))
    )
  }
  const sender = () => new BotDraftSender(client, "bot-1", queue, report, changed, () => 2000)
  return {
    client,
    sender,
    report,
    changed,
    queue,
    draft: () => draft!,
    saved: () => saved,
    setPersistenceError: (error: string | null) => {
      persistenceError = error
    },
    patch: (patch: Partial<QueuedMessage>) => queue.updateQueuedMessage("request-1", patch),
    reload: () => {
      if (!saved) {
        draft = undefined
        return
      }
      const parsed = JSON.parse(saved)
      draft = {
        ...parsed,
        created_at: new Date(parsed.created_at),
        updated_at: new Date(parsed.updated_at),
        ...(parsed.handoffRequestedAt
          ? { handoffRequestedAt: new Date(parsed.handoffRequestedAt) }
          : {})
      }
    }
  }
}

describe("Bot sends through the original durable draft queue", () => {
  it("never retargets a retained Bot handoff after unlink/delete/reassociation, including after its receipt retention", async () => {
    const f = fixture(),
      old = { botId: "original-bot", workId: "original-work" }
    f.patch({ botHandoffTarget: old, handoffRequestedAt: new Date(1000) })
    f.reload()
    const sender = new BotDraftSender(
      f.client,
      "new-bot",
      f.queue,
      f.report,
      f.changed,
      () => 1000 + BOT_REQUEST_RECEIPT_RETENTION_MS + 1,
      { botId: "new-bot", workId: "new-work" }
    )
    await sender.send(f.draft())
    expect(f.client.send).not.toHaveBeenCalled()
    expect(f.client.requestReceipts).not.toHaveBeenCalled()
    expect(f.draft().botHandoffTarget).toEqual(old)
    expect(f.report.mock.calls.some(([message]) => String(message).includes("此前的 Bot"))).toBe(
      true
    )
    const original = new BotDraftSender(
      f.client,
      "original-bot",
      f.queue,
      f.report,
      f.changed,
      () => 1000 + BOT_REQUEST_RECEIPT_RETENTION_MS + 1,
      old
    )
    await original.send(f.draft())
    expect(f.client.requestReceipts).toHaveBeenCalledTimes(1)
    expect(f.client.send).not.toHaveBeenCalled()
    expect(f.draft().handoffRequestedAt).toEqual(new Date(1000))
    expect(f.report.mock.calls.some(([message]) => String(message).includes("保留期"))).toBe(true)
  })

  it("retains the exact quote and payload across response loss and reload", async () => {
    const f = fixture()
    const reply = { id: "original", ordinal: 7, role: "assistant" as const, text: "合计 41" }
    f.patch({ botReplyTo: reply })
    const original = getQueuedModelContent(f.draft(), "bot")
    f.client.send.mockRejectedValueOnce(new Error("transport interrupted"))
    await f.sender().send(f.draft())
    expect(f.client.send.mock.calls[0][0]).toMatchObject({
      replyToId: reply.id,
      message: original,
      requestId: "request-1"
    })
    f.reload()
    expect(f.draft().botReplyTo).toEqual(reply)
    await f.sender().send(f.draft())
    expect(f.client.send.mock.calls[1][0]).toEqual(f.client.send.mock.calls[0][0])
    expect(f.saved()).toBe("")
  })

  it("does not dispatch a delayed retry after the user stops while receipt reconciliation is in flight", async () => {
    const f = fixture()
    f.patch({ handoffRequestedAt: new Date(1000) })
    let resolve!: (value: Array<{ requestId: string; state: "absent" }>) => void
    f.client.requestReceipts.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const sender = f.sender()
    const pending = sender.send(f.draft())
    await vi.waitFor(() => expect(f.client.requestReceipts).toHaveBeenCalledTimes(1))
    sender.stopPreparing()
    resolve([{ requestId: "request-1", state: "absent" }])
    await pending
    expect(f.client.send).not.toHaveBeenCalled()
    expect(f.draft().text).toBe("请核对附件")
    await sender.send(f.draft())
    expect(f.client.send).toHaveBeenCalledTimes(1)
  })
  it("retries a real SQLite inbox after response loss and renderer reload without creating another task", async () => {
    const f = fixture()
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    try {
      const store = new BotStore(db)
      const bot = store.create({ name: "A", instructions: "", color: "#ea2845", modelRef: null })
      const client: ConstructorParameters<typeof BotDraftSender>[0] = {
        send: vi.fn(async (input) => {
          store.enqueue(input)
          throw new Error("Response lost after commit")
        }),
        requestReceipts: vi
          .fn(async (id, checks) => store.requestReceipts(id, checks))
          .mockRejectedValueOnce(new Error("Receipt connection also lost"))
      }
      const sender = new BotDraftSender(client, bot.id, f.queue, f.report, f.changed)
      await sender.send(f.draft())
      expect(f.draft().handoffRequestedAt).toBeInstanceOf(Date)
      const rows = db.exec("SELECT request_id,message FROM bot_tasks")[0]
      expect(rows.values).toHaveLength(1)
      f.reload()
      await new BotDraftSender(client, bot.id, f.queue, f.report, f.changed).send(f.draft())
      expect(f.draft()).toBeUndefined()
      expect(db.exec("SELECT request_id FROM bot_tasks")[0].values).toHaveLength(1)
      expect(client.send).toHaveBeenCalledTimes(1)
      expect(client.requestReceipts).toHaveBeenCalledTimes(2)
    } finally {
      db.close()
    }
  })
  it("reconciles a committed request whose transport response was lost without resending or flattening attachments", async () => {
    const f = fixture()
    const original = f.draft()
    const message = getQueuedModelContent(original, "bot")
    f.client.send.mockImplementationOnce(async () => {
      f.client.requestReceipts.mockResolvedValue([{ requestId: original.id, state: "accepted" }])
      throw new Error("Response lost")
    })
    await f.sender().send(original)
    expect(f.client.send).toHaveBeenCalledExactlyOnceWith({
      botId: "bot-1",
      requestId: original.id,
      message
    })
    expect(f.saved()).toBe("")
    expect(f.draft()).toBeUndefined()
    expect(f.report).not.toHaveBeenCalledWith(expect.stringContaining("原消息和附件"))
  })
  it("keeps the nonce and structured payload through failure, reload and a user retry", async () => {
    const f = fixture()
    const original = f.draft()
    f.client.send.mockRejectedValueOnce(new Error("Disconnected"))
    await f.sender().send(original)
    expect(f.draft()).toMatchObject({
      id: original.id,
      text: original.text,
      attachmentModelBlocks: original.attachmentModelBlocks,
      attachmentDisplayPrefix: original.attachmentDisplayPrefix,
      skillBlock: original.skillBlock,
      builtinBrowser: true
    })
    expect(f.draft().handoffRequestedAt).toBeInstanceOf(Date)
    f.reload()
    const reopened = f.sender()
    await reopened.reconcile([f.draft()])
    expect(f.client.send).toHaveBeenCalledTimes(1)
    await reopened.send(f.draft())
    expect(f.client.send).toHaveBeenCalledTimes(2)
    expect(f.client.send.mock.calls[1][0]).toEqual(f.client.send.mock.calls[0][0])
    expect(f.saved()).toBe("")
  })
  it("clears an accepted pending draft after reload without starting a second execution", async () => {
    const f = fixture()
    f.client.send.mockImplementationOnce(async () => {
      f.client.requestReceipts.mockRejectedValueOnce(new Error("Receipt offline"))
      throw new Error("Lost response")
    })
    await f.sender().send(f.draft())
    f.reload()
    f.client.requestReceipts.mockResolvedValue([{ requestId: "request-1", state: "accepted" }])
    await f.sender().reconcile([f.draft()])
    expect(f.client.send).toHaveBeenCalledTimes(1)
    expect(f.saved()).toBe("")
  })
  it("does not dispatch if saving the handoff fails and can recover after quota is restored", async () => {
    const f = fixture()
    f.setPersistenceError("Quota exceeded")
    await f.sender().send(f.draft())
    expect(f.client.send).not.toHaveBeenCalled()
    expect(f.draft().text).toBe("请核对附件")
    f.setPersistenceError(null)
    await f.sender().send(f.draft())
    expect(f.client.send).toHaveBeenCalledTimes(1)
  })
  it("rejects conflicting receipts, invalid payloads and expired unknown requests without blindly replaying", async () => {
    const f = fixture()
    f.patch({ handoffRequestedAt: new Date(1000) })
    f.client.requestReceipts.mockResolvedValue([{ requestId: "request-1", state: "conflict" }])
    await f.sender().send(f.draft())
    expect(f.client.send).not.toHaveBeenCalled()
    f.client.requestReceipts.mockResolvedValue([{ requestId: "request-1", state: "absent" }])
    f.patch({ handoffRequestedAt: new Date(2000 - BOT_REQUEST_RECEIPT_RETENTION_MS) })
    await f.sender().send(f.draft())
    expect(f.client.send).not.toHaveBeenCalled()
    f.patch({ handoffRequestedAt: undefined, text: "x".repeat(64001) })
    await f.sender().send(f.draft())
    expect(f.client.send).not.toHaveBeenCalled()
    expect(f.draft().handoffRequestedAt).toBeUndefined()
  })
  it("coalesces concurrent retries and does not delete a newer edit after an old ACK", async () => {
    const f = fixture()
    let resolve!: (task: BotTask) => void
    f.client.send.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const sender = f.sender()
    const first = sender.send(f.draft())
    await vi.waitFor(() => expect(f.client.send).toHaveBeenCalledTimes(1))
    await sender.send(f.draft())
    f.patch({ text: "Newer edit" })
    resolve({ ...f.client.send.mock.calls[0][0], id: "task", state: "queued" } as BotTask)
    await first
    expect(f.client.send).toHaveBeenCalledTimes(1)
    expect(f.draft().text).toBe("Newer edit")
    expect(sender.sending.size).toBe(0)
    expect(f.changed).toHaveBeenCalledTimes(2)
  })
})
