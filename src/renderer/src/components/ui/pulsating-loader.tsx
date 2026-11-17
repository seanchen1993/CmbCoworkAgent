import { cn } from "@/lib/utils"

export function PulsatingDots({ className }: { className?: string }): React.JSX.Element {
  return (
    <span aria-hidden className={cn("inline-flex items-center gap-0.5", className)}>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="requirement-pulsating-dot size-1 rounded-full bg-current"
          style={{ animationDelay: `${index * 0.2}s` }}
        />
      ))}
    </span>
  )
}
