import { decorateDesignNodes } from "../../../shared/design-node-ids"
import { ensureEditMode } from "../../../shared/design-legacy-edit-mode"

self.onmessage = (event: MessageEvent<string>) => {
  try {
    self.postMessage({ html: decorateDesignNodes(ensureEditMode(event.data)) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
