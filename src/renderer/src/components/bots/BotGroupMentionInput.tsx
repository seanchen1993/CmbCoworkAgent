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
import { FileText, Users } from "lucide-react"
import type { BotDefinition, BotGroup, BotMessageMention } from "../../../../shared/bots/contracts"
import { groupMentionQuery, type BotGroupMention } from "@/lib/bot-group-mentions"
import {
  GroupMentionNode,
  groupEditorContent,
  groupEditorDraft,
  groupEditorExtensions,
  groupEditorOffset,
  groupEditorPosition,
  privateEditorContent,
  privateEditorDraft
} from "@/lib/bot-group-editor"
import type { AtFileSuggestion } from "@/features/mentions/useAtFileMentions"
import { BotAvatar } from "./BotAvatar"
import { BotMentionLabel } from "./BotMentionLabel"

export interface BotGroupInputControl {
  focus(): void
  readonly selectionStart: number
  setSelectionRange(start: number, end: number): void
}
const MentionMembers = createContext<readonly BotDefinition[]>([])

function MentionView({ node, selected }: NodeViewProps) {
  const members = useContext(MentionMembers)
  const mention = node.attrs.kind === "group"
    ? { start: 0, end: 0, kind: "group" as const, groupId: node.attrs.groupId, label: node.attrs.label }
    : { start: 0, end: 0, botId: node.attrs.botId, label: node.attrs.label }
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className="bot-composer-mention"
      data-selected={selected}
    >
      <BotMentionLabel mention={mention} bot={members.find((bot) => bot.id === ("botId" in mention ? mention.botId : undefined))} />
    </NodeViewWrapper>
  )
}

const extensions = groupEditorExtensions(
  GroupMentionNode.extend({
    addNodeView: () => ReactNodeViewRenderer(MentionView)
  })
)

type Mention = BotGroupMention | BotMessageMention
interface InputProps<M extends Mention> {
  text: string
  mentions: M[]
  members: BotDefinition[]
  placeholder?: string
  inputRef: RefObject<BotGroupInputControl | null>
  onEdit(patch: { text: string; mentions: M[] }): void
  onLayout?(multiline: boolean, hasText: boolean): void
  onCancelReply(): boolean
  onPasteFiles(files: File[]): void
}
interface PrivateInputOptions {
  groups: readonly BotGroup[]
  disabled: boolean
  files: readonly AtFileSuggestion[]
  onSelectFile(file: AtFileSuggestion): void
  onKeyDown(event: KeyboardEvent): void
  onCaret(offset: number): void
  className?: string
}

/** Same editor and native history in both conversations; no second send or draft store. */
function BotMentionInput<M extends Mention>({
  text, mentions, members, placeholder = "发消息，或 @ 提及 Bot…", inputRef,
  onEdit, onLayout, onCancelReply, onPasteFiles, privateChat
}: InputProps<M> & { privateChat?: PrivateInputOptions }) {
  const content = (value: string, selected: M[]) => privateChat
    ? privateEditorContent(value, selected as BotMessageMention[])
    : groupEditorContent(value, selected as BotGroupMention[])
  const draft = (doc: Parameters<typeof groupEditorDraft>[0]) =>
    (privateChat ? privateEditorDraft(doc) : groupEditorDraft(doc)) as { text: string; mentions: M[] }
  const id = useId()
  const [caret, setCaret] = useState(0)
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  const current = useRef({ onEdit, onLayout, onCancelReply, onPasteFiles, privateChat, draft })
  current.current = { onEdit, onLayout, onCancelReply, onPasteFiles, privateChat, draft }
  const measureLayout = useRef<() => void>(() => {})
  const actions = useRef<{ key(view: EditorView, event: KeyboardEvent): boolean }>({
    key: () => false
  })
  const [initial] = useState(() => content(text, mentions))
  const editor = useEditor({
    extensions,
    content: initial,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "bot-group-editor",
        role: "textbox",
        "aria-label": privateChat ? "私聊消息" : "群聊消息",
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
    onSelectionUpdate: ({ editor: value }) => {
      const offset = groupEditorOffset(value.state.doc, value.state.selection.from)
      setCaret(offset)
      current.current.privateChat?.onCaret(offset)
    },
    onUpdate: ({ editor: value }) => {
      setDismissed(null)
      setCaret(groupEditorOffset(value.state.doc, value.state.selection.from))
      current.current.onEdit(current.current.draft(value.getJSON()))
      current.current.privateChat?.onCaret(groupEditorOffset(value.state.doc, value.state.selection.from))
    }
  })
  const query = focused && !composing ? groupMentionQuery(text, caret, mentions) : null
  const queryKey = query ? `${query.start}:${query.end}:${query.query}` : null
  const open = query !== null && queryKey !== dismissed
  type Candidate = { key: string; id: string | null; name: string; bot?: BotDefinition; groupId?: string; file?: AtFileSuggestion }
  const identities: Candidate[] = [
    ...(!privateChat ? [{ key: "all", id: null, name: "所有人" }] : []),
    ...members.filter((bot) => !bot.archived && !bot.deleting)
      .map((bot) => ({ key: `bot:${bot.id}`, id: bot.id, name: bot.name, bot })),
    ...(privateChat?.groups ?? []).map((group) => ({ key: `group:${group.id}`, id: null, groupId: group.id, name: group.name }))
  ]
  const candidates: Candidate[] = [
    ...identities.filter((item) => !query?.query || item.name.toLocaleLowerCase().includes(query.query.toLocaleLowerCase())),
    ...(privateChat?.files ?? []).map((file) => ({ key: `file:${file.id}`, id: null, name: file.displayPath, file }))
  ]
  const selectedIndex = Math.min(selected, Math.max(0, candidates.length - 1))
  const canChoose = (name: string) =>
    mentions.length < 128 &&
    Boolean(query && text.length - (query.end - query.start) + name.length + 2 <= 30_000)
  const choose = (candidate: (typeof candidates)[number]) => {
    if (!editor || !query || privateChat?.disabled) return
    if (candidate.file) { privateChat?.onSelectFile(candidate.file); return }
    if (!canChoose(candidate.name)) return
    // Active queries contain only text: their plain length is also their PM length.
    const end = editor.state.selection.from
    editor
      .chain()
      .focus()
      .insertContentAt({ from: end - (query.end - query.start), to: end }, [
        { type: "groupMention", attrs: candidate.groupId
          ? { kind: "group", groupId: candidate.groupId, label: candidate.name }
          : { botId: candidate.id, label: candidate.name } },
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
    if (privateChat) {
      privateChat.onKeyDown(event)
      return event.defaultPrevented
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
      },
      get selectionStart() { return groupEditorOffset(editor.state.doc, editor.state.selection.from) },
      setSelectionRange: (start: number, end: number) => {
        if (!editor.isDestroyed) editor.commands.setTextSelection({
          from: groupEditorPosition(editor.state.doc, start), to: groupEditorPosition(editor.state.doc, end)
        })
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
      current.current.onLayout?.(multiline, hasText)
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
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(!privateChat?.disabled)
  }, [editor, privateChat?.disabled])
  const draftIdentity = useMemo(() => JSON.stringify({ text, mentions }), [text, mentions])
  useLayoutEffect(() => {
    if (
      !editor ||
      editor.isDestroyed ||
      JSON.stringify(draft(editor.getJSON())) === draftIdentity
    )
      return
    // Restored drafts/accepted sends are authoritative; do not echo them as user edits.
    editor.commands.setContent(content(text, mentions), { emitUpdate: false })
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
      className={`bot-group-input${privateChat ? " bot-private-input" : ""} ${privateChat?.className ?? ""}`}
      style={{ "--bot-group-placeholder": JSON.stringify(placeholder) } as CSSProperties}
    >
      {open && (
        <div id={id} role="listbox" aria-label={privateChat ? "提及 Bot、群或文件" : "提及群成员"} className="bot-mention-options">
          <div className="bot-mention-heading">提及</div>
          {!candidates.length && <p className="bot-mention-empty">{privateChat ? "没有匹配的 Bot、群或文件" : "没有匹配的群成员"}</p>}
          {candidates.map((candidate, index) => (
            <button
              key={candidate.key}
              id={`${id}-${index}`}
              type="button"
              role="option"
              ref={index === selectedIndex ? selectedRef : null}
              aria-selected={index === selectedIndex}
              disabled={Boolean(privateChat?.disabled) || (!candidate.file && !canChoose(candidate.name))}
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
              ) : candidate.file ? (
                <FileText size={24} />
              ) : (
                <Users size={24} />
              )}
              <span>{candidate.name}</span>
              <small>{candidate.file ? "文件" : candidate.groupId ? "群聊" : "Bot"}</small>
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

export function BotGroupMentionInput(props: InputProps<BotGroupMention>) {
  return <BotMentionInput {...props} />
}

export function BotPrivateMentionInput(props: InputProps<BotMessageMention> & { privateChat: PrivateInputOptions }) {
  return <BotMentionInput {...props} />
}
