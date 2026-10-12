import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react"
import { closeHistory } from "@tiptap/pm/history"
import { AtSign, Sparkles, X } from "lucide-react"
import { botInlineReference } from "@/lib/bot-composer-document"
import { BotAvatar } from "./BotAvatar"
import { BotEntityIcon } from "./BotEntityReferences"

export function BotInlineReferenceView({ node, editor, getPos, selected }: NodeViewProps) {
  const result = botInlineReference.safeParse(node.attrs.reference)
  if (!result.success) return <NodeViewWrapper as="span" contentEditable={false} />
  const reference = result.data
  const bot = reference.kind === "bot" || reference.kind === "recipient"
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      className="bot-inline-reference"
      data-selected={selected || undefined}
      data-kind={reference.kind}
    >
      {bot ? (
        <BotAvatar agentId={reference.id} size="xs" isStatic />
      ) : reference.kind === "skill" ? (
        <Sparkles size={13} />
      ) : reference.kind === "everyone" ? (
        <AtSign size={13} />
      ) : (
        <BotEntityIcon kind={reference.kind} />
      )}
      <span className="bot-inline-reference-label">{reference.name}</span>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`移除${reference.kind === "skill" ? "技能" : "引用"} ${reference.name}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          const position = getPos()
          if (typeof position === "number")
            editor
              .chain()
              .focus()
              .command(({ tr }) => {
                closeHistory(tr)
                return true
              })
              .deleteRange({ from: position, to: position + node.nodeSize })
              .run()
        }}
      >
        <X size={11} />
      </button>
    </NodeViewWrapper>
  )
}
