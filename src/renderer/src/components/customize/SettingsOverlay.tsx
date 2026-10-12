import { useRef, type ReactNode } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { cn } from "@/lib/utils"

/** Settings preserve the workspace underneath, with a floating variant for Bots. */
export function SettingsOverlay({
  onClose,
  children,
  floating = false
}: {
  onClose: () => void
  children: ReactNode
  floating?: boolean
}): React.JSX.Element {
  const previousFocus = useRef(document.activeElement)

  return (
    <Dialog.Root
      open
      modal={floating}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <div
        className={cn(
          "absolute inset-0 z-[70] flex items-center justify-center",
          floating && "bg-black/40 md:p-6"
        )}
      >
        <Dialog.Content
          className={cn(
            "relative flex h-full w-full flex-col overflow-hidden bg-background outline-none",
            floating &&
              "md:max-h-[820px] md:max-w-[1120px] md:rounded-2xl md:border md:border-border/70 md:shadow-2xl"
          )}
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
      </div>
    </Dialog.Root>
  )
}
