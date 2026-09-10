import { BrowserWindow } from "electron"
import type { HarnessWatchRef } from "../../shared/harness-board-types"
import { markHarnessStageAttributionDirty } from "../services/harness-stage-attribution"
import { HarnessWatchRefWorkerClient } from "./watch-ref-client"
import type { HarnessRunAttributionTarget } from "./watch-ref-protocol"

const client = new HarnessWatchRefWorkerClient({
  onChanged: (event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("harnessBoard:watchRefsChanged", {
        scopeKey: event.scopeKey,
        workspacePath: event.workspacePath,
        ref: event.ref,
        at: event.at
      })
    }
  },
  onDirty: (event) => {
    markHarnessStageAttributionDirty(
      event.attributionTarget.projectId,
      event.attributionTarget.featureSlug
    )
  }
})

export function startHarnessWatchRefs(
  scopeKey: string,
  workspacePath: string,
  refs: HarnessWatchRef[],
  attributionTarget?: HarnessRunAttributionTarget
): void {
  client.start(scopeKey, workspacePath, refs, attributionTarget)
}

export function stopHarnessWatchRefs(scopeKey: string): void {
  client.stop(scopeKey)
}

export function stopAllHarnessWatchRefs(): void {
  client.stopAll()
}

export function closeHarnessWatchRefWorker(): Promise<void> {
  return client.close()
}
