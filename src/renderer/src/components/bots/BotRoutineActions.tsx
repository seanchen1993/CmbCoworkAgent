import * as Menu from "@radix-ui/react-dropdown-menu"
import { useRef, type ReactElement, type ReactNode } from "react"
import {
  Eye,
  FlaskConical,
  History,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Trash2,
  Webhook
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from "@/components/ui/context-menu"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import type { BotRoutine } from "../../../../shared/bot-types"
import { BotRoutineRunControl } from "./BotRoutineRunButton"
import { useBotWorkItemVisibility } from "@/lib/use-bot-work-item-visibility"
import { useBotRoutineRun } from "@/lib/use-bot-routine-run"
import { routineToggleLabel } from "@/lib/bot-routine-presentation"

/** Both entry points use the owner's actions. A menu never starts a task on mount:
 * the receipt-aware controller stays mounted outside the disposable menu. */
export function BotRoutineActions({
  routine,
  dataEpoch,
  busy,
  mutationDisabled = busy,
  readinessSupport = false,
  view,
  edit,
  editInChat,
  history,
  webhook,
  remove,
  toggle,
  inlineRun = false,
  children
}: {
  routine: BotRoutine
  dataEpoch?: string
  busy: boolean
  mutationDisabled?: boolean
  readinessSupport?: boolean
  view?(): void
  edit?(): void
  editInChat?(): void
  history?(): void
  webhook?(): void
  remove?(): void
  toggle(): void
  inlineRun?: boolean
  children(more: ReactNode, run: ReactNode): ReactElement
}) {
  const restoreFocus = useRef<HTMLElement | null>(null)
  const focusHandoff = useRef(false)
  const keyboardOpen = useRef(false)
  const currentEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch)
  const managed = useBotWorkspaceStore(
    (state) =>
      state.snapshot?.primaryBot?.checkIn?.routineId === routine.id &&
      state.snapshot.primaryBot.checkIn.botId === routine.botId
  )
  const needsSetup = readinessSupport && routine.effectiveState === "needs_setup"
  const effectiveEnabled = routine.enabled && !needsSetup
  const runDisabled = mutationDisabled || !dataEpoch || dataEpoch !== currentEpoch || needsSetup
  const { ref: observeRoutine, visible: runVisible } = useBotWorkItemVisibility()
  const control = useBotRoutineRun({
    routine,
    dataEpoch: dataEpoch ?? "initial",
    disabled: runDisabled,
    visible: runVisible
  })
  // A pre-existing uncertain request can still be reconciled; a managed Main
  // routine never receives a fresh manual Test entry.
  const showRun = !managed || Boolean(control.pending || control.blocked || control.busy)
  const runControl = showRun ? <BotRoutineRunControl control={control} /> : null
  const actions = [
    ...(view ? [{ id: "view", label: "查看详情", Icon: Eye, disabled: busy, run: view }] : []),
    {
      id: "toggle",
      label: routineToggleLabel(routine, readinessSupport),
      Icon: effectiveEnabled ? Pause : Play,
      disabled: mutationDisabled,
      run: toggle
    },
    ...(!managed
      ? [
          {
            id: "run",
            label: control.label,
            Icon: FlaskConical,
            disabled: control.buttonDisabled,
            run: () => void control.submit()
          }
        ]
      : []),
    ...(editInChat
      ? [
          {
            id: "chat",
            label: "对话调整",
            Icon: MessageSquare,
            disabled: mutationDisabled,
            run: editInChat
          }
        ]
      : []),
    ...(edit
      ? [{ id: "edit", label: "编辑设置", Icon: Pencil, disabled: mutationDisabled, run: edit }]
      : []),
    ...(history
      ? [{ id: "history", label: "运行记录", Icon: History, disabled: busy, run: history }]
      : []),
    ...(webhook
      ? [
          {
            id: "webhook",
            label: "配置 Webhook",
            Icon: Webhook,
            disabled: mutationDisabled,
            run: webhook
          }
        ]
      : []),
    ...(remove
      ? [{ id: "delete", label: "删除例程", Icon: Trash2, disabled: mutationDisabled, run: remove }]
      : [])
  ]
  const select = (action: (typeof actions)[number]) => {
    if (action.disabled) return
    focusHandoff.current = !["toggle", "run"].includes(action.id)
    action.run()
  }
  const menuItems = (kind: "context" | "dropdown") => {
    const Item = kind === "context" ? ContextMenuItem : Menu.Item
    const Separator = kind === "context" ? ContextMenuSeparator : Menu.Separator
    return actions.map((action) => (
      <div key={action.id}>
        {action.id === "delete" && <Separator />}
        <Item
          disabled={action.disabled}
          className={action.id === "delete" ? "text-destructive" : undefined}
          onSelect={() => select(action)}
        >
          <action.Icon size={15} aria-hidden="true" />
          {action.label}
        </Item>
      </div>
    ))
  }
  const closeMenu = (event: Event) => {
    if (focusHandoff.current) {
      event.preventDefault()
      focusHandoff.current = false
      return
    }
    if (!restoreFocus.current?.isConnected || restoreFocus.current.closest("[inert]")) return
    event.preventDefault()
    const active = document.activeElement
    // Closing an older menu must not steal focus from a newer menu or dialog.
    if (
      active === document.body ||
      active === restoreFocus.current ||
      (event.target instanceof Element && event.target.contains(active))
    )
      restoreFocus.current.focus({ preventScroll: true })
  }
  const more = (
    <Menu.Root
      modal={false}
      onOpenChange={(open) => {
        if (open)
          restoreFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
      }}
    >
      <Menu.Trigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 shrink-0 rounded-full"
          aria-label={`例程 ${routine.name} 的更多操作`}
          title="更多操作"
          disabled={busy}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="bot-more-menu"
          align="end"
          sideOffset={6}
          aria-label={`例程 ${routine.name} 的操作`}
          aria-labelledby={undefined}
          onCloseAutoFocus={closeMenu}
        >
          {menuItems("dropdown")}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
  return (
    <>
      <ContextMenu modal={false}>
        <ContextMenuTrigger
          asChild
          ref={observeRoutine}
          onContextMenu={(event) => {
            if (keyboardOpen.current) {
              keyboardOpen.current = false
              return
            }
            const origin =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>("button,[tabindex]")
                : null
            restoreFocus.current =
              origin && event.currentTarget.contains(origin) ? origin : event.currentTarget
          }}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return
            event.preventDefault()
            event.stopPropagation()
            const bounds = event.currentTarget.getBoundingClientRect()
            restoreFocus.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null
            keyboardOpen.current = true
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + Math.min(bounds.width / 2, 80),
                clientY: bounds.top + bounds.height / 2
              })
            )
          }}
        >
          {children(more, runControl)}
        </ContextMenuTrigger>
        <ContextMenuContent
          className="bot-more-menu"
          aria-label={`例程 ${routine.name} 的操作`}
          onCloseAutoFocus={closeMenu}
        >
          {menuItems("context")}
        </ContextMenuContent>
      </ContextMenu>
      {!inlineRun && showRun && <BotRoutineRunControl control={control} feedbackOnly />}
    </>
  )
}
