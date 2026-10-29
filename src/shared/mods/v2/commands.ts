export interface FunctionCommand {
  name: string
  description: string
  argumentHint?: string
  immediate?: true
  isHidden?: true
  plugin: string
}

export interface FunctionCommandDescriptor extends FunctionCommand {
  digest: string
  epoch: number
}

export interface FunctionPluginStatus {
  pluginId: string
  name: string
  digest?: string
  state: "disabled" | "needs-approval" | "ready" | "invalid"
  error?: string
  capabilities: string[]
}
