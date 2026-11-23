import {
  readTrustedReleasePackageManifest,
  TRUSTED_RELEASE_PACKAGE_MAX_BYTES,
  type TrustedReleasePackageManifest
} from "./trusted-release-package"
import type { TrustedReleaseRef } from "../../../shared/mods/trusted-release"
export type { TrustedReleaseRef } from "../../../shared/mods/trusted-release"

export interface TrustedPublicationTarget {
  readonly publisherId: string
  readonly listingId: string
}

export interface TrustedReleaseMetadata extends TrustedReleaseRef {
  readonly package: TrustedReleasePackageManifest
}

/** A main-process adapter must bind all three calls to the same authenticated session. */
export interface TrustedReleaseSession {
  readonly accountId: string
  /** Must reject previous generations, including switching from A to B and back to A. */
  isCurrent(): boolean
  /** Returns the authenticated account, the exact target and an explicit canPublish decision. */
  authorizePublication(target: TrustedPublicationTarget, signal?: AbortSignal): Promise<unknown>
  /** Returns the authenticated account, immutable release metadata and canDownload. */
  resolveRelease(ref: TrustedReleaseRef, signal?: AbortSignal): Promise<unknown>
  /** Returns the same ref, authenticated account, packageSha256 and bounded bytes. */
  downloadRelease(ref: TrustedReleaseRef, signal?: AbortSignal): Promise<unknown>
}

type CaptureSession = () => TrustedReleaseSession | undefined

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("TRUSTED_RELEASE_IDENTITY_INVALID")
  return value as Record<string, unknown>
}

function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,127}$/.test(value))
    throw Error("TRUSTED_RELEASE_IDENTITY_INVALID")
  return value
}

function readTarget(input: unknown): TrustedPublicationTarget {
  const value = record(input)
  return Object.freeze({
    publisherId: identity(value.publisherId),
    listingId: identity(value.listingId)
  })
}

function readRef(input: unknown): TrustedReleaseRef {
  const value = record(input)
  return Object.freeze({ ...readTarget(value), releaseId: identity(value.releaseId) })
}

function assertTarget(
  receipt: Record<string, unknown>,
  accountId: string,
  target: TrustedPublicationTarget
): void {
  if (
    receipt.accountId !== accountId ||
    receipt.publisherId !== target.publisherId ||
    receipt.listingId !== target.listingId
  )
    throw Error("TRUSTED_RELEASE_IDENTITY_MISMATCH")
}

async function callAdapter<T>(assertCurrent: () => void, call: () => Promise<T>): Promise<T> {
  let result: T
  try {
    result = await call()
  } catch {
    assertCurrent()
    // The adapter may use credentials or signed URLs. Its exceptions stay in main.
    throw Error("TRUSTED_RELEASE_AUTHORITY_REQUEST_FAILED")
  }
  assertCurrent()
  return result
}

/** Accept only identity evidence from a configured main-process authority. */
export class TrustedReleaseAuthority {
  constructor(private readonly captureSession?: CaptureSession) {}

  get available(): boolean {
    return this.captureSession !== undefined
  }

  async authorizePublication(input: unknown, signal?: AbortSignal):
    Promise<TrustedPublicationTarget & { assertCurrent(): void }> {
    const target = readTarget(input)
    const { session, accountId, assertCurrent } = this.session(signal)
    const receipt = record(await callAdapter(assertCurrent, () =>
      session.authorizePublication(target, signal)))
    assertTarget(receipt, accountId, target)
    if (receipt.canPublish !== true) throw Error("TRUSTED_RELEASE_PUBLICATION_DENIED")
    return Object.freeze({ ...target, assertCurrent })
  }

  /** Package decoding still verifies these bytes against the authenticated manifest. */
  async download(input: unknown, signal?: AbortSignal): Promise<{
    readonly release: TrustedReleaseMetadata
    readonly bytes: Uint8Array
    assertCurrent(): void
  }> {
    const { ref, session, accountId, release, assertCurrent } = await this.resolve(input, signal)
    const downloaded = record(await callAdapter(assertCurrent, () => session.downloadRelease(ref, signal)))
    assertTarget(downloaded, accountId, ref)
    if (downloaded.releaseId !== ref.releaseId || downloaded.packageSha256 !== release.package.packageSha256)
      throw Error("TRUSTED_RELEASE_IDENTITY_MISMATCH")
    const bytes = downloaded.bytes
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > TRUSTED_RELEASE_PACKAGE_MAX_BYTES
    )
      throw Error("TRUSTED_RELEASE_PACKAGE_DOWNLOAD_INVALID")
    return Object.freeze({ release, bytes: Uint8Array.from(bytes), assertCurrent })
  }

  async inspect(input: unknown, signal?: AbortSignal) {
    const { release, assertCurrent } = await this.resolve(input, signal)
    return { release, assertCurrent }
  }

  private async resolve(input: unknown, signal?: AbortSignal) {
    const ref = readRef(input)
    const { session, accountId, assertCurrent } = this.session(signal)
    const receipt = record(await callAdapter(assertCurrent, () => session.resolveRelease(ref, signal)))
    assertTarget(receipt, accountId, ref)
    if (receipt.releaseId !== ref.releaseId) throw Error("TRUSTED_RELEASE_IDENTITY_MISMATCH")
    if (receipt.canDownload !== true) throw Error("TRUSTED_RELEASE_DOWNLOAD_DENIED")
    const manifest = readTrustedReleasePackageManifest(receipt.package)
    const release = Object.freeze({ ...ref, package: manifest })
    return { ref, session, accountId, release, assertCurrent }
  }

  private session(signal?: AbortSignal) {
    if (!this.captureSession) throw Error("TRUSTED_RELEASE_AUTHORITY_UNAVAILABLE")
    let session: TrustedReleaseSession | undefined
    try {
      session = this.captureSession()
    } catch {
      throw Error("TRUSTED_RELEASE_AUTHORITY_UNAVAILABLE")
    }
    if (!session) throw Error("TRUSTED_RELEASE_ACCOUNT_REQUIRED")
    const currentSession = session
    const accountId = identity(currentSession.accountId)
    const assertCurrent = () => {
      if (signal?.aborted) throw Error("TRUSTED_RELEASE_CANCELLED")
      let current = false
      try {
        current = currentSession.accountId === accountId && currentSession.isCurrent() === true
      } catch {
        // Fail closed if the host no longer has a current session.
      }
      if (!current) throw Error("TRUSTED_RELEASE_ACCOUNT_CHANGED")
    }
    assertCurrent()
    return { session: currentSession, accountId, assertCurrent }
  }
}
