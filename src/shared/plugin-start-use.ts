import type { PluginDerivationScope } from "./plugin-derivation"

export interface PluginStartUseIdentity {
  pluginId: string
  name: string
  version: string
  digest: string
}

export interface PluginStartUseInput extends PluginDerivationScope {
  pluginId: string
  expected: { name: string; version: string; digest?: string }
}

export interface PluginStartUseIssue {
  code: "configuration" | "knowledge" | "dependency" | "permission" | "runtime"
  message: string
  resolution: "plugin-settings" | "project-form" | "chat-settings"
}

/** This report authorizes no execution. The destination repeats its native admission checks. */
export interface PluginStartUseReport {
  identity: PluginStartUseIdentity
  kind: "host-project" | "plugin-project" | "chat"
  canOpen: boolean
  activationRequired?: boolean
  issues: PluginStartUseIssue[]
  chat?: {
    functionMod?: import("./mods/v2/commands").FunctionPluginStatus
    skills: Array<{ id: string; name: string; description: string }>
  }
}

export type PreparePluginStartUse = (input: PluginStartUseInput) => Promise<PluginStartUseReport>
