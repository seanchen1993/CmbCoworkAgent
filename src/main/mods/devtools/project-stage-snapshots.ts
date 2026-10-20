import { readBoundedProjectFiles, isSensitiveProjectFilePath,
  type ProjectFileInventory } from "../../harness-board/project-runtime/bounded-project-files"
import { randomUUID } from "node:crypto"
import { mkdirSync, readdirSync } from "node:fs"
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type {
  HostProjectOperation,
  HostProjectState
} from "../../../shared/project-runtime/host-types"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import {
  parseHostOperation,
  parseHostProjectState
} from "../../harness-board/project-runtime/host-state-protocol"
import {
  capturePackageMetadataGuard,
  HOST_PACKAGE_LIMITS
} from "../../harness-board/project-runtime/package-snapshots"
import {
  readRuntimeScopedFile,
  runtimeDigest,
  runtimeDirectory,
  runtimeDirectoryIdentity,
  runtimeRelativePath
} from "../../harness-board/project-runtime/safe-files"
import {
  readRuntimeScopedFileAsync,
  runtimeDirectoryAsync
} from "../../harness-board/project-runtime/safe-files-async"

export const PROJECT_STAGE_SNAPSHOT_LIMITS = {
  ...HOST_PACKAGE_LIMITS,
  metadataBytes: 2 * 1024 * 1024
}
interface SnapshotFile {
  path: string
  digest: string
  bytes: number
  executable: boolean
}
export interface StageInputSnapshot {
  schemaVersion: 1
  /** Content identity of the complete metadata, including file hashes. Never an execution grant. */
  id: string
  nonce: string
  createdAt: number
  scopeKey: string
  project: HostProjectState
  operation: HostProjectOperation
  stageId: string
  sourceRoot: string
  sourceDigest: string
  sourceDeclarationDigest: string
  inputIdentity: string
  workspaceIdentity: string
  files: SnapshotFile[]
  directories: string[]
  totalBytes: number
}
interface CaptureInput {
  scopeKey: string
  project: HostProjectState
  operation: HostProjectOperation
  sourceRoot: string
  inputIdentity: string
  guard(): void
  signal?: AbortSignal
}
function fail(code: string): never {
  throw Error(`PROJECT_STAGE_SNAPSHOT_${code}`)
}
const digestPattern = /^[a-f0-9]{64}$/
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
const sensitive = isSensitiveProjectFilePath
function text(value: unknown, max = 4096): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex -- Native scope identities must remain unambiguous.
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    fail("IDENTITY_INVALID")
}
function overlaps(left: string, right: string): boolean {
  const contained = (parent: string, child: string) => {
    const path = relative(parent, child)
    return (
      !path ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"))
    )
  }
  return contained(left, right) || contained(right, left)
}
function bind(project: HostProjectState, operation: HostProjectOperation) {
  const stage = project.manifest.stages[project.stageIndex]
  if (
    project.status !== "active" ||
    !stage ||
    operation.projectId !== project.projectId ||
    operation.expectedVersion !== project.version ||
    operation.stageId !== stage.id ||
    operation.pluginDigest !== project.pluginDigest ||
    operation.cancelRequestedAt !== null ||
    !["prepared", "started"].includes(operation.status) ||
    operation.receipts.length ||
    operation.execution?.terminal
  )
    fail("OPERATION_CHANGED")
}
function metadataIdentity(snapshot: Omit<StageInputSnapshot, "id">): string {
  return runtimeDigest(JSON.stringify(snapshot))
}

/** Main-only, bounded workspace snapshots. Full package validation belongs to the caller's
 * original Host guard; this service neither copies package source nor grants execution authority.
 * Private metadata/config-context identities must not be exported as plugin source or model text.
 */
export class ProjectStageSnapshots {
  private readonly root: string
  private readonly rootIdentity: string
  private capturing = false
  private readonly restoring = new Set<string>()
  constructor(root: string) {
    if (!isAbsolute(root)) fail("STORE_PATH_INVALID")
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.root = runtimeDirectory(root)
    this.rootIdentity = runtimeDirectoryIdentity(this.root)
  }
  private assertRoot() {
    if (runtimeDirectoryIdentity(this.root) !== this.rootIdentity) fail("STORE_CHANGED")
  }
  private capacity() {
    this.assertRoot()
    const entries = readdirSync(this.root, { withFileTypes: true })
    if (entries.some((entry) => !entry.isDirectory() || !digestPattern.test(entry.name)))
      fail("STORE_CHANGED")
    if (entries.length >= PROJECT_STAGE_SNAPSHOT_LIMITS.snapshots) fail("CAPACITY")
  }
  private sourceDeclaration(sourceRoot: string, project: HostProjectState) {
    const source = readRuntimeScopedFile(sourceRoot, "devclaw.project-runtime.json", 256 * 1024)
    if (!source.bytes) fail("SOURCE_MISSING")
    const manifest = parseProjectRuntimeManifest(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes))
    )
    if (!same(manifest, project.manifest)) fail("SOURCE_CHANGED")
    return runtimeDigest(source.bytes)
  }
  async capture(input: CaptureInput): Promise<StageInputSnapshot> {
    input.guard()
    input.signal?.throwIfAborted()
    text(input.scopeKey)
    text(input.inputIdentity)
    if (this.capturing) fail("BUSY")
    this.capacity()
    const project = parseHostProjectState(structuredClone(input.project))
    const operation = parseHostOperation(structuredClone(input.operation))
    bind(project, operation)
    const workspace = runtimeDirectory(project.workspace)
    const sourceRoot = runtimeDirectory(input.sourceRoot)
    if (
      overlaps(workspace, this.root) ||
      overlaps(workspace, sourceRoot) ||
      overlaps(sourceRoot, this.root)
    )
      fail("SCOPE_OVERLAP")
    const guardWorkspace = capturePackageMetadataGuard(workspace)
    const guardSource = capturePackageMetadataGuard(sourceRoot)
    const sourceDeclarationDigest = this.sourceDeclaration(sourceRoot, project)
    const guard = () => {
      input.signal?.throwIfAborted()
      input.guard()
      this.assertRoot()
    }
    const stable = () => {
      guard()
      guardWorkspace()
      guardSource()
    }
    this.capturing = true
    let created: string | undefined
    try {
      const files: SnapshotFile[] = []
      const buffers: Buffer[] = []
      const directories: string[] = []
      let totalBytes = 0
      const walk = async (base: string, depth: number) => {
        guard()
        if (depth > PROJECT_STAGE_SNAPSHOT_LIMITS.depth) fail("LIMIT")
        const directory = base ? join(workspace, base) : workspace
        await runtimeDirectoryAsync(directory)
        guard()
        const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
          left.name.localeCompare(right.name, "en")
        )
        guard()
        const names = new Set<string>()
        for (const entry of entries) {
          guard()
          const path = base ? `${base}/${entry.name}` : entry.name
          runtimeRelativePath(path)
          if (names.has(entry.name.toLowerCase())) fail("PATH_COLLISION")
          names.add(entry.name.toLowerCase())
          if (sensitive(path)) fail("SENSITIVE_PATH")
          const stat = await lstat(join(workspace, path))
          guard()
          if (stat.isSymbolicLink()) fail("UNSAFE_FILE")
          if (stat.isDirectory()) {
            if (directories.length >= PROJECT_STAGE_SNAPSHOT_LIMITS.directories) fail("LIMIT")
            directories.push(path)
            await walk(path, depth + 1)
          } else {
            if (!stat.isFile() || stat.nlink !== 1) fail("UNSAFE_FILE")
            if (
              files.length >= PROJECT_STAGE_SNAPSHOT_LIMITS.files ||
              stat.size > PROJECT_STAGE_SNAPSHOT_LIMITS.fileBytes ||
              totalBytes + stat.size > PROJECT_STAGE_SNAPSHOT_LIMITS.totalBytes
            )
              fail("LIMIT")
            const observed = await readRuntimeScopedFileAsync(
              workspace,
              path,
              PROJECT_STAGE_SNAPSHOT_LIMITS.fileBytes,
              input.signal
            )
            guard()
            if (!observed.bytes) fail("FILE_MISSING")
            totalBytes += observed.bytes.length
            if (totalBytes > PROJECT_STAGE_SNAPSHOT_LIMITS.totalBytes) fail("LIMIT")
            files.push({
              path,
              digest: runtimeDigest(observed.bytes),
              bytes: observed.bytes.length,
              executable: Boolean(stat.mode & 0o111)
            })
            buffers.push(observed.bytes)
          }
        }
      }
      await walk("", 0)
      stable()
      const metadata: Omit<StageInputSnapshot, "id"> = {
        schemaVersion: 1,
        nonce: randomUUID(),
        createdAt: Date.now(),
        scopeKey: input.scopeKey,
        project,
        operation,
        stageId: operation.stageId,
        sourceRoot,
        sourceDigest: project.pluginDigest,
        sourceDeclarationDigest,
        inputIdentity: input.inputIdentity,
        workspaceIdentity: runtimeDirectoryIdentity(workspace),
        files,
        directories,
        totalBytes
      }
      const id = metadataIdentity(metadata)
      const snapshot: StageInputSnapshot = { ...metadata, id }
      const encoded = Buffer.from(JSON.stringify(snapshot))
      if (encoded.length > PROJECT_STAGE_SNAPSHOT_LIMITS.metadataBytes) fail("LIMIT")
      stable()
      const destination = join(this.root, id)
      await mkdir(destination, { mode: 0o700 })
      created = destination
      stable()
      await mkdir(join(destination, "files"), { mode: 0o700 })
      for (const directory of directories) {
        guard()
        await mkdir(join(destination, "files", directory), { mode: 0o700 })
      }
      for (let index = 0; index < files.length; index++) {
        guard()
        await this.writeNew(
          join(destination, "files", files[index].path),
          buffers[index],
          files[index].executable,
          guard
        )
      }
      stable()
      await this.writeNew(join(destination, "snapshot.json"), encoded, false, guard)
      stable()
      return structuredClone(snapshot)
    } catch (error) {
      if (created) {
        try {
          this.assertRoot()
          await rm(created, { recursive: true, force: true })
        } catch {
          /* A changed store cannot be safely cleaned; preserve the original error. */
        }
      }
      throw error
    } finally {
      this.capturing = false
    }
  }
  /** Readback validates the immutable manifest identity. Execution must use materialize, which
   * rechecks every stored file and directory before admitting any restored workspace.
   */
  read(id: string, scopeKey: string): StageInputSnapshot {
    this.assertRoot()
    if (!digestPattern.test(id)) fail("ID_INVALID")
    text(scopeKey)
    const file = readRuntimeScopedFile(
      this.root,
      `${id}/snapshot.json`,
      PROJECT_STAGE_SNAPSHOT_LIMITS.metadataBytes
    )
    if (!file.bytes) fail("MISSING")
    const entries = readdirSync(runtimeDirectory(join(this.root, id))).sort()
    if (!same(entries, ["files", "snapshot.json"])) fail("FILES_CHANGED")
    let value: StageInputSnapshot
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("METADATA_INVALID")
    } catch {
      fail("METADATA_INVALID")
    }
    const { id: recorded, ...metadata } = value!
    if (
      recorded !== id ||
      metadataIdentity(metadata) !== id ||
      value!.scopeKey !== scopeKey ||
      value!.schemaVersion !== 1
    )
      fail("METADATA_CHANGED")
    const project = parseHostProjectState(value!.project)
    const operation = parseHostOperation(value!.operation)
    bind(project, operation)
    if (
      value!.stageId !== operation.stageId ||
      value!.sourceDigest !== project.pluginDigest ||
      !digestPattern.test(value!.sourceDeclarationDigest) ||
      !Array.isArray(value!.files) ||
      !Array.isArray(value!.directories) ||
      value!.files.length > PROJECT_STAGE_SNAPSHOT_LIMITS.files ||
      value!.directories.length > PROJECT_STAGE_SNAPSHOT_LIMITS.directories ||
      !Number.isSafeInteger(value!.totalBytes) ||
      value!.totalBytes < 0 ||
      value!.totalBytes > PROJECT_STAGE_SNAPSHOT_LIMITS.totalBytes
    )
      fail("METADATA_INVALID")
    const paths = new Set<string>()
    let total = 0
    for (const path of value!.directories) {
      runtimeRelativePath(path)
      if (sensitive(path) || paths.has(path.toLowerCase())) fail("METADATA_INVALID")
      paths.add(path.toLowerCase())
    }
    for (const entry of value!.files) {
      runtimeRelativePath(entry.path)
      if (
        sensitive(entry.path) ||
        paths.has(entry.path.toLowerCase()) ||
        !digestPattern.test(entry.digest) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        entry.bytes > PROJECT_STAGE_SNAPSHOT_LIMITS.fileBytes ||
        typeof entry.executable !== "boolean"
      )
        fail("METADATA_INVALID")
      paths.add(entry.path.toLowerCase())
      total += entry.bytes
    }
    if (total !== value!.totalBytes) fail("METADATA_INVALID")
    return structuredClone(value!)
  }
  /** Discovery does not confer restore/execute authority and never returns another scope. */
  list(scopeKey: string): StageInputSnapshot[] {
    text(scopeKey)
    this.assertRoot()
    const entries = readdirSync(this.root, { withFileTypes: true })
    if (entries.length > PROJECT_STAGE_SNAPSHOT_LIMITS.snapshots) fail("CAPACITY")
    const result: StageInputSnapshot[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !digestPattern.test(entry.name)) fail("STORE_CHANGED")
      const file = readRuntimeScopedFile(
        this.root,
        `${entry.name}/snapshot.json`,
        PROJECT_STAGE_SNAPSHOT_LIMITS.metadataBytes
      )
      if (!file.bytes) fail("MISSING")
      let value: StageInputSnapshot
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
      } catch {
        fail("METADATA_INVALID")
      }
      if (!value! || typeof value! !== "object" || Array.isArray(value!)) fail("METADATA_INVALID")
      const { id, ...metadata } = value!
      if (id !== entry.name || metadataIdentity(metadata) !== entry.name) fail("METADATA_CHANGED")
      // Different valid scopes share this native store. They are not an authorization error.
      if (value!.scopeKey === scopeKey) result.push(this.read(entry.name, scopeKey))
    }
    return result.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    )
  }
  /** Fully verify immutable baseline bytes for a read-only comparison. No restoration or grants. */
  async inspectFiles(id: string, scopeKey: string, guard: () => void,
    signal?: AbortSignal): Promise<{ snapshot: StageInputSnapshot; inventory: ProjectFileInventory }> {
    guard()
    const snapshot = this.read(id, scopeKey)
    const current = () => { signal?.throwIfAborted(); guard(); this.assertRoot() }
    const inventory = await readBoundedProjectFiles(join(this.root, id, "files"), {
      guard: current, signal, expected: snapshot
    })
    current()
    if (!same(this.read(id, scopeKey), snapshot)) fail("METADATA_CHANGED")
    return { snapshot, inventory }
  }

  async materialize(
    id: string,
    scopeKey: string,
    newWorkspace: string,
    guard: () => void,
    signal?: AbortSignal
  ): Promise<void> {
    guard()
    signal?.throwIfAborted()
    const snapshot = this.read(id, scopeKey)
    const destination = runtimeDirectory(newWorkspace)
    const destinationIdentity = runtimeDirectoryIdentity(destination)
    if (
      overlaps(destination, this.root) ||
      overlaps(destination, resolve(snapshot.project.workspace)) ||
      overlaps(destination, resolve(snapshot.sourceRoot))
    )
      fail("SCOPE_OVERLAP")
    if (this.restoring.has(destination)) fail("BUSY")
    if ((await readdir(destination)).length) fail("DESTINATION_NOT_EMPTY")
    const current = () => {
      signal?.throwIfAborted()
      guard()
      this.assertRoot()
      if (runtimeDirectoryIdentity(destination) !== destinationIdentity) fail("DESTINATION_CHANGED")
    }
    current()
    if (this.restoring.has(destination)) fail("BUSY")
    this.restoring.add(destination)
    try {
      const source = join(this.root, id, "files")
      const guardStored = capturePackageMetadataGuard(source)
      const buffers = await this.verifyFiles(source, snapshot, current, signal, true)
      guardStored()
      current()
      if ((await readdir(destination)).length) fail("DESTINATION_NOT_EMPTY")
      current()
      for (const directory of snapshot.directories) {
        current()
        await this.makeDirectory(join(destination, directory), current)
      }
      for (const file of snapshot.files) {
        current()
        await this.writeNew(
          join(destination, file.path),
          buffers.get(file.path)!,
          file.executable,
          current
        )
      }
      current()
      await this.verifyFiles(destination, snapshot, current, signal, false)
      current()
      guardStored()
      this.read(id, scopeKey)
    } finally {
      // On cancellation/error leave a partial private branch for its native owner to discard.
      // Never recursively delete or overwrite a workspace supplied to this method.
      this.restoring.delete(destination)
    }
  }
  private async verifyFiles(
    root: string,
    snapshot: StageInputSnapshot,
    guard: () => void,
    signal: AbortSignal | undefined,
    collect: boolean
  ): Promise<Map<string, Buffer>> {
    try {
      const inventory = await readBoundedProjectFiles(root, {
        guard, signal, expected: snapshot, collect
      })
      return inventory.buffers
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("PROJECT_FILE_OBSERVATION_"))
        fail(error.message.endsWith("_LIMIT") ? "LIMIT" : "FILES_CHANGED")
      throw error
    }
  }
  private async makeDirectory(path: string, guard: () => void) {
    guard()
    const parent = await runtimeDirectoryAsync(dirname(path))
    const identity = runtimeDirectoryIdentity(parent)
    guard()
    await mkdir(path, { mode: 0o700 })
    guard()
    if (runtimeDirectoryIdentity(parent) !== identity) fail("DESTINATION_CHANGED")
    await runtimeDirectoryAsync(path)
    guard()
  }
  private async writeNew(path: string, bytes: Buffer, executable: boolean, guard: () => void) {
    guard()
    const parent = await runtimeDirectoryAsync(dirname(path))
    const parentIdentity = runtimeDirectoryIdentity(parent)
    guard()
    const file = await open(path, "wx", executable ? 0o700 : 0o600)
    try {
      const opened = await file.stat()
      guard()
      if (runtimeDirectoryIdentity(parent) !== parentIdentity || opened.nlink !== 1)
        fail("DESTINATION_CHANGED")
      await file.writeFile(bytes)
      await file.sync()
      guard()
      if (runtimeDirectoryIdentity(parent) !== parentIdentity) fail("DESTINATION_CHANGED")
    } finally {
      await file.close()
    }
  }
}
