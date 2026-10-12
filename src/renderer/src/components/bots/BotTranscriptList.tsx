import {
  forwardRef,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type RefObject
} from "react"
import { Virtuoso, type VirtuosoHandle, type FlatIndexLocationWithAlign } from "react-virtuoso"
import type { BotMessage } from "../../../../shared/bot-types"
import { reconcileBotVirtualWindow, type BotVirtualWindow } from "@/lib/bot-virtual-window"

// Cmb's ChatMessageVirtualList uses this measured-row boundary: child margins
// must stay inside the item box, otherwise virtual offsets drift during paging.
const MeasuredList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={`[&>[data-item-index]]:flow-root ${className ?? ""}`} {...props} />
  )
)
MeasuredList.displayName = "BotMeasuredTranscriptList"
const components = { List: MeasuredList }

export function BotTranscriptList({
  viewId,
  messages,
  scrollParent,
  listRef,
  initialLocation,
  onRowsRendered,
  onHeightChanged,
  renderMessage
}: {
  viewId: string
  messages: BotMessage[]
  scrollParent: HTMLDivElement | null
  listRef: RefObject<VirtuosoHandle | null>
  initialLocation?: FlatIndexLocationWithAlign
  onRowsRendered(): void
  onHeightChanged(): void
  renderMessage(message: BotMessage, index: number): ReactNode
}) {
  const [window, setWindow] = useState<BotVirtualWindow>(() =>
    reconcileBotVirtualWindow(null, viewId, messages)
  )
  const lastRows = useRef("")
  if (window.viewId !== viewId || window.messages !== messages) {
    setWindow(reconcileBotVirtualWindow(window, viewId, messages))
    return null
  }
  if (!scrollParent || !messages.length) return null
  return (
    <Virtuoso
      key={`${viewId}:${window.generation}`}
      ref={listRef}
      data={messages}
      firstItemIndex={window.firstItemIndex}
      customScrollParent={scrollParent}
      initialTopMostItemIndex={initialLocation ?? { index: "LAST", align: "end" }}
      defaultItemHeight={112}
      increaseViewportBy={{ top: 400, bottom: 600 }}
      followOutput={false}
      computeItemKey={(_index, message) => message.id}
      components={components}
      itemsRendered={(rows) => {
        const key = `${viewId}:${window.generation}:${rows[0]?.data?.id}:${rows.at(-1)?.data?.id}:${rows.length}`
        if (lastRows.current === key) return
        lastRows.current = key
        onRowsRendered()
      }}
      totalListHeightChanged={onHeightChanged}
      itemContent={(index, message) => renderMessage(message, index - window.firstItemIndex)}
    />
  )
}
