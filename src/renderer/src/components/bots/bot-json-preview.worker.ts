import { JsonPreviewSession, type JsonPreviewRequest } from "@/lib/bot-json-preview"

const session = new JsonPreviewSession()
self.onmessage = (event: MessageEvent<JsonPreviewRequest>) => {
  try {
    self.postMessage(session.update(event.data))
  } catch {
    self.postMessage({ status: "source" })
  }
}
