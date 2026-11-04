import { DesignView } from "./DesignView"

/** DesignView owns navigation between design history, creation, and the editor. */
export function DesignModeEntryView({
  initialScreen = "restore",
  onListVisibilityChange
}: {
  initialScreen?: "gallery" | "restore"
  onListVisibilityChange?: (visible: boolean) => void
}): React.JSX.Element {
  return (
    <DesignView initialScreen={initialScreen} onListVisibilityChange={onListVisibilityChange} />
  )
}
