import { useRef, type ReactNode } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { ArrowLeft, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SettingsReturnFocusContext } from "./settings-return-focus"

export function SettingsBackButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-2 px-0"
      aria-label="返回应用"
      onClick={onClick}
    >
      <span className="flex h-7 w-9 items-center justify-center">
        <ArrowLeft className="size-6" strokeWidth={1} />
      </span>
      <span className="text-base font-bold">返回应用</span>
    </Button>
  )
}

/** Keep navigation available while the settings module loads, without mounting its editors. */
export function SettingsLoadingShell({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background sm:flex-row">
      <div className="flex max-h-[35%] shrink-0 flex-col border-b border-border sm:max-h-none sm:w-[200px] sm:border-b-0 sm:border-r">
        <div className="flex items-center gap-2 p-3">
          <SettingsBackButton onClick={onClose} />
        </div>
        <div aria-hidden="true" className="space-y-4 px-5 py-3">
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-3 w-32 animate-pulse rounded bg-muted" />
          <div className="h-3 w-28 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div role="status" className="flex min-h-0 flex-1 items-center justify-center gap-3 p-6">
        <Loader2 aria-hidden="true" className="size-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">正在打开自定义助手，可随时返回应用。</p>
      </div>
    </div>
  )
}

/** A full-page settings layer. The workspace underneath keeps its DOM and layout. */
export function SettingsOverlay({
  onClose,
  children
}: {
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const previousFocus = useRef(document.activeElement)
  const returnToComposer = useRef(false)

  return (
    <Dialog.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Content
        className="absolute inset-0 z-[70] flex flex-col overflow-hidden bg-background outline-none"
        aria-describedby={undefined}
        data-cmb-modal-dialog="true"
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          // Radix sees Escape during document capture, before the tour's React handler.
          // Let the inner tour close first so retained settings drafts stay mounted.
          if (event.target instanceof Element && event.target.closest("[data-sparks-tour-open]"))
            event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnToComposer.current) {
            returnToComposer.current = false
            const composer = document.querySelector<HTMLTextAreaElement>(
              "textarea.composer-textarea"
            )
            if (composer && !composer.closest("[inert], [aria-hidden='true']")) {
              composer.focus({ preventScroll: true })
              return
            }
          }
          const target = previousFocus.current
          if (target instanceof HTMLElement && target.isConnected) {
            target.focus({ preventScroll: true })
          }
        }}
      >
        <Dialog.Title className="sr-only">设置</Dialog.Title>
        <SettingsReturnFocusContext.Provider
          value={() => {
            returnToComposer.current = true
          }}
        >
          {children}
        </SettingsReturnFocusContext.Provider>
      </Dialog.Content>
    </Dialog.Root>
  )
}
