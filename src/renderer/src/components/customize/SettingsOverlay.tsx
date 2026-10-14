import { useRef, type ReactNode } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { SettingsReturnFocusContext } from "./settings-return-focus"

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
