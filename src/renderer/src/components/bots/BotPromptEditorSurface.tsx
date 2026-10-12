import {
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from "react"
import { EditorContent, useEditor } from "@tiptap/react"
import { EditorState } from "@tiptap/pm/state"
import { closeHistory } from "@tiptap/pm/history"
import type { EditorProps } from "@tiptap/pm/view"
import { toast } from "sonner"
import {
  composerDocument,
  composerDocumentChange,
  inlineReferenceKey,
  botInlineReference,
  parseComposerDocument,
  type BotInlineReference
} from "@/lib/bot-composer-document"
import { botComposerExtensions } from "@/lib/bot-composer-extensions"
import type { BotComposerDraft } from "@/lib/bot-composer-draft"
import { botSelectionQuote, type BotSelectionQuote } from "../../../../shared/bot-selection-quotes"

export interface BotPromptControls {
  focus(): void
  insertQuote(quote: BotSelectionQuote): boolean
  insertReference(reference: BotInlineReference | null, from: number, to: number): void
}
export interface BotPromptSelection {
  text: string
  caret: number
  start: number
}

/** A presentation owner, never a message or file permission grant. */
export interface BotPromptDraftPort {
  read(): BotComposerDraft | undefined
  commit(
    expectedRevision: string | undefined,
    changes: Partial<BotComposerDraft>
  ): BotComposerDraft | undefined
  canInsertReference(): boolean
}

export interface BotPromptEditorSurfaceProps {
  editorId: string
  disabled?: boolean
  ariaLabel?: string
  owner: BotPromptDraftPort
  inlineReferences?: boolean
  draft: BotComposerDraft
  controls: RefObject<BotPromptControls | null>
  placeholder: string
  expanded: boolean
  listId?: string
  activeOption?: string
  onSelection(selection: BotPromptSelection): void
  onFocus(focused: boolean): void
  onReady?(): void
  onKeyDown(event: KeyboardEvent): boolean
  onPaste(event: ClipboardEvent): void
}

export function BotPromptEditorSurface(props: BotPromptEditorSurfaceProps) {
  const current = useRef(props)
  useLayoutEffect(() => {
    current.current = props
  })
  const revision = useRef(props.draft.revision)
  const selection = useRef<BotPromptSelection>({
    text: "",
    caret: 0,
    start: 1
  })
  useLayoutEffect(() => {
    current.current.onFocus(false)
    current.current.onSelection({ text: "", caret: 0, start: 1 })
    return () => current.current.onFocus(false)
  }, [])
  const extensions = useMemo(
    () =>
      botComposerExtensions(
        () => toast.error("输入过长、引用过多或格式不支持，请调整后重试"),
        props.inlineReferences ?? true
      ),
    [props.inlineReferences]
  )
  // Keep initialization options stable. Reapplying editorProps after focus or a
  // keystroke can restore the old DOM selection before its native change arrives.
  // External draft changes are reconciled explicitly below.
  const [content] = useState(() => composerDocument(props.draft))
  const editorProps = useMemo<EditorProps>(
    () => ({
      attributes: {
        id: props.editorId,
        class: "bot-composer-input bot-rich-input",
        "aria-label": props.ariaLabel ?? "向 Bot 交办工作",
        role: "combobox",
        "aria-multiline": "true",
        "aria-autocomplete": "list",
        spellcheck: "false"
      },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || event.keyCode === 229) return false
        return current.current.onKeyDown(event)
      },
      handlePaste: (view, event) => {
        current.current.onPaste(event)
        // A paste is one edit, even immediately after typing. Undo must not
        // remove the preceding task description along with pasted content.
        if (!event.defaultPrevented) view.dispatch(closeHistory(view.state.tr))
        return event.defaultPrevented
      }
    }),
    [props.editorId, props.ariaLabel]
  )
  const editor = useEditor({
    extensions,
    content,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps,
    onFocus: () => current.current.onFocus(true),
    onBlur: () => current.current.onFocus(false),
    onUpdate: ({ editor: instance }) => {
      const owner = current.current.owner
      const draft = owner.read()
      // A delayed editor transaction cannot resurrect a draft cleared by a
      // receipt, a restore, or a newer external edit.
      if (!draft || draft.revision !== revision.current) return
      const change = composerDocumentChange(instance.getJSON(), draft)
      if (!change) return
      const accepted = owner.commit(revision.current, change)
      if (accepted) revision.current = accepted.revision
    },
    onTransaction: ({ editor: instance }) => {
      const { $from, empty } = instance.state.selection
      const next = {
        text: empty ? $from.parent.textBetween(0, $from.parent.content.size, "\n", "\uFFFC") : "",
        caret: empty ? $from.parentOffset : 0,
        start: $from.start()
      }
      if (
        next.text !== selection.current.text ||
        next.caret !== selection.current.caret ||
        next.start !== selection.current.start
      ) {
        selection.current = next
        current.current.onSelection(next)
      }
    }
  })

  useLayoutEffect(() => {
    // Changing input availability is not a document edit. An emitted update
    // would replace the draft revision and invalidate a pending file handoff.
    editor?.setEditable(!props.disabled, false)
  }, [editor, props.disabled])
  useLayoutEffect(() => {
    if (editor) current.current.onReady?.()
  }, [editor])

  useLayoutEffect(() => {
    if (!editor || props.owner.read()?.revision !== props.draft.revision) return
    const expected = composerDocument(props.draft)
    const rendered = parseComposerDocument(editor.getJSON())
    revision.current = props.draft.revision
    if (JSON.stringify(expected) !== JSON.stringify(rendered)) {
      // Accepted sends and externally restored drafts start a fresh history.
      // Native editing/undo already has matching JSON and never enters this path.
      const doc = editor.schema.nodeFromJSON(expected)
      editor.view.updateState(
        EditorState.create({
          schema: editor.schema,
          doc,
          plugins: editor.state.plugins
        })
      )
      const { $from } = editor.state.selection
      const next = {
        text: $from.parent.textBetween(0, $from.parent.content.size, "\n", "\uFFFC"),
        caret: $from.parentOffset,
        start: $from.start()
      }
      selection.current = next
      current.current.onSelection(next)
    }
    const normalized = composerDocumentChange(expected, props.draft)
    if (
      normalized &&
      (normalized.prompt !== props.draft.prompt || normalized.richText !== props.draft.richText)
    ) {
      const accepted = props.owner.commit(props.draft.revision, normalized)
      if (accepted) revision.current = accepted.revision
    }
  }, [editor, props.draft, props.owner])

  useLayoutEffect(() => {
    if (!editor) return
    const element = editor.view.dom
    element.setAttribute("aria-expanded", String(props.expanded))
    element.setAttribute("placeholder", props.placeholder)
    for (const [name, value] of [
      ["aria-controls", props.listId],
      ["aria-activedescendant", props.activeOption]
    ] as const) {
      if (value) element.setAttribute(name, value)
      else element.removeAttribute(name)
    }
  }, [editor, props.expanded, props.placeholder, props.listId, props.activeOption])

  useImperativeHandle(
    props.controls,
    () => ({
      focus: () => {
        editor?.commands.focus()
      },
      insertQuote(quote) {
        const parsed = botSelectionQuote.safeParse(quote)
        if (
          !editor ||
          editor.isDestroyed ||
          !editor.isEditable ||
          !parsed.success ||
          current.current.inlineReferences === false ||
          !current.current.owner.canInsertReference() ||
          current.current.owner.read()?.revision !== revision.current
        )
          return false
        const previousRevision = revision.current
        const inserted = editor
          .chain()
          .focus()
          .command(({ tr }) => {
            closeHistory(tr)
            return true
          })
          .insertContentAt(editor.state.doc.content.size, [
            {
              type: "paragraph",
              content: [{ type: "quoteReference", attrs: { quote: parsed.data } }]
            },
            { type: "paragraph" }
          ])
          .run()
        if (inserted) editor.commands.focus("end")
        // A rejected bounds transaction or a stale owner does not consume the selection.
        return inserted && revision.current !== previousRevision
      },
      insertReference(reference, from, to) {
        if (!editor || editor.isDestroyed) return
        const owner = current.current.owner
        if (
          current.current.inlineReferences === false ||
          !owner.canInsertReference() ||
          owner.read()?.revision !== revision.current
        )
          return
        const context = selection.current
        if (from < 0 || to > context.text.length || from > to) return
        const range = { from: context.start + from, to: context.start + to }
        const content = reference
          ? [
              { type: "botReference", attrs: { reference } },
              { type: "text", text: " " }
            ]
          : []
        editor
          .chain()
          .focus()
          .command(({ tr, commands }) => {
            closeHistory(tr)
            const remove: { from: number; to: number }[] = []
            if (reference)
              tr.doc.descendants((node, position) => {
                if (node.type.name !== "botReference") return
                const existing = botInlineReference.safeParse(node.attrs.reference)
                if (!existing.success) return
                if (
                  (reference.kind === "everyone" &&
                    ["recipient", "everyone"].includes(existing.data.kind)) ||
                  (reference.kind === "recipient" && existing.data.kind === "everyone")
                ) {
                  remove.push({ from: position, to: position + node.nodeSize })
                } else if (inlineReferenceKey(existing.data) === inlineReferenceKey(reference)) {
                  tr.setNodeMarkup(position, undefined, { reference })
                }
              })
            for (const old of remove.reverse()) tr.delete(old.from, old.to)
            return commands.insertContentAt(
              {
                from: tr.mapping.map(range.from),
                to: tr.mapping.map(range.to)
              },
              content
            )
          })
          .run()
      }
    }),
    [editor]
  )

  return (
    <EditorContent
      editor={editor}
      className="bot-rich-editor"
      style={
        {
          "--bot-composer-placeholder": JSON.stringify(props.placeholder)
        } as CSSProperties
      }
    />
  )
}
