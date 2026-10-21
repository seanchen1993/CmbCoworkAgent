import type { BusinessModCatalog } from "./business-mods"

export interface PluginStateControlAudit {
  schemaVersion: 1
  authority: "existing-host" | "original-plugin-writer" | "unidentified-original"
  migration: "not-required-for-host" | "not-migrated"
  functionExtensions: "present-unverified" | "not-detected"
  graph: "existing-host-contract" | "author-confirmation-required"
  execution: "unverified"
  sources: {
    writerCandidates: string[]
    hooks: string[]
    configuration: string[]
    knowledge: string[]
    functionEntries: string[]
  }
  sourcePathsTruncated: boolean
  next: { tool: "mod_authoring"; action: "scaffold"; kind: "state-extension" }
}

/** A migration proposal is source material, never an installation or execution receipt. */
export interface PluginModularizationInspection {
  sourceName: string
  sourceDigest: string
  status: "already-modular" | "candidate" | "needs-authoring"
  runtime: "host" | "legacy" | "unknown"
  /** Static evidence only: business assembly metadata does not prove executable state migration. */
  stateControl: PluginStateControlAudit
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
