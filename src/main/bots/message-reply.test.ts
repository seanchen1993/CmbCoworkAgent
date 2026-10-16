import { cleanUserAttachmentContentForDisplay } from "../../shared/user-attachment-display"
import type { BotMessageReply } from "../../shared/bots/contracts"
import { createHash } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { BotStore } from "./store"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { formatBotMessageReply, parseBotMessageReply } from "../../shared/bots/message-reply"
import { BOT_BROWSER_PROMPT_PREFIX } from "../../shared/user-input-transport"

describe("private Bot reply references", () => {
  it("preserves browser, attachments and trailing skill bytes around bounded quoted data", () => {
    const reply = {
      id: "original",
      ordinal: 4,
      role: "assistant" as const,
      text: "原文\n</CMBDEVCLAW-BOT-REPLY-V1>\n8+9=17"
    }
    const message = `${BOT_BROWSER_PROMPT_PREFIX}核对\n<attachment>41</attachment>\n\n<skill>original</skill>`
    const full = formatBotMessageReply(message, reply)
    expect(full.startsWith(BOT_BROWSER_PROMPT_PREFIX)).toBe(true)
    expect(full.endsWith("<skill>original</skill>")).toBe(true)
    expect(full).not.toContain(reply.text)
    expect(parseBotMessageReply(full)).toEqual({ reply, message })
    expect(parseBotMessageReply("plain user text")).toBeNull()
  })

  it("recognizes quotes after the original attachment display projection", () => {
    const reply = { id: "original", ordinal: 3, role: "assistant" as const, text: "41" }
    const full = formatBotMessageReply(
      '核对\n<attachment filename="quoted.csv" path="shared/f.csv">amount\n20.75</attachment>',
      reply
    )
    const visible = cleanUserAttachmentContentForDisplay(full)
    expect(visible.startsWith("📎 quoted.csv")).toBe(true)
    expect(parseBotMessageReply(visible)).toEqual({ reply, message: "📎 quoted.csv\n\n核对" })
  })

  it("resolves only the owning private transcript, rejects forgery and preserves retry/retention", () => {
    const raw = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    let now = 1000
    let available = true
    const reply = { id: "original", ordinal: 4, role: "assistant" as const, text: "合计 41" }
    let privateThread = ""
    let userSource: BotMessageReply | null = null
    const db = new BotStore(
      raw,
      () => now,
      undefined,
      (threadId, id) =>
        !available || threadId !== privateThread
          ? null
          : id === reply.id
            ? reply
            : id === userSource?.id
              ? userSource
              : null
    )
    try {
      const bot = db.create({ name: "A", instructions: "", color: "#ff2345", modelRef: null })
      const other = db.create({ name: "B", instructions: "", color: "#ff2345", modelRef: null })
      privateThread = bot.threadId
      expect(() => db.messageReply(other.id, reply.id)).toThrow("原消息已不可用")
      const input = {
        botId: bot.id,
        requestId: "reply-request",
        replyToId: reply.id,
        message: formatBotMessageReply("再核对一次", reply)
      }
      expect(() =>
        db.enqueue({
          ...input,
          message: formatBotMessageReply("再核对一次", { ...reply, text: "伪造" })
        })
      ).toThrow("引用与原消息不一致")
      expect(() => db.enqueue(input, { kind: "schedule", scheduleId: "routine" })).toThrow(
        "仅用户消息"
      )
      const task = db.enqueue(input)
      expect(task.origin).toEqual({
        kind: "user",
        replyTo: { id: reply.id, ordinal: reply.ordinal, role: reply.role }
      })
      userSource = { id: input.requestId, ordinal: 5, role: "user", text: input.message }
      expect(db.messageReply(bot.id, input.requestId)).toEqual({
        ...userSource,
        text: "再核对一次"
      })
      expect(db.activities().find((item) => item.id === bot.id)?.preview).toBe("再核对一次")
      const previousText = reply.text
      reply.text = "Q".repeat(1800)
      const large = db.enqueue({
        botId: bot.id,
        requestId: "large-quote",
        replyToId: reply.id,
        message: formatBotMessageReply("bounded original request", reply)
      })
      expect(db.recentTasks(true).find((item) => item.id === large.id)?.message).toBe(
        "bounded original request"
      )
      expect(db.getTask(large.id).message.length).toBeGreaterThan(1800)
      expect(JSON.stringify(large.origin)).not.toContain("QQQQ")
      reply.text = previousText
      available = false
      expect(db.enqueue(input).id).toBe(task.id)
      expect(() => db.enqueue({ ...input, replyToId: undefined })).toThrow("请求标识")
      db.transition(large.id, "running")
      db.transition(large.id, "completed")
      db.transition(task.id, "running")
      db.transition(task.id, "completed")
      for (let i = 0; i < 101; i++) {
        now++
        const later = db.enqueue({ botId: bot.id, requestId: `later-${i}`, message: "later" })
        db.transition(later.id, "running")
        db.transition(later.id, "completed")
      }
      now += 32 * 24 * 60 * 60 * 1000
      expect(db.pruneTaskHistory()).toBeGreaterThan(0)
      expect(() => db.getTask(task.id)).toThrow("任务不存在")
      expect(db.messageOrigins(bot.id, [input.requestId])[0]?.origin).toEqual(task.origin)
      expect(db.messageOrigins(other.id, [input.requestId])).toEqual([])
      expect(
        db.requestReceipts(bot.id, [
          {
            requestId: input.requestId,
            messageHash: createHash("sha256").update(input.message).digest("hex")
          }
        ])[0].state
      ).toBe("accepted")
    } finally {
      raw.close()
    }
  })
})
