import { decorateDesignNodes } from "../../../shared/design-node-ids"
import { ensureEditMode } from "../../../shared/design-legacy-edit-mode"
import { refreshDesignSnapshotRuntime } from "../../../shared/design-capture-runtime"

self.onmessage = (event: MessageEvent<string>) => {
  try {
    self.postMessage({ html: decorateDesignNodes(ensureEditMode(refreshDesignSnapshotRuntime(event.data))) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
