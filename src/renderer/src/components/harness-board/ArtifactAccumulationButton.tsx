import { Archive, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

interface ArtifactAccumulationButtonProps {
  disabled: boolean
  creating: boolean
  onClick: () => void
}

export function ArtifactAccumulationButton({
  disabled,
  creating,
  onClick
}: ArtifactAccumulationButtonProps): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="w-[160px] gap-2 text-sm font-medium"
      disabled={disabled || creating}
      onClick={onClick}
    >
      {creating ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}
      发起产物同步
    </Button>
  )
}
