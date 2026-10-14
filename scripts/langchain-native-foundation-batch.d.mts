export interface PreparedTarget {
  readonly absolutePath: string
  readonly relativePath: string
  readonly beforeBytes: Buffer | null
  readonly beforeSha256: string | null
  readonly afterBytes: Buffer
  readonly afterSha256: string
}

export interface PreparedEvidence {
  readonly absolutePath: string
  readonly bytes: Buffer
  readonly sha256: string
}

export interface PreparedPackagePlan {
  readonly name: "langchain" | "@langchain/core" | "@langchain/langgraph"
  readonly version: string
  readonly root: string
  readonly state: "before" | "base" | "after"
  readonly targets: readonly PreparedTarget[]
  readonly evidence: readonly PreparedEvidence[]
}

export interface PreparedInnerPlan {
  readonly packages: readonly [PreparedPackagePlan, PreparedPackagePlan]
  readonly evidence: readonly PreparedEvidence[]
}

export declare function installLangchainNativeFoundationBatch(options?: {
  workspaceRoot?: string
  checkOnly?: boolean
}): Promise<{ status: "installed" | "patched"; targets: 31 }>
