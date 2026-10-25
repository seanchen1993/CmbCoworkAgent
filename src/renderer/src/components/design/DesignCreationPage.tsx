import { useEffect, useState } from "react"
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FileCode2,
  FileText,
  FolderOpen,
  LoaderCircle,
  PencilLine,
  Upload,
  X
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { HtmlThumbnailPreview } from "@/components/ui/html-thumbnail-preview"
import { cn } from "@/lib/utils"
import type {
  DesignCreationSelection,
  DesignSessionKind,
  DesignSystemInfo,
  FileAttachment
} from "./types"
import { getDetailCode } from "@/api/leanstar-requirements"
import { NamespaceTreeSelector, type NamespaceTreeSelection } from "./RequirementCascadeSelector"

type SelectionMode = "select" | "upload" | "none"

type UploadedFile = {
  name: string
  path: string
  html?: string
  attachment?: FileAttachment
}

type TemplateOption = {
  id: string
  name: string
  description: string
  html: string
  previewPath: string
}

const TEMPLATE_PAGE_SIZE = 4

function getPathName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

const CREATION_METHODS: Array<{
  id: DesignSessionKind
  label: string
  description: string
  icon: typeof PencilLine
}> = [
  {
    id: "prompt",
    label: "从描述开始",
    description: "输入目标和页面要求，进入问答生成流程。",
    icon: PencilLine
  },
  {
    id: "import_url",
    label: "通过链接还原",
    description: "抓取现有页面并进入可编辑画布。",
    icon: ExternalLink
  },
  {
    id: "import_html",
    label: "导入 HTML",
    description: "选择本地 HTML 文件，保留可用的页面资源。",
    icon: FileCode2
  },
  {
    id: "prototype_zip",
    label: "原型压缩包",
    description: "导入原型压缩包并生成可预览页面。",
    icon: Archive
  }
]

export function DesignCreationPage({
  onBack,
  onEnterDesign,
  workspacePath,
  workspaceLoading,
  onSelectWorkspace,
  designSystemGroups,
  selectedDesignSystemId,
  onDesignSystemChange,
  importingSource,
  onImportUrl,
  onImportHtml,
  onImportPrototypeZip
}: {
  onBack: () => void
  onEnterDesign: (selection: DesignCreationSelection) => void
  workspacePath: string | null
  workspaceLoading: boolean
  onSelectWorkspace: () => void
  designSystemGroups: Array<{ label: string; items: DesignSystemInfo[] }>
  selectedDesignSystemId: string | null
  onDesignSystemChange: (id: string | null) => void
  importingSource: "url" | "html" | "prototype_zip" | null
  onImportUrl: () => void
  onImportHtml: () => void
  onImportPrototypeZip: () => void
}): React.JSX.Element {
  const [templateMode, setTemplateMode] = useState<SelectionMode>("select")
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(true)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState("")
  const [templatePage, setTemplatePage] = useState(0)
  const [uploadedTemplate, setUploadedTemplate] = useState<UploadedFile | null>(null)
  const [templateUploading, setTemplateUploading] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [requirementMode, setRequirementMode] = useState<SelectionMode>("select")
  const [requirementSelection, setRequirementSelection] = useState<NamespaceTreeSelection | null>(
    null
  )
  const [uploadedRequirement, setUploadedRequirement] = useState<UploadedFile | null>(null)
  const [requirementUploading, setRequirementUploading] = useState(false)
  const [requirementError, setRequirementError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.design
      .listTemplates()
      .then((items) => {
        if (cancelled) return
        const nextTemplates = items.map((item) => ({
          id: item.path,
          name: item.name,
          description: item.description,
          html: item.previewHtml,
          previewPath: item.previewPath
        }))
        setTemplates(nextTemplates)
        setSelectedTemplateId(nextTemplates[0]?.id ?? "")
        setTemplatePage(0)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setTemplatesError(error instanceof Error ? error.message : "加载模板列表失败")
        }
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const busy = workspaceLoading || importingSource !== null
  const canStart = !busy && !templateUploading && !requirementUploading

  const selectTemplateFile = async (): Promise<void> => {
    setTemplateUploading(true)
    setTemplateError(null)
    try {
      const picked = await window.api.file.selectCode()
      if (picked.canceled || picked.filePaths.length === 0) return
      const htmlPath = picked.filePaths.find((filePath) => /\.html?$/i.test(filePath))
      if (!htmlPath) {
        setTemplateError("请选择 HTML 文件，以便在这里预览模板。")
        return
      }
      const result = await window.api.file.readText(htmlPath)
      if (!result.success || !result.content) {
        setTemplateError(result.error || "无法读取模板文件。")
        return
      }
      setUploadedTemplate({
        name: result.filename || getPathName(htmlPath),
        path: htmlPath,
        html: result.content
      })
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : "上传模板失败")
    } finally {
      setTemplateUploading(false)
    }
  }

  const selectRequirementFile = async (): Promise<void> => {
    setRequirementUploading(true)
    setRequirementError(null)
    try {
      const picked = await window.api.file.select()
      if (picked.error) throw new Error(picked.error)
      if (picked.canceled || picked.files.length === 0) return
      const { filePath, grant } = picked.files[0]
      const parsed = await window.api.file.parseSelected({ filePath, grant })
      if (!parsed.success || !parsed.attachment) {
        throw new Error(parsed.error || "无法读取需求文件")
      }
      setUploadedRequirement({
        name: getPathName(filePath),
        path: filePath,
        attachment: parsed.attachment
      })
    } catch (error) {
      setRequirementError(error instanceof Error ? error.message : "上传需求文件失败")
    } finally {
      setRequirementUploading(false)
    }
  }

  const selectedTemplate = templates.find((item) => item.id === selectedTemplateId)
  const selectedDesignSystem = designSystemGroups
    .flatMap((group) => group.items)
    .find((system) => system.id === selectedDesignSystemId)
  const templatePageCount = Math.ceil(templates.length / TEMPLATE_PAGE_SIZE)
  const visibleTemplates = templates.slice(
    templatePage * TEMPLATE_PAGE_SIZE,
    (templatePage + 1) * TEMPLATE_PAGE_SIZE
  )
  const getTemplateSummary = (): string => {
    if (templateMode === "none") return "模板：不选择"
    if (templateMode === "upload") return `模板：上传 ${uploadedTemplate?.name || "尚未选择"}`
    return `模板：${selectedTemplate?.name || "未选择"}`
  }

  const getRequirementSummary = (): string => {
    if (requirementMode === "none") return "需求：不绑定"
    if (requirementMode === "upload") return `需求：上传 ${uploadedRequirement?.name || "尚未选择"}`
    if (!requirementSelection) return "需求：未选择"
    const detailCount = requirementSelection.implementationDetails.length
    return `需求：${requirementSelection.requirement.title} · ${requirementSelection.pathName}${detailCount ? `（${detailCount} 项实施详情）` : ""}`
  }

  const handleStart = (): void => {
    if (!canStart) return
    const templateHtml =
      templateMode === "select"
        ? (selectedTemplate?.html ?? null)
        : templateMode === "upload"
          ? (uploadedTemplate?.html ?? null)
          : null
    const templateName =
      templateMode === "select"
        ? (selectedTemplate?.name ?? null)
        : templateMode === "upload"
          ? (uploadedTemplate?.name ?? null)
          : null
    onEnterDesign({
      method: "prompt",
      workspacePath,
      template: {
        mode: templateMode,
        name: templateName,
        html: templateHtml,
        path: templateMode === "upload" ? (uploadedTemplate?.path ?? null) : null
      },
      requirement: {
        mode: requirementMode,
        namespaceId:
          requirementMode === "select" ? (requirementSelection?.namespaceId ?? null) : null,
        pathName: requirementMode === "select" ? (requirementSelection?.pathName ?? null) : null,
        requirement:
          requirementMode === "select" && requirementSelection
            ? {
                code: requirementSelection.requirement.code,
                title: requirementSelection.requirement.title
              }
            : null,
        implementationDetails:
          requirementMode === "select" && requirementSelection
            ? requirementSelection.implementationDetails.map((detail) => ({
                title: detail.title,
                code: getDetailCode(detail)
              }))
            : [],
        path: requirementMode === "upload" ? (uploadedRequirement?.path ?? null) : null,
        attachment: requirementMode === "upload" ? (uploadedRequirement?.attachment ?? null) : null
      },
      designSystemId: selectedDesignSystemId
    })
  }
  const handleCreationMethodClick = (nextMethod: DesignSessionKind): void => {
    if (nextMethod === "import_url") onImportUrl()
    if (nextMethod === "import_html") onImportHtml()
    if (nextMethod === "prototype_zip") onImportPrototypeZip()
  }

  const handleRequirementModeChange = (mode: SelectionMode): void => {
    setRequirementMode(mode)
    if (mode !== "select") setRequirementSelection(null)
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#fffdfb]">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-background-elevated px-6 py-3 lg:px-8">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} aria-label="返回设计历史">
          <ArrowLeft className="size-4" />
          返回设计历史
        </Button>
        <span className="text-xs text-muted-foreground">/</span>
        <span className="text-sm font-semibold text-foreground">新建设计</span>
      </header>

      <main className="min-h-0 flex-1 overflow-auto px-6 py-8 lg:px-10">
        <div className="mx-auto w-full max-w-[1100px]">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold tracking-[0.14em] text-primary">DESIGN WORKSPACE</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">新建设计</h1>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              选择创建方式后进入设计编辑器。
            </p>
          </div>

          <section className="mt-7 rounded-xl border border-border bg-background-elevated p-5 shadow-sm">
            <div className="flex flex-wrap items-center gap-3">
              <FolderOpen className="size-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">工作目录</h2>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {workspaceLoading ? "选择中..." : workspacePath || "尚未选择"}
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={workspaceLoading}
                onClick={onSelectWorkspace}
              >
                <FolderOpen className="size-3.5" />
                {workspacePath ? "切换目录" : "选择目录"}
              </Button>
            </div>
          </section>

          {designSystemGroups.length > 0 && (
            <section className="mt-6 rounded-xl border border-border bg-background-elevated p-5 shadow-sm">
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_300px] md:items-center">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">设计系统</h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    创建或导入后会固定到本次设计中，进入编辑器后可继续使用现有设计系统能力。
                  </p>
                </div>
                <select
                  aria-label="设计系统"
                  value={selectedDesignSystemId ?? ""}
                  onChange={(event) => onDesignSystemChange(event.target.value || null)}
                  title={
                    selectedDesignSystem
                      ? `设计系统: ${selectedDesignSystem.path}`
                      : "不注入设计系统"
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">无设计系统</option>
                  {designSystemGroups.map(({ label: category, items: systems }) => (
                    <optgroup key={category} label={category}>
                      {systems.map((system) => (
                        <option key={system.id} value={system.id}>
                          {system.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            </section>
          )}

          <section className="mt-6">
            <h2 className="mb-3 text-sm font-semibold text-foreground">创建方式</h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {CREATION_METHODS.map((item) => {
                const Icon = item.icon
                const active = item.id === "prompt"
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    disabled={busy}
                    aria-busy={importingSource === (item.id === "import_html" ? "html" : item.id)}
                    onClick={() => handleCreationMethodClick(item.id)}
                    className={cn(
                      "flex min-h-[122px] items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:cursor-wait disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-primary bg-primary/5 shadow-[0_0_0_3px_rgba(196,149,106,0.12)]"
                        : "border-border bg-background-elevated hover:border-border-emphasis hover:bg-muted/25"
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-lg",
                        active
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {importingSource === (item.id === "import_html" ? "html" : item.id) ? (
                        <LoaderCircle className="size-4 animate-spin" />
                      ) : (
                        <Icon className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-xs font-semibold text-foreground">
                        {item.label}
                      </span>
                      <span className="mt-2 block text-[11px] leading-5 text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <>
            <section
              className="mt-6 border-t border-border pt-6"
              aria-labelledby="template-heading"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 id="template-heading" className="text-sm font-semibold text-foreground">
                    选择模板
                  </h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    模板会作为页面结构和信息层级的起点。
                  </p>
                </div>
                <div
                  className="inline-flex rounded-md border border-border bg-background p-0.5"
                  role="group"
                  aria-label="模板来源"
                >
                  {(["select", "upload", "none"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={templateMode === mode}
                      onClick={() => setTemplateMode(mode)}
                      className={cn(
                        "rounded px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        templateMode === mode
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {mode === "select" ? "选择模板" : mode === "upload" ? "上传模板" : "不选模板"}
                    </button>
                  ))}
                </div>
              </div>

              {templateMode === "select" && (
                <div className="mt-4">
                  {templatesLoading ? (
                    <div className="flex h-48 items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 text-xs text-muted-foreground">
                      <LoaderCircle className="size-3.5 animate-spin" /> 正在加载模板...
                    </div>
                  ) : templatesError ? (
                    <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                      {templatesError}
                    </p>
                  ) : templates.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                      未找到可预览的 HTML 模板。
                    </p>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {visibleTemplates.map((template) => {
                        const active = template.id === selectedTemplateId
                        return (
                          <div
                            key={template.id}
                            className={cn(
                              "overflow-hidden rounded-lg border text-left transition-colors",
                              active
                                ? "border-primary bg-primary/5 shadow-[0_0_0_2px_rgba(196,149,106,0.12)]"
                                : "border-border bg-background hover:border-border-emphasis"
                            )}
                          >
                            <HtmlThumbnailPreview
                              html={template.html}
                              title={`${template.name}模板预览`}
                              className="h-50"
                              onSelect={() => setSelectedTemplateId(template.id)}
                              browserUrl={template.previewPath}
                            />
                            <button
                              type="button"
                              aria-pressed={active}
                              onClick={() => setSelectedTemplateId(template.id)}
                              className="flex w-full cursor-pointer gap-2 border-t border-border px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            >
                              <FileText className="mt-0.5 size-3.5 shrink-0 text-primary" />
                              <span className="min-w-0">
                                <span className="block text-xs font-semibold text-foreground">
                                  {template.name}
                                </span>
                                <span className="mt-0.5 block h-8 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                                  {template.description}
                                </span>
                              </span>
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {templatePageCount > 1 && (
                    <div className="mt-4 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                      <button
                        type="button"
                        aria-label="上一页模板"
                        title="上一页"
                        disabled={templatePage === 0}
                        onClick={() => setTemplatePage((page) => Math.max(0, page - 1))}
                        className="inline-flex size-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ArrowLeft className="size-3.5" />
                      </button>
                      <span className="min-w-16 text-center">
                        第 {templatePage + 1} / {templatePageCount} 页
                      </span>
                      <button
                        type="button"
                        aria-label="下一页模板"
                        title="下一页"
                        disabled={templatePage >= templatePageCount - 1}
                        onClick={() =>
                          setTemplatePage((page) => Math.min(templatePageCount - 1, page + 1))
                        }
                        className="inline-flex size-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ArrowRight className="size-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {templateMode === "upload" && (
                <div className="mt-4 rounded-lg border border-dashed border-border bg-muted/20 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                      <Upload className="size-4 text-primary" />{" "}
                      <span className="truncate">{uploadedTemplate?.name || "上传 HTML 模板"}</span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={templateUploading}
                      onClick={() => void selectTemplateFile()}
                    >
                      {templateUploading && <LoaderCircle className="size-3.5 animate-spin" />}
                      选择文件
                    </Button>
                  </div>
                  {templateError && (
                    <p className="mt-2 text-xs text-destructive">{templateError}</p>
                  )}
                  {uploadedTemplate?.html && (
                    <iframe
                      title="上传模板预览"
                      srcDoc={uploadedTemplate.html}
                      sandbox=""
                      className="mt-4 block h-48 w-full rounded border border-border bg-white"
                    />
                  )}
                </div>
              )}

              {templateMode === "none" && (
                <p className="mt-4 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                  将根据设计描述从空白页面开始。
                </p>
              )}
            </section>

            <section
              className="mt-6 border-t border-border pt-6"
              aria-labelledby="requirement-heading"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 id="requirement-heading" className="text-sm font-semibold text-foreground">
                    选择需求
                  </h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    选择组织树中的叶子命名空间作为本次设计的系统。
                  </p>
                </div>
                <div
                  className="inline-flex rounded-md border border-border bg-background p-0.5"
                  role="group"
                  aria-label="需求来源"
                >
                  {(["select", "upload", "none"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={requirementMode === mode}
                      onClick={() => handleRequirementModeChange(mode)}
                      className={cn(
                        "rounded px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        requirementMode === mode
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {mode === "select"
                        ? "选择已有需求"
                        : mode === "upload"
                          ? "上传需求文件"
                          : "不绑定需求"}
                    </button>
                  ))}
                </div>
              </div>

              {requirementMode === "select" && (
                <NamespaceTreeSelector
                  value={requirementSelection}
                  onChange={setRequirementSelection}
                />
              )}

              {requirementMode === "upload" && (
                <div className="mt-4 rounded-lg border border-dashed border-border bg-muted/20 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                      <FileText className="size-4 text-primary" />{" "}
                      <span className="truncate">
                        {uploadedRequirement?.name || "上传需求文件"}
                      </span>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={requirementUploading}
                      onClick={() => void selectRequirementFile()}
                    >
                      {requirementUploading && <LoaderCircle className="size-3.5 animate-spin" />}
                      选择文件
                    </Button>
                  </div>
                  {requirementError && (
                    <p role="alert" className="mt-2 text-xs text-destructive">
                      {requirementError}
                    </p>
                  )}
                  {uploadedRequirement && (
                    <button
                      type="button"
                      onClick={() => setUploadedRequirement(null)}
                      className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <X className="size-3.5" />
                      移除文件
                    </button>
                  )}
                </div>
              )}

              {requirementMode === "none" && (
                <p className="mt-4 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                  不绑定需求，生成流程只会使用上方的设计描述。
                </p>
              )}
            </section>
          </>
        </div>
      </main>

      <footer className="flex shrink-0 items-center justify-end gap-3 border-t border-border bg-background-elevated px-6 py-3 md:justify-between lg:px-10">
        <p className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
          {`${getTemplateSummary()} · ${getRequirementSummary()}`}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onBack}>
            取消
          </Button>
          <Button type="button" disabled={!canStart} onClick={handleStart}>
            进入设计
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </footer>
    </div>
  )
}
