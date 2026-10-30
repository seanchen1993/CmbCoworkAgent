import { useMemo } from "react"
import { useAppNotifications } from "./app-notifications"
import { projectHarnessNotification, type HarnessNotification } from "../../../shared/harness-notifications"
export { refreshAppNotifications } from "./app-notifications"
export function useHarnessNotifications(): HarnessNotification[] {
  const values = useAppNotifications()
  return useMemo(() => values.flatMap((value) => {
    const projected = projectHarnessNotification(value)
    return projected ? [projected] : []
  }), [values])
}
