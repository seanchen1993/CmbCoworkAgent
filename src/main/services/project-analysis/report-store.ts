import * as fs from "node:fs"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { RECOMMENDED_REPORT_TEMPLATE_ID } from "../../../shared/project-analysis-report"
import type {
  ProjectReportDocument,
  ProjectReportSummary,
  ProjectReportTemplate,
  ProjectReportVersion
} from "../../../shared/project-analysis-report"
import type { ReportSnapshot } from "./report-data"
import { extractReportTemplate } from "./report-html"
import { recommendedReportTemplate } from "./report-builtin-template"

const idSchema = z.string().uuid()
interface Manifest {
  summary: ProjectReportSummary
  versions: ProjectReportVersion[]
}
interface VersionFile {
  metadata: ProjectReportVersion
  source: string
  html: string
}
export interface SavedReportTemplate extends ProjectReportTemplate {
  layout: string
}

function privateDirectory(path: string) {
  if (!fs.existsSync(path)) fs.mkdirSync(path, { mode: 0o700 })
  const stat = fs.lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("报告私有目录不可用")
}
function readJson<T>(path: string, limit = 10_000_000): T {
  const stat = fs.lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > limit)
    throw new Error("报告文件无效或过大")
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    return JSON.parse(fs.readFileSync(fd, "utf8")) as T
  } finally {
    fs.closeSync(fd)
  }
}
function writeJson(path: string, value: unknown) {
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized) > 10_000_000)
    throw new Error("报告数据过大，请缩小周期或精简版式")
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, serialized, { mode: 0o600, flag: "wx" })
    fs.renameSync(temp, path)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

/** No dependency on the main chat runtime, global Skills catalog or arbitrary file tools. */
export class ProjectReportStore {
  private readonly root: string
  constructor(
    appDirectory: string,
    ownerId: string,
    private readonly canReadRoom: (room: string) => boolean
  ) {
    if (!ownerId.trim()) throw new Error("当前登录身份不可用")
    const base = join(appDirectory, "project-analysis")
    privateDirectory(base)
    this.root = join(base, createHash("sha256").update(ownerId).digest("hex"))
    privateDirectory(this.root)
    privateDirectory(join(this.root, "reports"))
    privateDirectory(join(this.root, "templates"))
  }
  private reportDirectory(id: string) {
    if (!idSchema.safeParse(id).success) throw new Error("无效的报告标识")
    const path = join(this.root, "reports", id)
    const stat = fs.lstatSync(path, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("报告不存在")
    return path
  }
  private manifest(id: string): Manifest {
    const manifest = readJson<Manifest>(join(this.reportDirectory(id), "manifest.json"), 100_000)
    if (manifest.summary.id !== id || !this.canReadRoom(manifest.summary.room))
      throw new Error("无该室报告查看权限")
    return manifest
  }
  private templatePath(id: string) {
    if (!idSchema.safeParse(id).success) throw new Error("无效的模板标识")
    return join(this.root, "templates", `${id}.json`)
  }
  listReports(): ProjectReportSummary[] {
    return fs
      .readdirSync(join(this.root, "reports"))
      .flatMap((id) => {
        if (!idSchema.safeParse(id).success) return []
        try {
          return [this.manifest(id).summary]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  listTemplates(): ProjectReportTemplate[] {
    const { id, name, kind, preferences, createdAt, updatedAt } = recommendedReportTemplate()
    return [{ id, name, kind, preferences, createdAt, updatedAt }, ...this.listPersonalTemplates()]
  }
  private listPersonalTemplates(): ProjectReportTemplate[] {
    return fs
      .readdirSync(join(this.root, "templates"))
      .flatMap((name) => {
        if (!name.endsWith(".json") || name === `${RECOMMENDED_REPORT_TEMPLATE_ID}.json`) return []
        try {
          const {
            id,
            name: title,
            preferences,
            createdAt,
            updatedAt
          } = this.readTemplate(name.slice(0, -5))
          return [{ id, name: title, kind: "personal" as const, preferences, createdAt, updatedAt }]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  readTemplate(id: string): SavedReportTemplate {
    if (id === RECOMMENDED_REPORT_TEMPLATE_ID) return recommendedReportTemplate()
    return { ...readJson<SavedReportTemplate>(this.templatePath(id), 500_000), kind: "personal" }
  }
  read(id: string, requestedVersion?: number): ProjectReportDocument {
    const manifest = this.manifest(id)
    const version = requestedVersion ?? manifest.summary.latestVersion
    const file = this.readVersion(id, version, manifest)
    const snapshot = this.snapshot(id)
    return {
      summary: manifest.summary,
      version: file.metadata,
      versions: manifest.versions,
      html: file.html,
      notes: snapshot.notes
    }
  }
  private readVersion(id: string, version: number, manifest = this.manifest(id)): VersionFile {
    if (!Number.isInteger(version) || !manifest.versions.some((v) => v.version === version))
      throw new Error("报告版本不存在")
    return readJson(join(this.reportDirectory(id), `version-${version}.json`))
  }
  source(id: string, version: number): string {
    return this.readVersion(id, version).source
  }
  snapshot(id: string): ReportSnapshot {
    const manifest = this.manifest(id)
    const snapshot = readJson<ReportSnapshot>(join(this.reportDirectory(id), "snapshot.json"))
    if (snapshot.schema !== 1 || snapshot.scope.upperOrgLv1 !== manifest.summary.room)
      throw new Error("报告快照不匹配")
    return snapshot
  }
  create(
    snapshot: ReportSnapshot,
    output: { source: string; html: string },
    instruction: string,
    modelName: string
  ): ProjectReportDocument {
    if (!this.canReadRoom(snapshot.scope.upperOrgLv1)) throw new Error("无该室报告生成权限")
    if (
      fs.readdirSync(join(this.root, "reports")).filter((x) => idSchema.safeParse(x).success)
        .length >= 100
    )
      throw new Error("已保存100份报告，请删除不再需要的报告后再生成")
    const id = randomUUID(),
      now = new Date().toISOString()
    const metadata: ProjectReportVersion = { version: 1, createdAt: now, instruction, modelName }
    const manifest: Manifest = {
      summary: {
        id,
        title: `${snapshot.scope.upperOrgLv1} · ${snapshot.periodData.period.label} ${snapshot.periodData.period.kind === "week" ? "周报" : "月报"}`,
        room: snapshot.scope.upperOrgLv1,
        selection: snapshot.scope.period,
        period: snapshot.periodData.period,
        dataAsOf: snapshot.periodData.dataAsOf,
        createdAt: now,
        updatedAt: now,
        latestVersion: 1,
        exampleData: snapshot.exampleData
      },
      versions: [metadata]
    }
    const temp = join(this.root, "reports", `.creating-${id}`)
    privateDirectory(temp)
    try {
      writeJson(join(temp, "snapshot.json"), snapshot)
      writeJson(join(temp, "version-1.json"), { ...output, metadata })
      writeJson(join(temp, "manifest.json"), manifest)
      fs.renameSync(temp, join(this.root, "reports", id))
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
    return this.read(id)
  }
  revise(
    id: string,
    baseVersion: number,
    output: { source: string; html: string },
    instruction: string,
    modelName: string
  ): ProjectReportDocument {
    const manifest = this.manifest(id)
    if (manifest.summary.latestVersion !== baseVersion)
      throw new Error("报告已有新版本，请打开最新版本后再修改")
    if (baseVersion >= 20) throw new Error("此报告已达20个版本，请新建报告继续调整")
    const now = new Date().toISOString(),
      version = baseVersion + 1
    const metadata: ProjectReportVersion = { version, createdAt: now, instruction, modelName }
    const path = this.reportDirectory(id)
    writeJson(join(path, `version-${version}.json`), { ...output, metadata })
    writeJson(join(path, "manifest.json"), {
      summary: { ...manifest.summary, updatedAt: now, latestVersion: version },
      versions: [...manifest.versions, metadata]
    })
    return this.read(id)
  }
  saveTemplate(
    reportId: string,
    version: number,
    name: string,
    preferences: string
  ): ProjectReportTemplate {
    if (!name.trim() || name.length > 80 || preferences.length > 4000)
      throw new Error("请输入80字以内的模板名，偏好不超过4000字")
    if (this.listPersonalTemplates().length >= 50)
      throw new Error("已保存50个模板，请先删除不再使用的模板")
    const layout = extractReportTemplate(this.source(reportId, version), this.snapshot(reportId))
    const now = new Date().toISOString()
    const template: ProjectReportTemplate = {
      id: randomUUID(),
      name: name.trim(),
      kind: "personal",
      preferences: preferences.trim(),
      createdAt: now,
      updatedAt: now
    }
    writeJson(this.templatePath(template.id), { ...template, layout })
    return template
  }
  deleteReport(id: string): void {
    this.manifest(id)
    fs.rmSync(this.reportDirectory(id), { recursive: true })
  }
  deleteTemplate(id: string): void {
    if (id === RECOMMENDED_REPORT_TEMPLATE_ID)
      throw new Error("内置推荐不能删除；可在调整报告后保存为自己的模板")
    this.readTemplate(id)
    fs.unlinkSync(this.templatePath(id))
  }
}
