import type { ComponentProps, ReactNode } from "react"
import { cn } from "@/lib/utils"

export function ManagedRunRadioOption({
  children,
  checked,
  disabled,
  ...props
}: Omit<ComponentProps<"input">, "type" | "className" | "children" | "checked"> & {
  checked: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <label
      className={cn(
        "inline-flex min-h-9 items-center gap-2 whitespace-nowrap text-sm",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      )}
    >
      <input
        {...props}
        type="radio"
        checked={checked}
        disabled={disabled}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-full border bg-background peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
          checked ? "border-primary" : "border-muted-foreground/60"
        )}
      >
        <span className={cn("size-1.5 rounded-full bg-primary", !checked && "invisible")} />
      </span>
      {children}
    </label>
  )
}
