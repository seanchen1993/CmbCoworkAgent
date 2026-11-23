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
}
