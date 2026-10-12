import { expect, it } from "vitest"
import {
  composerDocument,
  appendComposerText,
  composerDocumentChange,
  composerDocumentText,
  composerDocumentPayload,
  composerDraftInlineReferences,
  parseComposerDocument,
  type BotInlineReference
} from "./bot-composer-document"
import type { BotComposerDraft } from "./bot-composer-draft"

const skill = { botId: "bot", id: "skill", version: 1, name: "接口评审" }
const reference = { kind: "routine" as const, id: "daily", name: "日检" }
const blank = (): BotComposerDraft => ({ prompt: "", attachments: [] })
const atom = (ref: BotInlineReference) => ({ type: "botReference", attrs: { reference: ref } })
const doc = (...content: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content }] })
const text = (value: string) => ({ type: "text", text: value })

it("serializes reference positions against actual Unicode text, newlines and expanded links", () => {
  const parsed = parseComposerDocument({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          text("🙂 请"),
          atom(reference),
          { type: "hardBreak" },
          {
            type: "text",
            text: "文档",
            marks: [{ type: "link", attrs: { href: "https://example.com" } }]
          },
          atom({ ...skill, kind: "skill" })
        ]
      },
      { type: "paragraph", content: [atom({ ...reference, id: "other" }), text(" 结束")] }
    ]
  })!
  const payload = composerDocumentPayload(parsed)
  expect(payload.text).toBe("🙂 请@日检\n文档 (https://example.com)/接口评审\n@日检 结束")
  expect(payload.inlineReferences.map((span) => payload.text.slice(span.from, span.to))).toEqual([
    "@日检",
    "/接口评审",
    "@日检"
  ])
  expect(payload.inlineReferences[0]).toEqual({
    from: 4,
    to: 7,
    reference: { kind: "routine", id: "daily" }
  })
  expect(payload.inlineReferences[2].reference.id).toBe("other")
  const draft = { ...blank(), ...composerDocumentChange(parsed, blank()) }
  expect(composerDraftInlineReferences(draft)).toEqual(payload.inlineReferences)
  expect(composerDraftInlineReferences({ ...draft, prompt: "编辑器之外的新文本" })).toEqual([])
  expect(
    composerDraftInlineReferences({ prompt: "@日检", attachments: [], references: [reference] })
  ).toEqual([])
})

it("restores a legacy draft with typed inline references without copying its skill instructions", () => {
  const document = composerDocument({
    prompt: "检查接口",
    attachments: [],
    skills: [skill],
    references: [reference]
  })
  expect(composerDocumentText(document)).toBe("/接口评审 @日检 检查接口")
  expect(composerDocumentChange(document, blank())).toMatchObject({
    skills: [skill],
    references: [reference]
  })
})

it("removes selections with their nodes and restores them with the undo document", () => {
  const original = doc(atom({ ...skill, kind: "skill" }), text(" 检查"), atom(reference))
  const draft = { ...blank(), ...composerDocumentChange(original, blank()) }
  const removed = composerDocumentChange(doc(text(" 检查")), draft)!
  expect(removed.skills).toEqual([])
  expect(removed.references).toEqual([])
  expect(composerDocumentChange(original, { ...draft, ...removed })).toMatchObject({
    skills: [skill],
    references: [reference]
  })
})

it("does not revive a removed reference from persisted rich text", () => {
  const document = composerDocument({
    ...blank(),
    richText: JSON.stringify(doc(atom(reference), text(" 检查"))),
    references: []
  })
  expect(composerDocumentText(document)).toBe(" 检查")
})

it("preserves manual recipients and removes only the deleted inline recipients", () => {
  const original = doc(atom({ kind: "recipient", id: "inline", name: "助手" }), text(" 工作"))
  const draft = { ...blank(), recipients: ["manual", "inline"], richText: JSON.stringify(original) }
  expect(composerDocumentChange(doc(text(" 工作")), draft)?.recipients).toEqual(["manual"])
})

it("everyone explicitly clears individual routing and a following recipient narrows it", () => {
  expect(
    composerDocumentChange(doc(atom({ kind: "everyone", id: "everyone", name: "全体 Bot" })), {
      ...blank(),
      recipients: ["old"]
    })?.recipients
  ).toEqual([])
  expect(
    composerDocumentChange(
      doc(
        atom({ kind: "everyone", id: "everyone", name: "全体 Bot" }),
        atom({ kind: "recipient", id: "new", name: "助手" })
      ),
      blank()
    )?.recipients
  ).toEqual(["new"])
})

it("deduplicates repeated references but enforces total selected-object bounds", () => {
  expect(
    composerDocumentChange(doc(atom(reference), atom(reference)), blank())?.references
  ).toEqual([reference])
  expect(
    composerDocumentChange(
      doc(...Array.from({ length: 13 }, (_, i) => atom({ ...reference, id: String(i) }))),
      blank()
    )
  ).toBeNull()
})

it("bounds repeated visible reference nodes independently of identity deduplication", () => {
  expect(
    parseComposerDocument(doc(...Array.from({ length: 64 }, () => atom(reference))))
  ).not.toBeNull()
  expect(
    parseComposerDocument(doc(...Array.from({ length: 65 }, () => atom(reference))))
  ).toBeNull()
})

it("appends routine editing instructions without duplicating references or changing recipients", () => {
  const original = doc(
    atom(reference),
    text(" 先评审"),
    atom({ kind: "recipient", id: "peer", name: "助手" }),
    atom({ ...skill, kind: "skill" })
  )
  const draft = { ...blank(), ...composerDocumentChange(original, blank()) }
  const appended = appendComposerText(draft, "请修改例程：")!
  expect(appended.prompt).toBe("@日检 先评审@助手/接口评审\n\n请修改例程：")
  expect(appended.references).toEqual([reference])
  expect(appended.skills).toEqual([skill])
  expect(appended.recipients).toEqual(["peer"])
  expect(composerDocumentText(composerDocument({ ...draft, ...appended }))).toBe(appended.prompt)
  expect(appendComposerText(blank(), "请修改例程：")?.prompt).toBe("请修改例程：")
  expect(appendComposerText({ ...blank(), prompt: "a".repeat(64_000) }, "继续")).toBeNull()
})

it("preserves newlines and actual link destinations rather than losing pasted URL meaning", () => {
  const document = parseComposerDocument({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "文档",
            marks: [{ type: "link", attrs: { href: "https://example.com/spec", target: "_blank" } }]
          },
          { type: "hardBreak" },
          text("第二行")
        ]
      },
      { type: "paragraph", content: [text("末段")] }
    ]
  })!
  expect(composerDocumentText(document)).toBe("文档 (https://example.com/spec)\n第二行\n末段")
})

it.each([
  doc({ type: "image", attrs: { src: "https://remote.invalid/private" } }),
  doc({
    type: "text",
    text: "脚本",
    marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }]
  }),
  doc(atom({ ...reference, kind: "unknown" } as unknown as BotInlineReference)),
  doc(text("x".repeat(64_001)))
])("rejects unsupported or unbounded editor documents", (value) => {
  expect(parseComposerDocument(value)).toBeNull()
})

it("falls back to readable text for corrupt persisted documents", () => {
  expect(
    composerDocumentText(
      composerDocument({
        ...blank(),
        prompt: "保留文字",
        richText: '{"type":"doc","content":"bad"}'
      })
    )
  ).toBe("保留文字")
})
