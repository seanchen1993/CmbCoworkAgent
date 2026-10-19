import type { BusinessModCatalog } from "./business-mods"

/** A migration proposal is source material, never an installation or execution receipt. */
export interface PluginModularizationInspection {
  sourceName: string
  sourceDigest: string
  status: "already-modular" | "candidate" | "needs-authoring"
  runtime: "host" | "legacy" | "unknown"
  files: Array<{ path: string; digest: string; bytes: number }>
  excluded: string[]
  stages: Array<{ id: string; title: string; skill?: string; checks: number }>
  warnings: string[]
  blockers: Array<{ code: string; message: string; paths: string[] }>
  /** Present only when the static original contract can be retained without inference. */
  catalog?: BusinessModCatalog
  aliases?: Array<{ stageId: string; originalSkill: string; skill: string; name: string }>
  nextAction: "inspect-existing-mods" | "confirm-candidate" | "author-migration-plan"
}

export interface PluginModularizationConfirmation {
  sourceDigest: string
  confirmed: true
  /** Explicit authoring is required for packages without a statically recognized workflow. */
  catalog?: unknown
  modularizationFiles?: Array<{ path: string; text: string }>
}

export interface PluginModularizationStatus {
  requestId: string
  sourceDigest: string
  sourceName: string
  phase: "needs-confirmation" | "preparing" | "ready" | "failed" | "cancelled"
  summary: string
  resources: number
  mods: Array<{ id: string; title: string }>
  diagnostics: string[]
  canConfirm: boolean
  inspectionId?: string
  error?: string
}
