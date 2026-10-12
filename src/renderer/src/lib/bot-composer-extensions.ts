import { Node, Extension, mergeAttributes } from "@tiptap/core"
import { Document } from "@tiptap/extension-document"
import { Paragraph } from "@tiptap/extension-paragraph"
import { Text } from "@tiptap/extension-text"
import { HardBreak } from "@tiptap/extension-hard-break"
import { Link } from "@tiptap/extension-link"
import { UndoRedo, Placeholder, Dropcursor } from "@tiptap/extensions"
import { ReactNodeViewRenderer } from "@tiptap/react"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import {
  botInlineReference,
  inlineReferenceText,
  parseComposerDocument
} from "./bot-composer-document"
import { botSelectionQuote, quoteText } from "../../../shared/bot-selection-quotes"
import { BotSelectionQuoteView } from "../components/bots/BotSelectionQuoteView"
import { BotInlineReferenceView } from "../components/bots/BotInlineReferenceView"

const Reference = Node.create({
  name: "botReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { reference: { default: null, rendered: false } }
  },
  parseHTML() {
    return [
      {
        tag: "span[data-bot-reference]",
        getAttrs(element) {
          const raw = element.getAttribute("data-bot-reference")
          if (!raw || raw.length > 4096) return false
          try {
            const reference = botInlineReference.safeParse(JSON.parse(raw))
            return reference.success ? { reference: reference.data } : false
          } catch {
            return false
          }
        }
      }
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    const reference = botInlineReference.parse(node.attrs.reference)
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-bot-reference": JSON.stringify(reference),
        class: "bot-inline-reference"
      }),
      inlineReferenceText(reference)
    ]
  },
  renderText({ node }) {
    return inlineReferenceText(botInlineReference.parse(node.attrs.reference))
  },
  addNodeView() {
    return ReactNodeViewRenderer(BotInlineReferenceView)
  },
  addKeyboardShortcuts() {
    return {
      Backspace: () => {
        const { selection } = this.editor.state
        const before = selection.$from.nodeBefore
        if (!selection.empty || before?.type.name !== this.name) return false
        const reference = botInlineReference.safeParse(before.attrs.reference)
        if (!reference.success) return false
        return this.editor
          .chain()
          .command(({ tr }) => {
            closeHistory(tr)
            return true
          })
          .insertContentAt(
            { from: selection.from - before.nodeSize, to: selection.from },
            reference.data.kind === "skill" ? "/" : "@"
          )
          .run()
      }
    }
  }
})

const QuoteReference = Node.create({
  name: "quoteReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { quote: { default: null, rendered: false } }
  },
  parseHTML() {
    return [
      {
        tag: "span[data-bot-selection-quote]",
        getAttrs(element) {
          const raw = element.getAttribute("data-bot-selection-quote")
          if (!raw || raw.length > 128_000) return false
          try {
            const parsed = botSelectionQuote.safeParse(JSON.parse(raw))
            return parsed.success ? { quote: parsed.data } : false
          } catch {
            return false
          }
        }
      }
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    const quote = botSelectionQuote.parse(node.attrs.quote)
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-bot-selection-quote": JSON.stringify(quote),
        class: "bot-selection-quote"
      }),
      quoteText(quote)
    ]
  },
  renderText({ node }) {
    return quoteText(botSelectionQuote.parse(node.attrs.quote))
  },
  addNodeView() {
    return ReactNodeViewRenderer(BotSelectionQuoteView)
  }
})

/** Adapted from Grok's MacEmacsLineMotion; Ctrl+A/E respects hard-break lines. */
const LineMotion = Extension.create({
  name: "botMacLineMotion",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("botMacLineMotion"),
        props: {
          handleKeyDown(view, event) {
            if (
              !/mac/i.test(navigator.platform) ||
              !event.ctrlKey ||
              event.metaKey ||
              event.altKey ||
              !["a", "e"].includes(event.key.toLowerCase())
            )
              return false
            const { $head, anchor } = view.state.selection
            if (!$head.parent.isTextblock) return false
            const forward = event.key.toLowerCase() === "e"
            let offset = forward ? $head.parent.content.size : 0
            let found = false
            $head.parent.forEach((node, position) => {
              if (node.type.name !== "hardBreak") return
              if (!forward && position + node.nodeSize <= $head.parentOffset)
                offset = position + node.nodeSize
              if (forward && !found && position >= $head.parentOffset) {
                offset = position
                found = true
              }
            })
            const position = $head.start() + offset
            view.dispatch(
              view.state.tr
                .setSelection(
                  TextSelection.create(view.state.doc, event.shiftKey ? anchor : position, position)
                )
                .scrollIntoView()
            )
            return true
          }
        }
      })
    ]
  }
})

export function botComposerExtensions(rejected: () => void, inlineReferences = true) {
  return [
    Document,
    Paragraph,
    Text,
    HardBreak,
    ...(inlineReferences ? [Reference, QuoteReference] : []),
    LineMotion,
    Link.extend({ inclusive: () => false }).configure({
      openOnClick: false,
      enableClickSelection: false,
      autolink: false,
      // Plain-text filenames are not URLs. Explicit rich links retain their
      // destination; only URLs with a scheme gain a mark from plain-text paste.
      linkOnPaste: false,
      shouldAutoLink: (value) => /^(https?:\/\/|mailto:)/i.test(value),
      protocols: ["http", "https", "mailto"]
    }),
    UndoRedo.configure({ depth: 100 }),
    Dropcursor,
    // React supplies the current label through CSS; changing reply mode must
    // not reconfigure the editor or reset the native selection.
    Placeholder.configure({ placeholder: "" }),
    Extension.create({
      name: "botComposerBounds",
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: new PluginKey("botComposerBounds"),
            filterTransaction(transaction) {
              if (!transaction.docChanged || parseComposerDocument(transaction.doc.toJSON()))
                return true
              rejected()
              return false
            }
          })
        ]
      }
    })
  ]
}
