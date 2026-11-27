import { DesignMarketPanel } from "./DesignMarketPanel"

export function DesignMarketOverlay({
  open,
  initialSystemId,
  selectedLocalSystemId,
  onClose,
  onAssetsChanged
}: {
  open: boolean
  initialSystemId?: string | null
  selectedLocalSystemId?: string | null
  onClose: () => void
  onAssetsChanged: () => void
}): React.JSX.Element | null {
  if (!open) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="设计市场浮层"
      className="fixed inset-0 z-50 flex flex-col bg-background"
    >
      <DesignMarketPanel
        mode="overlay"
        initialSystemId={initialSystemId}
        selectedLocalSystemId={selectedLocalSystemId}
        onClose={onClose}
        onAssetsChanged={onAssetsChanged}
      />
    </div>
  )
}
