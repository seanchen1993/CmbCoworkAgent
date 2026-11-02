import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { AppErrorBoundary } from "../../src/renderer/src/components/app/AppErrorBoundary"
import { ModelSwitcher } from "../../src/renderer/src/components/chat/ModelSwitcher"
import { CustomModelDialog } from "../../src/renderer/src/components/chat/CustomModelDialog"
import { IDLE_MODEL_NOTICE } from "../../src/shared/model-catalog"
import * as store from "./model-switcher-store"

const root = createRoot(document.getElementById("root")!)
const idle = {
  id: "idle-ultra",
  ref: "builtin:idle-ultra" as const,
  source: "builtin" as const,
  origin: "local" as const,
  name: "闲时模型 Ultra",
  model: "ultra",
  baseUrl: "http://idle.example.test/pattern/llm/v1",
  hasApiKey: true,
  maxTokens: 128_000,
  maxOutputTokens: 8192,
  temperature: 0.1,
  topP: 0.95,
  topK: 40,
  notice: IDLE_MODEL_NOTICE,
  lockedFields: ["baseUrl", "model", "apiKey", "maxTokens"] as const
}
const fixture = {
  idleCatalog() {
    store.setModels([
      ...store.localModels,
      { ...idle, id: idle.ref, provider: "builtin", available: true }
    ])
  },
  showIdleSettings() {
    flushSync(() => root.render(null))
    root.render(<CustomModelDialog open selectedModelId={idle.ref} onOpenChange={() => {}} />)
  },
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
  api: {
    routing: { setMode: store.persistRoutingMode },
    models: {
      getBuiltinConfigs: async () => [idle],
      getCustomConfigs: async () => [],
      getDefault: async () => idle.ref,
      getTokenLimits: async () => ({
        defaultMaxTokens: 128_000,
        minMaxTokens: 32_000,
        maxMaxTokens: 1_000_000,
        defaultMaxOutputTokens: 8192,
        minMaxOutputTokens: 1,
        maxMaxOutputTokens: 100_000,
        defaultTemperature: 0.1,
        maxTemperature: 2,
        defaultTopP: 0.95,
        maxTopP: 1,
        defaultTopK: 40,
        minTopK: 0,
        maxTopK: 1000
      })
    }
  }
})
export type ModelSwitcherFixture = typeof fixture
