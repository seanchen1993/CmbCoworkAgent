import { Megaphone } from "lucide-react"
import { cn } from "@/lib/utils"

interface UpdateStatusCardProps {
  hasUpdate: boolean
  onClick: () => void
}

export function UpdateStatusCard({
  hasUpdate,
  onClick
}: UpdateStatusCardProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      type="button"
      className={cn(
        "group relative w-full rounded-xl px-4 py-3.5 text-left transition-all duration-300 ease-out hover:shadow-lg hover:scale-[1.01] active:scale-[0.99] backdrop-blur-sm",
        hasUpdate
          ? "border-red-400/60 bg-gradient-to-br from-red-50/90 to-red-100/70 hover:border-red-500 hover:from-red-100 hover:to-red-150/80 shadow-red-100/50"
          : "border border-border/70 bg-background/90 hover:bg-accent/35 hover:border-border transition-colors"
      )}
    >
      <div className="flex items-center gap-3.5">
        <div
          className={cn(
            "rounded-lg border p-1 transition-all duration-300 shadow-sm group-hover:shadow-md",
            hasUpdate
              ? "bg-red-100 text-red-600 border-red-200 group-hover:bg-red-200 group-hover:text-red-700 group-hover:shadow-red-200/50"
              : "rounded-md border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors"
          )}
        >
          <Megaphone size={14} className="drop-shadow-sm" />
        </div>
        <div className="flex-1 min-w-0">
          <div
            className={cn(
              "text-sm font-semibold leading-5 transition-colors duration-200",
              hasUpdate && "text-red-700"
            )}
          >
            {hasUpdate ? "发现新版本！" : "检测版本"}
          </div>
        </div>
        {hasUpdate && (
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse shadow-sm"></div>
          </div>
        )}
      </div>

      <div
        className={cn(
          "absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none",
          hasUpdate
            ? "bg-gradient-to-br from-red-400/8 via-transparent to-red-500/6"
            : "bg-gradient-to-br from-blue-400/8 via-transparent to-indigo-500/6"
        )}
      ></div>

      <div
        className={cn(
          "absolute inset-0 rounded-xl opacity-0 group-hover:opacity-30 transition-opacity duration-300 pointer-events-none border blur-sm",
          hasUpdate ? "border-red-300" : "border-blue-300"
        )}
      ></div>
    </button>
  )
}
