import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BotMessageMention, BotMessageReply } from "../../../shared/bots/contracts"
import type { BotWorkConversationResolution } from "../../../shared/bots/conversation"
import type { BotOrdinaryThreadRef } from "../../../shared/bots/thread-history"
import type { QueuedMessage, SkillMetadata, Thread } from "../types"
import type { FileAttachment } from "../../../shared/file-attachment"
import { buildAttachmentMessageParts } from "../../../shared/attachment-message-parts"
import { botInputFileIds } from "../../../shared/bots/input-files"
import {
  resolveAtFileAttachments,
  toMentionedWorkspaceFile,
  type MentionedWorkspaceFile
} from "@/features/mentions/atFileAttachments"
import { queueBotChatDraft } from "./bot-draft-sender"
import { getQueuedBotMessageInput, getQueuedModelContent } from "./queued-message-content"
import { completeBotConversationTransition } from "./bot-conversation-transition"
import { applyCommittedThreadDeletion, useAppStore } from "./store"
import {
  bindBotConversationDraft,
  bindDetachedBotThreadDraft,
  hasBotThreadDraft,
  loadBotConversationDraft,
  preserveUnlinkComposerDraft,
  restoreBotConversationDraft,
  saveBotConversationDraft,
  pruneBotConversationDrafts
} from "./bot-conversation-draft"
import { botThreadDraftKey } from "./bot-draft-storage"
import { parseFileBytes } from "../../../main/file-parser"
import { findEnabledSkillSelection } from "./skill-ids"
import type { ThreadDraftSkill } from "./thread-context"

type Context = Parameters<typeof bindBotConversationDraft>[0]
const file: FileAttachment = {
  filename: "核验.csv",
  filePath: "/retained/核验.csv",
  content: "amount\n38.55",
  mimeType: "text/csv",
  size: 12,
  truncated: false
}
const skill: SkillMetadata = {
  name: "核验数据",
  path: "/skills/check-data/SKILL.md",
  source: "user",
  version: "1",
  description: "Validate the data",
  id: "check-data"
}
const skillIdentity = { name: skill.name, path: skill.path }
const fixture = () => {
  let state = {
    draftInput: "",
    draftBotMentions: undefined as BotMessageMention[] | undefined,
    draftAttachments: [] as FileAttachment[],
    draftMentionedWorkspaceFiles: [] as MentionedWorkspaceFile[],
    draftBotReplyTo: null as BotMessageReply | null,
    draftSkill: null as ThreadDraftSkill | null,
    draftBuiltinBrowser: false,
    messages: []
  }
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const actions = {
    setDraftBotInput: (draftInput: string, draftBotMentions: BotMessageMention[]) => publish({ draftInput, draftBotMentions }),
    setDraftBotReplyTo: (draftBotReplyTo: BotMessageReply | null) => publish({ draftBotReplyTo }),
    setDraftInput: (draftInput: string) => publish({ draftInput }),
    setDraftAttachments: (draftAttachments: FileAttachment[]) => publish({ draftAttachments }),
    setDraftSkill: (draftSkill: ThreadDraftSkill | null) => publish({ draftSkill }),
    setDraftBuiltinBrowser: (draftBuiltinBrowser: boolean) => publish({ draftBuiltinBrowser }),
    setDraftMentionedWorkspaceFiles: (draftMentionedWorkspaceFiles: MentionedWorkspaceFile[]) =>
      publish({ draftMentionedWorkspaceFiles })
  }
  return {
    state: () => state,
    publish,
    actions,
    listeners,
    context: {
      initializeThread: vi.fn(),
      getThreadState: () => state,
      getThreadActions: () => actions,
      subscribeToThreadState: (_: string, listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    } as unknown as Context
  }
}

let values: Map<string, string>
beforeEach(() => {
  values = new Map()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe("drafts that remain with an unlinked native thread", () => {
  const ref: BotOrdinaryThreadRef = {
    kind: "local_thread", threadId: "unlinked-original", incarnation: { token: "original-token", legacyCreatedAt: 10 }
  }
  const link = {
    bot: { id: "owner", hostId: "local" },
    work: { id: "old-work", botId: "owner", threadId: ref.threadId, audienceKey: "desktop",
      conversation: { ref, origin: "existing", state: "bound" } }
  } as BotWorkConversationResolution
  const row: Thread = { thread_id: ref.threadId, status: "idle", created_at: new Date(10),
    updated_at: new Date(11), metadata: { cmb_thread_incarnation: "original-token" } }
  const quote: BotMessageReply = { id: "ref", ordinal: 2, role: "assistant", text: "原结论" }
  const attachment = { ...file, botInputId: "input-10000000-2000-4000-8000-000000000000" }
  const workspaceFile: MentionedWorkspaceFile = {
    id: "source.txt", displayPath: "source.txt", workspaceFilePath: "source.txt",
    absolutePath: "/work/source.txt", workspaceKey: "/work", filename: "source.txt"
  }
  const payload = { draftInput: "继续核对", draftAttachments: [attachment],
    draftMentionedWorkspaceFiles: [workspaceFile], draftBotReplyTo: quote }

  const linkRequest = { id: "natural-link", action: "link" as const, threadId: ref.threadId,
    incarnation: ref.incarnation }
  function associationFixture() {
    const original = fixture()
    const queuedMessages: QueuedMessage[] = []
    const get = vi.fn(async (_threadId: string): Promise<Thread | null> => row)
    const finish = vi.fn(async (_id: string, _error?: string) => {})
    const refresh = vi.fn(async () => {})
    vi.stubGlobal("window", { api: { threads: { get } } })
    const context = {
      ...original.context,
      getThreadState: () => ({ ...original.state(), queuedMessages }),
      getThreadActions: () => ({ ...original.actions, setQueueAutoDrainSuppressed: vi.fn() })
    } as unknown as Parameters<typeof completeBotConversationTransition>[0]
    return { original, get, finish, refresh,
      complete: (signal?: AbortSignal) => completeBotConversationTransition(context, linkRequest, finish, refresh, signal) }
  }

  it("parks a resident ordinary composer before committing a natural link and restores it after a cold start", async () => {
    const f = associationFixture()
    f.original.publish({ ...payload, draftSkill: skill })
    f.finish.mockImplementationOnce(async () => {
      expect(hasBotThreadDraft(ref.threadId)).toBe(true)
      expect(f.original.listeners.size).toBe(0)
    })
    await f.complete()
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(linkRequest.id)
    expect(f.get).toHaveBeenCalledExactlyOnceWith(ref.threadId)
    const cold = fixture()
    const unbind = bindBotConversationDraft(cold.context, "local", "owner", ref.threadId, vi.fn(), "old-work", ref)
    expect(cold.state()).toMatchObject({ ...payload, draftSkill: { ...skillIdentity, restored: true }, messages: [] })
    unbind()

    preserveUnlinkComposerDraft(fixture().context, link)
    const ordinary = fixture()
    const stop = bindDetachedBotThreadDraft(ordinary.context, ref.threadId, row, vi.fn(), vi.fn())!
    expect(ordinary.state()).toMatchObject({ ...payload, draftSkill: { ...skillIdentity, restored: true }, messages: [] })
    stop()
  })

  it("retains the browser choice and its send payload through cold association and unlink", async () => {
    const f = associationFixture()
    f.original.publish({ draftInput: "打开原网页", draftBuiltinBrowser: true })
    await f.complete()
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(linkRequest.id)

    const cold = fixture()
    const unbind = bindBotConversationDraft(cold.context, "local", "owner", ref.threadId, vi.fn(), "old-work", ref)
    expect(cold.state()).toMatchObject({ draftInput: "打开原网页", draftBuiltinBrowser: true, draftSkill: null })
    unbind()

    preserveUnlinkComposerDraft(fixture().context, link)
    const ordinary = fixture()
    const stop = bindDetachedBotThreadDraft(ordinary.context, ref.threadId, row, vi.fn(), vi.fn())!
    expect(ordinary.state()).toMatchObject({ draftInput: "打开原网页", draftBuiltinBrowser: true, draftSkill: null })
    const { draftInput: text, draftBuiltinBrowser: builtinBrowser } = ordinary.state()
    const queued: QueuedMessage = { id: "unsent", text, builtinBrowser, created_at: new Date(1), updated_at: new Date(1) }
    expect(getQueuedModelContent(queued)).toContain("<builtin-browser-instructions>")
    expect(getQueuedModelContent(queued)).toContain("打开原网页")
    stop()
  })

  it("preserves a browser-only composer and clears it when the detached chip is removed", async () => {
    const f = associationFixture()
    f.original.actions.setDraftBuiltinBrowser(true)
    await f.complete()
    expect(hasBotThreadDraft(ref.threadId)).toBe(true)

    const cold = fixture()
    const leave = bindBotConversationDraft(cold.context, "local", "owner", ref.threadId, vi.fn(), "old-work", ref)
    expect(cold.state()).toMatchObject({ draftInput: "", draftBuiltinBrowser: true })
    leave()

    const detached = fixture()
    const consumed = vi.fn()
    const unbind = bindDetachedBotThreadDraft(detached.context, ref.threadId, row, vi.fn(), consumed)!
    expect(detached.state().draftBuiltinBrowser).toBe(true)
    expect(consumed).not.toHaveBeenCalled()
    detached.actions.setDraftBuiltinBrowser(false)
    expect(consumed).toHaveBeenCalledOnce()
    expect(hasBotThreadDraft(ref.threadId)).toBe(false)
    unbind()
  })

  it.each(["txt", "csv"])("preserves the ordinary parser's full truncated %s attachment through association", async extension => {
    const bytes = new TextEncoder().encode("field,value\n".repeat(6_000)).buffer
    const attachment = await parseFileBytes(`reading.${extension}`, bytes)
    expect(attachment.truncated).toBe(true)
    expect(attachment.content.length).toBeGreaterThan(24_000)
    const f = associationFixture()
    f.original.publish({ draftInput: "Use this attachment", draftAttachments: [attachment], draftSkill: skill })
    await f.complete()
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(linkRequest.id)
    const textOnly = { ...attachment, originalUnavailable: true as const }
    expect(f.original.state().draftAttachments).toEqual([textOnly])
    const cold = fixture()
    const unbind = bindBotConversationDraft(cold.context, "local", "owner", ref.threadId, vi.fn(), "old-work", ref)
    expect(cold.state()).toMatchObject({ draftInput: "Use this attachment", draftAttachments: [textOnly],
      draftSkill: { ...skillIdentity, restored: true } })
    unbind()
    const stored = [...values.values()]
    cold.actions.setDraftAttachments([{ ...attachment, content: "x".repeat(25_001) }])
    expect(saveBotConversationDraft(cold.context, "local", "owner", ref.threadId, "old-work")).toContain("暂未保存")
    expect([...values.values()]).toEqual(stored)
  })

  it("marks only unretained files and keeps their text without treating an old path as a Bot attachment", async () => {
    const f = associationFixture()
    f.original.publish({ ...payload, draftAttachments: [file, attachment] })
    await f.complete()
    const attachments = f.original.state().draftAttachments
    expect(attachments[0]).toEqual({ ...file, originalUnavailable: true })
    expect(attachments[1]).toBe(attachment)
    expect(botInputFileIds(attachments)).toEqual([attachment.botInputId])
    expect(buildAttachmentMessageParts(attachments)).toEqual(buildAttachmentMessageParts([file, attachment]))

    const { attachmentModelBlocks, attachmentDisplayPrefix } = buildAttachmentMessageParts(attachments, true)
    const [plainTextBlock, retainedBlock] = attachmentModelBlocks.trim().split("\n\n<attachment")
    expect(plainTextBlock).toContain("Only extracted text is available. The original file version was not retained.")
    expect(plainTextBlock).toContain(file.content)
    expect(plainTextBlock).not.toContain(file.filePath)
    expect(retainedBlock).toContain(`input_id="${attachment.botInputId}"`)
    expect(retainedBlock).toContain(`path="${attachment.filePath}"`)
    expect(attachmentDisplayPrefix).toBe(buildAttachmentMessageParts([file, attachment]).attachmentDisplayPrefix)

    const draft = queueBotChatDraft({
      addQueuedMessage: (_draft, persisted) => persisted?.(null),
      deleteQueuedMessage: vi.fn()
    }, "Read this", attachments)
    expect(getQueuedBotMessageInput(draft)).toEqual({
      message: `Read this${attachmentModelBlocks}`,
      inputFileIds: [attachment.botInputId]
    })
  })

  it("leaves empty or stale associations and cancelled checks out of draft storage", async () => {
    const empty = associationFixture()
    await empty.complete()
    expect(empty.finish).toHaveBeenCalledExactlyOnceWith(linkRequest.id)
    expect(values.size).toBe(0)

    const stale = associationFixture()
    stale.original.publish({ ...payload, draftSkill: skill })
    stale.get.mockResolvedValueOnce({ ...row, metadata: { cmb_thread_incarnation: "replacement" } })
    await stale.complete()
    expect(stale.finish).toHaveBeenCalledExactlyOnceWith(linkRequest.id, expect.stringContaining("身份已变化"))
    expect(values.size).toBe(0)

    const cancelled = associationFixture()
    cancelled.original.publish({ ...payload, draftSkill: skill })
    const controller = new AbortController()
    cancelled.get.mockImplementationOnce(async () => {
      controller.abort()
      return row
    })
    await cancelled.complete(controller.signal)
    expect(cancelled.finish).not.toHaveBeenCalled()
    expect(cancelled.original.state()).toMatchObject({ ...payload, draftSkill: skill })
    expect(values.size).toBe(0)
  })

  it("restores the prior record on a rejected link and keeps it on a committed link with a lost response", async () => {
    const f = associationFixture()
    const key = botThreadDraftKey(ref.threadId)
    const unrelatedKey = botThreadDraftKey("another-thread")
    values.set(unrelatedKey, "unrelated record")
    const previous = fixture()
    const unbind = bindBotConversationDraft(previous.context, "local", "owner", ref.threadId, vi.fn(), "old-work", ref)
    previous.publish({ draftInput: "Previous text" })
    unbind()
    const stored = values.get(key)
    const original = { ...payload, draftSkill: skill, draftAttachments: [file, attachment] }
    f.original.publish(original)
    f.finish.mockRejectedValueOnce(new Error("原目录已失效"))
    await expect(f.complete()).rejects.toThrow("原目录已失效")
    expect(values.get(key)).toBe(stored)
    expect(values.get(unrelatedKey)).toBe("unrelated record")
    expect(f.original.state()).toMatchObject(original)

    f.get.mockResolvedValueOnce(row).mockResolvedValueOnce({
      ...row, metadata: { ...row.metadata, botLocalConversation: true }
    })
    f.finish.mockRejectedValueOnce(new Error("关联回执未送达"))
    await expect(f.complete()).rejects.toThrow("关联回执未送达")
    expect(JSON.parse(values.get(key)!).draft).toMatchObject({ text: payload.draftInput, skill: skillIdentity,
      attachments: [{ ...file, originalUnavailable: true }, attachment] })
    expect(f.original.state().draftAttachments).toEqual([{ ...file, originalUnavailable: true }, attachment])
    expect(values.get(unrelatedKey)).toBe("unrelated record")
  })

  it("declines association if the composer cannot be stored", async () => {
    const f = associationFixture()
    f.original.publish({ ...payload, draftSkill: skill })
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => { throw new Error("Quota exceeded") })
    await f.complete()
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(linkRequest.id, expect.stringContaining("草稿暂未保存"))
    expect(f.refresh).not.toHaveBeenCalled()
    expect(f.original.state()).toMatchObject({ ...payload, draftSkill: skill })
  })

  it("leaves a different incarnation's record and edits made during a failed association untouched", async () => {
    const f = associationFixture()
    f.original.publish({ ...payload, draftSkill: skill })
    const key = botThreadDraftKey(ref.threadId)
    const otherIncarnation = JSON.stringify({ incarnation: { token: "other", legacyCreatedAt: 10 },
      draft: { version: 2, text: "Other conversation", attachments: [] } })
    values.set(key, otherIncarnation)
    await f.complete()
    expect(f.finish).toHaveBeenCalledExactlyOnceWith(linkRequest.id, expect.stringContaining("其他会话身份"))
    expect(values.get(key)).toBe(otherIncarnation)

    values.delete(key)
    f.finish.mockImplementationOnce(async () => {
      const current = JSON.parse(values.get(key)!)
      values.set(key, JSON.stringify({ ...current, draft: { ...current.draft, text: "Newer draft" } }))
      throw new Error("关联未完成")
    })
    await expect(f.complete()).rejects.toThrow("关联未完成")
    expect(JSON.parse(values.get(key)!).draft.text).toBe("Newer draft")
  })

  it("keeps the exact unsent selection and other composer fields across cold unlink", () => {
    const original = fixture()
    const unbind = bindBotConversationDraft(original.context, "local", "owner", ref.threadId, vi.fn(), "old-work", ref)
    original.publish({ ...payload, draftSkill: skill })
    unbind()
    const parked = fixture()
    preserveUnlinkComposerDraft(parked.context, link)
    const ordinary = fixture()
    const consumed = vi.fn()
    const stop = bindDetachedBotThreadDraft(ordinary.context, ref.threadId, row, vi.fn(), consumed)!
    expect(ordinary.state()).toMatchObject({ ...payload, draftSkill: { ...skillIdentity, restored: true } })
    const saved = JSON.parse(values.get(botThreadDraftKey(ref.threadId))!)
    expect(saved.draft.skill).toEqual(skillIdentity)

    const replacement = { ...skill, path: "/other/check-data/SKILL.md" }
    expect(findEnabledSkillSelection(ordinary.state().draftSkill!, [replacement], new Set())).toBeUndefined()
    expect(findEnabledSkillSelection(ordinary.state().draftSkill!, [skill], new Set(["check-data"]))).toBeUndefined()
    expect(consumed).not.toHaveBeenCalled()
    expect(ordinary.state().draftSkill).toEqual({ ...skillIdentity, restored: true })
    expect(JSON.parse(values.get(botThreadDraftKey(ref.threadId))!).draft.skill).toEqual(skillIdentity)

    const current = { ...skill, description: "Current skill metadata" }
    expect(findEnabledSkillSelection(ordinary.state().draftSkill!, [replacement, current], new Set())).toBe(current)
    ordinary.actions.setDraftSkill(null)
    expect(JSON.parse(values.get(botThreadDraftKey(ref.threadId))!).draft).not.toHaveProperty("skill")
    expect(ordinary.state()).toMatchObject(payload)
    stop()
  })

  it("migrates a cold work draft and restores it in the same native thread without dispatching", () => {
    const previous = fixture()
    previous.publish(payload)
    expect(saveBotConversationDraft(previous.context, "local", "owner", ref.threadId, "old-work")).toBeNull()
    const cold = fixture()
    preserveUnlinkComposerDraft(cold.context, link)
    preserveUnlinkComposerDraft(cold.context, link)
    expect(cold.state().draftInput).toBe("")
    expect(loadBotConversationDraft("local", "owner", "old-work").draft).toBeUndefined()
    expect(hasBotThreadDraft(ref.threadId)).toBe(true)
    expect(values.size).toBe(1)
    const ordinary = fixture()
    expect(bindDetachedBotThreadDraft(ordinary.context, ref.threadId, {
      ...row, metadata: { ...row.metadata, botWorkId: "old-work" }
    }, vi.fn(), vi.fn())).toBeUndefined()
    expect(bindDetachedBotThreadDraft(ordinary.context, ref.threadId, {
      ...row, metadata: { cmb_thread_incarnation: "replacement-token" }
    }, vi.fn(), vi.fn())).toBeUndefined()
    const consumed = vi.fn()
    const unbind = bindDetachedBotThreadDraft(ordinary.context, ref.threadId, row, vi.fn(), consumed)!
    expect(ordinary.state()).toMatchObject(payload)
    expect(consumed).not.toHaveBeenCalled()
    unbind()
    const rebound = fixture()
    const stop = bindBotConversationDraft(rebound.context, "local", "owner", ref.threadId, vi.fn(), "new-work", ref)
    expect(rebound.state()).toMatchObject(payload)
    rebound.publish({ draftInput: "", draftAttachments: [], draftMentionedWorkspaceFiles: [], draftBotReplyTo: null })
    stop()
    expect(bindDetachedBotThreadDraft(fixture().context, ref.threadId, row, vi.fn(), vi.fn())).toBeUndefined()
    expect(values.size).toBe(0)
  })

  it("leaves the legacy draft intact when moving fails and does not restore it after a successful ordinary send", () => {
    const previous = fixture()
    previous.publish(payload)
    expect(saveBotConversationDraft(previous.context, "local", "owner", ref.threadId, "old-work")).toBeNull()
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => { throw new Error("Quota exceeded") })
    expect(() => preserveUnlinkComposerDraft(fixture().context, link)).toThrow("未保存")
    expect(loadBotConversationDraft("local", "owner", "old-work").draft?.text).toBe(payload.draftInput)
    expect(hasBotThreadDraft(ref.threadId)).toBe(false)
    preserveUnlinkComposerDraft(fixture().context, link)
    const ordinary = fixture()
    const consumed = vi.fn()
    const stop = bindDetachedBotThreadDraft(ordinary.context, ref.threadId, row, vi.fn(), consumed)!
    expect(ordinary.state()).toMatchObject(payload)
    ordinary.publish({ draftInput: "", draftAttachments: [], draftMentionedWorkspaceFiles: [], draftBotReplyTo: null })
    expect(consumed).toHaveBeenCalledOnce()
    ordinary.publish({ draftInput: "new ordinary draft" })
    stop()
    expect(values.has(botThreadDraftKey(ref.threadId))).toBe(false)
    expect(loadBotConversationDraft("local", "owner", "old-work").draft).toBeUndefined()
  })
})

describe("private Bot drafts in the original ThreadContext", () => {
  it("saves browser selection changes and keeps a restored skill and browser mutually exclusive", () => {
    const original = fixture()
    const stop = bindBotConversationDraft(original.context, "local", "owner", "main-thread", vi.fn())
    original.actions.setDraftBuiltinBrowser(true)
    expect(loadBotConversationDraft("local", "owner").draft).toMatchObject({ text: "", builtinBrowser: true })
    stop()

    const returned = fixture()
    const leave = bindBotConversationDraft(returned.context, "local", "owner", "main-thread", vi.fn())
    expect(returned.state().draftBuiltinBrowser).toBe(true)
    // The composer selects a skill before clearing the previous browser chip.
    returned.actions.setDraftSkill(skill)
    const stored = loadBotConversationDraft("local", "owner").draft
    expect(stored?.skill).toEqual(skillIdentity)
    expect(stored).not.toHaveProperty("builtinBrowser")
    returned.actions.setDraftBuiltinBrowser(false)
    leave()

    const reopened = fixture()
    restoreBotConversationDraft(reopened.context, "local", "owner", "main-thread")
    expect(reopened.state()).toMatchObject({ draftSkill: { ...skillIdentity, restored: true }, draftBuiltinBrowser: false })
    reopened.actions.setDraftSkill(null)
    reopened.actions.setDraftBuiltinBrowser(true)
    const unbind = bindBotConversationDraft(reopened.context, "local", "owner", "main-thread", vi.fn())
    expect(loadBotConversationDraft("local", "owner").draft?.builtinBrowser).toBe(true)
    reopened.actions.setDraftBuiltinBrowser(false)
    expect(loadBotConversationDraft("local", "owner").draft).toBeUndefined()
    unbind()
  })

  it("does not restore an older draft over a resident browser-only composer", () => {
    const older = fixture()
    older.publish({ draftInput: "older text", draftSkill: skill })
    expect(saveBotConversationDraft(older.context, "local", "owner", "main-thread")).toBeNull()

    const resident = fixture()
    resident.actions.setDraftBuiltinBrowser(true)
    const unbind = bindBotConversationDraft(resident.context, "local", "owner", "main-thread", vi.fn())
    expect(resident.state()).toMatchObject({ draftInput: "", draftBuiltinBrowser: true, draftSkill: null })
    expect(loadBotConversationDraft("local", "owner").draft).toMatchObject({ text: "", builtinBrowser: true })
    unbind()
  })

  it("persists and restores a skill-only draft after the Bot conversation reopens", () => {
    const original = fixture()
    const stop = bindBotConversationDraft(original.context, "local", "owner", "main-thread", vi.fn())
    original.actions.setDraftSkill(skill)
    expect(loadBotConversationDraft("local", "owner").draft?.skill).toEqual(skillIdentity)
    stop()

    const reopened = fixture()
    const unbind = bindBotConversationDraft(reopened.context, "local", "owner", "main-thread", vi.fn())
    expect(reopened.state()).toMatchObject({ draftInput: "", draftSkill: { ...skillIdentity, restored: true } })
    reopened.actions.setDraftSkill(null)
    expect(loadBotConversationDraft("local", "owner").draft).toBeUndefined()
    unbind()
  })

  it("restores the origin draft after switching to a peer's approval conversation and back", () => {
    const original = fixture()
    const leaveOrigin = bindBotConversationDraft(original.context, "local", "origin-bot", "origin-thread", vi.fn())
    original.actions.setDraftInput("未发送的补充说明")
    original.actions.setDraftAttachments([file])
    leaveOrigin()

    const peer = fixture()
    const leavePeer = bindBotConversationDraft(peer.context, "local", "peer-bot", "peer-thread", vi.fn())
    expect(peer.state()).toMatchObject({ draftInput: "", draftAttachments: [] })
    peer.actions.setDraftInput("同伴会话中的草稿")
    leavePeer()

    const returned = fixture()
    const unbind = bindBotConversationDraft(returned.context, "local", "origin-bot", "origin-thread", vi.fn())
    expect(returned.state()).toMatchObject({ draftInput: "未发送的补充说明", draftAttachments: [file] })
    unbind()
  })

  it("keeps a work draft when its thread cleanup publishes an empty state", () => {
    const f = fixture()
    const threadId = "retired-work-thread"
    vi.stubGlobal("window", { localStorage: globalThis.localStorage })
    const unbind = bindBotConversationDraft(f.context, "local", "a", threadId, vi.fn(), "work")
    f.publish({ draftInput: "keep until work deletion commits" })
    applyCommittedThreadDeletion(threadId)
    f.publish({ draftInput: "" })
    expect(loadBotConversationDraft("local", "a", "work").draft?.text).toBe(
      "keep until work deletion commits"
    )
    unbind()
  })

  it("clears only the work draft acknowledged by the workbench delete handler", async () => {
    const botId = "owner", workId = "target", threadId = "workbench-deletion-target"
    const f = fixture()
    f.publish({ draftInput: "Private draft", draftAttachments: [file] })
    saveBotConversationDraft(f.context, "local", botId, threadId, workId)
    saveBotConversationDraft(f.context, "local", botId, "other-work-thread", "other-work")
    saveBotConversationDraft(f.context, "local", botId, "bot-thread")
    const deleteThread = vi.fn(async () => ({ deletedWork: { botId, workId } }))
    vi.stubGlobal("window", { localStorage: globalThis.localStorage, api: { threads: { delete: deleteThread } } })

    await useAppStore.getState().deleteThread(threadId)

    expect(deleteThread).toHaveBeenCalledExactlyOnceWith(threadId, undefined)
    expect(loadBotConversationDraft("local", botId, workId)).toEqual({})
    expect(loadBotConversationDraft("local", botId, "other-work").draft?.attachments).toEqual([file])
    expect(loadBotConversationDraft("local", botId).draft?.text).toBe("Private draft")
  })

  it("preserves picker references through an unsent draft restart and subsequent queue submission", () => {
    const first = fixture(), selected = { ...file, botInputId: "input-11111111-1111-1111-1111-111111111111" }
    first.actions.setDraftInput("Use this design")
    first.actions.setDraftAttachments([selected])
    expect(saveBotConversationDraft(first.context, "local", "a", "thread-a")).toBeNull()
    const cold = fixture()
    expect(restoreBotConversationDraft(cold.context, "local", "a", "thread-a")).toBeNull()
    expect(botInputFileIds(cold.state().draftAttachments)).toEqual([selected.botInputId])
    const queued = queueBotChatDraft({
      addQueuedMessage: (_draft, persisted) => persisted?.(null),
      deleteQueuedMessage: vi.fn()
    }, cold.state().draftInput, cold.state().draftAttachments)
    expect(getQueuedBotMessageInput(queued).inputFileIds).toEqual([selected.botInputId])
    const beforeInvalid = [...values.values()]
    cold.actions.setDraftAttachments([{ ...selected, botInputId: "invalid" }])
    expect(saveBotConversationDraft(cold.context, "local", "a", "thread-a")).toContain("暂未保存")
    expect([...values.values()]).toEqual(beforeInvalid)
  })
  it("restores legacy mention drafts as unchanged plain text without input identity bindings", () => {
    const key = 'cmb-bot-conversation-draft-v1:["local","a","work"]'
    const text = "@FI-1024-CLEAN-DS"
    values.set(
      key,
      JSON.stringify({
        version: 1,
        text,
        attachments: [],
        mentions: [
          { start: 0, end: text.length, botId: "old-selected-peer", label: "FI-1024-CLEAN-DS" }
        ]
      })
    )
    const f = fixture()
    expect(restoreBotConversationDraft(f.context, "local", "a", "thread", "work")).toBeNull()
    expect(f.state().draftInput).toBe(text)
    expect(f.state().draftBotMentions).toBeUndefined()
    expect(saveBotConversationDraft(f.context, "local", "a", "thread", "work")).toBeNull()
    expect(JSON.parse(values.get(key)!)).not.toHaveProperty("mentions")
  })
  it("retains reply-only drafts, attachments and cancellation through the existing observer", () => {
    const f = fixture()
    const unbind = bindBotConversationDraft(f.context, "local", "a", "t", vi.fn())
    const reply: BotMessageReply = { id: "m1", ordinal: 5, role: "assistant", text: "合计 41" }
    f.actions.setDraftBotReplyTo(reply)
    const cold = fixture()
    restoreBotConversationDraft(cold.context, "local", "a", "t")
    expect(cold.state().draftBotReplyTo).toEqual(reply)
    f.actions.setDraftInput("核对附件")
    f.actions.setDraftAttachments([file])
    f.actions.setDraftBotReplyTo(null)
    const restored = fixture()
    restoreBotConversationDraft(restored.context, "local", "a", "t")
    expect(restored.state()).toMatchObject({
      draftInput: "核对附件",
      draftAttachments: [file],
      draftBotReplyTo: null
    })
    unbind()
  })
  it("keeps main and work drafts, references and retained attachments separate across pruning and remount", () => {
    const main = fixture(),
      work = fixture()
    main.actions.setDraftInput("Main draft")
    work.actions.setDraftInput("Work draft")
    work.actions.setDraftAttachments([file])
    saveBotConversationDraft(main.context, "local", "a", "main")
    saveBotConversationDraft(work.context, "local", "a", "work-thread", "work-id")
    pruneBotConversationDrafts("local", ["a"])
    const restoredMain = fixture(),
      restoredWork = fixture()
    restoreBotConversationDraft(restoredMain.context, "local", "a", "main")
    restoreBotConversationDraft(restoredWork.context, "local", "a", "work-thread", "work-id")
    expect(restoredMain.state()).toMatchObject({ draftInput: "Main draft", draftAttachments: [] })
    expect(restoredWork.state()).toMatchObject({
      draftInput: "Work draft",
      draftAttachments: [file]
    })
    const another = fixture()
    restoreBotConversationDraft(another.context, "local", "a", "other-thread", "other-id")
    expect(another.state().draftInput).toBe("")
  })
  it("restores a work's selected @file across navigation and snapshots it only on send", async () => {
    const first = fixture()
    const workspacePath = "/workspace"
    const selection = toMentionedWorkspaceFile({
      id: "/核验.csv",
      displayPath: "核验.csv",
      workspaceFilePath: "/核验.csv",
      filename: "核验.csv"
    }, workspacePath)
    const leave = bindBotConversationDraft(first.context, "local", "a", "work-thread", vi.fn(), "work-id")
    first.actions.setDraftMentionedWorkspaceFiles([selection])
    expect(loadBotConversationDraft("local", "a", "work-id").draft).toMatchObject({
      text: "",
      attachments: [],
      workspaceFiles: [selection]
    })
    first.actions.setDraftInput("核对合计")
    leave()

    const main = fixture()
    restoreBotConversationDraft(main.context, "local", "a", "main-thread")
    expect(main.state().draftMentionedWorkspaceFiles).toEqual([])
    const returned = fixture()
    const stop = bindBotConversationDraft(returned.context, "local", "a", "work-thread", vi.fn(), "work-id")
    expect(returned.state()).toMatchObject({
      draftInput: "核对合计",
      draftAttachments: [],
      draftMentionedWorkspaceFiles: [selection]
    })

    const snapshot = { ...file, botInputId: "input-11111111-1111-1111-1111-111111111111" }
    const readWorkspaceAttachment = vi.fn(async () => snapshot)
    const resolve = (root: string) => resolveAtFileAttachments({
      rawMessage: returned.state().draftInput,
      attachments: returned.state().draftAttachments,
      mentionedFiles: returned.state().draftMentionedWorkspaceFiles,
      workspacePath: root,
      workspaceFiles: [],
      maxAttachments: 3,
      maxTotalChars: 24_000,
      readWorkspaceFile: vi.fn(),
      readWorkspaceAttachment
    })
    await expect(resolve("/other-workspace")).rejects.toThrow("工作区已变更")
    expect(readWorkspaceAttachment).not.toHaveBeenCalled()
    await expect(resolve(workspacePath)).resolves.toMatchObject({ attachments: [snapshot] })
    expect(readWorkspaceAttachment).toHaveBeenCalledExactlyOnceWith("/核验.csv", 24_000)

    returned.actions.setDraftInput("")
    returned.actions.setDraftMentionedWorkspaceFiles([])
    expect(loadBotConversationDraft("local", "a", "work-id")).toEqual({})
    stop()
  })
  it("initializes the original queue and history before any restored composer action", () => {
    const f = fixture()
    f.actions.setDraftInput("Saved")
    saveBotConversationDraft(f.context, "local", "a", "t")
    const cold = fixture()
    const order: string[] = []
    cold.context.initializeThread = () => {
      order.push("initialize")
    }
    const write = cold.actions.setDraftInput
    cold.actions.setDraftInput = (text) => {
      order.push("draft")
      write(text)
    }
    restoreBotConversationDraft(cold.context, "local", "a", "t")
    expect(order).toEqual(["initialize", "draft"])
    expect(cold.state().draftInput).toBe("Saved")
  })
  it("restores unsent text and retained files after a cold reload, then removes consumed content", () => {
    const first = fixture()
    const stop = bindBotConversationDraft(first.context, "local", "a", "thread-a", vi.fn())
    first.actions.setDraftInput("核对这份文件")
    first.actions.setDraftAttachments([file])
    const writes = vi.mocked(localStorage.setItem).mock.calls.length
    first.publish({ messages: [] })
    first.publish({ messages: [] })
    expect(localStorage.setItem).toHaveBeenCalledTimes(writes)
    stop()
    expect(first.listeners.size).toBe(0)
    const cold = fixture()
    const unsubscribe = bindBotConversationDraft(cold.context, "local", "a", "thread-a", vi.fn())
    expect(cold.state()).toMatchObject({ draftInput: "核对这份文件", draftAttachments: [file] })
    cold.actions.setDraftInput("")
    cold.actions.setDraftAttachments([])
    unsubscribe()
    const afterSend = fixture()
    restoreBotConversationDraft(afterSend.context, "local", "a", "thread-a")
    expect(afterSend.state()).toMatchObject({ draftInput: "", draftAttachments: [] })
  })

  it("lets new chat restore before merging and keeps hosts, private Bots and in-memory edits separate", () => {
    const original = fixture()
    original.actions.setDraftInput("Old")
    original.actions.setDraftAttachments([file])
    saveBotConversationDraft(original.context, "local", "a", "t")
    const newChat = fixture()
    restoreBotConversationDraft(newChat.context, "local", "a", "t")
    newChat.actions.setDraftInput(newChat.state().draftInput + "\nNew")
    saveBotConversationDraft(newChat.context, "local", "a", "t")
    const cold = fixture()
    restoreBotConversationDraft(cold.context, "local", "a", "t")
    expect(cold.state()).toMatchObject({ draftInput: "Old\nNew", draftAttachments: [file] })
    cold.actions.setDraftInput("Newer local edit")
    restoreBotConversationDraft(cold.context, "local", "a", "t")
    expect(cold.state().draftInput).toBe("Newer local edit")
    for (const [host, bot] of [
      ["remote", "a"],
      ["local", "b"]
    ]) {
      const other = fixture()
      restoreBotConversationDraft(other.context, host, bot, "t")
      expect(other.state().draftInput).toBe("")
    }
  })

  it("preserves malformed recovery records through mounting, stream updates and unmounting", () => {
    const storageKey = 'cmb-bot-conversation-draft-v1:["local","a"]'
    values.set(storageKey, '{"version":1,"attachments":[{"filePath":null}]}')
    const context = fixture(),
      onError = vi.fn()
    const stop = bindBotConversationDraft(context.context, "local", "a", "t", onError)
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("未能恢复"))
    context.publish({ messages: [] })
    stop()
    expect(values.get(storageKey)).toContain('"filePath":null')
  })

  it("reports quota failure without losing current text or files and retries when the conversation reopens", () => {
    const current = fixture(),
      onError = vi.fn()
    const stop = bindBotConversationDraft(current.context, "local", "a", "t", onError)
    const setter = vi.mocked(localStorage.setItem)
    setter.mockImplementation(() => {
      throw new Error("Quota exceeded")
    })
    current.actions.setDraftInput("Keep")
    current.actions.setDraftAttachments([file])
    expect(current.state()).toMatchObject({ draftInput: "Keep", draftAttachments: [file] })
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining("未保存"))
    stop()
    setter.mockImplementation((key, value) => {
      values.set(key, value)
    })
    const cleanup = bindBotConversationDraft(current.context, "local", "a", "t", onError)
    expect(onError).toHaveBeenLastCalledWith(null)
    cleanup()
    const cold = fixture()
    restoreBotConversationDraft(cold.context, "local", "a", "t")
    expect(cold.state()).toMatchObject({ draftInput: "Keep", draftAttachments: [file] })
  })

  it("prunes deleted Bot drafts without deleting another host or group record, and unbound updates cannot revive them", () => {
    const removed = fixture()
    const stop = bindBotConversationDraft(removed.context, "prune-local", "removed", "t", vi.fn())
    removed.actions.setDraftInput("Discarded synthetic draft")
    const other = fixture()
    other.actions.setDraftInput("Retained")
    saveBotConversationDraft(other.context, "other-host", "removed", "t")
    const groupKey = 'cmb-bot-group-draft-v1:["prune-local","group"]'
    values.set(groupKey, "group record")
    stop()
    pruneBotConversationDrafts("prune-local", [])
    removed.publish({ messages: [] })
    expect([...values.keys()]).not.toContain(
      'cmb-bot-conversation-draft-v1:["prune-local","removed"]'
    )
    expect(values.has('cmb-bot-conversation-draft-v1:["other-host","removed"]')).toBe(true)
    expect(values.get(groupKey)).toBe("group record")
  })
})


it("persists a selected identity with its draft, but rejects damaged identity/text bindings", () => {
  const f = fixture()
  const mentions = [{ start: 0, end: 2, botId: "peer", label: "乙" }]
  const unbind = bindBotConversationDraft(f.context, "local", "a", "thread", vi.fn())
  f.actions.setDraftBotInput("@乙 你好", mentions)
  f.actions.setDraftAttachments([file])
  const cold = fixture()
  expect(restoreBotConversationDraft(cold.context, "local", "a", "thread")).toBeNull()
  expect(cold.state()).toMatchObject({ draftInput: "@乙 你好", draftBotMentions: mentions, draftAttachments: [file] })
  const key = 'cmb-bot-conversation-draft-v1:["local","a"]'
  const saved = JSON.parse(values.get(key)!)
  values.set(key, JSON.stringify({ ...saved, text: "@甲 你好" }))
  const broken = fixture()
  expect(restoreBotConversationDraft(broken.context, "local", "a", "thread")).toBeTruthy()
  expect(broken.state().draftInput).toBe("")
  unbind()
})
