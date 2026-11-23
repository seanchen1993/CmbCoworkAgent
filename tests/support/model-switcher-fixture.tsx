import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { AppErrorBoundary } from "../../src/renderer/src/components/app/AppErrorBoundary"
import { ModelSwitcher } from "../../src/renderer/src/components/chat/ModelSwitcher"
import { CustomModelDialog } from "../../src/renderer/src/components/chat/CustomModelDialog"
import {
  IDLE_MODEL_SAP_REQUIRED_MESSAGE,
  IDLE_MODEL_UAT_NOTICE
} from "../../src/shared/model-catalog"
import * as store from "./model-switcher-store"

const root = createRoot(document.getElementById("root")!)
let idleAvailable = true
let useUat = false
const modelChangeListeners = new Set<() => void>()
const settingsWrites = { names: [] as string[], defaults: [] as string[], maxTokens: [] as number[] }
const idle = {
  id: "idle-ultra",
  ref: "builtin:idle-ultra" as const,
  source: "builtin" as const,
  origin: "local" as const,
  name: "码豆模型PRO",
  model: "pro",
  baseUrl: "http://idle.example.test/pattern/llm/v1",
  hasApiKey: true,
  maxTokens: 128_000,
  maxOutputTokens: 8192,
  temperature: 0.1,
  topP: 0.95,
  topK: 40
}
const fixture = {
  idleCatalog(available = true) {
    idleAvailable = available
    store.setModels([
      ...store.localModels,
      {
        ...idle,
        id: idle.ref,
        provider: "builtin",
        available,
        selectable: available,
        unavailableReason: available ? undefined : IDLE_MODEL_SAP_REQUIRED_MESSAGE
      }
    ])
    for (const listener of modelChangeListeners) listener()
  },
  showIdleSettings(uat = false) {
    useUat = uat
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
  readSettingsWrites: () => settingsWrites,
  routingWrites: store.readRoutingWrites,
  metadata: store.setMetadata,
  catalog: (ready: boolean, empty = false) => store.setModels(empty ? [] : store.localModels, ready)
}

Object.assign(window, {
  modelSwitcherFixture: fixture,
  api: {
    routing: { setMode: store.persistRoutingMode },
    models: {
      onChanged: (listener: () => void) => {
        modelChangeListeners.add(listener)
        return () => { modelChangeListeners.delete(listener) }
      },
      getBuiltinConfigs: async () => [
        {
          ...idle,
          lockedFields: ["baseUrl", "model", "apiKey", ...(useUat ? [] : ["maxTokens"])],
          notice: useUat ? IDLE_MODEL_UAT_NOTICE : undefined,
          unavailableReason: idleAvailable ? undefined : IDLE_MODEL_SAP_REQUIRED_MESSAGE
        }
      ],
      getCustomConfigs: async () => [],
      getDefault: async () => idle.ref,
      updateBuiltinConfig: async (_id: string, config: { name: string; maxTokens: number }) => {
        settingsWrites.names.push(config.name)
        settingsWrites.maxTokens.push(config.maxTokens)
      },
      setDefault: async (id: string) => {
        settingsWrites.defaults.push(id)
      },
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
