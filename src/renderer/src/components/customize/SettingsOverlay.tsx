import { useRef, type ReactNode } from "react"
import * as Dialog from "@radix-ui/react-dialog"

/** A full-page settings layer. The workspace underneath keeps its DOM and layout. */
export function SettingsOverlay({
  onClose,
  children
}: {
  onClose: () => void
  children: ReactNode
}): React.JSX.Element {
  const previousFocus = useRef(document.activeElement)

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
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const target = previousFocus.current
          if (target instanceof HTMLElement && target.isConnected) {
            target.focus({ preventScroll: true })
          }
        }}
      >
        <Dialog.Title className="sr-only">设置</Dialog.Title>
        {children}
      </Dialog.Content>
    </Dialog.Root>
  )
}
