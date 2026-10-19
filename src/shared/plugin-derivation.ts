export interface PluginDerivationScope {
  threadId: string
  expectedWorkspace: string
}

export interface PluginDerivationSource {
  pluginId: string
  name: string
  description: string
}

export interface PluginDerivationInspection {
  inspectionId: string
  sourceName: string
  suggestedName: string
  digest: string
  fileCount: number
  totalBytes: number
  excluded: string[]
  warnings: string[]
}

export interface PluginDerivationCopy {
  copyId: string
  name: string
  sourceName: string
  sourceDigest: string
  digest: string
  status: "created" | "changed" | "checked" | "installed"
  createdAt: string
  fileCount: number
  excluded: string[]
  warnings: string[]
  businessNotes: string
  pluginId?: string
  parentCopyId?: string
}

export interface PluginDerivationUpstream {
  state: "unchanged" | "changed" | "unavailable"
  inspection?: PluginDerivationInspection
}

export interface PluginDerivationProposal {
  proposalId: string
  copyId: string
  baseDigest: string
  summary: string
  files: Array<{ path: string; before: string; after: string }>
}

/** All paths, source ownership and family identity remain in the main process. */
export interface PluginDerivationApi {
  prepareFlowComposition(
    input: PluginDerivationScope & {
      copyId: string
      expectedDigest: string
      requestId: string
    }
  ): Promise<PluginDerivationProposal>
  revise(
    input: PluginDerivationScope & { copyId: string; requestId: string }
  ): Promise<PluginDerivationCopy>
  inspectUpstream(
    input: PluginDerivationScope & { copyId: string; prepare?: boolean }
  ): Promise<PluginDerivationUpstream>
  prepareNodeComposition(
    input: PluginDerivationScope & {
      copyId: string
      expectedDigest: string
      requestId: string
    }
  ): Promise<PluginDerivationProposal>
  propose(
    input: PluginDerivationScope & {
      copyId: string
      expectedDigest: string
      instruction: string
      requestId: string
    }
  ): Promise<PluginDerivationProposal>
  applyProposal(
    input: PluginDerivationScope & { proposalId: string }
  ): Promise<PluginDerivationCopy>
  cancelProposal(
    input: PluginDerivationScope & {
      requestId?: string
      proposalId?: string
    }
  ): Promise<void>
  sources(scope: PluginDerivationScope): Promise<PluginDerivationSource[]>
  inspect(
    input: PluginDerivationScope & { pluginId?: string }
  ): Promise<PluginDerivationInspection | null>
  create(
    input: PluginDerivationScope & {
      inspectionId: string
      name: string
      requestId: string
    }
  ): Promise<PluginDerivationCopy>
  list(scope: PluginDerivationScope): Promise<PluginDerivationCopy[]>
  get(input: PluginDerivationScope & { copyId: string }): Promise<PluginDerivationCopy>
  saveNotes(
    input: PluginDerivationScope & {
      copyId: string
      businessNotes: string
      expectedDigest: string
    }
  ): Promise<PluginDerivationCopy>
  listEditableFiles(input: PluginDerivationScope & { copyId: string }): Promise<string[]>
  readFile(
    input: PluginDerivationScope & { copyId: string; path: string }
  ): Promise<{ path: string; text: string; digest: string }>
  saveFile(
    input: PluginDerivationScope & {
      copyId: string
      path: string
      text: string
      expectedDigest: string
    }
  ): Promise<PluginDerivationCopy>
  check(input: PluginDerivationScope & { copyId: string }): Promise<PluginDerivationCopy>
  install(
    input: PluginDerivationScope & {
      copyId: string
      expectedDigest: string
    }
  ): Promise<PluginDerivationCopy>
  openSource(input: PluginDerivationScope & { copyId: string }): Promise<void>
}
