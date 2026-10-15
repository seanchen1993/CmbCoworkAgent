import { describe, expect, it } from "vitest"
import { getSchema } from "@tiptap/core"
import { EditorState } from "@tiptap/pm/state"
import { history, undo, redo, closeHistory } from "@tiptap/pm/history"
import {
  groupEditorContent,
  groupEditorDraft,
  groupEditorExtensions,
  groupEditorOffset
} from "./bot-group-editor"
import { groupMessageRecipients } from "./bot-group-mentions"

const schema = getSchema(groupEditorExtensions())
const member = { start: 0, end: 3, botId: "a", label: "甲乙" }

describe("group editor draft projection", () => {
  it.each(["", "一行", "甲\n\n乙\n", "🙂\n<attachment> @普通文本"])(
    "keeps plain text unchanged: %s",
    (text) => {
      const doc = schema.nodeFromJSON(groupEditorContent(text, []))
      expect(groupEditorDraft(doc.toJSON())).toEqual({ text, mentions: [] })
    }
  )

  it("round trips multiple bound IDs, Everyone, Unicode and paragraphs", () => {
    const text = "🙂 @甲乙\n@所有人 完成"
    const mentions = [
      { ...member, start: 3, end: 6 },
      { start: 7, end: 11, botId: null, label: "所有人" }
    ]
    const doc = schema.nodeFromJSON(groupEditorContent(text, mentions))
    expect(groupEditorDraft(doc.toJSON())).toEqual({ text, mentions })
    expect(doc.firstChild!.child(1).isAtom).toBe(true)
  })

  it("does not bind typed labels or corrupted persisted ranges", () => {
    const text = "@甲乙 @甲乙"
    const doc = groupEditorContent(text, [{ ...member, start: 1, end: 4 }])
    expect(groupEditorDraft(doc)).toEqual({ text, mentions: [] })
  })

  it("preserves IDs through identical names and renaming in the external member list", () => {
    const text = "@甲乙 @甲乙"
    const mentions = [member, { ...member, start: 4, end: 7, botId: "b" }]
    expect(groupEditorDraft(groupEditorContent(text, mentions))).toEqual({ text, mentions })
    expect(groupMessageRecipients(mentions, ["a", "b"]).ids).toEqual(["a", "b"])
    expect(groupMessageRecipients(mentions, ["a"]).error).toBeTruthy()
  })

  it("preserves a legacy member label containing a newline as one atom", () => {
    const text = "前 @甲\n乙 后"
    const mentions = [{ start: 2, end: 6, botId: "a", label: "甲\n乙" }]
    const doc = schema.nodeFromJSON(groupEditorContent(text, mentions))
    expect(doc.childCount).toBe(1)
    expect(groupEditorDraft(doc.toJSON())).toEqual({ text, mentions })
  })

  it("projects the caret after atoms and paragraph boundaries to plain offsets", () => {
    const doc = schema.nodeFromJSON(groupEditorContent("@甲乙\n下一行 @", [member]))
    expect(groupEditorOffset(doc, 2)).toBe(3)
    expect(groupEditorOffset(doc, 4)).toBe(4)
    expect(groupEditorOffset(doc, 9)).toBe(9)
  })

  it("rebases bound ranges after real ProseMirror insert/delete transactions", () => {
    const doc = schema.nodeFromJSON(groupEditorContent("@甲乙 继续", [member]))
    let state = EditorState.create({ schema, doc })
    state = state.apply(state.tr.insertText("🙂 ", 1))
    expect(groupEditorDraft(state.doc.toJSON()).mentions).toEqual([{ ...member, start: 3, end: 6 }])
    state = state.apply(state.tr.delete(4, 5))
    expect(groupEditorDraft(state.doc.toJSON())).toEqual({ text: "🙂  继续", mentions: [] })
  })

  it("restores the exact member ID on native undo and removes it on redo", () => {
    let state = EditorState.create({
      schema,
      doc: schema.nodeFromJSON(groupEditorContent("@甲乙 ", [member])),
      plugins: [history()]
    })
    state = state.apply(closeHistory(state.tr).delete(1, 2))
    expect(groupEditorDraft(state.doc.toJSON()).mentions).toEqual([])
    expect(
      undo(state, (transaction) => {
        state = state.apply(transaction)
      })
    ).toBe(true)
    expect(groupEditorDraft(state.doc.toJSON()).mentions).toEqual([member])
    expect(
      redo(state, (transaction) => {
        state = state.apply(transaction)
      })
    ).toBe(true)
    expect(groupEditorDraft(state.doc.toJSON()).mentions).toEqual([])
  })

  it("projects Shift+Enter hard breaks without dropping later atoms", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("前"),
        schema.node("hardBreak"),
        schema.node("groupMention", { botId: "b", label: "乙" })
      ])
    ])
    expect(groupEditorDraft(doc.toJSON())).toEqual({
      text: "前\n@乙",
      mentions: [{ start: 2, end: 4, botId: "b", label: "乙" }]
    })
  })
})
