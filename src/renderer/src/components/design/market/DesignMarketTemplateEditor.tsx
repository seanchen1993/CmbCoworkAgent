import { useEffect, useState } from "react"
import {
  AlertTriangle,
  FileArchive,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Lock,
  RotateCcw,
  Save,
  Upload
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DESIGN_MARKET_SCENARIOS,
  type DesignMarketScenario,
  type MarketSystemDetail,
  type MarketTemplateDetail
} from "../../../../../shared/design-market"
import {
  formatCompatibilityRange,
  formatMarketVersion
} from "../../../../../shared/design-market-semver"
import type { DesignTemplateSummary } from "../../../../../shared/design-template"

export function DesignMarketTemplateEditor({
  parentSystem,
  detail,
  onBack,
  onSaved,
  onReloadLatest
}: {
  parentSystem: MarketSystemDetail
  detail: MarketTemplateDetail | null
  onBack: () => void
  onSaved: (next: MarketTemplateDetail, notice?: string) => void
  onReloadLatest: (templateId: string) => Promise<MarketTemplateDetail | null>
}): React.JSX.Element {
  const isCreate = !detail
  const draft = detail?.draft
  const latest = detail?.versions.find((v) => v.versionId === detail.template.latestVersionId)
  const parentVersions = parentSystem.versions

  const [name, setName] = useState(draft?.name ?? detail?.template.name ?? "")
  const [description, setDescription] = useState(
    draft?.description ?? detail?.template.description ?? ""
  )
  const [scenario, setScenario] = useState<DesignMarketScenario>(
    draft?.scenario ?? detail?.template.scenario ?? "列表"
  )
  const [minSystemVersion, setMinSystemVersion] = useState(
    draft?.minSystemVersion ??
      latest?.minSystemVersion ??
      parentSystem.system.latestVersion ??
      parentVersions[0]?.version ??
      "1.0.0"
  )
  const [defaultEntryPath, setDefaultEntryPath] = useState(
    draft?.defaultEntryPath ?? latest?.defaultEntryPath ?? ""
  )
  const [pages, setPages] = useState<string[]>(draft?.pages ?? latest?.pages ?? [])
  const [filesCount, setFilesCount] = useState(draft?.filesCount ?? latest?.filesCount ?? 0)
  const [totalBytes, setTotalBytes] = useState(draft?.totalBytes ?? latest?.bytes ?? 0)
  const [framework, setFramework] = useState(draft?.framework ?? latest?.framework ?? "HTML")
  const [packageFilename, setPackageFilename] = useState(
    draft?.packageFilename ?? (detail ? `${detail.template.name}.zip` : "")
  )
  const [stagedBlobSha256, setStagedBlobSha256] = useState<string | undefined>(
    draft?.stagedBlobSha256 ?? latest?.sha256
  )
  const [coverDataUrl, setCoverDataUrl] = useState(
    draft?.coverDataUrl ?? latest?.coverDataUrl ?? ""
  )
  const [version, setVersion] = useState(
    draft?.version ?? (detail?.template.highestPublishedVersion ? "1.0.1" : "1.0.0")
  )
  const [changelog, setChangelog] = useState(draft?.changelog ?? "")
  const [revision, setRevision] = useState(draft?.revision ?? 1)
  const [warnings, setWarnings] = useState<string[]>([])
  const [localImported, setLocalImported] = useState<DesignTemplateSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)

  useEffect(() => {
    void window.api?.design
      ?.listImportedTemplates?.()
      .then((list) => setLocalImported(list))
      .catch(() => setLocalImported([]))
  }, [])

  useEffect(() => {
    if (detail?.draft?.revision) setRevision(detail.draft.revision)
  }, [detail])

  const applyStaged = (staged: {
    stagedBlobSha256: string
    packageFilename: string
    pages: string[]
    defaultEntryPath: string
    filesCount: number
    totalBytes: number
    framework: string
    coverDataUrl: string
    warnings: string[]
  }) => {
    setStagedBlobSha256(staged.stagedBlobSha256)
    setPackageFilename(staged.packageFilename)
    setPages(staged.pages)
    setDefaultEntryPath(staged.defaultEntryPath)
    setFilesCount(staged.filesCount)
    setTotalBytes(staged.totalBytes)
    setFramework(staged.framework)
    setCoverDataUrl(staged.coverDataUrl)
    setWarnings(staged.warnings)
    if (!name.trim()) {
      setName(staged.packageFilename.replace(/\.zip$/i, ""))
    }
  }

  const pickPackage = async (source: "file" | "directory") => {
    const api = window.api?.designMarket
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.pickAndStageTemplatePackage(source)
      if (res.canceled) return
      if (!res.success || !res.data) {
        setError(res.error || "校验模板包失败")
        return
      }
      applyStaged(res.data)
    } finally {
      setBusy(false)
    }
  }

  const stageFromLocalImported = async (templateId: string) => {
    const item = localImported.find((tpl) => tpl.id === templateId)
    const api = window.api?.designMarket
    if (!item || !api) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.stageLocalTemplatePackage({ id: item.id, entryPath: item.entryPath })
      if (!res.success || !res.data) {
        setError(res.error || "导入本地模板包失败")
        return
      }
      applyStaged(res.data)
      if (!name.trim()) setName(item.name)
    } finally {
      setBusy(false)
    }
  }

  const pickCover = async () => {
    const api = window.api?.designMarket
    if (!api) return
    setError(null)
    const res = await api.pickManualCoverImage()
    if (res.canceled) return
    if (!res.success || !res.data) {
      setError(res.error || "替换封面失败")
      return
    }
    setCoverDataUrl(res.data.coverDataUrl)
  }

  const saveDraft = async (): Promise<MarketTemplateDetail | null> => {
    const api = window.api?.designMarket
    if (!api) return null
    if (!stagedBlobSha256) {
      setError("请先上传模板包文件或目录")
      return null
    }
    setBusy(true)
    setError(null)
    setConflict(false)
    try {
      const res = isCreate
        ? await api.createTemplateDraft({
            systemId: parentSystem.system.systemId,
            name,
            description,
            scenario,
            minSystemVersion,
            defaultEntryPath,
            pages,
            filesCount,
            totalBytes,
            framework,
            packageFilename,
            stagedBlobSha256,
            coverDataUrl,
            version,
            changelog
          })
        : await api.saveTemplateDraft({
            templateId: detail.template.templateId,
            expectedRevision: revision,
            name,
            description,
            scenario,
            minSystemVersion,
            defaultEntryPath,
            pages,
            filesCount,
            totalBytes,
            framework,
            packageFilename,
            stagedBlobSha256,
            coverDataUrl,
            version,
            changelog
          })
      if (!res.success || !res.data) {
        if (res.code === "CONFLICT") setConflict(true)
        setError(res.error || "保存模板草稿失败")
        return null
      }
      setRevision(res.data.draft?.revision ?? revision + 1)
      onSaved(res.data, "已保存模板草稿")
      return res.data
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    const api = window.api?.designMarket
    if (!api) return
    if (!stagedBlobSha256) {
      setError("请先上传模板包文件或目录")
      return
    }
    setBusy(true)
    setError(null)
    setConflict(false)
    try {
      const saved = isCreate
        ? await api.createTemplateDraft({
            systemId: parentSystem.system.systemId,
            name,
            description,
            scenario,
            minSystemVersion,
            defaultEntryPath,
            pages,
            filesCount,
            totalBytes,
            framework,
            packageFilename,
            stagedBlobSha256,
            coverDataUrl,
            version,
            changelog
          })
        : await api.saveTemplateDraft({
            templateId: detail.template.templateId,
            expectedRevision: revision,
            name,
            description,
            scenario,
            minSystemVersion,
            defaultEntryPath,
            pages,
            filesCount,
            totalBytes,
            framework,
            packageFilename,
            stagedBlobSha256,
            coverDataUrl,
            version,
            changelog
          })
      if (!saved.success || !saved.data) {
        if (saved.code === "CONFLICT") setConflict(true)
        setError(saved.error || "发布前保存草稿失败")
        return
      }
      const nextRev = saved.data.draft?.revision ?? revision + 1
      setRevision(nextRev)
      const pubRes = await api.publishTemplate({
        templateId: saved.data.template.templateId,
        expectedRevision: nextRev,
        version,
        changelog
      })
      if (!pubRes.success || !pubRes.data) {
        if (pubRes.code === "CONFLICT") setConflict(true)
        setError(pubRes.error || "发布模板版本失败")
        return
      }
      onSaved(pubRes.data, `已发布模板 ${formatMarketVersion(pubRes.data.template.latestVersion)}`)
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    const api = window.api?.designMarket
    if (!api || !detail) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.discardTemplateDraft(detail.template.templateId)
      if (!res.success || !res.data) {
        setError(res.error || "放弃草稿失败")
        return
      }
      const d = res.data.draft
      if (d) {
        setName(d.name)
        setDescription(d.description)
        setScenario(d.scenario)
        setMinSystemVersion(d.minSystemVersion)
        setDefaultEntryPath(d.defaultEntryPath)
        setPages(d.pages)
        setFilesCount(d.filesCount)
        setTotalBytes(d.totalBytes)
        setFramework(d.framework)
        setPackageFilename(d.packageFilename ?? "")
        setStagedBlobSha256(d.stagedBlobSha256)
        setCoverDataUrl(d.coverDataUrl)
        setVersion(d.version)
        setChangelog(d.changelog)
        setRevision(d.revision)
      }
      onSaved(res.data, "已还原到当前发布版本")
    } finally {
      setBusy(false)
    }
  }

  const toggleStatus = async (status: "published" | "unpublished") => {
    const api = window.api?.designMarket
    if (!api || !detail) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.setTemplateStatus(detail.template.templateId, status)
      if (!res.success || !res.data) {
        setError(res.error || "修改状态失败")
        return
      }
      onSaved(res.data, status === "unpublished" ? "模板已下架" : "模板已重新上架")
    } finally {
      setBusy(false)
    }
  }

  const reloadOnConflict = async () => {
    if (!detail) return
    const fresh = await onReloadLatest(detail.template.templateId)
    if (!fresh?.draft) return
    const d = fresh.draft
    setName(d.name)
    setDescription(d.description)
    setScenario(d.scenario)
    setMinSystemVersion(d.minSystemVersion)
    setDefaultEntryPath(d.defaultEntryPath)
    setPages(d.pages)
    setFilesCount(d.filesCount)
    setTotalBytes(d.totalBytes)
    setFramework(d.framework)
    setPackageFilename(d.packageFilename ?? "")
    setStagedBlobSha256(d.stagedBlobSha256)
    setCoverDataUrl(d.coverDataUrl)
    setVersion(d.version)
    setChangelog(d.changelog)
    setRevision(d.revision)
    setConflict(false)
    setError(null)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onBack}>
            ← 返回 {parentSystem.system.name}
          </button>
          <div className="mt-1 flex items-center gap-2">
            <h2 className="text-2xl font-semibold text-foreground">
              {isCreate ? "上传模板" : "编辑模板"}
            </h2>
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800">
              草稿
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {detail?.template.latestVersionId && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void discard()}>
              <RotateCcw className="size-3.5" />
              放弃草稿
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void saveDraft()}>
            <Save className="size-3.5" />
            保存草稿
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void publish()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            发布新版本
          </Button>
        </div>
      </div>

      {conflict && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-xs text-amber-900">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            <span>模板草稿已在其他窗口更新（已保留你当前的表单输入）。</span>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => void reloadOnConflict()}>
            重新加载最新草稿
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs text-destructive">
          {error}
        </p>
      )}

      {warnings.map((w) => (
        <p key={w} className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs text-amber-900">
          {w}
        </p>
      ))}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(270px,1fr)]">
        <section className="rounded-xl border border-border bg-background-elevated p-5 space-y-4">
          <h3 className="text-sm font-semibold text-foreground">模板内容</h3>

          <label className="block space-y-1.5 text-xs font-medium text-foreground">
            模板名称
            <Input
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：筛选表格"
            />
          </label>

          <div className="space-y-1.5 text-xs font-medium text-foreground">
            <span>所属设计系统</span>
            <div className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <span>{parentSystem.system.name}</span>
              <Lock className="size-3.5" />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              新版本
              <Input
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder="v1.0.0"
              />
            </label>
            <div className="space-y-1.5 text-xs font-medium text-foreground">
              <label className="block space-y-1.5">
                最低适配版本
                <select
                  aria-label="最低适配版本"
                  value={minSystemVersion}
                  onChange={(event) => setMinSystemVersion(event.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
                >
                  {parentVersions.map((ver) => (
                    <option key={ver.versionId} value={ver.version}>
                      {formatMarketVersion(ver.version)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] font-normal text-muted-foreground">
                {formatCompatibilityRange(minSystemVersion)}
              </p>
            </div>
          </div>

          <div className="space-y-2 text-xs">
            <span className="font-medium text-foreground">模板包</span>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <FileArchive className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {packageFilename || "尚未上传模板包"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {stagedBlobSha256
                      ? `${framework} · ${filesCount} 个文件 · ${(totalBytes / 1024 / 1024).toFixed(2)} MB`
                      : "支持 HTML、ZIP 或静态目录（自动检测离线资源完整性）"}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void pickPackage("file")}>
                  <Upload className="size-3.5" />
                  {stagedBlobSha256 ? "替换 HTML / ZIP" : "选择 HTML / ZIP"}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void pickPackage("directory")}>
                  <FolderOpen className="size-3.5" />
                  选择目录
                </Button>
              </div>
            </div>
            {localImported.length > 0 && (
              <select
                aria-label="从本地已导入模板带入"
                defaultValue=""
                disabled={busy}
                onChange={(event) => void stageFromLocalImported(event.target.value)}
                className="h-8 w-full rounded-md border border-border bg-background px-2.5 text-xs"
              >
                <option value="" disabled>
                  或从本地已导入模板带入…
                </option>
                {localImported.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.framework}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              默认入口
              <select
                aria-label="默认入口"
                value={defaultEntryPath}
                onChange={(event) => setDefaultEntryPath(event.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
              >
                {pages.length === 0 ? (
                  <option value="">请先上传模板包</option>
                ) : (
                  pages.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              场景
              <select
                aria-label="模板场景"
                value={scenario}
                onChange={(event) => setScenario(event.target.value as DesignMarketScenario)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
              >
                {DESIGN_MARKET_SCENARIOS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block space-y-1.5 text-xs font-medium text-foreground">
            模板说明
            <Input
              value={description}
              maxLength={200}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="适用于需要组合筛选、分页和批量操作的后台列表。"
            />
          </label>

          <label className="block space-y-1.5 text-xs font-medium text-foreground">
            版本更新说明
            <Input
              value={changelog}
              onChange={(event) => setChangelog(event.target.value)}
              placeholder="说明本次更新的页面或修复项"
            />
          </label>
        </section>

        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-background-elevated p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">资产归属</h3>
              {detail?.template.latestVersionId && detail.template.status !== "admin_removed" && (
                detail.template.status === "published" ? (
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void toggleStatus("unpublished")}>
                    下架模板
                  </Button>
                ) : (
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void toggleStatus("published")}>
                    重新上架
                  </Button>
                )
              )}
            </div>
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">上传者</dt>
                <dd className="flex items-center gap-1.5 font-medium">
                  <span>{detail?.template.ownerName || "当前账号"}</span>
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">我</span>
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">当前发布版本</dt>
                <dd className="font-medium">
                  {detail?.template.latestVersion
                    ? formatMarketVersion(detail.template.latestVersion)
                    : "尚未发布"}
                </dd>
              </div>
            </dl>
            <p className="flex items-center gap-1.5 rounded-lg bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
              <Lock className="size-3.5 shrink-0" />
              只有模板上传者可以保存和发布修改。
            </p>
          </section>

          <section className="rounded-xl border border-border bg-background-elevated p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">模板预览</h3>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void pickCover()}>
                <ImageIcon className="size-3.5" />
                替换封面
              </Button>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-white">
              {coverDataUrl ? (
                <img src={coverDataUrl} alt="模板静态封面预览" className="w-full object-contain" />
              ) : (
                <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
                  上传模板包后将自动生成静态封面
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
