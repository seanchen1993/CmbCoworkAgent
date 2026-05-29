import type { IpcMain } from "electron"
import { isFeatureGateEnabled } from "../feature-gates"
import type { FeatureGateCheckOptions, FeatureGateKey } from "../../shared/feature-gates"

export function registerFeatureGateHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    "featureGates:isEnabled",
    async (_event, name: FeatureGateKey, options?: FeatureGateCheckOptions) =>
      isFeatureGateEnabled(name, options)
  )
}
