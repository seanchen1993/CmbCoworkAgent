import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { AppErrorBoundary } from "../../src/renderer/src/components/app/AppErrorBoundary"
import { ModelSwitcher } from "../../src/renderer/src/components/chat/ModelSwitcher"
import * as store from "./model-switcher-store"

const root = createRoot(document.getElementById("root")!)
const fixture = {
  mount(
    metadata: Record<string, unknown>,
    ready = true,
    initialModel = "",
    routingMode: "auto" | "pinned" = "pinned"
  ) {
    flushSync(() => root.render(null))
    store.reset(metadata, ready, initialModel, routingMode)
    root.render(
      <AppErrorBoundary>
        <ModelSwitcher threadId="imported" />
      </AppErrorBoundary>
    )
  },
  read: store.readSelection,
  routingWrites: store.readRoutingWrites,
  metadata: store.setMetadata,
  catalog: (ready: boolean, empty = false) => store.setModels(empty ? [] : store.localModels, ready)
}

Object.assign(window, {
  modelSwitcherFixture: fixture,
  api: { routing: { setMode: store.persistRoutingMode } }
})
export type ModelSwitcherFixture = typeof fixture
