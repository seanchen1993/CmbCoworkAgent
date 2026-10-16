import { randomUUID } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import AdmZip from "adm-zip"
import type {
  BusinessModAssemblyRequest,
  BusinessModCopy,
  BusinessModExport,
  BusinessModInspection,
  BusinessModPreview
} from "../../shared/business-mods"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { createAsyncMutex } from "../utils/fs"
import type { DerivationServiceDependencies } from "./derivation-service"
import {
  snapshotDerivationSource,
  writeDerivationFiles,
  type DerivationFile
} from "./derivation-source"
import { businessModCatalog } from "./business-mod-manifest"
import { assembleBusinessMods } from "./business-mod-assembler"

interface InspectionRecord {
  owner: string
  directory: string
  digest: string
  expires: number
}
interface PreviewRecord {
  owner: string
  expires: number
  view: BusinessModPreview
  files: DerivationFile[]
  sources: Array<{ directory: string; digest: string }>
}
interface CopyRecord extends BusinessModCopy {
  owner: string
  requestId: string
  previewId: string
}
const uuid = /^[a-f0-9-]{36}$/
const ttl = 10 * 60_000

/** Host-owned materialization/installation transactions. Renderer never chooses a source file path. */
export class BusinessModAssemblyService {
  private readonly inspections = new Map<string, InspectionRecord>()
  private readonly previews = new Map<string, PreviewRecord>()
  private readonly copies = new Map<string, CopyRecord>()
  private readonly mutex = createAsyncMutex()
  constructor(
    private readonly root: string,
    private readonly deps: DerivationServiceDependencies
  ) {
    mkdirSync(root, { recursive: true })
    const entries = readdirSync(root, { withFileTypes: true })
    if (entries.length > 512) throw Error("业务 Mods 工作目录记录超限")
    for (const entry of entries) {
      if (!entry.isDirectory() || !uuid.test(entry.name)) continue
      const receipt = join(root, entry.name, "receipt.json")
      if (!existsSync(receipt)) continue
      const stat = lstatSync(receipt)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192)
        throw Error("业务 Mods 生成记录损坏")
      const record = JSON.parse(readFileSync(receipt, "utf8")) as CopyRecord
      if (
        record.copyId !== entry.name ||
        typeof record.owner !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.digest) ||
        !["created", "checked", "installed"].includes(record.status)
      )
        throw Error("业务 Mods 生成记录损坏")
      this.copies.set(record.copyId, record)
    }
  }
  private trim() {
    const now = Date.now()
    for (const [id, item] of this.inspections) if (item.expires < now) this.inspections.delete(id)
    for (const [id, item] of this.previews) if (item.expires < now) this.previews.delete(id)
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await this.mutex.acquire()
    try {
      return await work()
    } finally {
      this.mutex.release()
    }
  }
  private view(record: CopyRecord): BusinessModCopy {
    const { copyId, name, version, digest, status, fileCount, pluginId } = record
    return { copyId, name, version, digest, status, fileCount, ...(pluginId ? { pluginId } : {}) }
  }
  private record(owner: string, copyId: string) {
    const record = this.copies.get(copyId)
    if (!record || record.owner !== owner) throw Error("业务 Mods 插件记录不属于当前会话")
    return record
  }
  private directory(record: CopyRecord) {
    return join(this.root, record.copyId, "source")
  }
  private persist(record: CopyRecord) {
    const file = join(this.root, record.copyId, "receipt.json")
    const temporary = file + ".tmp"
    // Caller holds the service mutex. Never replace an existing unrelated temporary file.
    const descriptor = JSON.stringify(record)
    requireReceiptWrite(temporary, descriptor)
    renameSync(temporary, file)
  }
  private async assertSources(preview: PreviewRecord, guard: () => void) {
    for (const source of preview.sources) {
      if ((await snapshotDerivationSource(source.directory)).digest !== source.digest)
        throw Error("业务 Mods 来源已变化，请重新预览")
      guard()
    }
  }
  async inspect(
    directory: string,
    owner: string,
    guard: () => void
  ): Promise<BusinessModInspection> {
    guard()
    this.trim()
    if (this.inspections.size >= 32) throw Error("来源检查过多，请稍后重试")
    const snapshot = await snapshotDerivationSource(directory)
    const catalog = businessModCatalog(snapshot)
    guard()
    const id = randomUUID()
    this.inspections.set(id, {
      owner,
      directory: snapshot.root,
      digest: snapshot.digest,
      expires: Date.now() + ttl
    })
    return {
      id,
      sourceName: snapshot.name,
      sourceDigest: snapshot.digest,
      ...(catalog.kernel
        ? { kernel: { id: catalog.kernel.id, version: catalog.kernel.version } }
        : {}),
      mods: [
        ...catalog.modules.map((mod) => ({
          id: mod.id,
          title: mod.title,
          nodeId: String(mod.node.id),
          dependsOn: mod.dependencies.required,
          advisory: mod.dependencies.advisory,
          ...(mod.insertAfter ? { insertAfter: mod.insertAfter } : {})
        })),
        ...(catalog.extensions ?? []).map((mod) => ({
          id: mod.id,
          title: mod.title,
          kind: "function" as const,
          dependsOn: mod.dependencies.required,
          advisory: mod.dependencies.advisory
        }))
      ],
      excluded: snapshot.excluded,
      warnings: snapshot.excluded.length ? ["已排除凭据、缓存与运行状态；它们不会进入新插件"] : []
    }
  }
  async preview(
    owner: string,
    request: BusinessModAssemblyRequest,
    guard: () => void
  ): Promise<BusinessModPreview> {
    guard()
    this.trim()
    if (
      !request ||
      !Array.isArray(request.sources) ||
      !request.sources.length ||
      request.sources.length > 8 ||
      new Set(request.sources.map((source) => source.inspectionId)).size !== request.sources.length
    )
      throw Error("业务 Mods 来源选择无效")
    if ([...this.previews.values()].filter((item) => item.owner !== owner).length >= 8)
      throw Error("待生成预览过多，请稍后重试")
    const snapshots = [] as Parameters<typeof assembleBusinessMods>[0]
    for (const source of request.sources) {
      const inspected = this.inspections.get(source.inspectionId)
      if (!inspected || inspected.owner !== owner) throw Error("来源检查已过期或不属于当前会话")
      const snapshot = await snapshotDerivationSource(inspected.directory)
      if (snapshot.digest !== inspected.digest) throw Error("业务 Mods 来源已变化，请重新检查")
      snapshots.push({ snapshot, catalog: businessModCatalog(snapshot), modIds: source.modIds })
      guard()
    }
    const assembled = assembleBusinessMods(snapshots, structuredClone(request))
    if (
      [...this.previews.values()]
        .filter((item) => item.owner !== owner)
        .reduce(
          (sum, item) => sum + item.files.reduce((size, file) => size + file.bytes.length, 0),
          0
        ) +
        assembled.files.reduce((sum, file) => sum + file.bytes.length, 0) >
      96 * 1024 * 1024
    )
      throw Error("待生成预览内容过多，请先完成现有预览")
    const previewId = randomUUID()
    const view: BusinessModPreview = {
      previewId,
      digest: assembled.digest,
      name: request.name,
      version: request.version,
      steps: assembled.steps,
      ...(assembled.extensions?.length ? { extensions: assembled.extensions } : {}),
      files: assembled.files.map(({ path, digest, bytes }) => ({
        path,
        digest,
        bytes: bytes.length
      })),
      sources: snapshots.map(({ snapshot }) => ({ name: snapshot.name, digest: snapshot.digest })),
      diagnostics: assembled.diagnostics,
      ...(assembled.requiresFixedWorkflowAcknowledgement
        ? { requiresFixedWorkflowAcknowledgement: true } : {}),
      valid: assembled.missingProviders.length === 0 &&
        (!assembled.requiresFixedWorkflowAcknowledgement || request.acceptFixedWorkflow === true)
    }
    guard()
    for (const [id, previous] of this.previews)
      if (previous.owner === owner) this.previews.delete(id)
    this.previews.set(previewId, {
      owner,
      view,
      files: assembled.files,
      sources: snapshots.map(({ snapshot }) => ({
        directory: snapshot.root,
        digest: snapshot.digest
      })),
      expires: Date.now() + ttl
    })
    return structuredClone(view)
  }
  list(owner: string): BusinessModCopy[] {
    return [...this.copies.values()]
      .filter((record) => record.owner === owner)
      .map((record) => this.view(record))
  }
  create(
    owner: string,
    previewId: string,
    requestId: string,
    guard: () => void
  ): Promise<BusinessModCopy> {
    return this.locked(async () => {
      guard()
      this.trim()
      if (!uuid.test(requestId)) throw Error("业务 Mods 生成请求无效")
      const existing = [...this.copies.values()].find(
        (copy) => copy.owner === owner && copy.requestId === requestId
      )
      if (existing) {
        if (existing.previewId !== previewId) throw Error("生成请求与预览不一致")
        return this.view(existing)
      }
      const preview = this.previews.get(previewId)
      if (!preview || preview.owner !== owner) throw Error("业务 Mods 预览已过期")
      if (!preview.view.valid) throw Error("业务 Mods 存在未解决的依赖或行为差异，请先核对预览")
      if (
        this.deps
          .plugins()
          .some((plugin) => plugin.name.toLowerCase() === preview.view.name.toLowerCase()) ||
        [...this.copies.values()].some(
          (copy) => copy.name.toLowerCase() === preview.view.name.toLowerCase()
        )
      )
        throw Error("插件名称已存在，不能覆盖")
      await this.assertSources(preview, guard)
      const copyId = randomUUID(),
        temporary = await mkdtemp(join(this.root, ".creating-"))
      try {
        await mkdir(join(temporary, "source"))
        await writeDerivationFiles(join(temporary, "source"), preview.files)
        const snapshot = await snapshotDerivationSource(join(temporary, "source"))
        if (snapshot.digest !== preview.view.digest) throw Error("生成文件与预览不一致")
        await this.assertSources(preview, guard)
        const record: CopyRecord = {
          copyId,
          owner,
          requestId,
          previewId,
          name: preview.view.name,
          version: preview.view.version,
          digest: snapshot.digest,
          status: "created",
          fileCount: snapshot.files.length
        }
        await writeFile(join(temporary, "receipt.json"), JSON.stringify(record), { flag: "wx" })
        guard()
        renameSync(temporary, join(this.root, copyId))
        this.copies.set(copyId, record)
        return this.view(record)
      } finally {
        if (dirname(temporary) === this.root && temporary.startsWith(join(this.root, ".creating-")))
          await rm(temporary, { recursive: true, force: true })
      }
    })
  }
  check(
    owner: string,
    copyId: string,
    expectedDigest: string,
    guard: () => void
  ): Promise<BusinessModCopy> {
    return this.locked(async () => {
      const record = this.record(owner, copyId)
      guard()
      const before = await snapshotDerivationSource(this.directory(record))
      if (
        before.digest !== expectedDigest ||
        record.digest !== expectedDigest ||
        before.name !== record.name
      )
        throw Error("生成插件已变化，请重新生成预览")
      parseProjectRuntimeManifest(
        JSON.parse(
          (await readFile(join(before.root, "devclaw.project-runtime.json"))).toString("utf8")
        )
      )
      businessModCatalog(before)
      await this.deps.validatePackage?.(before.root)
      if ((await snapshotDerivationSource(before.root)).digest !== expectedDigest)
        throw Error("检查期间生成插件已变化")
      guard()
      record.status = record.status === "installed" ? "installed" : "checked"
      this.persist(record)
      return this.view(record)
    })
  }
  install(
    owner: string,
    copyId: string,
    expectedDigest: string,
    guard: () => void
  ): Promise<BusinessModCopy> {
    return this.locked(async () => {
      const record = this.record(owner, copyId)
      guard()
      if (record.digest !== expectedDigest) throw Error("安装目标版本已变化")
      if (
        record.status === "installed" &&
        record.pluginId &&
        this.deps.plugins().some((item) => item.id === record.pluginId)
      )
        return this.view(record)
      if (record.status !== "checked" || record.digest !== expectedDigest)
        throw Error("请先检查生成插件")
      const snapshot = await snapshotDerivationSource(this.directory(record))
      if (snapshot.digest !== expectedDigest || snapshot.name !== record.name)
        throw Error("生成插件已变化")
      const temporary = await mkdtemp(join(this.root, ".installing-"))
      const pluginId = randomUUID()
      try {
        await writeDerivationFiles(temporary, snapshot.files)
        guard()
        const result = await this.deps.install(
          temporary,
          record.name,
          pluginId,
          guard,
          async (directory) => {
            if (
              (await snapshotDerivationSource(directory)).digest !== expectedDigest ||
              (await snapshotDerivationSource(this.directory(record))).digest !== expectedDigest
            )
              throw Error("安装副本与已检查插件不一致")
            guard()
          }
        )
        if (!result.success) throw Error(result.error ?? "业务 Mods 插件安装失败")
        record.pluginId = pluginId
        record.status = "installed"
        this.persist(record)
        this.deps.invalidate()
        return this.view(record)
      } finally {
        if (
          dirname(temporary) === this.root &&
          temporary.startsWith(join(this.root, ".installing-"))
        )
          await rm(temporary, { recursive: true, force: true })
      }
    })
  }
  export(
    owner: string,
    copyId: string,
    expectedDigest: string,
    outputFile: string,
    guard: () => void
  ): Promise<BusinessModExport> {
    return this.locked(async () => {
      const record = this.record(owner, copyId)
      guard()
      if (!["checked", "installed"].includes(record.status) || record.digest !== expectedDigest)
        throw Error("请先检查生成插件")
      const snapshot = await snapshotDerivationSource(this.directory(record))
      if (snapshot.digest !== expectedDigest) throw Error("导出内容与已检查插件不一致")
      const output = resolve(outputFile)
      if (!output.toLowerCase().endsWith(".zip")) throw Error("请选择新的 ZIP 文件")
      const zip = new AdmZip()
      for (const file of snapshot.files) zip.addFile(file.path, file.bytes, "", file.mode & 0o777)
      const bytes = zip.toBuffer()
      if ((await snapshotDerivationSource(snapshot.root)).digest !== expectedDigest)
        throw Error("导出期间生成插件已变化")
      guard()
      await writeFile(output, bytes, { flag: "wx" })
      return { output, digest: expectedDigest, files: snapshot.files.length }
    })
  }
}

// Kept synchronous so publishing the record has no permission/scope await window.
function requireReceiptWrite(path: string, value: string) {
  writeFileSync(path, value, { flag: "wx", mode: 0o600 })
}
