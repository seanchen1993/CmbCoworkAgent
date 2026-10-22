import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from "react"
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditor,
  type NodeViewProps
} from "@tiptap/react"
import type { EditorView } from "@tiptap/pm/view"
import { Users } from "lucide-react"
import type { BotDefinition } from "../../../../shared/bots/contracts"
import { groupMentionQuery, type BotGroupMention } from "@/lib/bot-group-mentions"
import {
  GroupMentionNode,
  groupEditorContent,
  groupEditorDraft,
  groupEditorExtensions,
  groupEditorOffset
} from "@/lib/bot-group-editor"
import { BotAvatar } from "./BotAvatar"
import { BotMentionLabel } from "./BotMentionLabel"

export interface BotGroupInputControl {
  focus(): void
}
const MentionMembers = createContext<readonly BotDefinition[]>([])

function MentionView({ node, selected }: NodeViewProps) {
  const members = useContext(MentionMembers)
  const mention = { start: 0, end: 0, botId: node.attrs.botId, label: node.attrs.label }
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className="bot-composer-mention"
      data-selected={selected}
    >
      <BotMentionLabel mention={mention} bot={members.find((bot) => bot.id === mention.botId)} />
    </NodeViewWrapper>
  )
}

const extensions = groupEditorExtensions(
  GroupMentionNode.extend({
    addNodeView: () => ReactNodeViewRenderer(MentionView)
  })
)

/** Grok's atomic mention editor, connected to the existing group draft and recipient contract. */
export function BotGroupMentionInput({
  text,
  mentions,
  members,
  placeholder = "发消息，或 @ 提及 Bot…",
  inputRef,
  onEdit,
  onLayout,
  onCancelReply,
  onPasteFiles
}: {
  text: string
  mentions: BotGroupMention[]
  members: BotDefinition[]
  placeholder?: string
  inputRef: RefObject<BotGroupInputControl | null>
  onEdit(patch: { text: string; mentions: BotGroupMention[] }): void
  onLayout(multiline: boolean, hasText: boolean): void
  onCancelReply(): boolean
  onPasteFiles(files: File[]): void
}) {
  const id = useId()
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  const current = useRef({ onEdit, onLayout, onCancelReply, onPasteFiles })
  current.current = { onEdit, onLayout, onCancelReply, onPasteFiles }
  const measureLayout = useRef<() => void>(() => {})
  const actions = useRef<{ key(view: EditorView, event: KeyboardEvent): boolean }>({
    key: () => false
  })
  const [initial] = useState(() => groupEditorContent(text, mentions))
  const editor = useEditor({
    extensions,
    content: initial,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "bot-group-editor",
        role: "textbox",
        "aria-label": "群聊消息",
        "aria-multiline": "true"
      },
      handleKeyDown: (view, event) => actions.current.key(view, event),
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? [])
        if (files.length) {
          event.preventDefault()
          current.current.onPasteFiles(files)
          return true
        }
        // Use the editor's paragraph/selection/clipboard semantics. The mention
        // schema rejects HTML imports, so pasted labels cannot create recipients.
        return false
      },
      handleDrop: (_view, event) => {
        // File drops bubble to the existing composer attachment handler.
        return Boolean(event.dataTransfer?.files.length)
      },
      handleDOMEvents: {
        compositionstart: () => {
          setComposing(true)
          return false
        },
        compositionend: () => {
          setComposing(false)
          return false
        }
      }
    },
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false)
      setDismissed(null)
    },
    onSelectionUpdate: ({ editor: value }) =>
      setCaret(groupEditorOffset(value.state.doc, value.state.selection.from)),
    onUpdate: ({ editor: value }) => {
      setDismissed(null)
      setCaret(groupEditorOffset(value.state.doc, value.state.selection.from))
      current.current.onEdit(groupEditorDraft(value.getJSON()))
    }
  })
  const query = focused && !composing ? groupMentionQuery(text, caret, mentions) : null
  const queryKey = query ? `${query.start}:${query.end}:${query.query}` : null
  const open = query !== null && queryKey !== dismissed
  const candidates = [
    { id: null, name: "所有人", bot: undefined as BotDefinition | undefined },
    ...members
      .filter((bot) => !bot.archived && !bot.deleting)
      .map((bot) => ({ id: bot.id, name: bot.name, bot }))
  ].filter(
    (item) =>
      !query?.query || item.name.toLocaleLowerCase().includes(query.query.toLocaleLowerCase())
  )
  const selectedIndex = Math.min(selected, Math.max(0, candidates.length - 1))
  const canChoose = (name: string) =>
    mentions.length < 128 &&
    Boolean(query && text.length - (query.end - query.start) + name.length + 2 <= 30_000)
  const choose = (candidate: (typeof candidates)[number]) => {
    if (!editor || !query || !canChoose(candidate.name)) return
    // Active queries contain only text: their plain length is also their PM length.
    const end = editor.state.selection.from
    editor
      .chain()
      .focus()
      .insertContentAt({ from: end - (query.end - query.start), to: end }, [
        { type: "groupMention", attrs: { botId: candidate.id, label: candidate.name } },
        { type: "text", text: " " }
      ])
      .run()
    setDismissed(queryKey)
  }
  actions.current.key = (view, event) => {
    if (event.isComposing || view.composing || composing || event.keyCode === 229) return false
    if (open) {
      if (event.key === "Escape") {
        event.preventDefault()
        setDismissed(queryKey)
        return true
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        setSelected(
          (value) =>
            (value + (event.key === "ArrowDown" ? 1 : -1) + Math.max(1, candidates.length)) %
            Math.max(1, candidates.length)
        )
        return true
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault()
        if (candidates[selectedIndex]) choose(candidates[selectedIndex])
        return true
      }
    }
    // ProseMirror consumes Escape before it bubbles to the composer's form.
    if (event.key === "Escape" && current.current.onCancelReply()) {
      event.preventDefault()
      return true
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      view.dom.closest("form")?.requestSubmit()
      return true
    }
    return false
  }
  useEffect(() => setSelected(0), [queryKey])
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex, open])
  useEffect(() => {
    if (!editor) return
    const control = {
      focus: () => {
        if (!editor.isDestroyed) editor.commands.focus()
      }
    }
    inputRef.current = control
    return () => {
      if (inputRef.current === control) inputRef.current = null
    }
  }, [editor, inputRef])
  useLayoutEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    let previous: { multiline: boolean; hasText: boolean } | undefined
    const measure = () => {
      if (editor.isDestroyed) return
      const style = getComputedStyle(dom)
      const lineHeight = parseFloat(style.lineHeight)
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      // Measure rendered lines, including soft wraps and atomic mentions.
      const multiline = dom.scrollHeight - padding > lineHeight * 1.5
      const hasText = editor.getText().length > 0
      if (previous?.multiline === multiline && previous.hasText === hasText) return
      previous = { multiline, hasText }
      current.current.onLayout(multiline, hasText)
    }
    measureLayout.current = measure
    const observer = new ResizeObserver(measure)
    observer.observe(dom)
    editor.on("update", measure)
    measure()
    return () => {
      observer.disconnect()
      editor.off("update", measure)
      measureLayout.current = () => {}
    }
  }, [editor])
  const draftIdentity = useMemo(() => JSON.stringify({ text, mentions }), [text, mentions])
  useLayoutEffect(() => {
    if (
      !editor ||
      editor.isDestroyed ||
      JSON.stringify(groupEditorDraft(editor.getJSON())) === draftIdentity
    )
      return
    // Restored drafts/accepted sends are authoritative; do not echo them as user edits.
    editor.commands.setContent(groupEditorContent(text, mentions), { emitUpdate: false })
    setCaret(groupEditorOffset(editor.state.doc, editor.state.selection.from))
    measureLayout.current()
  }, [editor, draftIdentity])
  useEffect(() => {
    if (!editor) return
    const dom = editor.view.dom
    dom.setAttribute("aria-placeholder", placeholder)
    dom.setAttribute("aria-expanded", String(open))
    dom.setAttribute("aria-autocomplete", "list")
    if (open) dom.setAttribute("aria-controls", id)
    else dom.removeAttribute("aria-controls")
    if (open && candidates.length)
      dom.setAttribute("aria-activedescendant", `${id}-${selectedIndex}`)
    else dom.removeAttribute("aria-activedescendant")
  }, [editor, open, candidates.length, id, selectedIndex, placeholder])
  return (
    <div
      className="bot-group-input"
      style={{ "--bot-group-placeholder": JSON.stringify(placeholder) } as CSSProperties}
    >
      {open && (
        <div id={id} role="listbox" aria-label="提及群成员" className="bot-mention-options">
          <div className="bot-mention-heading">提及</div>
          {!candidates.length && <p className="bot-mention-empty">没有匹配的群成员</p>}
          {candidates.map((candidate, index) => (
            <button
              key={candidate.id ?? "all"}
              id={`${id}-${index}`}
              type="button"
              role="option"
              ref={index === selectedIndex ? selectedRef : null}
              aria-selected={index === selectedIndex}
              disabled={!canChoose(candidate.name)}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(candidate)}
            >
              {candidate.bot ? (
                <BotAvatar
                  color={candidate.bot.color}
                  shape={candidate.bot.shape}
                  size={24}
                  animated={false}
                />
              ) : (
                <Users size={24} />
              )}
              <span>{candidate.name}</span>
              <small>Bot</small>
            </button>
          ))}
        </div>
      )}
      <MentionMembers.Provider value={members}>
        <EditorContent editor={editor} />
      </MentionMembers.Provider>
    </div>
  )
}
