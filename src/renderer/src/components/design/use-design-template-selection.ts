import { useCallback, useEffect, useRef, useState } from "react"
import type {
  DesignTemplatePackage,
  DesignTemplateSummary
} from "../../../../shared/design-template"
import type { DesignCreationSelection } from "./types"

export type DesignPageTemplate = DesignCreationSelection["template"]
type TemplateOption = {
  id: string
  name: string
  description: string
  html: string
  previewPath: string
}
const TEMPLATE_PAGE_SIZE = 4

/** Shared by the creation page and the editor's first-generation template picker. */
export function useDesignTemplateSelection(initial?: DesignPageTemplate | null) {
  const [templateMode, setTemplateMode] = useState<DesignPageTemplate["mode"]>(
    initial?.mode === "upload" ? "upload" : "select"
  )
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(true)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState("")
  const [templatePage, setTemplatePage] = useState(0)
  const [uploadedTemplate, setUploadedTemplate] = useState<DesignTemplatePackage | null>(null)
  const [importedTemplates, setImportedTemplates] = useState<DesignTemplateSummary[]>([])
  const [templateUploading, setTemplateUploading] = useState(Boolean(initial?.package))
  const [templateError, setTemplateError] = useState<string | null>(null)
  const initialRef = useRef(initial)
  const mounted = useRef(false)
  const operation = useRef(0)

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    void window.api.design
      .listTemplates()
      .then((items) => {
        if (cancelled) return
        const next = items.map((item) => ({
          id: item.path,
          name: item.name,
          description: item.description,
          html: item.previewHtml,
          previewPath: item.previewPath
        }))
        // Older sessions have no built-in ID; name + HTML identifies the selected template.
        const prior = initialRef.current
        if (
          prior?.mode === "select" &&
          prior.html &&
          !next.some((item) => item.name === prior.name && item.html === prior.html)
        ) {
          next.unshift({
            id: "session-template",
            name: prior.name || "已关联模板",
            html: prior.html,
            description: "当前会话保存的模板",
            previewPath: ""
          })
        }
        setTemplates(next)
        const index = Math.max(
          0,
          next.findIndex((item) => item.name === prior?.name && item.html === prior?.html)
        )
        setSelectedTemplateId(next[index]?.id ?? "")
        setTemplatePage(Math.floor(index / TEMPLATE_PAGE_SIZE))
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setTemplatesError(error instanceof Error ? error.message : "加载模板列表失败")
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false)
      })
    void window.api.design
      .listImportedTemplates()
      .then((items) => {
        if (!cancelled) setImportedTemplates(items)
      })
      .catch((error) => console.warn("[Design] Imported template list unavailable", error))
    return () => {
      cancelled = true
      mounted.current = false
    }
  }, [])

  const loadPackage = useCallback(
    async (
      read: () => ReturnType<typeof window.api.design.readTemplate>,
      refresh = false
    ): Promise<void> => {
      const token = ++operation.current
      setTemplateUploading(true)
      setTemplateError(null)
      try {
        const result = await read()
        if (!mounted.current || operation.current !== token || result.canceled) return
        if (!result.template) throw new Error(result.error || "无法读取模板包")
        setUploadedTemplate(result.template)
        if (refresh) {
          // A library refresh failure must not discard a successfully imported package.
          const items = await window.api.design.listImportedTemplates().catch(() => null)
          if (mounted.current && operation.current === token && items) setImportedTemplates(items)
        }
      } catch (error) {
        if (mounted.current && operation.current === token)
          setTemplateError(error instanceof Error ? error.message : "加载模板失败")
      } finally {
        if (mounted.current && operation.current === token) setTemplateUploading(false)
      }
    },
    []
  )
  const selectTemplateFile = (source: "file" | "directory" = "file") =>
    loadPackage(() => window.api.design.importTemplate(source), true)
  const readImportedTemplate = useCallback(
    (id: string, entryPath: string) =>
      loadPackage(() => window.api.design.readTemplate({ id, entryPath })),
    [loadPackage]
  )
  useEffect(() => {
    const reference = initialRef.current?.package
    if (reference) void readImportedTemplate(reference.id, reference.entryPath)
  }, [readImportedTemplate])

  const selectedTemplate = templates.find((item) => item.id === selectedTemplateId)
  const templatePageCount = Math.ceil(templates.length / TEMPLATE_PAGE_SIZE)
  const visibleTemplates = templates.slice(
    templatePage * TEMPLATE_PAGE_SIZE,
    (templatePage + 1) * TEMPLATE_PAGE_SIZE
  )
  const selection: DesignPageTemplate = {
    mode: templateMode,
    name:
      templateMode === "select"
        ? (selectedTemplate?.name ?? null)
        : templateMode === "upload"
          ? (uploadedTemplate?.name ?? null)
          : null,
    html:
      templateMode === "select"
        ? (selectedTemplate?.html ?? null)
        : templateMode === "upload"
          ? (uploadedTemplate?.html ?? null)
          : null,
    path:
      templateMode === "upload" && uploadedTemplate
        ? `${uploadedTemplate.rootDir}/${uploadedTemplate.entryPath}`
        : null,
    package:
      templateMode === "upload" && uploadedTemplate
        ? { id: uploadedTemplate.id, entryPath: uploadedTemplate.entryPath }
        : undefined
  }
  const canConfirm =
    !templateUploading &&
    (templateMode === "none" ||
      (templateMode === "upload" ? Boolean(uploadedTemplate) : Boolean(selectedTemplate)))
  return {
    templateMode,
    setTemplateMode,
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
    selectTemplateFile,
    readImportedTemplate,
    selectedTemplate,
    templatePageCount,
    visibleTemplates,
    selection,
    canConfirm
  }
}
