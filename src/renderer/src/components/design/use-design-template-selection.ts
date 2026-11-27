import { useCallback, useEffect, useRef, useState } from "react"
import {
  checkTemplateSystemCompatibility,
  designSystemKey,
  isTemplateVisible,
  type DesignTemplatePackage,
  type DesignTemplateReference,
  type DesignTemplateSummary,
  type TemplateSystemCompatibility
} from "../../../../shared/design-template"
import type { DesignSystemInfo } from "../../../../shared/design-system"
import type { DesignCreationSelection } from "./types"

export type DesignPageTemplate = DesignCreationSelection["template"]
type TemplateScope = "exclusive" | "public"
type TemplateOption = {
  id: string
  name: string
  description: string
  html: string
  previewPath: string
  previewImageDataUrl?: string
  pages?: string[]
  source?: "builtin" | "local" | "market"
  marketVersion?: string
  marketMinSystemVersion?: string
  marketOwnerName?: string
  designSystemKey?: string | null
  package?: DesignTemplateReference
}
const TEMPLATE_PAGE_SIZE = 4

/** Shared by the creation page and the editor's first-generation template picker. */
export function useDesignTemplateSelection(
  initial?: DesignPageTemplate | null,
  currentSystem?: DesignSystemInfo | null,
  systems: DesignSystemInfo[] = [],
  catalogRevision = 0
) {
  const currentKey = designSystemKey(currentSystem)
  const [templateMode, setTemplateMode] = useState<DesignPageTemplate["mode"]>(
    initial?.mode === "none" ? "none" : initial?.mode === "upload" ? "upload" : "select"
  )
  const [templateScope, setScope] = useState<TemplateScope>(
    initial?.mode === "select" && (initial.html || initial.package)
      ? initial.designSystemKey
        ? "exclusive"
        : "public"
      : currentKey
        ? "exclusive"
        : "public"
  )
  const [allTemplates, setTemplates] = useState<TemplateOption[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(true)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState("")
  const [selectedEntryPaths, setSelectedEntryPaths] = useState<Record<string, string>>({})
  const [templatePage, setTemplatePage] = useState(0)
  const [packageSelection, setUploadedTemplate] = useState<DesignTemplatePackage | null>(null)
  const [allImportedTemplates, setImportedTemplates] = useState<DesignTemplateSummary[]>([])
  const [templateUploading, setTemplateUploading] = useState(
    Boolean(initial?.mode === "upload" && initial.package)
  )
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [templateNotice, setTemplateNotice] = useState<string | null>(null)
  const [association, setAssociation] = useState<string | null>(currentKey)
  const initialRef = useRef(initial)
  const mounted = useRef(false)
  const initialLoaded = useRef(false)
  const operation = useRef(0)
  const catalogRevisionRef = useRef(0)
  const context = useRef({ key: currentKey, system: currentSystem, systems, scope: templateScope })
  context.current = { key: currentKey, system: currentSystem, systems, scope: templateScope }
  const uploadedRef = useRef(packageSelection)
  uploadedRef.current = packageSelection

  const mapTemplateOption = useCallback(
    (item: Awaited<ReturnType<typeof window.api.design.listTemplates>>[number]): TemplateOption => ({
      id: item.path,
      name: item.name,
      description: item.description,
      html: item.previewHtml,
      previewPath: item.previewPath,
      previewImageDataUrl: item.previewImageDataUrl,
      pages: item.pages,
      source: item.source,
      marketVersion: item.marketVersion,
      marketMinSystemVersion: item.marketMinSystemVersion,
      marketOwnerName: item.marketOwnerName,
      designSystemKey: item.designSystemKey,
      package: item.package
    }),
    []
  )

  useEffect(() => {
    mounted.current = true
    const operations = operation
    let cancelled = false
    const isInitialLoad = !initialLoaded.current
    initialLoaded.current = true

    void window.api.design
      .listTemplates()
      .then((items) => {
        if (cancelled) return
        const next: TemplateOption[] = items.map(mapTemplateOption)
        const prior = initialRef.current
        // Only legacy inline snapshots need this fallback; a known catalog ID must not bypass filtering.
        if (
          prior?.mode === "select" &&
          prior.html &&
          !prior.builtinPath &&
          !next.some((item) => item.name === prior.name && item.html === prior.html)
        ) {
          next.unshift({
            id: "session-template",
            name: prior.name || "已关联模板",
            html: prior.html,
            description: "当前会话保存的模板",
            previewPath: "",
            designSystemKey: prior.designSystemKey
          })
        }
        setTemplates(next)
        if (isInitialLoad) {
          const available = next.filter((item) => {
            const compat = checkTemplateSystemCompatibility(item, context.current.system)
            return compat.visible && compat.compatible
          })
          const priorItem = next.find((item) =>
            prior?.builtinPath
              ? item.id === prior.builtinPath
              : prior?.package?.id
                ? item.package?.id === prior.package.id
                : item.name === prior?.name && item.html === prior?.html
          )
          const selected =
            prior?.mode === "select"
              ? priorItem
              : available.find((item) =>
                  context.current.scope === "public"
                    ? item.designSystemKey == null
                    : item.designSystemKey != null
                )
          const selectedCompat = selected
            ? checkTemplateSystemCompatibility(selected, context.current.system)
            : null
          if (selected && selectedCompat?.visible && selectedCompat.compatible) {
            setSelectedTemplateId(selected.id)
            if (prior?.package?.entryPath && selected.pages?.includes(prior.package.entryPath)) {
              setSelectedEntryPaths((prev) => ({
                ...prev,
                [selected.id]: prior.package!.entryPath
              }))
            }
            const scope = selected.designSystemKey == null ? "public" : "exclusive"
            setScope(scope)
            const group = next.filter(
              (item) =>
                checkTemplateSystemCompatibility(item, context.current.system).visible &&
                (scope === "public" ? item.designSystemKey == null : item.designSystemKey != null)
            )
            setTemplatePage(
              Math.max(
                0,
                Math.floor(group.findIndex((item) => item.id === selected.id) / TEMPLATE_PAGE_SIZE)
              )
            )
          } else {
            setSelectedTemplateId("")
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && isInitialLoad)
          setTemplatesError(error instanceof Error ? error.message : "加载模板列表失败")
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false)
      })
    void window.api.design
      .listImportedTemplates()
      .then((items) => {
        if (!cancelled && (catalogRevisionRef.current === 0 || !isInitialLoad)) {
          setImportedTemplates(items)
        }
      })
      .catch((error) => console.warn("[Design] Imported template list unavailable", error))
    return () => {
      cancelled = true
      mounted.current = false
      operations.current++
    }
  }, [catalogRevision, mapTemplateOption])

  useEffect(() => {
    setTemplatePage(0)
    setTemplateNotice(null)
    setAssociation(currentKey)
    const selected = allTemplates.find((item) => item.id === selectedTemplateId)
    const compat = selected ? checkTemplateSystemCompatibility(selected, currentSystem) : null
    const keepSelected = Boolean(selected && compat?.visible && compat.compatible)
    setScope(
      keepSelected
        ? selected!.designSystemKey == null
          ? "public"
          : "exclusive"
        : currentKey
          ? "exclusive"
          : "public"
    )
    if (selected && !keepSelected) {
      setSelectedTemplateId("")
      setTemplateNotice(
        compat?.visible && !compat.compatible
          ? `已取消原模板选择：${compat.reason || "不兼容当前设计系统版本"}`
          : "已取消原设计系统的专属模板，请重新选择"
      )
    }
    if (packageSelection && !isTemplateVisible(packageSelection, currentKey)) {
      setUploadedTemplate(null)
      setTemplateNotice("已取消原设计系统的专属模板，请重新选择")
    } else if (packageSelection) setAssociation(packageSelection.designSystemKey ?? null)
    // Context changes reset the pending import. Results use context.current to avoid stale selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, currentSystem?.id, currentSystem?.marketVersion])

  const loadPackage = useCallback(
    async (
      read: () => ReturnType<typeof window.api.design.readTemplate>,
      refresh = false,
      rollbackKey?: string | null
    ): Promise<void> => {
      const token = ++operation.current
      setTemplateUploading(true)
      setTemplateError(null)
      setTemplateNotice(null)
      try {
        const result = await read()
        if (!mounted.current || operation.current !== token || result.canceled) return
        if (!result.template) throw new Error(result.error || "无法读取模板包")
        const template = result.template
        catalogRevisionRef.current++
        if (isTemplateVisible(template, context.current.key)) {
          setUploadedTemplate(template)
          setAssociation(template.designSystemKey ?? null)
        } else {
          setUploadedTemplate(null)
          setAssociation(context.current.key)
          const system = context.current.systems.find(
            (item) => designSystemKey(item) === template.designSystemKey
          )
          setTemplateNotice(`已保存到${system?.name || "对应设计系统"}，切换设计系统后可选用`)
        }
        setImportedTemplates((items) => [
          template,
          ...items.filter((item) => item.id !== template.id)
        ])
        if (refresh) {
          const items = await window.api.design.listImportedTemplates().catch(() => null)
          if (mounted.current && operation.current === token && items) setImportedTemplates(items)
        }
      } catch (error) {
        if (mounted.current && operation.current === token) {
          setTemplateError(error instanceof Error ? error.message : "加载模板失败")
          if (rollbackKey !== undefined)
            setAssociation(
              rollbackKey == null || rollbackKey === context.current.key
                ? rollbackKey
                : context.current.key
            )
        }
      } finally {
        if (mounted.current && operation.current === token) setTemplateUploading(false)
      }
    },
    []
  )
  const selectTemplateFile = (source: "file" | "directory" = "file") =>
    loadPackage(() => window.api.design.importTemplate(source, association), true)
  const readImportedTemplate = useCallback(
    (id: string, entryPath: string) =>
      loadPackage(() => window.api.design.readTemplate({ id, entryPath })),
    [loadPackage]
  )
  const setTemplateAssociation = (key: string | null) => {
    setAssociation(key)
    const template = uploadedRef.current
    if (template)
      void loadPackage(
        () =>
          window.api.design.updateTemplateAssociation(
            { id: template.id, entryPath: template.entryPath },
            key
          ),
        true,
        template.designSystemKey ?? null
      )
  }
  const setTemplateScope = (scope: TemplateScope) => {
    if (scope === templateScope) return
    setScope(scope)
    setTemplatePage(0)
    setSelectedTemplateId("")
    setTemplateNotice(null)
  }
  useEffect(() => {
    const reference = initialRef.current?.mode === "upload" ? initialRef.current.package : undefined
    if (reference) void readImportedTemplate(reference.id, reference.entryPath)
  }, [readImportedTemplate])

  const compatibilityById = new Map<string, TemplateSystemCompatibility>()
  for (const item of allTemplates) {
    compatibilityById.set(item.id, checkTemplateSystemCompatibility(item, currentSystem))
  }
  const getTemplateCompatibility = (id: string): TemplateSystemCompatibility =>
    compatibilityById.get(id) ?? { visible: false, compatible: false }

  const templates = allTemplates.filter((item) => {
    const compat = getTemplateCompatibility(item.id)
    return (
      compat.visible &&
      (templateScope === "public" ? item.designSystemKey == null : item.designSystemKey != null)
    )
  })
  const importedTemplates = allImportedTemplates.filter((item) =>
    isTemplateVisible(item, currentKey)
  )
  const uploadedTemplate =
    packageSelection && isTemplateVisible(packageSelection, currentKey) ? packageSelection : null
  const selectedTemplate = templates.find((item) => item.id === selectedTemplateId)
  const selectedCompat = selectedTemplate ? getTemplateCompatibility(selectedTemplate.id) : null
  const selectedEntryPath =
    selectedTemplate?.package
      ? (selectedEntryPaths[selectedTemplate.id] ?? selectedTemplate.package.entryPath)
      : undefined
  const setMarketTemplateEntryPath = (templateId: string, entryPath: string) => {
    setSelectedEntryPaths((prev) => ({ ...prev, [templateId]: entryPath }))
  }
  const selectTemplateById = (id: string) => {
    const compat = getTemplateCompatibility(id)
    if (!compat.visible || !compat.compatible) return
    setSelectedTemplateId(id)
  }
  const templatePageCount = Math.ceil(templates.length / TEMPLATE_PAGE_SIZE)
  const visibleTemplates = templates.slice(
    templatePage * TEMPLATE_PAGE_SIZE,
    (templatePage + 1) * TEMPLATE_PAGE_SIZE
  )
  const designSystemOptions = Array.from(
    new Map(
      systems
        .filter(
          (item) =>
            item.ownership !== "market" &&
            !item.removedFromPicker &&
            (item.isLatest !== false || item.id === currentSystem?.id)
        )
        .map((item) => [designSystemKey(item), item])
    ).values()
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
      templateMode === "select" && selectedTemplate?.package
        ? {
            ...selectedTemplate.package,
            entryPath: selectedEntryPath ?? selectedTemplate.package.entryPath
          }
        : templateMode === "upload" && uploadedTemplate
          ? { id: uploadedTemplate.id, entryPath: uploadedTemplate.entryPath }
          : undefined,
    builtinPath:
      templateMode === "select" && selectedTemplate && selectedTemplate.id !== "session-template"
        ? selectedTemplate.id
        : undefined,
    designSystemKey:
      templateMode === "select"
        ? (selectedTemplate?.designSystemKey ?? null)
        : templateMode === "upload"
          ? (uploadedTemplate?.designSystemKey ?? null)
          : null
  }
  const canConfirm =
    !templateUploading &&
    (templateMode === "none" ||
      (templateMode === "upload"
        ? Boolean(uploadedTemplate)
        : Boolean(selectedTemplate && selectedCompat?.compatible)))
  return {
    templateMode,
    setTemplateMode,
    templateScope,
    setTemplateScope,
    hasDesignSystem: currentKey !== null,
    templates,
    templatesLoading,
    templatesError,
    selectedTemplateId,
    setSelectedTemplateId: selectTemplateById,
    selectedEntryPath,
    setMarketTemplateEntryPath,
    getTemplateCompatibility,
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
    selectedTemplate,
    templatePageCount,
    visibleTemplates,
    selection,
    canConfirm
  }
}
