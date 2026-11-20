import * as React from "react"
import { cn } from "@/lib/utils"

type ToggleThumbProps = React.ComponentPropsWithoutRef<"span">

const ToggleThumb = React.forwardRef<HTMLSpanElement, ToggleThumbProps>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      aria-hidden="true"
      {...props}
      className={cn(
        "pointer-events-none rounded-full border border-[#fff] bg-[#fff] shadow-sm transition-transform",
        className
      )}
    />
  )
)

ToggleThumb.displayName = "ToggleThumb"

export { ToggleThumb }
