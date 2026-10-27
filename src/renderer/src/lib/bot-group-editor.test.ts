import { afterEach, describe, expect, it, vi } from "vitest"
import { getSchema } from "@tiptap/core"
import { EditorState, TextSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import { history, undo, redo, closeHistory } from "@tiptap/pm/history"
import {
  groupEditorContent,
  privateEditorContent,
  privateEditorDraft,
  groupEditorPosition,
  groupEditorDraft,
  groupEditorExtensions,
  groupEditorOffset,
  groupEditorDeleteMention,
  groupEditorLineBoundary,
  groupEditorMotionPlugin,
  groupEditorClipboardPlugin
} from "./bot-group-editor"
import { groupMessageRecipients, groupMentionQuery } from "./bot-group-mentions"

const schema = getSchema(groupEditorExtensions())
const member = { start: 0, end: 3, botId: "a", label: "甲乙" }
afterEach(() => vi.unstubAllGlobals())

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

  it("returns a backspaced member to @, rebases later identities and restores exact IDs on undo", () => {
    const text = "@甲乙 @丙丁"
    const mentions = [member, { start: 4, end: 7, botId: "b", label: "丙丁" }]
    const doc = schema.nodeFromJSON(groupEditorContent(text, mentions))
    let state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
      plugins: [history()]
    })
    const view = {
      get state() {
        return state
      },
      dispatch: (transaction: typeof state.tr) => {
        state = state.apply(transaction)
      }
    }
    expect(groupEditorDeleteMention(view, true)).toBe(true)
    const changed = groupEditorDraft(state.doc.toJSON())
    expect(changed).toEqual({
      text: "@ @丙丁",
      mentions: [{ start: 2, end: 5, botId: "b", label: "丙丁" }]
    })
    expect(
      groupMentionQuery(
        changed.text,
        groupEditorOffset(state.doc, state.selection.from),
        changed.mentions
      )
    ).toEqual({ start: 0, end: 1, query: "" })
    expect(groupMessageRecipients(changed.mentions, ["a", "b"]).ids).toEqual(["b"])
    expect(undo(state, view.dispatch)).toBe(true)
    expect(groupEditorDraft(state.doc.toJSON())).toEqual({ text, mentions })
    expect(redo(state, view.dispatch)).toBe(true)
    expect(groupEditorDraft(state.doc.toJSON())).toEqual(changed)
  })

  it("keeps forward deletion atomic and leaves ordinary text or nonempty selections to the editor", () => {
    const doc = schema.nodeFromJSON(
      groupEditorContent("前 @甲乙 后", [{ ...member, start: 2, end: 5 }])
    )
    let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 3) })
    const view = {
      get state() {
        return state
      },
      dispatch: (transaction: typeof state.tr) => {
        state = state.apply(transaction)
      }
    }
    expect(groupEditorDeleteMention(view, false)).toBe(true)
    expect(groupEditorDraft(state.doc.toJSON())).toEqual({ text: "前  后", mentions: [] })
    const previous = state
    expect(groupEditorDeleteMention(view, true)).toBe(false)
    expect(state).toBe(previous)
    state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 4) })
    const selected = state
    expect(groupEditorDeleteMention(view, true)).toBe(false)
    expect(groupEditorDeleteMention(view, false)).toBe(false)
    expect(state).toBe(selected)
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

describe("group editor clipboard", () => {
  const clipboard = groupEditorClipboardPlugin()
  const paste = (state: EditorState, text: string) => {
    const slice = clipboard.props.clipboardTextParser!.call(
      clipboard,
      text,
      state.selection.$from,
      true,
      { state } as EditorView
    )
    return state.apply(state.tr.replaceSelection(slice!).setMeta("uiEvent", "paste"))
  }

  it.each([
    "首段\n\n第二段\n\n- 第一项\n- 第二项\n\n```js\nconsole.log(82)\n```",
    "\n\n首段\n\n",
    "  缩进\t空格  \n\n🙂",
    "首段\r\n\r\n第二段\r末行"
  ])("preserves exact plain paragraphs through native paste replacement: %s", (text) => {
    const state = paste(EditorState.create({ schema }), text)
    expect(groupEditorDraft(state.doc.toJSON())).toEqual({
      text: text.replace(/\r\n?/g, "\n"),
      mentions: []
    })
    expect(groupEditorOffset(state.doc, state.selection.from)).toBe(
      text.replace(/\r\n?/g, "\n").length
    )
  })

  it("replaces selected text between bound atoms, preserving IDs and native undo/redo", () => {
    const text = "@甲乙 待替换 @甲乙"
    const mentions = [member, { ...member, start: 8, end: 11, botId: "b" }]
    const doc = schema.nodeFromJSON(groupEditorContent(text, mentions))
    let state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 3, 6),
      plugins: [history()]
    })
    state = paste(state, "首段\n\n@甲乙\n末行")
    const pasted = groupEditorDraft(state.doc.toJSON())
    expect(pasted).toEqual({
      text: "@甲乙 首段\n\n@甲乙\n末行 @甲乙",
      mentions: [member, { ...member, botId: "b", start: 15, end: 18 }]
    })
    expect(groupEditorOffset(state.doc, state.selection.from)).toBe(14)
    expect(
      undo(state, (transaction) => {
        state = state.apply(transaction)
      })
    ).toBe(true)
    expect(groupEditorDraft(state.doc.toJSON())).toEqual({ text, mentions })
    expect(
      redo(state, (transaction) => {
        state = state.apply(transaction)
      })
    ).toBe(true)
    expect(groupEditorDraft(state.doc.toJSON())).toEqual(pasted)
  })

  it("keeps clipboard markup and typed mention labels as unbound text", () => {
    const text = '<span data-group-mention data-bot-id="a">@甲乙</span>\n\n@所有人'
    const state = paste(EditorState.create({ schema }), text)
    expect(groupEditorDraft(state.doc.toJSON())).toEqual({ text, mentions: [] })
  })
})

describe("Grok editor motion adaptation", () => {
  it("requests a single caret scroll after content edits, never a transaction loop", () => {
    const state = EditorState.create({ schema, plugins: [groupEditorMotionPlugin()] })
    const edited = state.applyTransaction(state.tr.insertText("内容"))
    expect(edited.transactions).toHaveLength(2)
    expect(edited.transactions.at(-1)!.scrolledIntoView).toBe(true)
    expect(
      state.applyTransaction(state.tr.insertText("内容").scrollIntoView()).transactions
    ).toHaveLength(1)
    expect(
      edited.state.applyTransaction(edited.state.tr.setMeta("unrelated", true)).transactions
    ).toHaveLength(1)
  })

  it("uses actual node offsets across hard breaks and mention atoms", () => {
    const paragraph = schema.node("paragraph", null, [
      schema.text("前"),
      schema.node("groupMention", { botId: "a", label: "长名称" }),
      schema.node("hardBreak"),
      schema.text("后"),
      schema.node("hardBreak"),
      schema.text("尾")
    ])
    expect(groupEditorLineBoundary(paragraph, 3, "backward")).toBe(3)
    expect(groupEditorLineBoundary(paragraph, 3, "forward")).toBe(4)
    expect(groupEditorLineBoundary(paragraph, 6, "backward")).toBe(5)
  })

  it("moves and extends the Mac selection within the current hard-break line", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" })
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("第一行"),
        schema.node("hardBreak"),
        schema.text("第二行")
      ])
    ])
    let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 7) })
    const view = {
      get state() {
        return state
      },
      composing: false,
      dispatch(transaction) {
        state = state.apply(transaction)
      }
    } as EditorView
    const plugin = groupEditorMotionPlugin()
    const press = (key: string, extra: object = {}) =>
      plugin.props.handleKeyDown!.call(plugin, view, {
        key,
        ctrlKey: true,
        ...extra
      } as KeyboardEvent)
    expect(press("a")).toBe(true)
    expect(state.selection.from).toBe(5)
    expect(press("e", { shiftKey: true })).toBe(true)
    expect([state.selection.anchor, state.selection.head]).toEqual([5, 8])
    expect(press("a", { isComposing: true })).toBe(false)
    vi.stubGlobal("navigator", { platform: "Win32" })
    expect(press("a")).toBe(false)
    expect([state.selection.anchor, state.selection.head]).toEqual([5, 8])
  })
})


describe("private mention editor uses the same atoms without group broadcast", () => {
  it("round trips same-named Bot and group identities among Unicode and paragraphs", () => {
    const text = "🙂 @同名\n@同名 收到"
    const mentions = [
      { start: 3, end: 6, botId: "peer", label: "同名" },
      { start: 7, end: 10, kind: "group" as const, groupId: "room", label: "同名" }
    ]
    const doc = schema.nodeFromJSON(privateEditorContent(text, mentions))
    expect(privateEditorDraft(doc.toJSON())).toEqual({ text, mentions })
    for (const offset of [0, 2, 3, 6, 7, 10, 11, 13])
      expect(groupEditorOffset(doc, groupEditorPosition(doc, offset))).toBe(Math.min(offset, text.length))
    expect(groupEditorOffset(doc, groupEditorPosition(doc, 5))).toBe(6)
  })

  it("backspace drops the identity, undo restores it, pasted text binds no identity", () => {
    const text = "@乙"
    const mentions = [{ start: 0, end: 2, botId: "peer", label: "乙" }]
    let state = EditorState.create({ schema, doc: schema.nodeFromJSON(privateEditorContent(text, mentions)), plugins: [history()] })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)))
    const view = { get state() { return state }, dispatch: (tr: Parameters<typeof state.apply>[0]) => { state = state.apply(tr) } }
    expect(groupEditorDeleteMention(view, true)).toBe(true)
    expect(privateEditorDraft(state.doc.toJSON())).toEqual({ text: "@", mentions: [] })
    undo(state, view.dispatch)
    expect(privateEditorDraft(state.doc.toJSON())).toEqual({ text, mentions })
    expect(privateEditorDraft(privateEditorContent(text, []))).toEqual({ text, mentions: [] })
  })

  it("rejects the group Everyone token in private chat rather than manufacturing a recipient", () => {
    expect(() => privateEditorDraft(groupEditorContent("@所有人", [{ start: 0, end: 4, botId: null, label: "所有人" }]))).toThrow()
  })
})
