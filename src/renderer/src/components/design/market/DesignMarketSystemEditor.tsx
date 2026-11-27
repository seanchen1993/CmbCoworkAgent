import { useEffect, useState } from "react"
import { AlertTriangle, Loader2, Palette, RotateCcw, Save, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MarkdownPreview } from "@/components/ui/MarkdownPreview/MarkdownPreview"
import {
  DESIGN_MARKET_CATEGORIES,
  type DesignMarketCategory,
  type MarketSystemDetail,
  type MarketSystemPalette
} from "../../../../../shared/design-market"
import { formatMarketVersion } from "../../../../../shared/design-market-semver"
import type { DesignSystemInfo } from "../../../../../shared/design-system"

const DEFAULT_PALETTE: MarketSystemPalette = ["#3B6BE0", "#7E9EF0", "#DAE5FA", "#182B59"]

export function DesignMarketSystemEditor({
  detail,
  onBack,
  onSaved,
  onReloadLatest
}: {
  detail: MarketSystemDetail | null
  onBack: () => void
  onSaved: (next: MarketSystemDetail, notice?: string) => void
  onReloadLatest: (systemId: string) => Promise<MarketSystemDetail | null>
}): React.JSX.Element {
  const isCreate = !detail
  const initialDraft = detail?.draft
  const [name, setName] = useState(initialDraft?.name ?? detail?.system.name ?? "")
  const [description, setDescription] = useState(
    initialDraft?.description ?? detail?.system.description ?? ""
  )
  const [category, setCategory] = useState<DesignMarketCategory>(
    initialDraft?.category ?? detail?.system.category ?? "企业应用"
  )
  const [markdown, setMarkdown] = useState(
    initialDraft?.markdown ??
      detail?.markdown ??
      "# 新设计系统\n\n描述品牌定位、排版与组件规范。\n\n```css\n:root {\n  --accent: #3B6BE0;\n  --primary: #7E9EF0;\n  --surface: #DAE5FA;\n  --fg: #182B59;\n}\n```\n"
  )
  const [palette, setPalette] = useState<MarketSystemPalette>(
    initialDraft?.palette ?? detail?.system.palette ?? DEFAULT_PALETTE
  )
  const [version, setVersion] = useState(
    initialDraft?.version ?? (detail?.system.highestPublishedVersion ? "1.0.1" : "1.0.0")
  )
  const [changelog, setChangelog] = useState(initialDraft?.changelog ?? "")
  const [revision, setRevision] = useState(initialDraft?.revision ?? 1)
  const [localSystems, setLocalSystems] = useState<DesignSystemInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [confirmUnpublish, setConfirmUnpublish] = useState(false)

  useEffect(() => {
    if (!detail) {
      void window.api?.design
        ?.listSystems?.()
        .then((list) =>
          setLocalSystems(
            list.filter((item) => item.ownership !== "market" && item.isLatest !== false)
          )
        )
        .catch(() => setLocalSystems([]))
    }
  }, [detail])

  useEffect(() => {
    if (!detail) return
    setRevision(detail.draft?.revision ?? revision)
  }, [detail])

  const syncPaletteFromMarkdown = async (content: string) => {
    const api = window.api?.designMarket
    if (!api) return
    const extracted = await api.extractPalette(content)
    setPalette(extracted)
  }

  const pickMarkdownFile = async () => {
    const api = window.api?.designMarket
    if (!api) return
    setError(null)
    const res = await api.pickSystemMarkdownFile()
    if (!res.success || !res.data) {
      if (res.error && res.error !== "已取消选择") setError(res.error)
      return
    }
    if (!name.trim()) setName(res.data.name)
    setMarkdown(res.data.markdown)
    setPalette(res.data.palette)
  }

  const importFromLocalSystem = async (localId: string) => {
    if (!localId) return
    setError(null)
    setBusy(true)
    try {
      const readRes = await window.api?.design?.readSystem?.(localId)
      if (!readRes?.success || !readRes.system || !readRes.content) {
        throw new Error(readRes?.error || "读取本地设计系统失败")
      }
      setName(readRes.system.name)
      setDescription(readRes.system.description)
      setMarkdown(readRes.content)
      await syncPaletteFromMarkdown(readRes.content)
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败")
    } finally {
      setBusy(false)
    }
  }

  const handleSaveDraft = async (): Promise<MarketSystemDetail | null> => {
    const api = window.api?.designMarket
    if (!api) return null
    setBusy(true)
    setError(null)
    setConflict(false)
    try {
      const res = isCreate
        ? await api.createSystemDraft({
            name,
            description,
            category,
            markdown,
            palette,
            version,
            changelog
          })
        : await api.saveSystemDraft({
            systemId: detail.system.systemId,
            expectedRevision: revision,
            name,
            description,
            category,
            markdown,
            palette,
            version,
            changelog
          })
      if (!res.success || !res.data) {
        if (res.code === "CONFLICT") setConflict(true)
        setError(res.error || "保存草稿失败")
        return null
      }
      setRevision(res.data.draft?.revision ?? revision + 1)
      onSaved(res.data, "已保存草稿")
      return res.data
    } finally {
      setBusy(false)
    }
  }

  const handlePublish = async () => {
    const api = window.api?.designMarket
    if (!api) return
    setBusy(true)
    setError(null)
    setConflict(false)
    try {
      const saved = isCreate
        ? await api.createSystemDraft({
            name,
            description,
            category,
            markdown,
            palette,
            version,
            changelog
          })
        : await api.saveSystemDraft({
            systemId: detail.system.systemId,
            expectedRevision: revision,
            name,
            description,
            category,
            markdown,
            palette,
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
      const pubRes = await api.publishSystem({
        systemId: saved.data.system.systemId,
        expectedRevision: nextRev,
        version,
        changelog
      })
      if (!pubRes.success || !pubRes.data) {
        if (pubRes.code === "CONFLICT") setConflict(true)
        setError(pubRes.error || "发布设计系统失败")
        return
      }
      onSaved(pubRes.data, `已发布 ${formatMarketVersion(pubRes.data.system.latestVersion)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleDiscard = async () => {
    const api = window.api?.designMarket
    if (!api || !detail) return
    setBusy(true)
    setError(null)
    setConflict(false)
    try {
      const res = await api.discardSystemDraft(detail.system.systemId)
      if (!res.success || !res.data) {
        setError(res.error || "放弃草稿失败")
        return
      }
      const d = res.data.draft
      setName(d?.name ?? res.data.system.name)
      setDescription(d?.description ?? res.data.system.description)
      setCategory(d?.category ?? res.data.system.category)
      setMarkdown(d?.markdown ?? res.data.markdown)
      setPalette(d?.palette ?? res.data.system.palette)
      setVersion(d?.version ?? "1.0.1")
      setChangelog(d?.changelog ?? "")
      setRevision(d?.revision ?? revision + 1)
      onSaved(res.data, "已恢复到当前发布版本")
    } finally {
      setBusy(false)
    }
  }

  const handleToggleStatus = async (status: "published" | "unpublished") => {
    const api = window.api?.designMarket
    if (!api || !detail) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.setSystemStatus(detail.system.systemId, status)
      if (!res.success || !res.data) {
        setError(res.error || "更新上架状态失败")
        return
      }
      setConfirmUnpublish(false)
      onSaved(
        res.data.detail,
        status === "unpublished"
          ? `设计系统已下架，受影响模板 ${res.data.affectedTemplateCount} 个`
          : "设计系统已重新上架"
      )
    } finally {
      setBusy(false)
    }
  }

  const reloadOnConflict = async () => {
    if (!detail) return
    const fresh = await onReloadLatest(detail.system.systemId)
    if (!fresh) return
    setName(fresh.draft?.name ?? fresh.system.name)
    setDescription(fresh.draft?.description ?? fresh.system.description)
    setCategory(fresh.draft?.category ?? fresh.system.category)
    setMarkdown(fresh.draft?.markdown ?? fresh.markdown)
    setPalette(fresh.draft?.palette ?? fresh.system.palette)
    setVersion(fresh.draft?.version ?? "1.0.1")
    setChangelog(fresh.draft?.changelog ?? "")
    setRevision(fresh.draft?.revision ?? 1)
    setConflict(false)
    setError(null)
  }

  const affectedPublishedCount =
    detail?.templates.filter((t) => t.status === "published" && t.visibility === "visible").length ?? 0

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={onBack}>
            ← 返回
          </button>
          <div className="mt-1 flex items-center gap-2">
            <h2 className="text-2xl font-semibold text-foreground">
              {isCreate ? "上传设计系统" : "编辑设计系统"}
            </h2>
            <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800">
              草稿
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {detail?.system.latestVersionId && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void handleDiscard()}>
              <RotateCcw className="size-3.5" />
              放弃草稿
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void handleSaveDraft()}>
            <Save className="size-3.5" />
            保存草稿
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void handlePublish()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            发布新版本
          </Button>
        </div>
      </div>

      {conflict && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-xs text-amber-900">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            <span>检测到草稿在其他位置已更新（已保留你当前的输入，未覆盖）。</span>
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

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(260px,1fr)]">
        <section className="rounded-xl border border-border bg-background-elevated p-5 space-y-4">
          {isCreate && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/25 p-3">
              <Button type="button" size="sm" variant="outline" onClick={() => void pickMarkdownFile()}>
                <Upload className="size-3.5" />
                上传 DESIGN.md
              </Button>
              {localSystems.length > 0 && (
                <select
                  aria-label="从本地设计系统库导入"
                  defaultValue=""
                  onChange={(event) => void importFromLocalSystem(event.target.value)}
                  className="h-8 rounded-md border border-border bg-background px-2.5 text-xs"
                >
                  <option value="" disabled>
                    从本地设计系统库导入…
                  </option>
                  {localSystems.map((sys) => (
                    <option key={sys.id} value={sys.id}>
                      {sys.name} ({sys.ownership === "user" ? `我的 v${sys.version || 1}` : "系统内置"})
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              系统名称
              <Input
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：企业工作台"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              分类
              <select
                aria-label="设计系统分类选择"
                value={category}
                onChange={(event) => setCategory(event.target.value as DesignMarketCategory)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-xs"
              >
                {DESIGN_MARKET_CATEGORIES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              新版本（SemVer）
              <Input
                value={version}
                onChange={(event) => setVersion(event.target.value)}
                placeholder="v1.0.0"
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              系统简介
              <Input
                value={description}
                maxLength={160}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="一句话描述适用场景和规范特色"
              />
            </label>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">展示色板（4 个色块）</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                onClick={() => void syncPaletteFromMarkdown(markdown)}
              >
                <Palette className="size-3.5" />
                从规范提取
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {palette.map((color, idx) => (
                <div key={`pal-${idx}`} className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5">
                  <input
                    type="color"
                    aria-label={`色块 ${idx + 1}`}
                    value={color}
                    onChange={(event) => {
                      const next = [...palette] as MarketSystemPalette
                      next[idx] = event.target.value.toUpperCase()
                      setPalette(next)
                    }}
                    className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={color}
                    onChange={(event) => {
                      const next = [...palette] as MarketSystemPalette
                      next[idx] = event.target.value
                      setPalette(next)
                    }}
                    className="w-full bg-transparent font-mono text-[11px] outline-none"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <label className="space-y-1.5 text-xs font-medium text-foreground">
              规范内容（DESIGN.md）
              <textarea
                value={markdown}
                onChange={(event) => setMarkdown(event.target.value)}
                className="min-h-[300px] w-full rounded-md border border-input bg-background p-3 font-mono text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                spellCheck={false}
              />
            </label>
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-foreground">规范预览</span>
              <div className="max-h-[320px] overflow-auto rounded-md border border-border bg-background p-2">
                <MarkdownPreview content={markdown} showHeader={false} showModeToggle={false} defaultExpanded />
              </div>
            </div>
          </div>

          <label className="block space-y-1.5 text-xs font-medium text-foreground">
            版本更新说明
            <Input
              value={changelog}
              onChange={(event) => setChangelog(event.target.value)}
              placeholder="说明本次版本调整内容"
            />
          </label>
        </section>

        <aside className="space-y-4">
          <section className="rounded-xl border border-border bg-background-elevated p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">资产归属与状态</h3>
              {detail?.system.latestVersionId && detail.system.status !== "admin_removed" && (
                detail.system.status === "published" ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirmUnpublish(true)}
                  >
                    下架系统
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void handleToggleStatus("published")}
                  >
                    重新上架
                  </Button>
                )
              )}
            </div>
            {confirmUnpublish && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2 text-xs">
                <p className="font-medium text-amber-900">
                  确认下架「{detail?.system.name}」？将停止该系统及其 {affectedPublishedCount} 个关联模板的新增市场下载（已有设计继续读取本地版本）。
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" onClick={() => void handleToggleStatus("unpublished")}>
                    确认下架
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmUnpublish(false)}>
                    取消
                  </Button>
                </div>
              </div>
            )}
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">当前发布版本</dt>
                <dd className="font-medium">
                  {detail?.system.latestVersion
                    ? formatMarketVersion(detail.system.latestVersion)
                    : "尚未发布"}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">上架状态</dt>
                <dd className="font-medium">
                  {detail?.system.status === "published"
                    ? "已上架"
                    : detail?.system.status === "admin_removed"
                      ? "平台已下架"
                      : "未上架"}
                </dd>
              </div>
            </dl>
            <p className="rounded-lg bg-muted/40 p-2.5 text-[11px] text-muted-foreground">
              只有设计系统上传者可以保存草稿、发布新版或上下架该系统。
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}
