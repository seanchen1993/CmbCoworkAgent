import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react"
import { DialogContent } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/** Keep Radix focus, dismissal and portal behavior shared with the rest of Cmb. */
export const BotDialogContent = forwardRef<
  ElementRef<typeof DialogContent>,
  ComponentPropsWithoutRef<typeof DialogContent>
>(({ className, ...props }, ref) => (
  <DialogContent ref={ref} className={cn("bot-dialog", className)} {...props} />
))
BotDialogContent.displayName = "BotDialogContent"
