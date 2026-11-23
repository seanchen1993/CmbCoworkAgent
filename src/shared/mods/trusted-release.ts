export interface TrustedReleaseRef {
  publisherId: string
  listingId: string
  releaseId: string
}

export interface TrustedReleaseInstallReceipt extends TrustedReleaseRef {
  state: "installed-inactive"
  installationId: string
  packageSha256: string
  sourceDigest: string
  compiledDigest: string
}

export interface TrustedReleaseApi {
  available(): Promise<boolean>
  install(ref: TrustedReleaseRef): Promise<TrustedReleaseInstallReceipt | null>
  prepareUse(input: TrustedReleaseUseRequest): Promise<TrustedReleaseUseReport>
}

export interface TrustedReleaseUseRequest extends TrustedReleaseRef {
  installationId: string
  threadId: string
  expectedWorkspace: string
}

export interface TrustedReleaseUseReport {
  release: TrustedReleaseInstallReceipt
  target: { threadId: string; workspace: string }
  name: string
  version: string
  contentDigest: string
  state: "inactive"
}
