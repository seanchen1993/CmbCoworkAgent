import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { AppErrorBoundary } from "../../src/renderer/src/components/app/AppErrorBoundary"
import { ModelSwitcher } from "../../src/renderer/src/components/chat/ModelSwitcher"
import { CustomModelDialog } from "../../src/renderer/src/components/chat/CustomModelDialog"
import { IDLE_MODEL_OUTSIDE_HOURS_MESSAGE } from "../../src/shared/idle-model-service-window"
import {
  IDLE_MODEL_NOTICE,
  IDLE_MODEL_SAP_REQUIRED_MESSAGE,
  IDLE_MODEL_UAT_NOTICE,
  IDLE_ULTRA_MODEL_MAX_TOKENS,
  MAODOU_PRO_MODEL_DEFAULT_MAX_TOKENS,
  isModelAvailable,
  isModelSelectable
} from "../../src/shared/model-catalog"
import * as store from "./model-switcher-store"

const root = createRoot(document.getElementById("root")!)
let gatewayStatus: "open" | "closed" | "missing-sap" = "open"
let useUat = false
const modelChangeListeners = new Set<() => void>()
const settingsWrites = { names: [] as string[], defaults: [] as string[], maxTokens: [] as number[] }
const pro = {
  id: "idle-ultra",
  ref: "builtin:idle-ultra" as const,
  source: "builtin" as const,
  origin: "local" as const,
  name: "码豆模型PRO",
  model: "pro",
  baseUrl: "http://idle.example.test/pattern/llm/v1",
  hasApiKey: true,
  maxTokens: MAODOU_PRO_MODEL_DEFAULT_MAX_TOKENS,
  maxOutputTokens: 8192,
  temperature: 0.1,
  topP: 0.95,
  topK: 40
}
const ultra = {
  ...pro,
  id: "maodou-ultra",
  ref: "builtin:maodou-ultra" as const,
  name: "闲时模型 Ultra",
  model: "ultra",
  maxTokens: IDLE_ULTRA_MODEL_MAX_TOKENS
}
const gatewayModels = [pro, ultra]

function gatewayUnavailableReason(model: string): string | undefined {
  if (gatewayStatus === "missing-sap") return IDLE_MODEL_SAP_REQUIRED_MESSAGE
  if (model === "ultra" && gatewayStatus === "closed" && !useUat) return IDLE_MODEL_OUTSIDE_HOURS_MESSAGE
}

function gatewayNotice(model: string): string | undefined {
  if (useUat) return IDLE_MODEL_UAT_NOTICE
  if (model === "ultra") return IDLE_MODEL_NOTICE
}

const fixture = {
  idleCatalog(status: "open" | "closed" | "missing-sap" = "open") {
    gatewayStatus = status
    store.setModels([
      ...store.localModels,
      ...gatewayModels.map((item) => {
        const config = {
          apiKey: "test-key",
          transport: "idle-gateway" as const,
          unavailableReason: gatewayUnavailableReason(item.model)
        }
        return {
          ...item,
          id: item.ref,
          provider: "builtin",
          available: isModelAvailable(config),
          selectable: isModelSelectable(config),
          notice: gatewayNotice(item.model),
          unavailableReason: config.unavailableReason
        }
      })
    ])
    for (const listener of modelChangeListeners) listener()
  },
  showGatewaySettings(model: "pro" | "ultra", uat = false) {
    useUat = uat
    flushSync(() => root.render(null))
    const selectedModelId = model === "ultra" ? ultra.ref : pro.ref
    root.render(<CustomModelDialog open selectedModelId={selectedModelId} onOpenChange={() => {}} />)
  },
  mount(
    metadata: Record<string, unknown>,
    ready = true,
    initialModel = "",
    routingMode: "auto" | "pinned" = "pinned",
    threadId = "imported"
  ) {
    flushSync(() => root.render(null))
    store.reset(metadata, ready, initialModel, routingMode, threadId)
    root.render(
      <AppErrorBoundary>
        <ModelSwitcher threadId={threadId} />
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
      getBuiltinConfigs: async () =>
        gatewayModels.map((item) => ({
          ...item,
          lockedFields: ["baseUrl", "model", "apiKey", "name", ...(item.model === "ultra" ? ["maxTokens"] : [])],
          notice: gatewayNotice(item.model),
          unavailableReason: gatewayUnavailableReason(item.model)
        })),
      getCustomConfigs: async () => [],
      getDefault: async () => pro.ref,
      updateBuiltinConfig: async (_id: string, config: { name?: string; maxTokens: number }) => {
        if (config.name !== undefined) settingsWrites.names.push(config.name)
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
