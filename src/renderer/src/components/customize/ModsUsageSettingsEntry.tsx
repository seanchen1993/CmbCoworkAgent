import { Settings2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"

/** Navigation only: opening settings never enables or approves a plugin. */
export function ModsUsageSettingsEntry({ disabled = false }: { disabled?: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={() => useAppStore.getState().setShowCustomizeView(true, "mods", "installed")}
    >
      <Settings2 className="size-3.5" />
      插件
    </Button>
  )
}
