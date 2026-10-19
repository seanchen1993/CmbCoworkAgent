import { Extension, Node, type JSONContent } from "@tiptap/core"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Text from "@tiptap/extension-text"
import HardBreak from "@tiptap/extension-hard-break"
import { Placeholder, UndoRedo } from "@tiptap/extensions"
import { Plugin, TextSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import { Slice, type Node as EditorNode } from "@tiptap/pm/model"
import { validGroupMentions, type BotGroupMention } from "./bot-group-mentions"

// Adapted from Grok's rich-text-editor.tsx: a plain prompt with inline mention atoms,
// native history and paragraph serialization. Durable state remains the existing draft.
export function groupEditorContent(
  text: string,
  mentions: readonly BotGroupMention[]
): JSONContent {
  const content: JSONContent[] = [{ type: "paragraph", content: [] }]
  const append = (value: string) => {
    value.split("\n").forEach((line, index) => {
      if (index) content.push({ type: "paragraph", content: [] })
      if (line) content.at(-1)!.content!.push({ type: "text", text: line })
    })
  }
  let offset = 0
  for (const mention of validGroupMentions(text, mentions)) {
    append(text.slice(offset, mention.start))
    content.at(-1)!.content!.push({
      type: "groupMention",
      attrs: { botId: mention.botId, label: mention.label }
    })
    offset = mention.end
  }
  append(text.slice(offset))
  return { type: "doc", content }
}

export function groupEditorDraft(doc: JSONContent): { text: string; mentions: BotGroupMention[] } {
  let text = ""
  const mentions: BotGroupMention[] = []
  const visit = (node: JSONContent) => {
    if (node.type === "text") text += node.text ?? ""
    else if (node.type === "hardBreak") text += "\n"
    else if (node.type === "groupMention" && typeof node.attrs?.label === "string") {
      const { label, botId } = node.attrs
      const start = text.length
      text += `@${label}`
      if (botId === null || typeof botId === "string")
        mentions.push({ start, end: text.length, botId, label })
    } else node.content?.forEach(visit)
  }
  doc.content?.forEach((node, index) => {
    if (index) text += "\n"
    visit(node)
  })
  return { text, mentions }
}

export function groupEditorOffset(doc: EditorNode, position: number): number {
  return doc.textBetween(0, position, "\n", (node) =>
    node.type.name === "groupMention" ? `@${node.attrs.label}` : "\n"
  ).length
}

/** Match Grok's Mention backspace: return to the trigger without retaining its recipient ID. */
export function groupEditorDeleteMention(
  view: Pick<EditorView, "state" | "dispatch">,
  backward: boolean
): boolean {
  const { state } = view
  const { $from, empty, from } = state.selection
  const node = backward ? $from.nodeBefore : $from.nodeAfter
  if (!empty || node?.type.name !== "groupMention") return false
  const start = backward ? from - node.nodeSize : from
  const transaction = state.tr.delete(start, start + node.nodeSize)
  if (backward) transaction.insertText("@", start)
  view.dispatch(transaction)
  return true
}

export const GroupMentionNode = Node.create({
  name: "groupMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ botId: { default: null }, label: { default: "" } }),
  // Clipboard/drag HTML is never a source of recipient authority.
  parseHTML: () => [],
  renderText: ({ node }) => `@${node.attrs.label}`,
  renderHTML: ({ node }) => ["span", { "data-group-mention": "" }, `@${node.attrs.label}`],
  addKeyboardShortcuts() {
    return {
      Backspace: () => groupEditorDeleteMention(this.editor.view, true),
      Delete: () => groupEditorDeleteMention(this.editor.view, false)
    }
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (transaction) => {
          if (!transaction.docChanged) return true
          const draft = groupEditorDraft(transaction.doc.toJSON())
          return draft.text.length <= 30_000 && draft.mentions.length <= 128
        }
      })
    ]
  }
})

// Grok's editor plugins: keep typed/pasted content visible and preserve Mac line
// navigation across hard breaks and mention atoms without custom DOM selection.
export function groupEditorLineBoundary(
  parent: EditorNode,
  offset: number,
  direction: "forward" | "backward"
): number {
  let boundary = direction === "backward" ? 0 : parent.content.size
  let found = false
  parent.forEach((node, position) => {
    if (node.type.name !== "hardBreak") return
    if (direction === "backward" && position + node.nodeSize <= offset)
      boundary = position + node.nodeSize
    if (direction === "forward" && !found && position >= offset) {
      boundary = position
      found = true
    }
  })
  return boundary
}

export function groupEditorMotionPlugin() {
  return new Plugin({
    appendTransaction(transactions, _previous, state) {
      return transactions.some((item) => item.docChanged) &&
        state.selection.empty &&
        !transactions.some((item) => item.scrolledIntoView)
        ? state.tr.scrollIntoView()
        : null
    },
    props: {
      handleKeyDown(view, event) {
        if (
          typeof navigator === "undefined" ||
          !/mac/i.test(navigator.platform) ||
          !event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.isComposing ||
          view.composing ||
          event.keyCode === 229
        )
          return false
        const key = event.key.toLowerCase()
        if (key !== "a" && key !== "e") return false
        const { state } = view
        const head = state.selection.$head
        if (!head.parent.isTextblock) return false
        const position =
          head.start() +
          groupEditorLineBoundary(
            head.parent,
            head.parentOffset,
            key === "e" ? "forward" : "backward"
          )
        view.dispatch(
          state.tr
            .setSelection(
              TextSelection.create(
                state.doc,
                event.shiftKey ? state.selection.anchor : position,
                position
              )
            )
            .scrollIntoView()
        )
        return true
      }
    }
  })
}

const GroupEditorMotion = Extension.create({
  name: "groupEditorMotion",
  addProseMirrorPlugins: () => [groupEditorMotionPlugin()]
})

export function groupEditorClipboardPlugin() {
  return new Plugin({
    props: {
      clipboardTextParser(text, context) {
        // PM's default parser collapses consecutive newlines. Keep the prompt's
        // exact paragraphs, then use native paste selection/history semantics.
        const doc = context.doc.type.schema.nodeFromJSON(
          groupEditorContent(text.replace(/\r\n?/g, "\n"), [])
        )
        return Slice.maxOpen(doc.content)
      }
    }
  })
}

const GroupEditorClipboard = Extension.create({
  name: "groupEditorClipboard",
  addProseMirrorPlugins: () => [groupEditorClipboardPlugin()]
})

/** Same editor primitives as Grok; omit its unrelated formatting/reference extensions. */
export function groupEditorExtensions(mention = GroupMentionNode) {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    UndoRedo.configure({ newGroupDelay: 100 }),
    GroupEditorMotion,
    GroupEditorClipboard,
    Placeholder.configure({ placeholder: "发消息，或 @ 提及 Bot…" }),
    mention
  ]
}
