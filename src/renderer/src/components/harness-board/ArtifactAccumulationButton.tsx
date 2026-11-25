import { FolderSync, Loader2 } from "lucide-react"
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
      disabled={disabled || creating}
      onClick={onClick}
    >
      {creating ? <Loader2 className="size-4 animate-spin" /> : <FolderSync className="size-4" />}
      产物同步
    </Button>
  )
}
