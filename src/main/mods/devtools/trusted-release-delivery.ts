import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { compileFunctionPlugin } from "../v2/loader"
import type { AuthoringSourceBundle } from "./authoring-bundle"
import { TrustedReleaseAuthority, type TrustedReleaseMetadata } from "./trusted-release-authority"
import { TrustedReleaseInstaller } from "./trusted-release-install"
import {
  assertTrustedReleaseCompiledDigest, readTrustedReleasePackage,
  readTrustedReleasePackageIdentity,
  type TrustedReleasePackageManifest
} from "./trusted-release-package"

export interface TrustedReleaseReview {
  release: TrustedReleaseMetadata
  name: string
  version: string
  description: string
}

export async function writeReleaseCandidate(
  path: string,
  prepared: TrustedReleasePackageManifest & { bytes: Buffer }
): Promise<void> {
  const { bytes, ...manifest } = prepared
  const zip = new AdmZip()
  zip.addFile("release.json", Buffer.from(JSON.stringify({ schemaVersion: 1, package: manifest }, null, 2)))
  zip.addFile("plugin.zip", bytes)
  await writeFile(path, zip.toBuffer(), { flag: "wx", mode: 0o600 })
}

export async function compileTrustedReleaseSource(
  source: AuthoringSourceBundle,
  assertCurrent: () => void
) {
  const parent = resolve(tmpdir())
  const directory = resolve(await mkdtemp(join(parent, "cmb-trusted-release-")))
  if (dirname(directory) !== parent || !basename(directory).startsWith("cmb-trusted-release-"))
    throw Error("TRUSTED_RELEASE_TEMP_DIRECTORY")
  try {
    for (const file of source.files) {
      assertCurrent()
      const target = join(directory, file.path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.text, { encoding: "utf8", flag: "wx", mode: 0o600 })
    }
    const compiled = await compileFunctionPlugin(directory, { captureSources: false, portablePaths: true })
    assertCurrent()
    return { name: compiled.name, digest: compiled.digest }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3 })
  }
}

export class TrustedReleaseDelivery {
  constructor(
    private readonly authority: TrustedReleaseAuthority,
    private readonly installer: TrustedReleaseInstaller
  ) {}

  get available(): boolean {
    return this.authority.available
  }

  recover(): Promise<void> {
    return this.installer.recover()
  }

  async install(
    ref: unknown,
    scope: { signal: AbortSignal; assertCurrent(): void },
    confirm: (review: TrustedReleaseReview) => Promise<boolean>
  ) {
    scope.assertCurrent()
    const download = await this.authority.download(ref, scope.signal)
    const assertCurrent = () => {
      scope.assertCurrent()
      download.assertCurrent()
    }
    assertCurrent()
    const { release } = download
    const source = readTrustedReleasePackage(Buffer.from(download.bytes), release.package)
    const { name, version, description } = readTrustedReleasePackageIdentity(source)
    const compiled = await compileTrustedReleaseSource(source, assertCurrent)
    assertTrustedReleaseCompiledDigest(compiled.digest, release.package.compiledDigest)
    if (compiled.name !== name)
      throw Error("TRUSTED_RELEASE_PACKAGE_IDENTITY_MISMATCH")
    assertCurrent()
    const confirmed = await confirm({ release, name, version, description })
    assertCurrent()
    if (!confirmed) return null
    return this.installer.install({
      publisherId: release.publisherId,
      listingId: release.listingId,
      releaseId: release.releaseId,
      packageSha256: release.package.packageSha256,
      compiledDigest: release.package.compiledDigest,
      sourceDigest: release.package.sourceDigest,
      source, name, version, description
    }, assertCurrent)
  }
}
