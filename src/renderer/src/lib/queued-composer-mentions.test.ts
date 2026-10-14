import { expect, it } from "vitest"
import type { QueuedMessage } from "../types"
import { getQueuedComposerSubmission, getQueuedDisplayContent,
  getQueuedModelContent } from "./queued-message-content"
import { editQueuedComposerMentionText } from "./queued-composer-mentions"
import { captureComposerMentionSubmission } from "../../../shared/mods/v2/composer-mentions"

function draft(): QueuedMessage {
  return { id: "draft", text: "inspect @src/a.ts#L2-3", created_at: new Date(0), updated_at: new Date(0),
    pendingMentions: [{ mention: "src/a.ts#L2-3", relativePath: "src/a.ts", workspacePath: "C:/project",
      filename: "a.ts", source: "typed", offset: 2, limit: 2 }], existingUploads: [],
    attachmentDisplayPrefix: "📎 a.ts" }
}
it("keeps the same unread request through live and queued content", () => {
  const actual = draft(), model = getQueuedModelContent(actual)
  const request = getQueuedComposerSubmission(actual)
  const captured = captureComposerMentionSubmission(request, model)
  expect(captured?.pendingMentions).toEqual(actual.pendingMentions)
  expect(captured?.existingUploads).toEqual([])
  expect(model).not.toContain("<attachment")
  expect(getQueuedDisplayContent(actual)).toBe("📎 a.ts\n\ninspect @src/a.ts#L2-3")
})
it("takes independent parts and mention snapshots before the draft is edited", () => {
  const actual = draft(), request = getQueuedComposerSubmission(actual)
  const captured = captureComposerMentionSubmission(request, getQueuedModelContent(actual))
  actual.text = "later"
  if (!actual.pendingMentions) throw Error("real mentions missing")
  actual.pendingMentions[0].relativePath = "later.txt"
  expect(captured?.messageParts.text).toBe("inspect @src/a.ts#L2-3")
  expect(captured?.pendingMentions[0].relativePath).toBe("src/a.ts")
})
it("preserves the original plain and mixed-upload submission distinction", () => {
  const plain: QueuedMessage = { id: "plain", text: "plain", created_at: new Date(0), updated_at: new Date(0) }
  expect(getQueuedComposerSubmission(plain)).toEqual({ kind: "plain-text", text: "plain" })
  expect(getQueuedComposerSubmission({ ...plain, attachmentModelBlocks: "\n\n<attachment>body</attachment>" }))
    .toBeUndefined()
  expect(getQueuedComposerSubmission({ ...plain, skillBlock: "<skill_use>actual</skill_use>" })).toBeUndefined()
})
it("replaces edited typed references while preserving real chips and their workspace", () => {
  const actual = draft()
  actual.pendingMentions?.push({ mention: "kept.txt", relativePath: "kept.txt",
    workspacePath: "C:/project", filename: "kept.txt", source: "chip" })
  const edited = editQueuedComposerMentionText(actual, "inspect @src/new.ts#L4-5", "C:/project")
  expect(edited.pendingMentions?.map(item => item.mention)).toEqual(["kept.txt", "src/new.ts#L4-5"])
  expect(edited.pendingMentions?.[1]).toMatchObject({ offset: 4, limit: 2 })
  expect(edited.attachmentDisplayPrefix).toBe("📎 kept.txt\n📎 new.ts")
  expect(() => editQueuedComposerMentionText(actual, "inspect", "C:/other"))
    .toThrow("工作区已变化，请重新选择该草稿的 @文件")
  expect(actual.pendingMentions?.[0].mention).toBe("src/a.ts#L2-3")
})
