import { useId, useLayoutEffect, useRef, type ComponentPropsWithRef, type ReactNode } from "react"
import { Presence } from "@radix-ui/react-presence"
import { ChevronRight } from "lucide-react"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"

const tabLabels = { details: "详情", files: "资料库", members: "成员", computer: "电脑" }

export function BotDetailTabs({ label, tabs, onDetails }: {
  label: string
  tabs: (keyof typeof tabLabels)[]
  onDetails?(): void
}) {
  return (
    <TabsList className="bot-detail-tabs" aria-label={label}>
      {tabs.map(tab => (
        <TabsTrigger key={tab} value={tab} onClick={tab === "details" ? onDetails : undefined}>
          {tabLabels[tab]}
        </TabsTrigger>
      ))}
    </TabsList>
  )
}

export function BotDetailCard({
  title, label = title, count, actions, className = "", children
}: {
  title?: string
  label?: string
  count?: number
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`bot-detail-card ${className}`.trimEnd()} aria-label={label}>
      {title && (
        <header className="bot-detail-card-heading">
          <h3>{title}{count !== undefined && count > 0 && <span className="bot-detail-count">{count}</span>}</h3>
          {actions && <div className="bot-detail-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}

export function BotDetailRow({
  icon, label, description, trailing, ...props
}: ComponentPropsWithRef<"button"> & {
  icon: ReactNode
  label: string
  description?: string
  trailing?: ReactNode
}) {
  const descriptionId = useId()
  return (
    <button type="button" className="bot-detail-row" aria-label={label}
      aria-describedby={description ? descriptionId : undefined} {...props}>
      {icon}
      <span className="bot-detail-row-copy">
        <span>{label}</span>
        {description && <small id={descriptionId} title={description}>{description}</small>}
      </span>
      {trailing ?? <ChevronRight size={14} aria-hidden="true" />}
    </button>
  )
}

/** Reuse Radix's animation lifecycle; the existing workspace still owns open/tab/width state. */
export function BotDetailsPane({
  open,
  label,
  conversationId,
  children
}: {
  open: boolean
  label: string
  conversationId: string
  children: ReactNode
}) {
  const content = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = 0
  }, [conversationId, open])
  return (
    <aside
      className="bot-details"
      data-state={open ? "open" : "closed"}
      aria-label={label}
      aria-hidden={!open}
      inert={!open}
    >
      <Presence present={open}>
        <div ref={content} className="bot-details-content" data-state={open ? "open" : "closed"}>
          {children}
        </div>
      </Presence>
    </aside>
  )
}
