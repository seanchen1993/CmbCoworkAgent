import { ArrowLeft, ArrowRight, FileText, FolderOpen, LoaderCircle, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { HtmlThumbnailPreview } from "@/components/ui/html-thumbnail-preview"
import { cn } from "@/lib/utils"
import { designSystemKey } from "../../../../shared/design-template"
import type { useDesignTemplateSelection } from "./use-design-template-selection"

export function DesignTemplateSelector({
  picker,
  headingId = "template-heading",
  browserPreview = true
}: {
  picker: ReturnType<typeof useDesignTemplateSelection>
  headingId?: string
  browserPreview?: boolean
}) {
  const {
    templateMode,
    setTemplateMode,
    templateScope,
    setTemplateScope,
    hasDesignSystem,
    templates,
    templatesLoading,
    templatesError,
    selectedTemplateId,
    setSelectedTemplateId,
    templatePage,
    setTemplatePage,
    uploadedTemplate,
    importedTemplates,
    templateUploading,
    templateError,
    templateNotice,
    association,
    designSystemOptions,
    setTemplateAssociation,
    selectTemplateFile,
    readImportedTemplate,
    templatePageCount,
    visibleTemplates
  } = picker
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id={headingId} className="text-sm font-semibold text-foreground">
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
          <div
            role="group"
            aria-label="模板归属"
            className="mb-4 inline-flex rounded-md border border-border bg-background p-0.5"
          >
            {(["exclusive", "public"] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                aria-pressed={templateScope === scope}
                onClick={() => setTemplateScope(scope)}
                className={cn(
                  "rounded px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  templateScope === scope
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {scope === "exclusive" ? "专属模板" : "公共模板"}
              </button>
            ))}
          </div>
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
              {templateScope === "exclusive"
                ? hasDesignSystem
                  ? "当前设计系统暂无专属模板，可切换到公共模板。"
                  : "请先选择设计系统，查看其专属模板。"
                : "暂无可用的公共模板。"}
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
                      showBrowserPreview={browserPreview && Boolean(template.previewPath)}
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
                onClick={() => setTemplatePage((page) => Math.min(templatePageCount - 1, page + 1))}
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
              <span className="truncate">
                {uploadedTemplate?.name || "上传 HTML、ZIP 或模板文件夹"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={templateUploading}
                onClick={() => void selectTemplateFile("directory")}
              >
                <FolderOpen className="size-3.5" /> 选择文件夹
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={templateUploading}
                onClick={() => void selectTemplateFile()}
              >
                {templateUploading && <LoaderCircle className="size-3.5 animate-spin" />}
                选择 HTML / ZIP
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            整包保留页面、框架、样式和图片；支持浏览器可直接运行的模板。源码工程请先构建为静态页面。
          </p>
          <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            关联设计系统
            <select
              aria-label="关联设计系统"
              disabled={templateUploading}
              value={association ?? ""}
              className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-foreground"
              onChange={(event) => setTemplateAssociation(event.target.value || null)}
            >
              <option value="">公共模板（不关联设计系统）</option>
              {(["builtin", "user"] as const).map((ownership) => (
                <optgroup
                  key={ownership}
                  label={ownership === "builtin" ? "系统内置" : "我的设计系统"}
                >
                  {designSystemOptions
                    .filter((system) => (system.ownership ?? "builtin") === ownership)
                    .map((system) => (
                      <option key={designSystemKey(system)} value={designSystemKey(system)!}>
                        {system.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          {importedTemplates.length > 0 && (
            <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
              已导入模板
              <select
                aria-label="已导入模板"
                disabled={templateUploading}
                value={uploadedTemplate?.id ?? ""}
                className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-foreground"
                onChange={(event) => {
                  const item = importedTemplates.find(
                    (template) => template.id === event.target.value
                  )
                  if (item) void readImportedTemplate(item.id, item.entryPath)
                }}
              >
                <option value="" disabled>
                  选择已保存的模板
                </option>
                {importedTemplates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} · {template.framework}
                  </option>
                ))}
              </select>
            </label>
          )}
          {uploadedTemplate && (
            <div className="mt-3 space-y-2 text-xs text-muted-foreground">
              <p>
                {uploadedTemplate.framework} · {uploadedTemplate.files.length} 个文件 ·{" "}
                {(uploadedTemplate.totalBytes / 1024 / 1024).toFixed(2)} MB
              </p>
              <label className="flex items-center gap-2">
                页面入口
                <select
                  aria-label="模板页面入口"
                  value={uploadedTemplate.entryPath}
                  disabled={templateUploading}
                  className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1.5 text-foreground"
                  onChange={(event) =>
                    void readImportedTemplate(uploadedTemplate.id, event.target.value)
                  }
                >
                  {uploadedTemplate.pages.map((page) => (
                    <option key={page} value={page}>
                      {page}
                    </option>
                  ))}
                </select>
              </label>
              {uploadedTemplate.warnings.map((warning) => (
                <p key={warning} className="text-amber-700">
                  {warning}
                </p>
              ))}
            </div>
          )}
          {templateError && <p className="mt-2 text-xs text-destructive">{templateError}</p>}
          {uploadedTemplate?.previewUrl && (
            <iframe
              title="上传模板预览"
              key={`${uploadedTemplate.id}:${uploadedTemplate.entryPath}`}
              src={uploadedTemplate.previewUrl}
              sandbox="allow-scripts allow-forms allow-modals"
              referrerPolicy="no-referrer"
              className="mt-4 block h-80 w-full rounded border border-border bg-white"
            />
          )}
        </div>
      )}

      {templateMode === "none" && (
        <p className="mt-4 rounded-lg border border-dashed border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          将根据设计描述从空白页面开始。
        </p>
      )}
      {templateNotice && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {templateNotice}
        </p>
      )}
    </div>
  )
}
