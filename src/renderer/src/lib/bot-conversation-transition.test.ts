import { createHash } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_BOT_VIEW, useBotViewStore } from "@/components/bots/view-store"
import type { QueuedMessage, Thread } from "../types"
import type { useThreadContext } from "./thread-context"
import type { BotWorkConversationResolution } from "../../../shared/bots/conversation"
import { BOT_REQUEST_RECEIPT_RETENTION_MS } from "../../../shared/bots/contracts"
import {
  completeBotConversationDeletion,
  completeBotConversationTransition,
  prepareBotConversationLink,
  parkLinkedConversationQueue,
  parkOrdinaryConversationQueue
} from "./bot-conversation-transition"
import { getQueuedModelContent, nextOrdinaryQueuedMessage, prepareParkedSkillResume, queueStorageKey } from "./queued-message-content"
import { canonicalBotMessageInput } from "../../../shared/bots/message-mentions"
import { formatSkillUseBlock, parseSkillUseBlock } from "../features/slash-commands/skill-marker"
import { isThreadRetired, useAppStore } from "./store"
import { botConversationDraftKey, botThreadDraftKey } from "./bot-draft-storage"
const receipt = vi.fn(),
  reconcile = vi.fn()
const linkRequest = {
  id: "request-1", threadId: "original", action: "link",
  incarnation: { token: "original-incarnation", legacyCreatedAt: 1 }
} as const
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.restoreAllMocks()
})
function fixture(botTarget = false) {
  let queue: QueuedMessage[] = Array.from({ length: 41 }, (_, i) => ({
    id: `draft-${i}`,
    text: `Original ${i}`,
    created_at: new Date(1),
    updated_at: new Date(1),
    ...(i < 2
      ? {
          handoffRequestedAt: new Date(1),
          ...(botTarget ? { botHandoffTarget: { botId: "owner", workId: "work" } } : {})
        }
      : {})
  }))
  let suppressed = false
  vi.stubGlobal("window", {
    api: {
      agent: { reconcileCurrentRunQueuedMessages: reconcile },
      bots: { requestReceipts: receipt },
      threads: { get: vi.fn(async () => ({
        thread_id: linkRequest.threadId,
        created_at: new Date(linkRequest.incarnation.legacyCreatedAt),
        metadata: { cmb_thread_incarnation: linkRequest.incarnation.token }
      })) }
    }
  })
  const context = {
    initializeThread: () => {},
    getThreadState: () => ({
      queuedMessages: queue, draftInput: "", draftAttachments: [], draftMentionedWorkspaceFiles: []
    }),
    getThreadActions: () => ({
      syncDurableTranscript: vi.fn(async () => true),
      deleteQueuedMessage: (id: string, done?: (error: string | null) => void) => {
        queue = queue.filter((d) => d.id !== id)
        done?.(null)
      },
      updateQueuedMessage: (
        id: string,
        patch: Partial<QueuedMessage>,
        done?: (error: string | null) => void
      ) => {
        queue = queue.map((d) => (d.id === id ? { ...d, ...patch } : d))
        done?.(null)
      },
      setQueueAutoDrainSuppressed: (value: boolean) => {
        suppressed = value
      }
    })
  } as unknown as ReturnType<typeof useThreadContext>
  return {
    context,
    get queue() {
      return queue
    },
    get suppressed() {
      return suppressed
    }
  }
}
describe("association queue transitions", () => {
  it("restores the ordinary queue after a busy link rejection without reviving durable handoffs", async () => {
    const f = fixture()
    f.context.getThreadActions("original").updateQueuedMessage("draft-1", { handoffRequestedAt: undefined })
    reconcile.mockResolvedValue({ pendingIds: [], injectedIds: [], durableIds: ["draft-0"] })
    const original = f.queue.slice(1)
    const commit = await prepareBotConversationLink(f.context, {
      kind: "local_thread", threadId: "original", incarnation: linkRequest.incarnation
    })
    expect(nextOrdinaryQueuedMessage(f.queue)).toBeUndefined()
    await expect(commit(async () => { throw new Error("会话仍在运行") })).rejects.toThrow("仍在运行")
    expect(f.queue).toEqual(original)
    expect(f.queue.some(draft => draft.id === "draft-0")).toBe(false)
    expect(nextOrdinaryQueuedMessage(f.queue)?.id).toBe("draft-1")
    expect(f.suppressed).toBe(false)
  })

  it.each(["before", "during"] as const)("does not undo a user's Stop state (%s association)", async when => {
    const f = fixture()
    const stop = () => f.context.getThreadActions("original").setQueueAutoDrainSuppressed(true)
    reconcile.mockResolvedValue({ pendingIds: [], injectedIds: [], durableIds: [] })
    if (when === "before") stop()
    const commit = await prepareBotConversationLink(f.context, {
      kind: "local_thread", threadId: "original", incarnation: linkRequest.incarnation
    })
    if (when === "during") stop()
    await expect(commit(async () => { throw new Error("关联失败") })).rejects.toThrow("关联失败")
    expect(f.queue.every(draft => !draft.parkedForConversationLink)).toBe(true)
    expect(f.suppressed).toBe(true)
  })

  it.each(["bound", "new-incarnation", "unavailable"] as const)(
    "keeps the queue parked when a failed response cannot confirm an unbound original (%s)", async state => {
      const f = fixture()
      reconcile.mockResolvedValue({ pendingIds: [], injectedIds: [], durableIds: [] })
      const commit = await prepareBotConversationLink(f.context, {
        kind: "local_thread", threadId: "original", incarnation: linkRequest.incarnation
      })
      const read = vi.mocked(window.api.threads.get)
      if (state === "unavailable") read.mockRejectedValue(new Error("read failed"))
      else read.mockResolvedValue({ thread_id: "original", created_at: new Date(1), updated_at: new Date(1),
        status: "idle", metadata: state === "bound" ? {
          cmb_thread_incarnation: linkRequest.incarnation.token, botLocalConversation: true, botWorkId: "work"
        } : { cmb_thread_incarnation: "replacement" } })
      vi.spyOn(console, "warn").mockImplementation(() => {})
      await expect(commit(async () => { throw new Error("lost response") })).rejects.toThrow("lost response")
      expect(f.queue.every(draft => draft.parkedForConversationLink)).toBe(true)
    }
  )

  it("does not overwrite newer queue edits or restore deleted drafts after a link rejection", async () => {
    const f = fixture()
    reconcile.mockResolvedValue({ pendingIds: [], injectedIds: [], durableIds: [] })
    const commit = await prepareBotConversationLink(f.context, {
      kind: "local_thread", threadId: "original", incarnation: linkRequest.incarnation
    })
    const actions = f.context.getThreadActions("original")
    actions.updateQueuedMessage("draft-2", { text: "new user text" })
    actions.deleteQueuedMessage("draft-3")
    const edited = f.queue.find(draft => draft.id === "draft-2")
    await expect(commit(async () => { throw new Error("关联失败") })).rejects.toThrow("关联失败")
    expect(f.queue.find(draft => draft.id === "draft-2")).toBe(edited)
    expect(f.queue.some(draft => draft.id === "draft-3")).toBe(false)
    expect(f.queue.find(draft => draft.id === "draft-4")?.parkedForConversationLink).toBeUndefined()
  })

  it("restores and parks a cold queue before acknowledging a model association", async () => {
    const f = fixture()
    const getThreadState = f.context.getThreadState
    let restored = false
    f.context.initializeThread = (threadId, options) => {
      expect(threadId).toBe("original")
      expect(options?.requireQueuedMessages).toBe(true)
      restored = true
    }
    f.context.getThreadState = (threadId) => {
      expect(restored).toBe(true)
      return getThreadState(threadId)
    }
    reconcile.mockResolvedValue({ pendingIds: [], injectedIds: [], durableIds: [] })
    const finish = vi.fn(async () => {
      expect(f.queue.every((draft) => draft.parkedForConversationLink)).toBe(true)
    })
    const refresh = vi.fn(async () => {
      expect(finish).toHaveBeenCalledExactlyOnceWith("request-1")
      throw new Error("refresh failed")
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(completeBotConversationTransition(
      f.context, linkRequest, finish, refresh
    )).resolves.toBeUndefined()
    expect(finish).toHaveBeenCalledExactlyOnceWith("request-1")
    expect(refresh).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("refresh thread summaries"), new Error("refresh failed"))
  })

  it("reports an unresolved Bot handoff without committing or refreshing", async () => {
    const f = fixture(true)
    const link = {
      bot: { id: "owner" },
      work: { id: "work", threadId: "original" }
    } as BotWorkConversationResolution
    f.context.initializeThread = vi.fn()
    receipt.mockResolvedValue([])
    const finish = vi.fn(async () => {})
    const refresh = vi.fn(async () => {})
    await completeBotConversationTransition(
      f.context, { id: "request-2", threadId: "original", action: "unlink", link }, finish, refresh
    )
    expect(f.context.initializeThread).toHaveBeenCalledExactlyOnceWith("original", {
      requireQueuedMessages: true
    })
    expect(finish).toHaveBeenCalledExactlyOnceWith("request-2", expect.stringContaining("尚未核对"))
    expect(refresh).not.toHaveBeenCalled()
  })

  it.each(["confirmed", "rejected", "new-incarnation"] as const)(
    "preserves an unexposed work-key draft during native unlink (%s)", async outcome => {
      const f = fixture(true)
      const ref = { kind: "local_thread", threadId: "original", incarnation: linkRequest.incarnation } as const
      const request = { action: "unlink", id: "native-unlink", threadId: ref.threadId, unexposedRef: ref,
        link: {
          bot: { id: "owner", hostId: "local" },
          work: { id: "work", threadId: ref.threadId }
        } as BotWorkConversationResolution
      } as const
      vi.mocked(window.api.threads.get).mockResolvedValue({
        thread_id: ref.threadId, created_at: new Date(1), updated_at: new Date(1), status: "idle",
        metadata: { botId: "owner", botWorkId: "work",
          cmb_thread_incarnation: outcome === "new-incarnation" ? "replacement" : ref.incarnation.token }
      } satisfies Thread)
      receipt.mockImplementation(async (_bot, checks: { requestId: string }[]) =>
        checks.map(check => ({ requestId: check.requestId, state: "accepted" })))
      const workKey = botConversationDraftKey("local", "owner", "work")
      const threadKey = botThreadDraftKey(ref.threadId)
      const draft = { version: 2, text: "Unsent original", attachments: [], skill: { name: "review", path: "/skills/review" } }
      const values = new Map([[workKey, JSON.stringify(draft)]])
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      })
      const finish = vi.fn(async (_id: string, error?: string) => {
        expect(values.get(workKey)).toBe(JSON.stringify(draft))
        if (error) return
        expect(JSON.parse(values.get(threadKey)!)).toEqual({ incarnation: ref.incarnation, draft })
        if (outcome === "rejected") throw new Error("原任务仍在运行")
      })
      const refresh = vi.fn(async () => {})
      const result = completeBotConversationTransition(f.context, request, finish, refresh)
      if (outcome === "rejected") await expect(result).rejects.toThrow("仍在运行")
      else await result

      if (outcome === "confirmed") {
        expect(values.has(workKey)).toBe(false)
        expect(JSON.parse(values.get(threadKey)!)).toEqual({ incarnation: ref.incarnation, draft })
        expect(refresh).toHaveBeenCalledOnce()
      } else {
        expect(values.get(workKey)).toBe(JSON.stringify(draft))
        expect(values.has(threadKey)).toBe(false)
        expect(refresh).not.toHaveBeenCalled()
      }
      if (outcome === "new-incarnation") {
        expect(finish).toHaveBeenCalledExactlyOnceWith(request.id, expect.stringContaining("身份已变化"))
        expect(receipt).not.toHaveBeenCalled()
      }
    }
  )

  it.each(["matching", "changed", "failed"] as const)(
    "reconciles the saved Bot selection after a natural unlink (%s)",
    async (scenario) => {
      const f = fixture(true)
      receipt.mockImplementation(async (_bot, checks: { requestId: string }[]) =>
        checks.map(({ requestId }) => ({ requestId, state: "accepted" }))
      )
      const activeWorkIdByBot = { owner: "work", other: "work" }
      const hosts = {
        local: { ...DEFAULT_BOT_VIEW, activeWorkIdByBot },
        other: { ...DEFAULT_BOT_VIEW, activeWorkIdByBot: { owner: "work" } }
      }
      const update = vi.fn()
      vi.spyOn(useBotViewStore, "getState").mockReturnValue({
        ...useBotViewStore.getState(),
        hosts,
        update
      })
      const request = {
        id: "request-2", threadId: "original", action: "unlink",
        link: {
          bot: { hostId: "local", id: "owner" },
          work: { id: "work", threadId: "original" }
        } as BotWorkConversationResolution
      } as const
      const finish = vi.fn(async () => {
        expect(update).not.toHaveBeenCalled()
        if (scenario === "changed")
          hosts.local = { ...hosts.local, activeWorkIdByBot: { ...activeWorkIdByBot, owner: "new-work" } }
        if (scenario === "failed") throw new Error("解除关联未成功")
      })
      const refresh = vi.fn(async () => {})
      const result = completeBotConversationTransition(f.context, request, finish, refresh)
      if (scenario === "failed") {
        await expect(result).rejects.toThrow("解除关联未成功")
        expect(refresh).not.toHaveBeenCalled()
      } else {
        await result
        expect(refresh).toHaveBeenCalledOnce()
      }
      expect(finish).toHaveBeenCalledExactlyOnceWith(request.id)
      if (scenario === "matching") {
        expect(update).toHaveBeenCalledExactlyOnceWith("local", {
          activeWorkIdByBot: { owner: null, other: "work" }
        })
      } else {
        expect(update).not.toHaveBeenCalled()
      }
    }
  )

  it("does not park or remove queued drafts when the link expires during receipt checking", async () => {
    const f = fixture()
    const original = f.queue
    const controller = new AbortController()
    reconcile.mockImplementationOnce(async () => {
      controller.abort()
      return { pendingIds: [], injectedIds: [], durableIds: ["draft-0"] }
    })
    const finish = vi.fn(async () => {})
    await completeBotConversationTransition(f.context, linkRequest, finish, async () => {}, controller.signal)
    expect(reconcile).toHaveBeenCalledOnce()
    expect(finish).not.toHaveBeenCalled()
    expect(f.queue).toBe(original)
  })

  it("does not clear or reinterpret an old Bot handoff when associating a retained ordinary conversation", async () => {
    const f = fixture(true)
    await expect(parkOrdinaryConversationQueue(f.context, "original")).rejects.toThrow("此前 Bot")
    expect(reconcile).not.toHaveBeenCalled()
    expect(f.queue[0].handoffRequestedAt).toEqual(new Date(1))
    expect(f.queue[0].botHandoffTarget).toEqual({ botId: "owner", workId: "work" })
  })

  it("reconciles original desktop handoff and parks the remaining queue without dispatching it", async () => {
    const f = fixture()
    reconcile.mockResolvedValue({ pendingIds: [], injectedIds: [], durableIds: ["draft-0"] })
    await parkOrdinaryConversationQueue(f.context, "original")
    expect(reconcile).toHaveBeenCalledWith("original", ["draft-0", "draft-1"])
    expect(f.queue).toHaveLength(40)
    expect(f.queue.every((d) => d.parkedForConversationLink && !d.handoffRequestedAt)).toBe(true)
    expect(f.suppressed).toBe(false)
    expect(receipt).not.toHaveBeenCalled()
  })
  it("does not convert an existing pending desktop handoff into a new Bot request", async () => {
    const f = fixture()
    reconcile.mockResolvedValue({ pendingIds: ["draft-1"], injectedIds: [], durableIds: [] })
    await expect(parkOrdinaryConversationQueue(f.context, "original")).rejects.toThrow("已交接")
    expect(f.queue).toHaveLength(41)
    expect(f.suppressed).toBe(false)
  })
  it("keeps a handoff that starts while the ordinary queue is being checked", async () => {
    const f = fixture()
    reconcile.mockImplementationOnce(async () => {
      f.context.getThreadActions("original").updateQueuedMessage("draft-2", {
        handoffRequestedAt: new Date(2)
      })
      return { pendingIds: [], injectedIds: [], durableIds: [] }
    })
    await expect(parkOrdinaryConversationQueue(f.context, "original")).rejects.toThrow("已变化")
    expect(f.queue[2]).toMatchObject({ handoffRequestedAt: new Date(2) })
    expect(f.queue[2].parkedForConversationLink).toBeUndefined()
  })
  it("clears accepted Bot drafts before detach, leaves unsent drafts parked and keeps bounded reads", async () => {
    const f = fixture(true)
    receipt.mockImplementation(async (_bot: string, checks: { requestId: string }[]) =>
      checks.map((c) => ({ ...c, state: "accepted" }))
    )
    const link = {
      bot: { id: "owner" },
      work: { id: "work", threadId: "original" }
    } as BotWorkConversationResolution
    await parkLinkedConversationQueue(f.context, link)
    expect(receipt).toHaveBeenCalledTimes(1)
    expect(receipt.mock.calls[0][1]).toHaveLength(2)
    expect(receipt.mock.calls[0][2]).toBe("work")
    expect(f.queue).toHaveLength(39)
    expect(
      f.queue.every(
        (d) => d.parkedForConversationLink && !d.handoffRequestedAt && !d.botHandoffTarget
      )
    ).toBe(true)
    expect(f.suppressed).toBe(true)
  })
  it("keeps an unsent quoted draft usable in the original thread after unlink", async () => {
    const f = fixture(true)
    const quote = { id: "original-reply", ordinal: 9, role: "assistant" as const, text: "已核对旧报告" }
    f.context.getThreadActions("original").updateQueuedMessage("draft-1", {
      botReplyTo: quote, handoffRequestedAt: undefined, botHandoffTarget: undefined
    })
    receipt.mockImplementation(async (_bot: string, checks: { requestId: string }[]) =>
      checks.map(check => ({ ...check, state: "accepted" }))
    )
    await parkLinkedConversationQueue(f.context, {
      bot: { id: "owner" }, work: { id: "work", threadId: "original" }
    } as BotWorkConversationResolution)
    const parked = f.queue.find(draft => draft.id === "draft-1")!
    expect(parked).toMatchObject({ parkedForConversationLink: true, botReplyTo: quote })
    expect(parked.botHandoffTarget).toBeUndefined()
    expect(getQueuedModelContent(parked)).toContain("\n> 已核对旧报告\n\nOriginal 1")
    expect(f.suppressed).toBe(true)
  })
  it("reconciles an accepted explicit skill draft with the original request identity", async () => {
    const f = fixture(true)
    const explicitSkill = { name: "review", path: "/skills/review/SKILL.md" }
    f.context.getThreadActions("original").updateQueuedMessage("draft-0", { botExplicitSkill: explicitSkill })
    const expectedHash = createHash("sha256")
      .update(canonicalBotMessageInput("Original 0", undefined, undefined, explicitSkill)).digest("hex")
    receipt.mockImplementation(async (_bot, checks: { requestId: string; messageHash: string }[]) =>
      checks.map(check => ({ requestId: check.requestId, state: check.requestId !== "draft-0"
        ? "accepted" : check.messageHash === expectedHash ? "accepted" : "conflict" })))
    await parkLinkedConversationQueue(f.context, {
      bot: { id: "owner" }, work: { id: "work", threadId: "original" }
    } as BotWorkConversationResolution)
    expect(f.queue.some(draft => draft.id === "draft-0")).toBe(false)
  })
  it("resumes only the verified original skill and full parked draft in the ordinary queue", async () => {
    const f = fixture(true)
    const selection = { name: "review", path: "/skills/review/SKILL.md" }
    const skill = { ...selection, description: "Review a report", source: "user" as const, version: "1" }
    const quote = { id: "original-reply", ordinal: 9, role: "assistant" as const, text: "旧报告" }
    const attachments = '\n\n<attachment filename="report.md">报告</attachment>'
    const original = {
      handoffRequestedAt: undefined, botHandoffTarget: undefined,
      botExplicitSkill: selection, skillBlock: formatSkillUseBlock(selection),
      attachmentModelBlocks: attachments, attachmentDisplayPrefix: "📎 report.md", botReplyTo: quote
    }
    f.context.getThreadActions("original").updateQueuedMessage("draft-0", original)
    receipt.mockImplementation(async (_bot, checks: { requestId: string }[]) =>
      checks.map(check => ({ ...check, state: "accepted" })))
    await parkLinkedConversationQueue(f.context, {
      bot: { id: "owner" }, work: { id: "work", threadId: "original" }
    } as BotWorkConversationResolution)

    const [parked] = f.queue
    expect(nextOrdinaryQueuedMessage(f.queue)).toBeUndefined()
    expect(prepareParkedSkillResume(parked, [{ ...skill, path: "/other/SKILL.md" }], new Set())).toBeUndefined()
    expect(prepareParkedSkillResume(parked, [skill], new Set([skill.name]))).toBeUndefined()
    expect(prepareParkedSkillResume({ ...parked, skillBlock: formatSkillUseBlock({ ...selection, name: "other" }) },
      [skill], new Set())).toBeUndefined()
    expect(prepareParkedSkillResume({ ...parked, handoffRequestedAt: new Date() }, [skill], new Set())).toBeUndefined()
    const resume = prepareParkedSkillResume(parked, [skill], new Set())
    expect(resume).toEqual({ parkedForConversationLink: false, botExplicitSkill: undefined, skillBlock: formatSkillUseBlock(skill) })
    const resumed = { ...parked, ...resume }
    expect(nextOrdinaryQueuedMessage([resumed, ...f.queue.slice(1)])).toBe(resumed)
    expect(resumed).toMatchObject({ id: "draft-0", text: "Original 0", botReplyTo: quote, attachmentModelBlocks: attachments })
    expect(parseSkillUseBlock(getQueuedModelContent(resumed))).toMatchObject({
      skillName: skill.name, skillPath: skill.path, rest: expect.stringContaining(`> 旧报告\n\nOriginal 0${attachments}`)
    })
  })
  it("keeps an expired absent skill receipt identity across unlink", async () => {
    const f = fixture(true)
    const handoffRequestedAt = new Date(Date.now() - BOT_REQUEST_RECEIPT_RETENTION_MS)
    const botExplicitSkill = { name: "review", path: "/skills/review/SKILL.md" }
    f.context.getThreadActions("original").updateQueuedMessage("draft-0", { handoffRequestedAt, botExplicitSkill })
    receipt.mockImplementation(async (_bot, checks: { requestId: string }[]) =>
      checks.map(check => ({ ...check, state: "absent" })))
    await parkLinkedConversationQueue(f.context, {
      bot: { id: "owner" }, work: { id: "work", threadId: "original" }
    } as BotWorkConversationResolution)
    expect(f.queue[0]).toMatchObject({ handoffRequestedAt, botExplicitSkill, botHandoffTarget: { botId: "owner", workId: "work" } })
    expect(f.queue[0].parkedForConversationLink).toBeUndefined()
  })
  it("keeps unresolved Bot receipts and their source rather than reverting them to ordinary pending", async () => {
    const f = fixture(true),
      link = {
        bot: { id: "owner" },
        work: { id: "work", threadId: "original" }
      } as BotWorkConversationResolution
    receipt.mockResolvedValue([])
    await expect(parkLinkedConversationQueue(f.context, link)).rejects.toThrow("尚未核对")
    expect(f.queue[0].botHandoffTarget).toEqual({ botId: "owner", workId: "work" })
    expect(f.queue[0].handoffRequestedAt).toEqual(new Date(1))
  })
  it.each(["accepted-unlink", "rejected-unlink"] as const)(
    "keeps an absent Bot receipt protected when native unlink is %s", async outcome => {
    const f = fixture(true)
    f.context.getThreadActions("original").updateQueuedMessage("draft-0", {
      handoffRequestedAt: new Date(),
      botExplicitSkill: { name: "review", path: "/skills/review/SKILL.md" }
    })
    const original = f.queue.slice(0, 2)
    receipt.mockImplementation(async (_bot, checks: { requestId: string }[]) =>
      checks.map(check => ({ ...check, state: "absent" })))
    const finish = vi.fn(async () => {
      if (outcome === "rejected-unlink") throw new Error("原任务仍在运行")
    })
    const result = completeBotConversationTransition(f.context, {
      id: "unlink", action: "unlink", threadId: "original",
      link: { bot: { id: "owner" }, work: { id: "work", threadId: "original" } } as BotWorkConversationResolution
    }, finish, async () => {})
    if (outcome === "rejected-unlink") await expect(result).rejects.toThrow("仍在运行")
    else await result
    expect(finish).toHaveBeenCalledExactlyOnceWith("unlink")
    expect(f.queue[0]).toBe(original[0])
    expect(f.queue[1]).toBe(original[1])
    expect(f.queue[0].botHandoffTarget).toEqual({ botId: "owner", workId: "work" })
    expect(nextOrdinaryQueuedMessage(f.queue)).toBeUndefined()
    f.context.getThreadActions("original").deleteQueuedMessage("draft-0")
    f.context.getThreadActions("original").deleteQueuedMessage("draft-1")
    expect(f.queue.every(draft => draft.parkedForConversationLink)).toBe(true)
  })
  it("keeps a handoff that starts while the linked queue is being checked", async () => {
    const f = fixture(true)
    const link = {
      bot: { id: "owner" },
      work: { id: "work", threadId: "original" }
    } as BotWorkConversationResolution
    const handoff = { handoffRequestedAt: new Date(2), botHandoffTarget: { botId: "owner", workId: "work" } }
    receipt.mockImplementationOnce(async () => {
      f.context.getThreadActions("original").updateQueuedMessage("draft-2", handoff)
      return [{ requestId: "draft-0", state: "accepted" }]
    })
    await expect(parkLinkedConversationQueue(f.context, link)).rejects.toThrow("已变化")
    expect(f.queue[2]).toMatchObject(handoff)
    expect(f.queue[2].parkedForConversationLink).toBeUndefined()
  })
})

describe("model deletion renderer settlement", () => {
  const original = "approved-thread"
  const queue = queueStorageKey(original)
  const work = { botId: "owner", workId: "approved-work" }
  const draft = `cmb-bot-conversation-draft-v1:${JSON.stringify(["local", work.botId, work.workId])}`
  const otherDraft = `cmb-bot-conversation-draft-v1:${JSON.stringify(["local", work.botId, "other-work"])}`

  function deletionFixture() {
    const values = new Map([[queue, "queue"], [draft, "draft"], [otherDraft, "other draft"]])
    const storage = { removeItem: (key: string) => values.delete(key) }
    const deleteThread = vi.fn()
    vi.stubGlobal("localStorage", storage)
    vi.stubGlobal("window", { localStorage: storage, api: { threads: { delete: deleteThread } } })
    const cleanupThread = vi.fn()
    const context = {
      cleanupThread,
      getThreadStateSummaries: () => ({ [original]: {} })
    } as unknown as Parameters<typeof completeBotConversationDeletion>[0]
    return { cleanupThread, context, deleteThread, values }
  }

  it("cleans the committed thread and keeps the work draft when work bookkeeping fails", async () => {
    const f = deletionFixture()
    const thread = (id: string): Thread => ({
      thread_id: id, title: id, status: "idle", created_at: new Date(1), updated_at: new Date(1)
    })
    const next = thread("next-thread")
    const { threads, currentThreadId, mainView } = useAppStore.getState()
    useAppStore.setState({ threads: [thread(original), next], currentThreadId: original, mainView: "thread" })
    try {
      const finish = vi.fn(async () => ({ deletedThreadId: original, error: "剩余工作未删除" }))
      await expect(completeBotConversationDeletion(f.context, "approved", finish)).resolves.toBe("剩余工作未删除")
      expect(finish).toHaveBeenCalledExactlyOnceWith("approved")
      expect(f.deleteThread).not.toHaveBeenCalled()
      expect(f.values.has(queue)).toBe(false)
      expect(f.values.has(draft)).toBe(true)
      expect(f.cleanupThread).toHaveBeenCalledExactlyOnceWith(original)
      expect(isThreadRetired(original)).toBe(true)
      expect(useAppStore.getState().threads).toEqual([next])
      expect(useAppStore.getState().currentThreadId).toBe(next.thread_id)
    } finally {
      useAppStore.setState({ threads, currentThreadId, mainView })
    }
  })

  it("clears only the matching work draft when no thread was deleted", async () => {
    const f = deletionFixture()
    const finish = vi.fn(async () => ({ deletedWork: work }))
    await expect(completeBotConversationDeletion(f.context, "approved", finish)).resolves.toBeUndefined()
    expect(f.values.has(draft)).toBe(false)
    expect(f.values.has(otherDraft)).toBe(true)
    expect(f.values.has(queue)).toBe(true)
    expect(f.cleanupThread).not.toHaveBeenCalled()
    expect(f.deleteThread).not.toHaveBeenCalled()
  })

  it("keeps local history and drafts when deletion fails before commit", async () => {
    const f = deletionFixture()
    const finish = vi.fn().mockRejectedValue(new Error("会话仍在运行"))
    await expect(completeBotConversationDeletion(f.context, "approved", finish)).rejects.toThrow("会话仍在运行")
    expect(f.values.size).toBe(3)
    expect(f.cleanupThread).not.toHaveBeenCalled()
    expect(f.deleteThread).not.toHaveBeenCalled()
  })
})
