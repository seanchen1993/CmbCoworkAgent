interface ChatMessageCountProps {
  count: number
}

export function ChatMessageCount({ count }: ChatMessageCountProps): React.JSX.Element {
  return (
    <span className="text-[11px] text-muted-foreground" title="当前会话消息数量" aria-live="polite">
      消息 {count.toLocaleString()} 条
    </span>
  )
}
