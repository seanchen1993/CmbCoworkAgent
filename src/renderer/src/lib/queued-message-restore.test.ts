import { describe, expect, it } from "vitest"
import type { QueuedMessage } from "../types"
import {
  formatComposerAttachments,
  captureComposerMentionSubmission,
  type ComposerFileAttachment
} from "../../../shared/mods/v2/composer-mentions"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"
import {
  collectPendingAtFileMentions,
  toMentionedWorkspaceFile
} from "../features/mentions/atFileAttachments"
import {
  getQueuedComposerSubmission,
  getQueuedDisplayContent,
  getQueuedModelContent
} from "./queued-message-content"
import { editQueuedComposerMentionText } from "./queued-composer-mentions"
import {
  assertQueuedComposerMentionWorkspace,
  normalizeQueuedMessage
} from "./queued-message-restore"

const workspace = "C:/mention-project"
function upload(content = "完整上传\n"): ComposerFileAttachment {
  return {
    filename: "upload.txt",
    filePath: "C:/uploaded/upload.txt",
    content,
    mimeType: "text/plain",
    size: new TextEncoder().encode(content).length,
    truncated: false
  }
}
function draft(
  options: {
    text?: string
    chip?: boolean
    uploads?: ComposerFileAttachment[]
    skill?: string
    browser?: boolean
    fileOnly?: boolean
  } = {}
): QueuedMessage {
  const text = options.text ?? "inspect @src/a.ts#L2-3",
    uploads = options.uploads ?? []
  const chip = toMentionedWorkspaceFile(
    {
      id: "/kept.txt",
      displayPath: "kept.txt",
      workspaceFilePath: "/kept.txt",
      filename: "kept.txt",
      size: 5
    },
    workspace
  )
  const pending = collectPendingAtFileMentions({
    rawMessage: text,
    attachments: uploads,
    mentionedFiles: options.chip ? [chip] : [],
    workspacePath: workspace,
    maxAttachments: 3
  })
  if (pending.countLimitHit || pending.staleWorkspace) throw Error("Actual draft fixture failed")
  return {
    id: "same-draft-id",
    text,
    pendingMentions: pending.pendingMentions,
    existingUploads: uploads,
    fileOnly: options.fileOnly === true,
    attachmentModelBlocks: formatComposerAttachments(uploads),
    attachmentDisplayPrefix: [
      ...uploads.map((item) => `📎 ${item.filename}`),
      ...pending.pendingMentions.map((item) => `📎 ${item.filename}`)
    ].join("\n"),
    skillBlock: options.skill,
    builtinBrowser: options.browser,
    modelId: "custom:fixture",
    created_at: new Date(10),
    updated_at: new Date(20)
  }
}
function roundTrip(message: QueuedMessage): Record<string, unknown> {
  return JSON.parse(JSON.stringify(message)) as Record<string, unknown>
}
function restore(message: QueuedMessage): QueuedMessage {
  const actual = normalizeQueuedMessage(roundTrip(message))
  if (!actual) throw Error("Actual JSON draft was not restored")
  return actual
}

describe("unread composer mention queue restore", () => {
  it("retains actual collected line references, parts, id, model and versions through JSON", () => {
    const original = draft(),
      actual = restore(original)
    expect(actual.pendingMentions).toEqual(original.pendingMentions)
    expect(actual.existingUploads).toEqual([])
    expect(actual.id).toBe(original.id)
    expect(actual.modelId).toBe(original.modelId)
    expect(actual.created_at).toEqual(original.created_at)
    expect(actual.updated_at).toEqual(original.updated_at)
    expect(getQueuedModelContent(actual)).toBe(getQueuedModelContent(original))
    expect(getQueuedDisplayContent(actual)).toBe(getQueuedDisplayContent(original))
    const captured = captureComposerMentionSubmission(
      getQueuedComposerSubmission(actual),
      getQueuedModelContent(actual)
    )
    expect(captured?.pendingMentions).toEqual(original.pendingMentions)
    assertQueuedComposerMentionWorkspace(actual, workspace)
  })

  it("restores real selected chip-only fileOnly without inventing typed references", () => {
    const original = draft({ text: "请分析以下文件内容。", chip: true, fileOnly: true })
    const actual = restore(original)
    expect(actual.pendingMentions).toEqual(original.pendingMentions)
    expect(actual.pendingMentions?.[0]).toEqual({
      mention: "kept.txt",
      workspacePath: workspace,
      relativePath: "/kept.txt",
      filename: "kept.txt",
      source: "chip"
    })
    expect(actual.fileOnly).toBe(true)
    expect(getQueuedModelContent(actual)).toBe("请分析以下文件内容。")
    expect(getQueuedDisplayContent(actual)).toBe(getQueuedDisplayContent(original))
  })

  it("keeps exact mixed upload XML, full Unicode body and selected chip with typed line references", () => {
    const original = draft({
      chip: true,
      uploads: [upload()],
      skill: "<skill_use>fixture</skill_use>"
    })
    const actual = restore(original)
    expect(actual.existingUploads).toEqual(original.existingUploads)
    expect(actual.pendingMentions).toEqual(original.pendingMentions)
    expect(actual.attachmentModelBlocks).toBe(original.attachmentModelBlocks)
    expect(getQueuedModelContent(actual)).toBe(getQueuedModelContent(original))
    expect(getQueuedDisplayContent(actual)).toBe(getQueuedDisplayContent(original))
  })

  it("retains original builtin-browser formatting and does not turn it into a plain request", () => {
    const original = draft({ browser: true }),
      actual = restore(original)
    expect(actual.builtinBrowser).toBe(true)
    expect(getQueuedModelContent(actual)).toBe(getQueuedModelContent(original))
    expect(getQueuedComposerSubmission(actual)).toEqual(getQueuedComposerSubmission(original))
  })

  it("recaptures edited typed references and preserves the selected chip across a second reload", () => {
    const original = draft({ chip: true }),
      edited = editQueuedComposerMentionText(original, "inspect @src/b.ts#L4-5", workspace),
      actual = restore(edited)
    expect(actual.pendingMentions?.map((item) => item.mention)).toEqual([
      "kept.txt",
      "src/b.ts#L4-5"
    ])
    expect(actual.pendingMentions?.[1]).toEqual({
      mention: "src/b.ts#L4-5",
      workspacePath: workspace,
      relativePath: "src/b.ts",
      filename: "b.ts",
      source: "typed",
      offset: 4,
      limit: 2
    })
    expect(getQueuedModelContent(actual)).toBe(getQueuedModelContent(edited))
    expect(original.pendingMentions?.some((item) => item.mention === "src/a.ts#L2-3")).toBe(true)
  })

  it("returns edited empty references to the original plain and mixed-upload distinction", () => {
    const plain = restore(editQueuedComposerMentionText(draft(), "plain after edit", workspace))
    expect(plain.pendingMentions).toEqual([])
    expect(getQueuedComposerSubmission(plain)).toEqual({
      kind: "plain-text",
      text: "plain after edit"
    })
    const mixed = restore(
      editQueuedComposerMentionText(draft({ uploads: [upload()] }), "uploaded only", workspace)
    )
    expect(mixed.pendingMentions).toEqual([])
    expect(getQueuedComposerSubmission(mixed)).toBeUndefined()
    expect(mixed.attachmentModelBlocks).toBe(formatComposerAttachments([upload()]))
  })

  it("preserves legacy normalization defaults and handoff dates without minting mentions", () => {
    const actual = normalizeQueuedMessage({
      id: "legacy",
      text: "@old literal",
      attachmentModelBlocks: "<attachment>old</attachment>",
      attachmentDisplayPrefix: "old display",
      skillBlock: "old skill",
      builtinBrowser: true,
      modelId: "old model",
      created_at: "bad",
      updated_at: "bad",
      handoffRequestedAt: new Date(30).toISOString(),
      extraLegacyField: "ignored"
    })
    if (!actual) throw Error("Actual legacy draft was lost")
    expect(actual.pendingMentions).toBeUndefined()
    expect(actual.existingUploads).toBeUndefined()
    expect(actual.fileOnly).toBeUndefined()
    expect(actual.attachmentModelBlocks).toBe("<attachment>old</attachment>")
    expect(actual.attachmentDisplayPrefix).toBe("old display")
    expect(actual.skillBlock).toBe("old skill")
    expect(actual.builtinBrowser).toBe(true)
    expect(actual.modelId).toBe("old model")
    expect(actual.handoffRequestedAt).toEqual(new Date(30))
    expect(actual.updated_at).toEqual(actual.created_at)
  })

  it("keeps valid structured handoff identity for the original pending/injected/durable reconciliation", () => {
    const original = { ...draft(), handoffRequestedAt: new Date(40) },
      actual = restore(original)
    expect(actual.id).toBe(original.id)
    expect(actual.handoffRequestedAt).toEqual(original.handoffRequestedAt)
    expect(getQueuedComposerSubmission(actual)).toEqual(getQueuedComposerSubmission(original))
  })

  it("captures independent immutable reference and upload snapshots", () => {
    const original = draft({ uploads: [upload()] }),
      parsed = roundTrip(original)
    const actual = normalizeQueuedMessage(parsed)
    if (!actual) throw Error("Actual draft was not captured")
    const refs = parsed.pendingMentions,
      uploads = parsed.existingUploads
    if (!Array.isArray(refs) || !Array.isArray(uploads)) throw Error("JSON fixture is incomplete")
    refs[0].relativePath = "other.txt"
    uploads[0].content = "later"
    expect(actual.pendingMentions?.[0].relativePath).toBe("src/a.ts")
    expect(actual.existingUploads?.[0].content).toBe("完整上传\n")
    expect(Object.isFrozen(actual.pendingMentions)).toBe(true)
    expect(Object.isFrozen(actual.pendingMentions?.[0])).toBe(true)
    expect(Object.isFrozen(actual.existingUploads)).toBe(true)
  })

  for (const field of ["text", "relativePath", "filename", "offset", "limit", "source"] as const) {
    it(`rejects a saved ${field} substitution instead of degrading the same draft to plain text`, () => {
      const parsed = roundTrip(draft()),
        refs = parsed.pendingMentions
      if (!Array.isArray(refs)) throw Error("Actual references missing")
      if (field === "text") parsed.text = "inspect @src/other.ts"
      else
        refs[0][field] =
          field === "offset" ? 3 : field === "limit" ? 1 : field === "source" ? "chip" : "other.ts"
      expect(normalizeQueuedMessage(parsed)).toBeNull()
    })
  }

  it("rejects absent structured fields, fake budgets, excessive files and inconsistent mixed XML", () => {
    const missing = roundTrip(draft())
    Reflect.deleteProperty(missing, "existingUploads")
    expect(normalizeQueuedMessage(missing)).toBeNull()
    expect(normalizeQueuedMessage({ ...roundTrip(draft()), remainingChars: 1000000 })).toBeNull()
    const mixed = roundTrip(draft({ uploads: [upload()] }))
    mixed.attachmentModelBlocks = "<attachment>different body</attachment>"
    expect(normalizeQueuedMessage(mixed)).toBeNull()
    const excessive = roundTrip(draft({ chip: true, uploads: [upload()] }))
    const refs = excessive.pendingMentions
    if (!Array.isArray(refs)) throw Error("Actual references missing")
    refs.push({
      ...refs[0],
      mention: "fourth.txt",
      relativePath: "/fourth.txt",
      filename: "fourth.txt"
    })
    expect(normalizeQueuedMessage(excessive)).toBeNull()
  })

  it("retains the actual 24000 character limit and rejects overflow without truncating Unicode", () => {
    const exact = restore(draft({ uploads: [upload("中".repeat(24000))] }))
    expect(exact.existingUploads?.[0].content).toBe("中".repeat(24000))
    expect(
      normalizeQueuedMessage(roundTrip(draft({ uploads: [upload("中".repeat(24001))] })))
    ).toBeNull()
  })

  for (const nested of [false, true]) {
    it(`rejects an ordinary ${nested ? "nested" : "top-level"} accessor without reading its getter`, () => {
      const parsed = roundTrip(draft())
      let getterCalls = 0
      if (nested) {
        const refs = parsed.pendingMentions
        if (!Array.isArray(refs)) throw Error("Actual references missing")
        Object.defineProperty(refs[0], "relativePath", {
          enumerable: true,
          get: () => {
            getterCalls += 1
            return "src/a.ts"
          }
        })
      } else
        Object.defineProperty(parsed, "pendingMentions", {
          enumerable: true,
          get: () => {
            getterCalls += 1
            return []
          }
        })
      expect(normalizeQueuedMessage(parsed)).toBeNull()
      expect(getterCalls).toBe(0)
    })
  }

  it("does not obtain inherited upload fields and retains an independently valid sibling", () => {
    const bad = roundTrip(draft({ uploads: [upload()] })),
      uploads = bad.existingUploads
    if (!Array.isArray(uploads)) throw Error("Actual uploads missing")
    Reflect.deleteProperty(uploads[0], "content")
    expect(normalizeQueuedMessage(bad)).toBeNull()
    const entries = [bad, roundTrip(draft()), { id: "legacy", text: "keep legacy" }]
      .map(normalizeQueuedMessage)
      .filter((item) => item !== null)
    expect(entries.map((item) => item.id)).toEqual(["same-draft-id", "legacy"])
  })

  it("rebuilds display labels from valid request parts and rejects a selected chip name/path mismatch", () => {
    const parsed = { ...roundTrip(draft()), attachmentDisplayPrefix: "fake display" }
    expect(normalizeQueuedMessage(parsed)?.attachmentDisplayPrefix).toBe("📎 a.ts")
    const chip = roundTrip(draft({ text: "inspect", chip: true })),
      refs = chip.pendingMentions
    if (!Array.isArray(refs)) throw Error("Actual chip missing")
    refs[0].filename = "unrelated.txt"
    expect(normalizeQueuedMessage(chip)).toBeNull()
  })

  it("checks real workspace keys without migrating saved references", () => {
    const actual = restore(draft())
    expect(() => assertQueuedComposerMentionWorkspace(actual, "C:/different-project")).toThrow(
      "工作区已变化，请重新选择该草稿的 @文件"
    )
    expect(() => assertQueuedComposerMentionWorkspace(actual, null)).toThrow(
      "工作区已变化，请重新选择该草稿的 @文件"
    )
    const alternate = "c:\\mention-project\\"
    if (normalizeWorkspacePathKey(alternate) === normalizeWorkspacePathKey(workspace))
      assertQueuedComposerMentionWorkspace(actual, alternate)
    else
      expect(() => assertQueuedComposerMentionWorkspace(actual, alternate)).toThrow("工作区已变化")
    expect(actual.pendingMentions?.[0].workspacePath).toBe(workspace)
  })

  it("rejects a workspace replacement after the actual asynchronous hydration boundary", async () => {
    const actual = restore(draft())
    let currentWorkspace = workspace,
      commits = 0
    assertQueuedComposerMentionWorkspace(actual, currentWorkspace)
    await Promise.resolve().then(() => {
      currentWorkspace = "C:/replaced-project"
    })
    const claim = () => {
      assertQueuedComposerMentionWorkspace(actual, currentWorkspace)
      commits += 1
    }
    expect(claim).toThrow("工作区已变化，请重新选择该草稿的 @文件")
    expect(commits).toBe(0)
    expect(actual.id).toBe("same-draft-id")
  })
})
