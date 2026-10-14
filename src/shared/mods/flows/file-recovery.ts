import type {
  FlowPromptDependencies,
  FlowPromptRuntimeSettledCapture,
  FlowPromptRecoveryEvidence
} from "./prompt-recovery"

/** A retained SQLite namespace, not a path or permission to publish into the user's project. */
export interface FlowFileNamespace {
  schemaVersion: 1
  treeId: string
  initialRoot: string
  originDigest: string
}

export interface FlowFileDependencies extends Omit<
  FlowPromptDependencies,
  "profile" | "coverage" | "runtimeProtocol" | "priorProjection"
> {
  profile: "workspace-files-v1"
  coverage: "prompt-prior-and-virtual-root"
  runtimeProtocol: "flow-files-runtime-v1"
  priorProjection: "files-prior-v1"
  virtualInput: { version: 1; root: string; originDigest: string }
}

/** Digest summaries of actual private file capability capture; never provider-supplied evidence. */
export interface FlowFileTreeCapture {
  schemaVersion: 1
  treeId: string
  inputRoot: string
  finalRoot: string
  originDigest: string
  readDependencyDigest: string
  effectLedgerDigest: string
  fileCallLedgerDigest: string
  fileCalls: number
  effectIds: readonly string[]
}

export interface FlowFileRuntimeSettledCapture extends Omit<
  FlowPromptRuntimeSettledCapture,
  "dependencies"
> {
  dependencies: FlowFileDependencies
  virtualTree: FlowFileTreeCapture
}

export interface FlowFileRecoveryEvidence extends Omit<
  FlowPromptRecoveryEvidence,
  "dependencies" | "evidenceKind"
> {
  evidenceKind: "flow-resumable-files-execution"
  dependencies: FlowFileDependencies
  virtualTree: FlowFileTreeCapture
}
