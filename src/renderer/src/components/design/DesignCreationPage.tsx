import { useEffect, useState } from "react"
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  FileCode2,
  FileText,
  FolderOpen,
  LayoutPanelTop,
  List,
  LoaderCircle,
  PencilLine,
  TableProperties,
  Upload,
  X
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { DesignCreationRequest, DesignSessionKind, DesignSystemInfo } from "./types"
import { getDetailCode } from "@/api/leanstar-requirements"
import { NamespaceTreeSelector, type NamespaceTreeSelection } from "./RequirementCascadeSelector"

type SelectionMode = "select" | "upload" | "none"

type UploadedFile = {
  name: string
  path: string
  html?: string
}

type TemplateOption = {
  id: string
  name: string
  description: string
  icon: typeof LayoutPanelTop
  html: string
}

const TEMPLATE_OPTIONS: TemplateOption[] = [
  {
    id: "detail",
    name: "详情页",
    description: "信息概览、操作区与内容详情",
    icon: LayoutPanelTop,
    html: `<!doctype html><html><body style="margin:0;padding:14px;font:12px Arial;color:#172033;background:#fff"><div style="height:11px;width:45%;background:#dde3ea;border-radius:3px"></div><div style="margin-top:12px;border:1px solid #e4e7ec;border-radius:5px;padding:10px"><div style="height:32px;background:#f6f8fa;border-radius:3px"></div><div style="display:flex;gap:8px;margin-top:10px"><div style="height:48px;flex:1;background:#edf3f9;border-radius:3px"></div><div style="height:48px;flex:1;background:#f7f1e9;border-radius:3px"></div></div><div style="height:8px;width:82%;background:#e8ebef;border-radius:3px;margin-top:12px"></div><div style="height:8px;width:62%;background:#e8ebef;border-radius:3px;margin-top:7px"></div></div></body></html>`
  },
  {
    id: "list",
    name: "列表页",
    description: "筛选、列表项与批量操作",
    icon: List,
    html: `<!doctype html><html><body style="margin:0;padding:14px;font:12px Arial;color:#172033;background:#fff"><div style="display:flex;justify-content:space-between"><div style="height:11px;width:34%;background:#dde3ea;border-radius:3px"></div><div style="height:18px;width:30px;background:#bc8158;border-radius:3px"></div></div><div style="margin-top:12px;height:22px;background:#f4f6f8;border:1px solid #e4e7ec;border-radius:3px"></div><div style="margin-top:9px;border:1px solid #e4e7ec;border-radius:5px">${[1, 2, 3, 4].map((row) => `<div style="height:20px;border-bottom:${row === 4 ? "0" : "1px solid #eef0f2"};display:flex;align-items:center;gap:7px;padding:0 8px"><span style="width:7px;height:7px;background:#ccd5df;border-radius:50%"></span><span style="height:6px;width:${45 + row * 7}%;background:#e5e9ee;border-radius:2px"></span></div>`).join("")}</div></body></html>`
  },
  {
    id: "table-form",
    name: "表格 / 表单",
    description: "数据表格与编辑表单组合",
    icon: TableProperties,
    html: `<!doctype html><html><body style="margin:0;padding:14px;font:12px Arial;color:#172033;background:#fff"><div style="height:11px;width:40%;background:#dde3ea;border-radius:3px"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:12px">${[1, 2, 3, 4].map(() => '<div style="height:17px;border:1px solid #dfe4ea;border-radius:3px;background:#fafbfc"></div>').join("")}</div><div style="margin-top:10px;border:1px solid #e2e6ea;border-radius:4px"><div style="height:14px;background:#f2f4f6"></div>${[1, 2, 3].map(() => '<div style="height:15px;border-top:1px solid #edf0f2"></div>').join("")}</div></body></html>`
  },
  {
    id: "dashboard",
    name: "数据看板",
    description: "指标卡、趋势和数据分布",
    icon: LayoutPanelTop,
    html: `<!doctype html><html><body style="margin:0;padding:14px;font:12px Arial;color:#172033;background:#fff"><div style="height:11px;width:34%;background:#dde3ea;border-radius:3px"></div><div style="display:flex;gap:6px;margin-top:11px">${[1, 2, 3].map(() => '<div style="height:31px;flex:1;border:1px solid #e4e7ec;border-radius:4px;background:#fafbfc"></div>').join("")}</div><div style="display:flex;gap:8px;margin-top:9px"><div style="height:54px;flex:1;border:1px solid #e4e7ec;border-radius:4px;background:linear-gradient(160deg,#fff 55%,#eaf0f6 56%)"></div><div style="height:54px;width:35%;border:1px solid #e4e7ec;border-radius:4px"></div></div></body></html>`
  }
]

function getPathName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

function parsedHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname || "导入设计"
  } catch {
    return "导入设计"
  }
}

function completeCreation(request: DesignCreationRequest): void {
  const sessionId = `ds_${Math.random().toString(36).slice(2, 10)}`
  const tabId = "design-main"
  const now = Date.now()
  const tabState = {
    messages: request.kind === "prompt" ? [] : [{ role: "user", content: request.prompt }],
    html: request.kind === "prompt" ? "" : request.prompt,
    sourceInfo: { kind: request.kind, label: request.title },
    variations: [],
    activeVariationId: null,
    selectedModelId: null,
    tweaksOn: request.kind !== "prompt",
    zoom: 100,
    comments: [],
    drawStrokes: [],
    drawElementHints: [],
    drawNotes: [],
    drawToolMode: "draw",
    codeContext: null,
    designLink: request.url ?? null,
    selectedDesignSystemId: request.designSystemId ?? null,
    rightTab: "design",
    apiHistory: [],
    artifactPath: null,
    artifactMetadata: null,
    variationPanelPosition: null
  }
  localStorage.setItem(
    `design_session_v2_${sessionId}`,
    JSON.stringify({
      chatTabs: [{ id: tabId, label: "Design" }],
      activeTabId: tabId,
      tabStates: { [tabId]: tabState }
    })
  )
  let index: unknown[] = []
  try {
    const parsed = JSON.parse(localStorage.getItem("design_index_v1") || "[]")
    if (Array.isArray(parsed)) index = parsed
  } catch {
    index = []
  }
  localStorage.setItem(
    "design_index_v1",
    JSON.stringify([
      { id: sessionId, title: request.title, createdAt: now, updatedAt: now, kind: request.kind },
      ...index
    ])
  )
  localStorage.setItem("design_last_session", sessionId)
  window.location.reload()
}

function getDesignSystemGroupLabel(label: string | null | undefined): string {
  switch (label) {
    case "Core":
      return "核心"
    case "AI & LLM Platforms":
      return "AI 与大模型平台"
    case "Backend, Database & DevOps":
      return "后端、数据库与 DevOps"
    case "Design & Creative Tools":
      return "设计与创作工具"
    case "Developer Tools & IDEs":
      return "开发工具与 IDE"
    case "E-commerce & Retail":
      return "电商与零售"
    case "Fintech & Crypto":
      return "金融科技与加密"
    case "Media & Consumer Tech":
      return "媒体与消费科技"
    case "Productivity & SaaS":
      return "效率工具与 SaaS"
    case "Automotive":
      return "汽车"
    default:
      return label?.trim() || "其他"
  }
}

const DESIGN_SYSTEM_DISPLAY_ORDER = new Map<string, number>([
  ["wplus", 0],
  ["wealth", 1]
])

function compareDesignSystemsForDisplay(a: DesignSystemInfo, b: DesignSystemInfo): number {
  const aPinned = DESIGN_SYSTEM_DISPLAY_ORDER.get(a.id)
  const bPinned = DESIGN_SYSTEM_DISPLAY_ORDER.get(b.id)
  if (aPinned !== undefined || bPinned !== undefined) {
    return (aPinned ?? Number.MAX_SAFE_INTEGER) - (bPinned ?? Number.MAX_SAFE_INTEGER)
  }
  return a.name.localeCompare(b.name, "zh-CN")
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

export function DesignCreationPage({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [method, setMethod] = useState<DesignSessionKind>("prompt")
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [designSystems, setDesignSystems] = useState<DesignSystemInfo[]>([])
  const [selectedDesignSystemId, setSelectedDesignSystemId] = useState<string | null>(null)
  const [templateMode, setTemplateMode] = useState<SelectionMode>("select")
  const [selectedTemplateId, setSelectedTemplateId] = useState(TEMPLATE_OPTIONS[0].id)
  const [uploadedTemplate, setUploadedTemplate] = useState<UploadedFile | null>(null)
  const [templateUploading, setTemplateUploading] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [requirementMode, setRequirementMode] = useState<SelectionMode>("select")
  const [requirementSelection, setRequirementSelection] = useState<NamespaceTreeSelection | null>(
    null
  )
  const [uploadedRequirement, setUploadedRequirement] = useState<UploadedFile | null>(null)
  const [requirementUploading, setRequirementUploading] = useState(false)
  const [linkModalOpen, setLinkModalOpen] = useState(false)
  const [linkModalText, setLinkModalText] = useState("")
  const [importingKind, setImportingKind] = useState<DesignSessionKind | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.workspace
      .get()
      .then((path) => {
        if (!cancelled) setWorkspacePath(path)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.design
      .listSystems()
      .then((systems) => {
        if (cancelled) return
        setDesignSystems(systems)
        // Keep the standalone page's default in sync with CreateDesignModal.
        setSelectedDesignSystemId(
          systems.find((system) => system.id === "neutral-modern")?.id ?? systems[0]?.id ?? null
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) console.warn("加载设计系统失败", error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selectWorkspace = async (): Promise<void> => {
    setWorkspaceLoading(true)
    try {
      const path = await window.api.workspace.select()
      if (path) setWorkspacePath(path)
    } finally {
      setWorkspaceLoading(false)
    }
  }

  // TODO(design-entry): keep these creation choices aligned with CreateDesignModal until it is removed.
  const canStart = true

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
    } finally {
      setTemplateUploading(false)
    }
  }

  const selectRequirementFile = async (): Promise<void> => {
    setRequirementUploading(true)
    try {
      const picked = await window.api.file.select()
      if (picked.canceled || picked.filePaths.length === 0) return
      const filePath = picked.filePaths[0]
      setUploadedRequirement({ name: getPathName(filePath), path: filePath })
    } finally {
      setRequirementUploading(false)
    }
  }

  const ensureWorkspace = async (): Promise<boolean> => {
    if (workspacePath) return true
    setWorkspaceLoading(true)
    try {
      const path = await window.api.workspace.select()
      if (path) {
        setWorkspacePath(path)
        return true
      }
    } finally {
      setWorkspaceLoading(false)
    }
    return false
  }

  const importHtml = async (): Promise<void> => {
    if (!(await ensureWorkspace())) return
    setImportingKind("import_html")
    setImportError(null)
    try {
      const picked = await window.api.file.selectCode()
      if (picked.canceled || picked.filePaths.length === 0) return
      const htmlPath = picked.filePaths.find((filePath) => /\.html?$/i.test(filePath))
      if (!htmlPath) throw new Error("请选择 .html 或 .htm 文件")
      const result = await window.api.file.readText(htmlPath)
      if (!result.success || !result.content) throw new Error(result.error || "无法读取 HTML 文件")
      completeCreation({
        kind: "import_html",
        workspacePath,
        title: result.filename || getPathName(htmlPath),
        prompt: result.content,
        designSystemId: selectedDesignSystemId
      })
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入 HTML 页面失败")
    } finally {
      setImportingKind(null)
    }
  }

  const importPrototypeZip = async (): Promise<void> => {
    if (!(await ensureWorkspace())) return
    setImportingKind("prototype_zip")
    setImportError(null)
    try {
      const picked = await window.api.file.selectPrototypeZip()
      if (picked.canceled || picked.filePaths.length === 0) return
      const zipPath = picked.filePaths.find((filePath) => /\.zip$/i.test(filePath))
      if (!zipPath) throw new Error("请选择 .zip 压缩包")
      const result = await window.api.design.importPrototypeZip(zipPath)
      if (!result.success || !result.html) throw new Error(result.error || "解析原型图压缩包失败")
      completeCreation({
        kind: "prototype_zip",
        workspacePath,
        title: result.title || getPathName(zipPath),
        prompt: result.html,
        designSystemId: selectedDesignSystemId
      })
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入原型图压缩包失败")
    } finally {
      setImportingKind(null)
    }
  }

  const confirmImportUrl = (): void => {
    const url = linkModalText.trim()
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error()
    } catch {
      setImportError("请输入有效的页面链接")
      return
    }
    setImportingKind("import_url")
    void window.api.design
      .importFromUrl(url)
      .then((result) => {
        if (!result.success || !result.html) throw new Error(result.error || "抓取页面失败")
        setLinkModalOpen(false)
        completeCreation({
          kind: "import_url",
          workspacePath,
          title: result.title || parsedHostname(url),
          prompt: result.html,
          url,
          designSystemId: selectedDesignSystemId
        })
      })
      .catch((error: unknown) => {
        setImportError(error instanceof Error ? error.message : "导入链接页面失败")
      })
      .finally(() => setImportingKind(null))
  }

  const selectedTemplate = TEMPLATE_OPTIONS.find((item) => item.id === selectedTemplateId)
  const orderedDesignSystems = [...designSystems].sort(compareDesignSystemsForDisplay)
  const designSystemGroups = Array.from(
    orderedDesignSystems.reduce((groups, system) => {
      const label = getDesignSystemGroupLabel(system.category || system.source)
      const items = groups.get(label) ?? []
      items.push(system)
      groups.set(label, items)
      return groups
    }, new Map<string, DesignSystemInfo[]>())
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
    const fallbackTitle = method === "prompt" ? "新设计" : "导入设计"
    const basePrompt = "请创建一个现代、清晰且适合桌面端使用的页面。"
    const creationContext =
      method === "prompt"
        ? [
            "",
            "创建上下文：",
            getTemplateSummary(),
            getRequirementSummary(),
            uploadedTemplate?.path && templateMode === "upload"
              ? `模板文件路径：${uploadedTemplate.path}`
              : "",
            templateMode === "select" && selectedTemplate
              ? `页面模板 HTML（请参考其信息结构，不必复刻示例内容）：\n${selectedTemplate.html}`
              : "",
            templateMode === "upload" && uploadedTemplate?.html
              ? `页面模板 HTML（请参考其信息结构，不必复刻示例内容）：\n${uploadedTemplate.html}`
              : "",
            requirementMode === "select" && requirementSelection
              ? [
                  `命名空间：${requirementSelection.pathName}（${requirementSelection.namespaceId}）`,
                  `需求特性：${requirementSelection.requirement.title}（${requirementSelection.requirement.code}）`,
                  requirementSelection.implementationDetails.length > 0
                    ? `特性实施详情：${requirementSelection.implementationDetails.map((detail) => `${detail.title}（${getDetailCode(detail)}）`).join("、")}`
                    : "特性实施详情：暂无"
                ].join("\n")
              : "",
            uploadedRequirement?.path && requirementMode === "upload"
              ? `需求文件路径：${uploadedRequirement.path}`
              : ""
          ]
            .filter(Boolean)
            .join("\n")
        : ""
    completeCreation({
      kind: method,
      workspacePath,
      title: fallbackTitle,
      templateMode: method === "prompt" ? templateMode : undefined,
      template:
        method === "prompt" && templateMode === "select" ? selectedTemplate?.name : undefined,
      templateUploadPath:
        method === "prompt" && templateMode === "upload" ? uploadedTemplate?.path : undefined,
      requirementMode: method === "prompt" ? requirementMode : undefined,
      requirementId:
        method === "prompt" && requirementMode === "select"
          ? requirementSelection?.requirement.code
          : undefined,
      requirementModuleId:
        method === "prompt" && requirementMode === "select"
          ? getDetailCode(requirementSelection?.implementationDetails[0]) || undefined
          : undefined,
      requirementUploadPath:
        method === "prompt" && requirementMode === "upload" ? uploadedRequirement?.path : undefined,
      prompt: `${basePrompt}${creationContext}`,
      designSystemId: selectedDesignSystemId
    })
  }

  const handleCreationMethodClick = (nextMethod: DesignSessionKind): void => {
    if (nextMethod === "prompt") {
      setMethod("prompt")
      return
    }
    if (nextMethod === "import_url") {
      setImportError(null)
      setLinkModalText("")
      setLinkModalOpen(true)
    } else if (nextMethod === "import_html") {
      void importHtml()
    } else {
      void importPrototypeZip()
    }
  }

  const handleRequirementModeChange = (mode: SelectionMode): void => {
    setRequirementMode(mode)
    if (mode !== "select") setRequirementSelection(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#fffdfb]">
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
                onClick={() => void selectWorkspace()}
              >
                <FolderOpen className="size-3.5" />
                {workspacePath ? "切换目录" : "选择目录"}
              </Button>
            </div>
          </section>

          {designSystems.length > 0 && (
            <section className="mt-6 rounded-xl border border-border bg-background-elevated p-5 shadow-sm">
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_300px] md:items-center">
                <div>
                  <h2 className="text-sm font-semibold text-foreground">设计系统</h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    创建或导入后会固定到本次设计中，进入编辑器后可继续使用现有设计系统能力。
                  </p>
                </div>
                <select
                  value={selectedDesignSystemId ?? ""}
                  onChange={(event) => setSelectedDesignSystemId(event.target.value || null)}
                  title={
                    designSystems.find((system) => system.id === selectedDesignSystemId)
                      ? `设计系统: ${designSystems.find((system) => system.id === selectedDesignSystemId)?.path}`
                      : "不注入设计系统"
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground outline-none transition focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">无设计系统</option>
                  {designSystemGroups.map(([category, systems]) => (
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
                const active = item.id === method
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => handleCreationMethodClick(item.id)}
                    className={cn(
                      "flex min-h-[122px] items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
                      <Icon className="size-4" />
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

          {method === "prompt" && (
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
                        {mode === "select"
                          ? "选择模板"
                          : mode === "upload"
                            ? "上传模板"
                            : "不选模板"}
                      </button>
                    ))}
                  </div>
                </div>

                {templateMode === "select" && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    {TEMPLATE_OPTIONS.map((template) => {
                      const Icon = template.icon
                      const active = template.id === selectedTemplateId
                      return (
                        <button
                          key={template.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setSelectedTemplateId(template.id)}
                          className={cn(
                            "overflow-hidden rounded-lg border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active
                              ? "border-primary bg-primary/5 shadow-[0_0_0_2px_rgba(196,149,106,0.12)]"
                              : "border-border bg-background hover:border-border-emphasis"
                          )}
                        >
                          <iframe
                            title={`${template.name}模板预览`}
                            srcDoc={template.html}
                            sandbox=""
                            tabIndex={-1}
                            className="pointer-events-none block h-32 w-full border-0 bg-white"
                          />
                          <span className="flex gap-2 border-t border-border px-3 py-2.5">
                            <Icon className="mt-0.5 size-3.5 shrink-0 text-primary" />
                            <span className="min-w-0">
                              <span className="block text-xs font-semibold text-foreground">
                                {template.name}
                              </span>
                              <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                                {template.description}
                              </span>
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {templateMode === "upload" && (
                  <div className="mt-4 rounded-lg border border-dashed border-border bg-muted/20 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2 text-sm text-foreground">
                        <Upload className="size-4 text-primary" />{" "}
                        <span className="truncate">
                          {uploadedTemplate?.name || "上传 HTML 模板"}
                        </span>
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
          )}
        </div>
      </main>

      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-background-elevated px-6 py-3 lg:px-10">
        <p className="hidden min-w-0 truncate text-xs text-muted-foreground md:block">
          {method === "prompt" ? `${getTemplateSummary()} · ${getRequirementSummary()}` : ""}
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onBack}>
            取消
          </Button>
          <Button type="button" disabled={!canStart} onClick={handleStart}>
            {method === "prompt" ? "进入设计" : "开始设计"}
            <ArrowRight className="size-4" />
          </Button>
        </div>
      </footer>

      {linkModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-5"
          onClick={() => setLinkModalOpen(false)}
        >
          <div
            className="w-full max-w-[480px] rounded-xl bg-background-elevated p-6 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-foreground">🌐 通过链接还原页面</h3>
              <button
                type="button"
                className="text-lg text-muted-foreground hover:text-foreground"
                onClick={() => setLinkModalOpen(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              输入网页链接后，design 会抓取页面 HTML 并还原成可编辑设计。
            </p>
            <input
              autoFocus
              value={linkModalText}
              onChange={(event) => setLinkModalText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") confirmImportUrl()
              }}
              placeholder="https://example.com/page"
              className="mt-4 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {importError && <p className="mt-2 text-xs text-destructive">{importError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setLinkModalOpen(false)}>
                取消
              </Button>
              <Button type="button" onClick={confirmImportUrl}>
                {importingKind === "import_url" ? "还原中..." : "开始还原"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
