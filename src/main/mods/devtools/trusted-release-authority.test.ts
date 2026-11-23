import { describe, expect, it, vi } from "vitest"
import {
  TrustedReleaseAuthority,
  type TrustedReleaseSession
} from "./trusted-release-authority"
import { TRUSTED_RELEASE_PACKAGE_MAX_BYTES } from "./trusted-release-package"

const ref = {
  publisherId: "publisher-verified",
  listingId: "listing-imaging",
  releaseId: "release-73"
}
const target = { publisherId: ref.publisherId, listingId: ref.listingId }
const accountId = "authenticated-account"
const packageSha256 = "a".repeat(64)

function fixture() {
  let account = accountId
  let generation = 0
  const bytes = Uint8Array.of(1, 2, 3)
  const publishedPackage = {
    packageSha256,
    sourceDigest: "b".repeat(64),
    compiledDigest: "c".repeat(64),
    files: [{ path: "plugin.json", digest: "d".repeat(64), bytes: 3 }]
  }
  const catalog = { ...ref, accountId, canDownload: true, package: publishedPackage }
  const download = { ...ref, accountId, packageSha256, bytes }
  const authorizePublication = vi.fn(async (): Promise<unknown> => ({
    ...target, accountId, canPublish: true
  }))
  const resolveRelease = vi.fn(async (): Promise<unknown> => catalog)
  const downloadRelease = vi.fn(async (): Promise<unknown> => download)
  const captureSession = (): TrustedReleaseSession => {
    const capturedGeneration = generation
    return {
      accountId: account,
      isCurrent: () => generation === capturedGeneration,
      authorizePublication,
      resolveRelease,
      downloadRelease
    }
  }
  const switchAccount = (next: string) => {
    account = next
    generation++
  }
  return {
    authority: new TrustedReleaseAuthority(captureSession),
    authorizePublication,
    resolveRelease,
    downloadRelease,
    switchAccount,
    publishedPackage,
    catalog,
    download,
    bytes
  }
}

describe("trusted release authority", () => {
  it("fails closed without a main authority or a current authenticated session", async () => {
    const missing = new TrustedReleaseAuthority()
    const unavailable = new TrustedReleaseAuthority(() => undefined)

    expect(missing.available).toBe(false)
    await expect(missing.authorizePublication(target))
      .rejects.toThrow("TRUSTED_RELEASE_AUTHORITY_UNAVAILABLE")
    await expect(missing.download(ref)).rejects.toThrow("TRUSTED_RELEASE_AUTHORITY_UNAVAILABLE")
    await expect(unavailable.download(ref)).rejects.toThrow("TRUSTED_RELEASE_ACCOUNT_REQUIRED")
  })

  it("binds a publication authorization to the main account, publisher and listing", async () => {
    const f = fixture()
    const verified = await f.authority.authorizePublication({
      ...target, accountId: "renderer-supplied", canPublish: true
    })
    expect(verified).toEqual({ ...target, assertCurrent: expect.any(Function) })
    expect(f.authorizePublication).toHaveBeenCalledWith(target, undefined)
    f.switchAccount("other-user")
    expect(verified.assertCurrent).toThrow("TRUSTED_RELEASE_ACCOUNT_CHANGED")
  })

  it.each([
    { field: "publisherId", changed: "other-publisher" },
    { field: "listingId", changed: "other-listing" },
    { field: "accountId", changed: "other-account" }
  ])("rejects a publication response for the wrong $field", async ({ field, changed }) => {
    const f = fixture()
    f.authorizePublication.mockResolvedValueOnce({ ...target, accountId, canPublish: true, [field]: changed })

    await expect(f.authority.authorizePublication(target))
      .rejects.toThrow("TRUSTED_RELEASE_IDENTITY_MISMATCH")
  })

  it("requires explicit publication authorization from the main session", async () => {
    const f = fixture()
    f.authorizePublication.mockResolvedValueOnce({ ...target, accountId, canPublish: false })

    await expect(f.authority.authorizePublication({ ...target, canPublish: true }))
      .rejects.toThrow("TRUSTED_RELEASE_PUBLICATION_DENIED")
  })

  it("accepts immutable release metadata and bounded bytes from the session only", async () => {
    const f = fixture()
    const received = await f.authority.download({
      ...ref,
      url: "https://renderer.invalid/arbitrary",
      package: { packageSha256: "z".repeat(64) },
      bytes: [0]
    })
    expect(f.resolveRelease).toHaveBeenCalledWith(ref, undefined)
    expect(f.downloadRelease).toHaveBeenCalledWith(ref, undefined)
    expect(received.release).toEqual({ ...ref, package: f.publishedPackage })
    f.publishedPackage.files[0].path = "later-changed.json"
    f.bytes[0] = 255
    expect(received.release.package.files[0].path).toBe("plugin.json")
    expect(received.bytes).toEqual(Uint8Array.of(1, 2, 3))
  })

  it.each([
    { field: "publisherId", changed: "other-publisher" },
    { field: "listingId", changed: "other-listing" },
    { field: "releaseId", changed: "other-release" },
    { field: "accountId", changed: "other-account" }
  ])("refuses to download metadata for the wrong $field", async ({ field, changed }) => {
    const f = fixture()
    f.resolveRelease.mockResolvedValueOnce({ ...f.catalog, [field]: changed })

    await expect(f.authority.download(ref)).rejects.toThrow("TRUSTED_RELEASE_IDENTITY_MISMATCH")
    expect(f.downloadRelease).not.toHaveBeenCalled()
  })

  it("prevents downloading when the catalog declines access", async () => {
    const f = fixture()
    f.resolveRelease.mockResolvedValueOnce({ ...f.catalog, canDownload: false })

    await expect(f.authority.download(ref)).rejects.toThrow("TRUSTED_RELEASE_DOWNLOAD_DENIED")
    expect(f.downloadRelease).not.toHaveBeenCalled()
  })

  it("refuses wrong identifiers or a malformed manifest before fetching package bytes", async () => {
    const f = fixture()
    await expect(f.authority.download({ ...ref, releaseId: "../elsewhere" }))
      .rejects.toThrow("TRUSTED_RELEASE_IDENTITY_INVALID")
    expect(f.resolveRelease).not.toHaveBeenCalled()

    f.resolveRelease.mockResolvedValueOnce({ ...f.catalog, package: { packageSha256 } })
    await expect(f.authority.download(ref)).rejects.toThrow("TRUSTED_RELEASE_PACKAGE_MANIFEST")
    expect(f.downloadRelease).not.toHaveBeenCalled()
  })

  it.each([
    { field: "publisherId", changed: "other-publisher" },
    { field: "listingId", changed: "other-listing" },
    { field: "releaseId", changed: "other-release" },
    { field: "accountId", changed: "other-account" },
    { field: "packageSha256", changed: "f".repeat(64) }
  ])("rejects download bytes with a mismatched $field", async ({ field, changed }) => {
    const f = fixture()
    f.downloadRelease.mockResolvedValueOnce({ ...f.download, [field]: changed })

    await expect(f.authority.download(ref)).rejects.toThrow("TRUSTED_RELEASE_IDENTITY_MISMATCH")
  })

  it("rejects a switched account before starting the download, even if A becomes current again", async () => {
    const f = fixture()
    f.resolveRelease.mockImplementationOnce(async () => {
      f.switchAccount("other-account")
      f.switchAccount(accountId)
      return f.catalog
    })

    await expect(f.authority.download(ref)).rejects.toThrow("TRUSTED_RELEASE_ACCOUNT_CHANGED")
    expect(f.downloadRelease).not.toHaveBeenCalled()
  })

  it("rejects bytes if the account changes during the download", async () => {
    const f = fixture()
    f.downloadRelease.mockImplementationOnce(async () => {
      f.switchAccount("other-account")
      return f.download
    })

    await expect(f.authority.download(ref)).rejects.toThrow("TRUSTED_RELEASE_ACCOUNT_CHANGED")
  })

  it("exposes an account-current check for the durable installation boundary", async () => {
    const f = fixture()
    const result = await f.authority.download(ref)
    expect(result.assertCurrent).not.toThrow()
    f.switchAccount(accountId)
    expect(result.assertCurrent).toThrow("TRUSTED_RELEASE_ACCOUNT_CHANGED")
  })

  it("rejects non-binary, empty and oversized download bodies", async () => {
    const f = fixture()
    for (const bytes of [[], new Uint8Array(0), new Uint8Array(TRUSTED_RELEASE_PACKAGE_MAX_BYTES + 1)]) {
      f.downloadRelease.mockResolvedValueOnce({ ...f.download, bytes })
      await expect(f.authority.download(ref)).rejects.toThrow("TRUSTED_RELEASE_PACKAGE_DOWNLOAD_INVALID")
    }
  })

  it("keeps transport error credentials out of the caller's error", async () => {
    const f = fixture()
    f.downloadRelease.mockRejectedValueOnce(Error("Authorization: Bearer private-test-credential"))

    await expect(f.authority.download(ref)).rejects.toThrow(/^TRUSTED_RELEASE_AUTHORITY_REQUEST_FAILED$/)
  })

  it("does not give a receipt when the renderer request ends during download", async () => {
    const f = fixture()
    const controller = new AbortController()
    f.downloadRelease.mockImplementationOnce(async () => {
      controller.abort()
      throw Error("fetch aborted")
    })

    await expect(f.authority.download(ref, controller.signal)).rejects.toThrow("TRUSTED_RELEASE_CANCELLED")
  })
})
