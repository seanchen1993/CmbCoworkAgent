import { useMemo } from "react"
import { List, type RowComponentProps } from "react-window"
import { cn } from "@/lib/utils"

export interface VirtualListProps<Item> {
  items: readonly Item[]
  itemHeight: number
  renderItem: (item: Item, index: number) => React.ReactNode
  className?: string
  listClassName?: string
  maxHeight?: number
  overscanCount?: number
}

interface VirtualListRowProps<Item> {
  items: readonly Item[]
  renderItem: (item: Item, index: number) => React.ReactNode
}

const DEFAULT_MAX_HEIGHT = 700
const DEFAULT_OVERSCAN_COUNT = 16

export function VirtualList<Item>({
  items,
  itemHeight,
  renderItem,
  className,
  listClassName,
  maxHeight = DEFAULT_MAX_HEIGHT,
  overscanCount = DEFAULT_OVERSCAN_COUNT
}: VirtualListProps<Item>): React.JSX.Element {
  const listHeight = Math.min(items.length * itemHeight, maxHeight)
  const rowProps = useMemo(() => ({ items, renderItem }), [items, renderItem])

  function Row({
    ariaAttributes,
    index,
    style,
    items,
    renderItem
  }: RowComponentProps<VirtualListRowProps<Item>>): React.JSX.Element {
    return (
      <div style={style} {...ariaAttributes}>
        {renderItem(items[index], index)}
      </div>
    )
  }

  return (
    <div className={cn("flex-1 min-h-0", className)}>
      <List
        className={listClassName}
        defaultHeight={listHeight}
        overscanCount={overscanCount}
        rowComponent={Row}
        rowCount={items.length}
        rowHeight={itemHeight}
        rowProps={rowProps}
        style={{ height: listHeight, width: "100%", maxHeight: "100%" }}
      />
    </div>
  )
}
