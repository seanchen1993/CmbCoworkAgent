import { randomUUID } from "node:crypto"
import type { ProjectDeliveryObservation } from "./plugin-delivery-observation"
import { isDeepStrictEqual } from "node:util"
import { prepareNodeCompositionFiles } from "./derivation-node-composition"
import { prepareFlowCompositionFiles } from "./derivation-flow-composition"
import { mkdir, mkdtemp, rename, rm, writeFile, readFile } from "node:fs/promises"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync
} from "node:fs"
import { dirname, join } from "node:path"
import type { PluginMetadata } from "../types"
import type {
  PluginDerivationCopy,
  PluginDerivationInspection,
  PluginDerivationUpstream,
  PluginDerivationProposal
} from "../../shared/plugin-derivation"
import { createAsyncMutex } from "../utils/fs"
import {
  snapshotDerivationSource,
  derivationContentIdentity,
  renameDerivation,
  writeDerivationFiles,
  DERIVATION_NOTES,
  type DerivationSnapshot
} from "./derivation-source"
import {
  setDerivationFamilies,
  setDerivationInstallationObserver,
  type DerivationFamily
} from "./derivation-scope"
import {
  publishDerivationTransaction,
  recoverDerivationTransactions
} from "./derivation-transaction"

interface CopyRecord extends PluginDerivationCopy {
  owner: string
  requestId: string
  familyId: string
  originalId?: string
  installedDigest?: string
  upstream?: { root: string; pluginId?: string; digest: string }
  changes: Array<{ path: string; before: string; after: string }>
}
interface Inspection {
  owner: string
  root: string
  digest: string
  sourceId?: string
  familyId?: string
  originalId?: string
  expires: number
  parentCopyId?: string
}
interface Ledger {
  copies: CopyRecord[]
  families: DerivationFamily[]
}
const idPattern = /^[a-f0-9-]{36}$/
const defaultNotes =
  "# 我的插件\n\n## 用途\n说明这个插件要解决的问题。\n\n## 业务步骤\n先修改技能或节点的说明；修改阶段结构前，请核对流程、验证器和状态接口。\n\n## 检查方法\n保留原有检查与人工确认，不以说明文字代替真实验证。\n"
const editable = (path: string) =>
  /\.(?:md|txt|json|py|js|mjs|cjs|ts|tsx|jsx|css|html|sh|cmd|ps1|yaml|yml|toml)$/i.test(path)

export interface DerivationServiceDependencies {
  plugins(): PluginMetadata[]
  validatePackage?(directory: string): Promise<void>
  install(
    directory: string,
    name: string,
    pluginId: string,
    guard: () => void,
    verify: (directory: string) => Promise<void>
  ): Promise<{ success: boolean; error?: string }>
  invalidate(): void
  observeInstallation?(
    input: { pluginId: string; name: string; version: string; digest: string },
    guard: () => void
  ): Promise<ProjectDeliveryObservation>
}

export class PluginDerivationService {
  private readonly inspections = new Map<string, Inspection>()
  private readonly mutex = createAsyncMutex()
  private upstreamBusy = false
  private ledger: Ledger
  constructor(
    private readonly root: string,
    private readonly deps: DerivationServiceDependencies
  ) {
    mkdirSync(root, { recursive: true })
    const file = join(root, "ledger.json")
    this.ledger = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { copies: [], families: [] }
    if (!Array.isArray(this.ledger.copies) || !Array.isArray(this.ledger.families))
      throw Error("插件副本记录损坏，停止操作")
    recoverDerivationTransactions(
      root,
      new Map(this.ledger.copies.map((copy) => [copy.copyId, copy.digest]))
    )
    // A published copy carries its host receipt outside source, so a crash between rename and
    // ledger commit is recoverable without copying the source or guessing from package metadata.
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !idPattern.test(entry.name) ||
        this.ledger.copies.some((copy) => copy.copyId === entry.name)
      )
        continue
      const receipt = join(root, entry.name, "receipt.json")
      if (!existsSync(receipt)) continue
      const copy = JSON.parse(readFileSync(receipt, "utf8")) as CopyRecord
      if (
        copy.copyId !== entry.name ||
        typeof copy.owner !== "string" ||
        typeof copy.requestId !== "string" ||
        copy.status !== "created"
      )
        throw Error("插件副本发布记录损坏")
      this.ledger.copies.push(copy)
    }
    setDerivationFamilies(this.ledger.families)
    setDerivationInstallationObserver((id, directory, name) =>
      this.associateInstallation(id, directory, name)
    )
  }
  private async associateInstallation(
    pluginId: string,
    directory: string,
    name: string
  ): Promise<void> {
    if (
      !this.ledger.families.some((family) => family.sources?.some((source) => source.name === name))
    )
      return
    let snapshot: DerivationSnapshot
    try {
      snapshot = await snapshotDerivationSource(directory)
    } catch {
      // Legacy installs accept formats outside the derivation subset. They cannot prove an
      // exact lineage match, but must retain their existing installation behavior.
      return
    }
    const family = this.ledger.families.find((item) =>
      item.sources?.some(
        (source) =>
          source.name === snapshot.name &&
          source.digest === derivationContentIdentity(snapshot.files)
      )
    )
    if (!family) return
    family.originalId = pluginId
    if (!family.members.includes(pluginId)) family.members.push(pluginId)
    for (const copy of this.ledger.copies)
      if (copy.familyId === family.familyId) copy.originalId = pluginId
    this.persist()
  }
  private persist() {
    const file = join(this.root, "ledger.json")
    const temporary = join(this.root, `ledger-${randomUUID()}.tmp`)
    writeFileSync(temporary, JSON.stringify(this.ledger), { flag: "wx", mode: 0o600 })
    renameSync(temporary, file)
    setDerivationFamilies(this.ledger.families)
    this.deps.invalidate()
  }
  private async locked<T>(run: () => Promise<T>): Promise<T> {
    await this.mutex.acquire()
    try {
      return await run()
    } finally {
      this.mutex.release()
    }
  }
  sourcePath(copyId: string, owner: string): string {
    this.record(copyId, owner)
    return join(this.root, copyId, "source")
  }
  private record(copyId: string, owner: string): CopyRecord {
    if (!idPattern.test(copyId)) throw Error("副本标识无效")
    const record = this.ledger.copies.find((item) => item.copyId === copyId && item.owner === owner)
    if (!record) throw Error("找不到此工作区的插件副本")
    if (existsSync(join(this.root, copyId, "proposal-transaction.json")))
      throw Error("插件修改尚待恢复，请重新启动应用后再操作此副本")
    return record
  }
  private view(record: CopyRecord): PluginDerivationCopy {
    return structuredClone({
      copyId: record.copyId,
      name: record.name,
      sourceName: record.sourceName,
      sourceDigest: record.sourceDigest,
      digest: record.digest,
      status: record.status,
      createdAt: record.createdAt,
      fileCount: record.fileCount,
      excluded: record.excluded,
      warnings: record.warnings,
      businessNotes: record.businessNotes,
      parentCopyId: record.parentCopyId,
      ...(record.pluginId && this.deps.plugins().some((plugin) => plugin.id === record.pluginId)
        ? { pluginId: record.pluginId }
        : {})
    })
  }
  list(owner: string) {
    return this.ledger.copies.filter((copy) => copy.owner === owner).map((copy) => this.view(copy))
  }
  get(copyId: string, owner: string) {
    return this.view(this.record(copyId, owner))
  }
  private upstreamFor(record: CopyRecord): CopyRecord["upstream"] {
    if (record.upstream) return record.upstream
    // Older ledgers already retain a host-owned original ID and exact source digest.
    const original = this.deps
      .plugins()
      .find((plugin) => plugin.id === record.originalId && plugin.name === record.sourceName)
    return original
      ? { root: original.path, pluginId: original.id, digest: record.sourceDigest }
      : undefined
  }
  async revise(owner: string, copyId: string, requestId: string, guard: () => void) {
    guard()
    const parent = this.record(copyId, owner)
    const existing = this.ledger.copies.find(
      (copy) => copy.owner === owner && copy.requestId === requestId
    )
    if (existing) {
      if (existing.parentCopyId !== copyId) throw Error("版本请求与原插件不一致")
      return this.view(existing)
    }
    const installed = this.deps.plugins().find((plugin) => plugin.id === parent.pluginId)
    if (!installed || parent.status !== "installed") throw Error("请先安装插件再创建新版本")
    const inspection = await this.inspect(installed.path, owner, guard, installed.id)
    this.inspections.get(inspection.inspectionId)!.parentCopyId = copyId
    const base = parent.name.replace(/-v\d+$/, "").slice(0, 60)
    let version = 2
    const names = new Set([
      ...this.ledger.copies.map((copy) => copy.name.toLowerCase()),
      ...this.deps.plugins().map((plugin) => plugin.name.toLowerCase())
    ])
    while (names.has(`${base}-v${version}`.toLowerCase())) version++
    return this.create(owner, inspection.inspectionId, `${base}-v${version}`, requestId, guard)
  }
  async inspectUpstream(
    owner: string,
    copyId: string,
    guard: () => void,
    prepare = false
  ): Promise<PluginDerivationUpstream> {
    guard()
    if (this.upstreamBusy) throw Error("正在检查来源，请稍候再试")
    this.upstreamBusy = true
    try {
      return await this.readUpstream(owner, copyId, guard, prepare)
    } finally {
      this.upstreamBusy = false
    }
  }
  private async readUpstream(
    owner: string,
    copyId: string,
    guard: () => void,
    prepare = false
  ): Promise<PluginDerivationUpstream> {
    guard()
    const record = this.record(copyId, owner)
    const upstream = this.upstreamFor(record)
    if (!upstream) return { state: "unavailable" }
    const plugin = upstream.pluginId
      ? this.deps.plugins().find((item) => item.id === upstream.pluginId)
      : undefined
    if (upstream.pluginId && !plugin) return { state: "unavailable" }
    const root = plugin?.path ?? upstream.root
    if (!existsSync(root)) return { state: "unavailable" }
    const snapshot = await snapshotDerivationSource(root)
    guard()
    const state = snapshot.digest === upstream.digest ? "unchanged" : "changed"
    // Automatic visibility refreshes must not mint source capabilities or exhaust their quota.
    if (!prepare) return { state }
    const inspection = await this.inspect(root, owner, guard, plugin?.id)
    const names = new Set([
      ...this.ledger.copies.map((copy) => copy.name.toLowerCase()),
      ...this.deps.plugins().map((item) => item.name.toLowerCase())
    ])
    const base = `${record.name.slice(0, 55)}-来源更新`
    let version = 1
    while (names.has(`${base}-${version}`.toLowerCase())) version++
    inspection.suggestedName = `${base}-${version}`
    return {
      state: inspection.digest === upstream.digest ? "unchanged" : "changed",
      inspection
    }
  }
  async proposalSnapshot(owner: string, copyId: string, digest: string, guard: () => void) {
    const record = this.record(copyId, owner)
    if (record.pluginId && this.deps.plugins().some((plugin) => plugin.id === record.pluginId))
      throw Error("已安装副本请先创建新副本，不能覆盖安装版本")
    const snapshot = await snapshotDerivationSource(this.sourcePath(copyId, owner))
    if (snapshot.digest !== digest)
      throw Error("源码已变化，请取消建议并重新检查副本，再生成修改建议")
    if (snapshot.excluded.length) throw Error("副本包含新增的排除文件，请先移出后再生成")
    guard()
    return snapshot
  }
  async applyProposal(
    owner: string,
    proposal: PluginDerivationProposal,
    guard: () => void,
    kind: "skill" | "node-composition" | "flow-composition" = "skill"
  ) {
    return this.locked(async () => {
      const snapshot = await this.proposalSnapshot(
        owner,
        proposal.copyId,
        proposal.baseDigest,
        guard
      )
      const record = this.record(proposal.copyId, owner)
      if (
        kind === "node-composition" &&
        !isDeepStrictEqual(proposal.files, prepareNodeCompositionFiles(snapshot).files)
      )
        throw Error("节点组合候选不符合宿主确定性配置协议")
      if (
        kind === "flow-composition" &&
        !isDeepStrictEqual(proposal.files, prepareFlowCompositionFiles(snapshot).files)
      )
        throw Error("流程组合候选不符合宿主确定性配置协议")
      const beforeRecord = structuredClone(record)
      const transactionId = randomUUID()
      const staging = join(this.root, proposal.copyId, `proposal-${transactionId}`)
      await mkdir(staging)
      try {
        const changes = new Map(proposal.files.map((file) => [file.path, file]))
        if (!changes.size || changes.size !== proposal.files.length) throw Error("修改建议无效")
        const files = snapshot.files.map((file) => {
          const changed = changes.get(file.path)
          if (!changed) return file
          if (
            (kind === "skill" && !/^skills\/(?:[a-zA-Z0-9_-]+\/)*SKILL\.md$/.test(file.path)) ||
            changed.before !== file.bytes.toString("utf8") ||
            (kind === "skill" && !changed.after.startsWith(changed.before)) ||
            changed.after === changed.before ||
            Buffer.byteLength(changed.after) > (kind === "skill" ? 256 * 1024 : 2 * 1024 * 1024)
          )
            throw Error("修改建议不符合技能补充协议")
          changes.delete(file.path)
          return { ...file, bytes: Buffer.from(changed.after, "utf8") }
        })
        if (kind === "flow-composition") {
          // The exact deterministic file set was regenerated above; no caller-chosen writes.
          for (const changed of changes.values()) {
            if (changed.before !== "") throw Error("新增配置不能覆盖已有文件")
            files.push({
              path: changed.path,
              bytes: Buffer.from(changed.after, "utf8"),
              mode: 0o644,
              digest: ""
            })
          }
          changes.clear()
        }
        if (changes.size) throw Error("修改建议包含未知文件")
        await writeDerivationFiles(staging, files)
        const staged = await snapshotDerivationSource(staging)
        if (staged.name !== record.name) throw Error("插件身份不能改变")
        await this.proposalSnapshot(owner, proposal.copyId, snapshot.digest, guard)
        guard()
        try {
          publishDerivationTransaction(
            this.root,
            {
              version: 1,
              copyId: proposal.copyId,
              transactionId,
              beforeDigest: snapshot.digest,
              afterDigest: staged.digest
            },
            () => {
              record.digest = staged.digest
              record.status = "changed"
              record.changes.push(
                ...staged.files.flatMap((file) => {
                  const previous = snapshot.files.find((item) => item.path === file.path)
                  return previous?.digest === file.digest
                    ? []
                    : [{ path: file.path, before: previous?.digest ?? "", after: file.digest }]
                })
              )
              try {
                this.persist()
              } catch (error) {
                // Read the durable commit point: invalidation can fail after ledger publication.
                const saved = JSON.parse(
                  readFileSync(join(this.root, "ledger.json"), "utf8")
                ) as Ledger
                if (
                  saved.copies.find((item) => item.copyId === record.copyId)?.digest !==
                  staged.digest
                )
                  Object.assign(record, beforeRecord)
                throw error
              }
            },
            () => {
              const saved = JSON.parse(
                readFileSync(join(this.root, "ledger.json"), "utf8")
              ) as Ledger
              return saved.copies.find((item) => item.copyId === record.copyId)?.digest ?? ""
            }
          )
        } catch (error) {
          const saved = JSON.parse(readFileSync(join(this.root, "ledger.json"), "utf8")) as Ledger
          const committed = saved.copies.find((item) => item.copyId === record.copyId)
          if (committed?.digest !== staged.digest) throw error
          const live = await snapshotDerivationSource(join(this.root, proposal.copyId, "source"))
          if (live.digest !== staged.digest) throw error
          // Publication has committed. Report the saved version, never invite a duplicate append.
          Object.assign(record, committed)
          if (existsSync(join(this.root, proposal.copyId, "proposal-transaction.json")))
            record.warnings = [
              ...record.warnings,
              "修改已保存，清理尚待恢复；请重启后继续检查或安装。"
            ]
        }
        return this.view(record)
      } finally {
        // A recovery journal owns all directories after publication begins.
        if (!existsSync(join(this.root, proposal.copyId, "proposal-transaction.json")))
          await rm(staging, { recursive: true, force: true })
      }
    })
  }
  async listEditableFiles(owner: string, copyId: string, guard: () => void) {
    const snapshot = await snapshotDerivationSource(this.sourcePath(copyId, owner))
    guard()
    return snapshot.files
      .filter((file) => editable(file.path) && file.bytes.length <= 256 * 1024)
      .map((file) => file.path)
  }
  async readFile(owner: string, copyId: string, path: string, guard: () => void) {
    const snapshot = await snapshotDerivationSource(this.sourcePath(copyId, owner))
    const file = snapshot.files.find((item) => item.path === path && editable(path))
    if (!file || file.bytes.length > 256 * 1024) throw Error("此文件不能在制作页编辑")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)
    if (text.includes("\0")) throw Error("二进制文件不能作为文本编辑")
    guard()
    return { path, text, digest: snapshot.digest }
  }
  async saveFile(
    owner: string,
    copyId: string,
    path: string,
    text: string,
    digest: string,
    guard: () => void
  ) {
    return this.locked(async () => {
      const record = this.record(copyId, owner)
      if (record.pluginId && this.deps.plugins().some((plugin) => plugin.id === record.pluginId))
        throw Error("已安装副本请先创建新副本，不能覆盖安装版本")
      if (typeof text !== "string" || text.includes("\0") || Buffer.byteLength(text) > 256 * 1024)
        throw Error("文本文件大小或格式不支持")
      const root = this.sourcePath(copyId, owner)
      const snapshot = await snapshotDerivationSource(root)
      if (snapshot.digest !== digest) throw Error("源码已变化，请重新检查后再修改")
      const file = snapshot.files.find((item) => item.path === path && editable(path))
      if (!file || file.bytes.length > 256 * 1024) throw Error("此文件不能在制作页编辑")
      guard()
      const target = join(root, file.path)
      const temporary = join(dirname(target), `.edit-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, text, { flag: "wx", mode: file.mode & 0o777 })
        const current = await snapshotDerivationSource(root)
        // The owned temporary file is the only expected change.
        const originalFiles = current.files.filter(
          (item) => item.path !== temporary.slice(root.length + 1).replace(/\\/g, "/")
        )
        if (
          originalFiles.some(
            (item) => snapshot.files.find((old) => old.path === item.path)?.digest !== item.digest
          ) ||
          originalFiles.length !== snapshot.files.length
        )
          throw Error("源码已变化，请重新读取")
        guard()
        await rename(temporary, target)
      } finally {
        await rm(temporary, { force: true })
      }
      record.digest = (await snapshotDerivationSource(root)).digest
      if (path === DERIVATION_NOTES) record.businessNotes = text
      record.status = "changed"
      this.persist()
      return this.view(record)
    })
  }
  async inspect(
    root: string,
    owner: string,
    guard: () => void,
    sourceId?: string
  ): Promise<PluginDerivationInspection> {
    guard()
    const snapshot = await snapshotDerivationSource(root)
    guard()
    if (
      sourceId &&
      !this.deps.plugins().some((plugin) => plugin.id === sourceId && plugin.path === root)
    )
      throw Error("来源插件已变化")
    // Directory selection is associated with an installation only after exact content verification.
    if (!sourceId)
      for (const plugin of this.deps.plugins().filter((p) => p.name === snapshot.name)) {
        const installed = await snapshotDerivationSource(plugin.path)
        guard()
        if (
          derivationContentIdentity(installed.files) === derivationContentIdentity(snapshot.files)
        ) {
          sourceId = plugin.id
          break
        }
      }
    const ownedSource = !sourceId
      ? this.ledger.copies.find(
          (copy) => copy.name === snapshot.name && copy.digest === snapshot.digest
        )
      : undefined
    let family = this.ledger.families.find(
      (item) =>
        (sourceId && item.members.includes(sourceId)) ||
        item.familyId === ownedSource?.familyId ||
        item.sources?.some(
          (source) =>
            source.name === snapshot.name &&
            source.digest === derivationContentIdentity(snapshot.files)
        )
    )
    if (!family) {
      family = {
        familyId: randomUUID(),
        originalId: sourceId,
        members: sourceId ? [sourceId] : [],
        sources: [{ name: snapshot.name, digest: derivationContentIdentity(snapshot.files) }]
      }
      this.ledger.families.push(family)
    } else if (sourceId && !ownedSource && !family.members.includes(sourceId)) {
      family.originalId = sourceId
      family.members.push(sourceId)
    }
    if (
      sourceId === family.originalId &&
      !ownedSource &&
      !family.sources?.some(
        (source) =>
          source.name === snapshot.name &&
          source.digest === derivationContentIdentity(snapshot.files)
      )
    ) {
      family.sources ??= []
      family.sources.push({
        name: snapshot.name,
        digest: derivationContentIdentity(snapshot.files)
      })
    }
    guard()
    this.persist()
    for (const [id, item] of this.inspections)
      if (item.expires < Date.now()) this.inspections.delete(id)
    if (this.inspections.size >= 64) throw Error("检查次数过多，请关闭旧窗口后重试")
    const inspectionId = randomUUID()
    this.inspections.set(inspectionId, {
      owner,
      root,
      digest: snapshot.digest,
      sourceId,
      familyId: family.familyId,
      originalId: family.originalId,
      expires: Date.now() + 30 * 60_000
    })
    return {
      inspectionId,
      sourceName: snapshot.name,
      suggestedName: `${snapshot.name.slice(0, 65)}-我的副本`,
      digest: snapshot.digest,
      fileCount: snapshot.files.length,
      totalBytes: snapshot.totalBytes,
      excluded: snapshot.excluded,
      warnings: this.warnings(snapshot)
    }
  }
  private warnings(snapshot: DerivationSnapshot): string[] {
    const warnings = ["完整业务验证需在新项目中运行原检查；静态检查不代表业务通过。"]
    if (snapshot.files.some((file) => file.path === ".mcp.json"))
      warnings.push("此插件包含 MCP；使用原生项目入口，连接器仍需原有配置与授权。")
    if (snapshot.files.some((file) => /\.py$/.test(file.path)))
      warnings.push("此插件包含 Python 脚本；新项目需准备原插件要求的 Python 环境。")
    return warnings
  }
  async create(
    owner: string,
    inspectionId: string,
    name: string,
    requestId: string,
    guard: () => void
  ) {
    return this.locked(async () => {
      guard()
      if (typeof requestId !== "string" || !idPattern.test(requestId))
        throw Error("创建请求标识无效")
      const existing = this.ledger.copies.find(
        (copy) => copy.owner === owner && copy.requestId === requestId
      )
      if (existing) return this.view(existing)
      const inspection = this.inspections.get(inspectionId)
      if (!inspection || inspection.owner !== owner || inspection.expires < Date.now())
        throw Error("来源检查已过期，请重新选择来源")
      const snapshot = await snapshotDerivationSource(inspection.root)
      if (snapshot.digest !== inspection.digest) throw Error("来源已变化，请重新检查")
      if (typeof name !== "string") throw Error("新插件名称无效")
      name = name.trim()
      if (
        this.deps.plugins().some((plugin) => plugin.name.toLowerCase() === name.toLowerCase()) ||
        this.ledger.copies.some((copy) => copy.name.toLowerCase() === name.toLowerCase())
      )
        throw Error("插件名称已存在，请选择独立名称")
      const files = renameDerivation(snapshot, name)
      const copyId = randomUUID()
      const temporary = await mkdtemp(join(this.root, ".creating-"))
      const final = join(this.root, copyId)
      try {
        await mkdir(join(temporary, "source"))
        await writeDerivationFiles(join(temporary, "source"), files)
        if (!files.some((file) => file.path === DERIVATION_NOTES))
          await writeFile(join(temporary, "source", DERIVATION_NOTES), defaultNotes, { flag: "wx" })
        const sourceAgain = await snapshotDerivationSource(inspection.root)
        if (sourceAgain.digest !== snapshot.digest) throw Error("来源已变化，请重新检查")
        guard()
        const created = await snapshotDerivationSource(join(temporary, "source"))
        let family = this.ledger.families.find(
          (item) => inspection.sourceId && item.members.includes(inspection.sourceId)
        )
        family ??= this.ledger.families.find((item) => item.familyId === inspection.familyId)
        family ??= this.ledger.families.find((item) =>
          item.sources?.some(
            (source) =>
              source.name === snapshot.name &&
              source.digest === derivationContentIdentity(snapshot.files)
          )
        )
        if (!family) {
          family = {
            familyId: inspection.familyId ?? randomUUID(),
            originalId: inspection.originalId ?? inspection.sourceId,
            members: inspection.sourceId ? [inspection.sourceId] : [],
            sources: [{ name: snapshot.name, digest: derivationContentIdentity(snapshot.files) }]
          }
          this.ledger.families.push(family)
        }
        const record: CopyRecord = {
          copyId,
          owner,
          requestId,
          familyId: family?.familyId ?? inspection.familyId ?? randomUUID(),
          originalId: family?.originalId ?? inspection.originalId ?? inspection.sourceId,
          parentCopyId: inspection.parentCopyId,
          upstream: inspection.parentCopyId
            ? this.upstreamFor(this.record(inspection.parentCopyId, owner))
            : { root: inspection.root, pluginId: inspection.sourceId, digest: snapshot.digest },
          name,
          sourceName: snapshot.name,
          sourceDigest: snapshot.digest,
          digest: created.digest,
          status: "created",
          createdAt: new Date().toISOString(),
          fileCount: created.files.length,
          excluded: snapshot.excluded,
          warnings: this.warnings(created),
          businessNotes: await readFile(join(temporary, "source", DERIVATION_NOTES), "utf8"),
          changes: files.flatMap((file) => {
            const before = snapshot.files.find((source) => source.path === file.path)!.digest
            return before === file.digest ? [] : [{ path: file.path, before, after: file.digest }]
          })
        }
        await writeFile(join(temporary, "receipt.json"), JSON.stringify(record), { flag: "wx" })
        guard()
        renameSync(temporary, final)
        this.ledger.copies.push(record)
        this.persist()
        return this.view(record)
      } finally {
        if (dirname(temporary) === this.root && temporary.startsWith(join(this.root, ".creating-")))
          await rm(temporary, { recursive: true, force: true })
      }
    })
  }
  async saveNotes(owner: string, copyId: string, text: string, digest: string, guard: () => void) {
    if (typeof text !== "string" || Buffer.byteLength(text) > 64 * 1024) throw Error("业务说明过长")
    return this.saveFile(owner, copyId, DERIVATION_NOTES, text, digest, guard)
  }
  async check(owner: string, copyId: string, guard: () => void) {
    return this.locked(async () => {
      const record = this.record(copyId, owner)
      const snapshot = await snapshotDerivationSource(this.sourcePath(copyId, owner))
      if (snapshot.name !== record.name) throw Error("副本名称已在源码改变，请创建新的独立副本")
      await this.deps.validatePackage?.(snapshot.root)
      if ((await snapshotDerivationSource(snapshot.root)).digest !== snapshot.digest)
        throw Error("源码已变化，请重新检查")
      guard()
      record.digest = snapshot.digest
      record.fileCount = snapshot.files.length
      record.businessNotes =
        snapshot.files.find((file) => file.path === DERIVATION_NOTES)?.bytes.toString("utf8") ?? ""
      record.status =
        record.pluginId && this.deps.plugins().some((plugin) => plugin.id === record.pluginId)
          ? "installed"
          : "checked"
      record.warnings = this.warnings(snapshot)
      this.persist()
      return this.view(record)
    })
  }
  async install(owner: string, copyId: string, digest: string, guard: () => void) {
    return this.locked(async () => {
      const record = this.record(copyId, owner)
      guard()
      if (record.pluginId && this.deps.plugins().some((plugin) => plugin.id === record.pluginId))
        return this.view(record)
      if (record.status !== "checked" || record.digest !== digest) throw Error("请先重新检查插件")
      const snapshot = await snapshotDerivationSource(this.sourcePath(copyId, owner))
      if (snapshot.digest !== digest || snapshot.name !== record.name)
        throw Error("源码已变化，请重新检查")
      const temporary = await mkdtemp(join(this.root, ".installing-"))
      const pluginId = record.pluginId ?? randomUUID()
      try {
        await writeDerivationFiles(temporary, snapshot.files)
        guard()
        // Persist the host lineage before catalog publication. An orphan disabled member is inert.
        let family = this.ledger.families.find((item) => item.familyId === record.familyId)
        if (!family) {
          family = {
            familyId: record.familyId,
            originalId: record.originalId,
            members: record.originalId ? [record.originalId] : []
          }
          this.ledger.families.push(family)
        }
        if (!family.members.includes(pluginId)) family.members.push(pluginId)
        record.pluginId = pluginId
        this.persist()
        const result = await this.deps.install(
          temporary,
          record.name,
          pluginId,
          guard,
          async (directory) => {
            const installed = await snapshotDerivationSource(directory)
            if (installed.digest !== digest) throw Error("安装文件与已检查副本不一致")
            const currentSource = await snapshotDerivationSource(this.sourcePath(copyId, owner))
            if (currentSource.digest !== digest) throw Error("源码已变化，请重新检查")
            guard()
          }
        )
        if (!result.success) throw Error(result.error ?? "安装失败")
        record.status = "installed"
        record.installedDigest = digest
        this.persist()
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
}
