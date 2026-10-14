import type { FunctionConfigValue } from "./config"

export type SensitiveFunctionUserConfigAction =
  | { operation: "set"; value: FunctionConfigValue }
  | { operation: "clear" }

export interface FunctionUserConfigView {
  pluginId: string
  plugin: string
  digest: string
  workspace: string
  savedRevision: number
  effectiveRevision?: number
  state: "inactive" | "applied" | "pending" | "failed" | "stopped"
  error?: string
  fields: Array<{
    key: string
    label: string
    description: string
    type: "string" | "boolean" | "number" | "directory" | "file"
    supported: boolean
    required: boolean
    multiple?: boolean
    sensitive?: boolean
    secretState?: "saved" | "default" | "unset" | "unavailable" | "invalid" | "changed"
    effectiveConfigured?: boolean
    options?: string[]
    min?: number
    max?: number
    value?: FunctionConfigValue
    effectiveValue?: FunctionConfigValue
  }>
}
