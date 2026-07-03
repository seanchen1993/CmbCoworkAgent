import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Download,
  FileText,
  Loader2,
  Network,
  RefreshCw,
  Route,
  ShieldCheck,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { Thread } from "@/types"

type TaskMmdSettings = Awaited<ReturnType<typeof window.api.taskMmd.getSettings>>
type TaskMmdSnapshot = Awaited<ReturnType<typeof window.api.taskMmd.getSnapshot>>
type TaskMmdCompileModelInfo = Awaited<ReturnType<typeof window.api.taskMmd.getCompileModelInfo>>
type TaskMmdEntry = TaskMmdSnapshot["entries"][number]
type GraphTooltip = { text: string; x: number; y: number; nodeId: string | null }

const ANSI_ESCAPE = String.fromCharCode(27)
const ANSI_BEL = String.fromCharCode(7)
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${ANSI_ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${ANSI_BEL}]*(?:${ANSI_BEL}|${ANSI_ESCAPE}\\\\)|[@-Z\\\\-_])`,
  "g"
)

interface TaskMmdPanelProps {
  currentThreadId?: string | null
  threads: Thread[]
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(value: string | null): string {
  if (!value) return "尚未生成"
  return new Date(value).toLocaleString()
}

function formatTier(tier: "economy" | "premium" | null): string {
  if (!tier) return "未解析"
  return tier === "economy" ? "经济" : "高级"
}

function formatModelSource(source: TaskMmdCompileModelInfo["source"]): string {
  switch (source) {
    case "tier":
      return "按档位"
    case "routing":
      return "按路由"
    case "fallback":
      return "已回退"
    case "none":
      return "无可用模型"
  }
}

function formatBaseUrl(value: string | null): string {
  if (!value) return "未配置服务地址"
  try {
    const url = new URL(value)
    return url.host || value
  } catch {
    return value
  }
}

function exportText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function shortThreadId(threadId: string): string {
  return threadId.length > 8 ? threadId.slice(0, 8) : threadId
}

function truncateTooltip(value: string, maxChars = 1600): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars).trimEnd()}\n...`
}

function stripAnsiText(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "")
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  }
  return value.replace(/&(#(\d+)|#x([\da-f]+)|[a-z]+);/gi, (match, entity, decimal, hex) => {
    if (decimal) return String.fromCodePoint(Number(decimal))
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16))
    return named[String(entity).toLowerCase()] ?? match
  })
}

function cleanGraphLabel(value: string): string {
  return stripAnsiText(decodeHtmlEntities(value))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
}

function extractMmdNodeLabels(mmd: string): Map<string, string> {
  const labels = new Map<string, string>()
  const patterns = [
    /(?:^|[\s>;])([A-Za-z_][\w-]*)\s*\[\s*"((?:\\.|[^"])*)"\s*\]/gm,
    /(?:^|[\s>;])([A-Za-z_][\w-]*)\s*\(\s*"((?:\\.|[^"])*)"\s*\)/gm,
    /(?:^|[\s>;])([A-Za-z_][\w-]*)\s*\{\s*"((?:\\.|[^"])*)"\s*\}/gm,
    /(?:^|[\s>;])([A-Za-z_][\w-]*)\s*\[\s*([^\]\n]+?)\s*\]/gm,
    /(?:^|[\s>;])([A-Za-z_][\w-]*)\s*\(\s*([^)\n]+?)\s*\)/gm,
    /(?:^|[\s>;])([A-Za-z_][\w-]*)\s*\{\s*([^}\n]+?)\s*\}/gm
  ]

  for (const pattern of patterns) {
    for (const match of mmd.matchAll(pattern)) {
      const nodeId = match[1]
      const rawLabel = match[2]
      if (!nodeId || !rawLabel || labels.has(nodeId)) continue
      labels.set(nodeId, cleanGraphLabel(rawLabel.replace(/\\"/g, '"')))
    }
  }

  return labels
}

function mermaidDomNodeId(rawId: string | null): string | null {
  if (!rawId) return null
  const withoutPrefix = rawId.replace(/^flowchart-/, "")
  const withoutSuffix = withoutPrefix.replace(/-\d+$/, "")
  return withoutSuffix || rawId
}

function graphNodeVisibleText(node: SVGGElement): string {
  return Array.from(node.childNodes)
    .filter((child) => child.nodeName.toLowerCase() !== "title")
    .map((child) => child.textContent ?? "")
    .join(" ")
}

function closestGraphNode(target: EventTarget | null, root: HTMLElement): SVGGElement | null {
  if (!(target instanceof Element)) return null
  const node = target.closest<SVGGElement>("g.node")
  return node && root.contains(node) ? node : null
}

function tooltipPosition(clientX: number, clientY: number): { x: number; y: number } {
  const margin = 12
  const tooltipWidth = 420
  const tooltipHeight = 260
  const maxX = Math.max(margin, window.innerWidth - tooltipWidth - margin)
  const maxY = Math.max(margin, window.innerHeight - tooltipHeight - margin)
  return {
    x: Math.max(margin, Math.min(clientX + 14, maxX)),
    y: Math.max(margin, Math.min(clientY + 14, maxY))
  }
}

function tooltipPositionForNode(node: SVGGElement): { x: number; y: number } {
  const rect = node.getBoundingClientRect()
  const prefersRight = rect.right + 440 < window.innerWidth
  const x = prefersRight ? rect.right + 12 : rect.left
  const y = rect.bottom + 10
  return tooltipPosition(x - 14, y - 14)
}

function entrySearchText(entry: TaskMmdEntry): string {
  return stripAnsiText([entry.toolName, entry.argsPreview, entry.resultPreview].join(" ")).toLowerCase()
}

function scoreEntryForLabel(label: string, entry: TaskMmdEntry): number {
  const normalizedLabel = label
    .replace(/status:\s*\w+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  if (!normalizedLabel) return 0

  const haystack = entrySearchText(entry)
  const toolName = entry.toolName.toLowerCase()
  let score = 0
  if (normalizedLabel.length >= 4 && haystack.includes(normalizedLabel)) score += 10
  if (normalizedLabel.includes(toolName) || toolName.includes(normalizedLabel)) score += 8

  const terms = Array.from(
    new Set(
      normalizedLabel
        .split(/[^\w\u4e00-\u9fa5./:\\-]+/)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3 && !["status", "done", "doing", "paused", "blocked"].includes(term))
    )
  ).slice(0, 12)

  for (const term of terms) {
    if (haystack.includes(term)) score += 1
  }
  return score
}

function findEntryForGraphNode(
  nodeId: string | null,
  label: string,
  entries: TaskMmdEntry[],
  isFallbackGraph: boolean
): TaskMmdEntry | null {
  if (isFallbackGraph && nodeId) {
    const numbered = /^N(\d+)$/.exec(nodeId)
    if (numbered) {
      const recent = entries.slice(-12)
      const entry = recent[Number(numbered[1]) - 1]
      if (entry) return entry
    }
  }

  let best: { entry: TaskMmdEntry; score: number } | null = null
  for (const entry of entries) {
    const score = scoreEntryForLabel(label, entry)
    if (score > (best?.score ?? 0)) best = { entry, score }
  }
  return best && best.score >= 3 ? best.entry : null
}

function buildEntryTooltip(entry: TaskMmdEntry): string {
  const status = entry.status === "error" ? "失败" : "成功"
  const lines = [
    `执行：${stripAnsiText(entry.toolName)}`,
    `范围：${entry.scope} · 状态：${status} · 耗时：${entry.durationMs}ms`,
    `时间：${new Date(entry.timestamp).toLocaleString()}`
  ]
  if (entry.argsPreview) lines.push(`参数：${stripAnsiText(entry.argsPreview)}`)
  if (entry.resultPreview) lines.push(`结果：${stripAnsiText(entry.resultPreview)}`)
  return truncateTooltip(lines.join("\n"))
}

function buildGraphTooltip(label: string, entry: TaskMmdEntry | null): string {
  const lines: string[] = []
  if (label) lines.push(label)
  if (entry) lines.push(buildEntryTooltip(entry))
  return truncateTooltip(stripAnsiText(lines.join("\n\n")))
}

function getThreadTitle(thread: Thread): string {
  return (
    thread.title ||
    (typeof thread.metadata?.title === "string" ? thread.metadata.title : "") ||
    "未命名会话"
  )
}

function getThreadSubtitle(thread: Thread): string {
  const workspacePath =
    typeof thread.metadata?.workspacePath === "string" ? thread.metadata.workspacePath : ""
  const updatedAt = new Date(thread.updated_at).toLocaleString()
  return workspacePath ? `${updatedAt} · ${workspacePath}` : updatedAt
}

function EntryRow({ entry }: { entry: TaskMmdEntry }): React.JSX.Element {
  const preview = stripAnsiText(entry.resultPreview || entry.argsPreview || "(empty)")
  const toolName = stripAnsiText(entry.toolName)

  return (
    <div className="rounded-md border border-border/70 bg-background px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            entry.status === "error" ? "bg-destructive" : "bg-emerald-500"
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={toolName}>
          {toolName}
        </span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {entry.scope}
        </span>
      </div>
      <p
        className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground"
        title={preview}
      >
        {preview}
      </p>
      <p className="mt-1 text-[10px] text-muted-foreground/70">
        {new Date(entry.timestamp).toLocaleTimeString()} · {entry.durationMs}ms
      </p>
    </div>
  )
}

export function TaskMmdPanel({ currentThreadId, threads }: TaskMmdPanelProps): React.JSX.Element {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    currentThreadId ?? threads[0]?.thread_id ?? null
  )
  const [settings, setSettings] = useState<TaskMmdSettings | null>(null)
  const [snapshot, setSnapshot] = useState<TaskMmdSnapshot | null>(null)
  const [compileModelInfo, setCompileModelInfo] = useState<TaskMmdCompileModelInfo | null>(null)
  const [directorySize, setDirectorySize] = useState(0)
  const [svg, setSvg] = useState("")
  const [renderError, setRenderError] = useState<string | null>(null)
  const [graphTooltip, setGraphTooltip] = useState<GraphTooltip | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const mountedRef = useRef(true)
  const graphRef = useRef<HTMLDivElement | null>(null)
  const graphTooltipRef = useRef<HTMLDivElement | null>(null)
  const tooltipHideTimerRef = useRef<number | null>(null)
  const tooltipHoverRef = useRef(false)
  const tooltipInteractingRef = useRef(false)
  const renderId = useMemo(() => `task-mmd-${Math.random().toString(36).slice(2)}`, [])
  const selectedThread = useMemo(
    () => threads.find((thread) => thread.thread_id === selectedThreadId) ?? null,
    [selectedThreadId, threads]
  )
  const threadId = selectedThreadId
  const currentSettings = settings
  const state = snapshot?.state
  const entries = snapshot?.entries ?? []
  const isViewingCurrentThread = Boolean(threadId && threadId === currentThreadId)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const cancelGraphTooltipHide = useCallback(() => {
    if (tooltipHideTimerRef.current == null) return
    window.clearTimeout(tooltipHideTimerRef.current)
    tooltipHideTimerRef.current = null
  }, [])

  const forceHideGraphTooltip = useCallback(() => {
    cancelGraphTooltipHide()
    tooltipHoverRef.current = false
    tooltipInteractingRef.current = false
    setGraphTooltip(null)
  }, [cancelGraphTooltipHide])

  const scheduleGraphTooltipHide = useCallback(
    (delayMs = 220) => {
      cancelGraphTooltipHide()
      tooltipHideTimerRef.current = window.setTimeout(() => {
        tooltipHideTimerRef.current = null
        if (!tooltipHoverRef.current && !tooltipInteractingRef.current) {
          setGraphTooltip(null)
        }
      }, delayMs)
    },
    [cancelGraphTooltipHide]
  )

  const handleGraphTooltipEnter = useCallback(() => {
    tooltipHoverRef.current = true
    cancelGraphTooltipHide()
  }, [cancelGraphTooltipHide])

  const handleGraphTooltipLeave = useCallback(() => {
    tooltipHoverRef.current = false
    scheduleGraphTooltipHide(650)
  }, [scheduleGraphTooltipHide])

  const handleGraphTooltipPointerDown = useCallback(() => {
    tooltipHoverRef.current = true
    tooltipInteractingRef.current = true
    cancelGraphTooltipHide()
  }, [cancelGraphTooltipHide])

  const handleGraphTooltipPointerUp = useCallback(() => {
    if (!tooltipInteractingRef.current) return
    tooltipInteractingRef.current = false
    if (!tooltipHoverRef.current) scheduleGraphTooltipHide(650)
  }, [scheduleGraphTooltipHide])

  useEffect(() => {
    window.addEventListener("pointerup", handleGraphTooltipPointerUp)
    window.addEventListener("pointercancel", handleGraphTooltipPointerUp)
    return () => {
      window.removeEventListener("pointerup", handleGraphTooltipPointerUp)
      window.removeEventListener("pointercancel", handleGraphTooltipPointerUp)
      cancelGraphTooltipHide()
    }
  }, [cancelGraphTooltipHide, handleGraphTooltipPointerUp])

  useEffect(() => {
    if (selectedThreadId && threads.some((thread) => thread.thread_id === selectedThreadId)) {
      return
    }
    setSelectedThreadId(currentThreadId ?? threads[0]?.thread_id ?? null)
  }, [currentThreadId, selectedThreadId, threads])

  // Clear stale data when switching threads so we never show another
  // thread's snapshot/graph during the brief reload.
  useEffect(() => {
    setSnapshot(null)
    setCompileModelInfo(null)
    setDirectorySize(0)
    setSvg("")
    setRenderError(null)
  }, [threadId])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const nextSettings = await window.api.taskMmd.getSettings()
      if (!mountedRef.current) return
      setSettings(nextSettings)

      if (!threadId) {
        setSnapshot(null)
        setCompileModelInfo(null)
        setDirectorySize(0)
        return
      }

      const [nextSnapshot, nextSize, nextModelInfo] = await Promise.all([
        window.api.taskMmd.getSnapshot(threadId),
        window.api.taskMmd.getDirectorySize(threadId),
        window.api.taskMmd.getCompileModelInfo(threadId)
      ])
      if (!mountedRef.current) return
      setSnapshot(nextSnapshot)
      setCompileModelInfo(nextModelInfo)
      setDirectorySize(nextSize)
    } catch (error) {
      console.error(error)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [threadId])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    return window.api.taskMmd.onChanged((payload) => {
      if (!payload.threadId || payload.threadId === threadId) {
        loadData()
      }
    })
  }, [loadData, threadId])

  useEffect(() => {
    if (!settings?.enabled || !threadId) return
    const id = window.setInterval(() => {
      loadData()
    }, 5000)
    return () => window.clearInterval(id)
  }, [loadData, settings?.enabled, threadId])

  useEffect(() => {
    let cancelled = false
    async function render(): Promise<void> {
      const mmd = stripAnsiText(snapshot?.mmd?.trim() ?? "")
      if (!mmd) {
        setSvg("")
        setRenderError(null)
        setGraphTooltip(null)
        return
      }
      try {
        const mermaid = await import("mermaid")
        mermaid.default.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
            primaryColor: "#eef6ff",
            primaryBorderColor: "#5b8def",
            primaryTextColor: "#172033",
            lineColor: "#7a8496",
            secondaryColor: "#f5f7fb",
            tertiaryColor: "#fff7ed"
          },
          flowchart: {
            htmlLabels: true,
            nodeSpacing: 36,
            rankSpacing: 52,
            padding: 14,
            useMaxWidth: false
          }
        })
        const result = await mermaid.default.render(renderId, mmd)
        if (!cancelled) {
          setSvg(result.svg)
          setRenderError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setSvg("")
          setRenderError(error instanceof Error ? error.message : String(error))
        }
      }
    }
    render()
    return () => {
      cancelled = true
    }
  }, [renderId, snapshot?.mmd])

  useEffect(() => {
    forceHideGraphTooltip()

    const root = graphRef.current
    if (!root || !svg) return

    const svgElement = root.querySelector<SVGSVGElement>("svg")
    if (svgElement) {
      const viewBox = svgElement.viewBox.baseVal
      if (viewBox.width > 0) {
        svgElement.style.width = `${Math.ceil(viewBox.width)}px`
        svgElement.setAttribute("width", String(Math.ceil(viewBox.width)))
      }
      if (viewBox.height > 0) {
        svgElement.style.height = `${Math.ceil(viewBox.height)}px`
        svgElement.setAttribute("height", String(Math.ceil(viewBox.height)))
      }
      svgElement.style.maxWidth = "none"
      svgElement.style.overflow = "visible"
      svgElement.style.display = "block"
      svgElement.setAttribute("preserveAspectRatio", "xMinYMin meet")
    }

    const nodeLabels = extractMmdNodeLabels(snapshot?.mmd ?? "")
    const isFallbackGraph = snapshot?.state.lastCompileMode === "fallback"
    const nodes = Array.from(root.querySelectorAll<SVGGElement>("g.node"))
    const tooltipByNode = new WeakMap<SVGGElement, string>()

    for (const node of nodes) {
      const nodeId = mermaidDomNodeId(node.getAttribute("id"))
      const label = cleanGraphLabel(
        (nodeId ? nodeLabels.get(nodeId) : "") || graphNodeVisibleText(node)
      )
      const entry = findEntryForGraphNode(nodeId, label, entries, isFallbackGraph)
      const tooltip = buildGraphTooltip(label, entry)
      if (!tooltip) continue

      node.style.cursor = "help"
      node.setAttribute("tabindex", "0")
      node.setAttribute("role", "img")
      node.setAttribute("aria-label", tooltip.replace(/\s+/g, " "))
      Array.from(node.children)
        .filter((child) => child.tagName.toLowerCase() === "title")
        .forEach((child) => child.remove())
      tooltipByNode.set(node, tooltip)
    }

    const hideTooltip = (): void => scheduleGraphTooltipHide(450)
    const hideTooltipSoon = (): void => scheduleGraphTooltipHide(650)
    const hideTooltipNow = (): void => forceHideGraphTooltip()
    const hideTooltipOnOutsideScroll = (event: Event): void => {
      const target = event.target
      if (target instanceof Node && graphTooltipRef.current?.contains(target)) return
      hideTooltipNow()
    }
    const showTooltip = (node: SVGGElement): void => {
      const tooltip = tooltipByNode.get(node)
      if (!tooltip) {
        hideTooltip()
        return
      }
      tooltipHoverRef.current = false
      tooltipInteractingRef.current = false
      cancelGraphTooltipHide()
      const nodeId = mermaidDomNodeId(node.getAttribute("id"))
      const position = tooltipPositionForNode(node)
      setGraphTooltip((current) => {
        if (
          current?.nodeId === nodeId &&
          current.text === tooltip &&
          current.x === position.x &&
          current.y === position.y
        ) {
          return current
        }
        return { text: tooltip, nodeId, ...position }
      })
    }
    const onPointerOver = (event: PointerEvent): void => {
      const node = closestGraphNode(event.target, root)
      if (!node) {
        hideTooltip()
        return
      }
      showTooltip(node)
    }
    const onPointerOut = (event: PointerEvent): void => {
      const node = closestGraphNode(event.target, root)
      if (!node) return
      if (event.relatedTarget instanceof Element && node.contains(event.relatedTarget)) return
      hideTooltip()
    }
    const onFocusIn = (event: FocusEvent): void => {
      const node = closestGraphNode(event.target, root)
      if (!node) {
        hideTooltip()
        return
      }
      showTooltip(node)
    }

    root.addEventListener("pointerover", onPointerOver)
    root.addEventListener("pointerout", onPointerOut)
    root.addEventListener("mouseleave", hideTooltip)
    root.addEventListener("pointerleave", hideTooltip)
    root.addEventListener("scroll", hideTooltipNow)
    root.addEventListener("focusin", onFocusIn)
    root.addEventListener("focusout", hideTooltipSoon)
    window.addEventListener("blur", hideTooltipNow)
    window.addEventListener("scroll", hideTooltipOnOutsideScroll, true)

    return () => {
      root.removeEventListener("pointerover", onPointerOver)
      root.removeEventListener("pointerout", onPointerOut)
      root.removeEventListener("mouseleave", hideTooltip)
      root.removeEventListener("pointerleave", hideTooltip)
      root.removeEventListener("scroll", hideTooltipNow)
      root.removeEventListener("focusin", onFocusIn)
      root.removeEventListener("focusout", hideTooltipSoon)
      window.removeEventListener("blur", hideTooltipNow)
      window.removeEventListener("scroll", hideTooltipOnOutsideScroll, true)
      forceHideGraphTooltip()
    }
  }, [
    cancelGraphTooltipHide,
    entries,
    forceHideGraphTooltip,
    scheduleGraphTooltipHide,
    snapshot?.mmd,
    snapshot?.state.lastCompileMode,
    svg
  ])

  const updateSettings = useCallback(async (patch: Partial<TaskMmdSettings>) => {
    setSaving(true)
    try {
      const next = await window.api.taskMmd.setSettings(patch)
      if (mountedRef.current) setSettings(next)
    } catch (error) {
      console.error(error)
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [])

  const clearThread = useCallback(async () => {
    if (!threadId) return
    if (!confirm("确定清空所选会话的任务画布吗？此操作不可撤销。")) return
    await window.api.taskMmd.clearThread(threadId)
    await loadData()
  }, [loadData, threadId])

  return (
    <div className="isolate flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 w-[340px] shrink-0 flex-col border-r border-border">
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 border-b border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-base font-bold">任务画布</h2>
                <p className="truncate text-xs text-muted-foreground">
                  {threadId ? `线程 ${shortThreadId(threadId)}` : "未选择会话"}
                </p>
              </div>
              <button
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-xs transition-colors",
                  currentSettings?.enabled
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : "border-border bg-muted text-muted-foreground"
                )}
                disabled={!currentSettings || saving}
                onClick={() => updateSettings({ enabled: !currentSettings?.enabled })}
              >
                {currentSettings?.enabled ? "已启用" : "已禁用"}
              </button>
            </div>

            <div className="rounded-md border border-border/70 bg-muted/30 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <p>
                任务画布会把会话里的工具调用摘要整理成流程图，帮助 Agent
                在长任务和上下文压缩后记住已完成步骤、阻塞点和继续方向。
              </p>
              <p className="mt-1">设置全局生效；画布内容按会话单独保存，只保存脱敏摘要。</p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-[11px] font-medium text-muted-foreground">查看会话</label>
                {isViewingCurrentThread ? (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                    当前主页会话
                  </span>
                ) : null}
              </div>
              {threads.length > 0 ? (
                <Select
                  value={threadId ?? undefined}
                  onValueChange={(value) => setSelectedThreadId(value)}
                >
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue placeholder="选择会话" />
                  </SelectTrigger>
                  <SelectContent className="max-w-[360px]">
                    {threads.map((thread) => (
                      <SelectItem
                        key={thread.thread_id}
                        value={thread.thread_id}
                        textValue={getThreadTitle(thread)}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{getThreadTitle(thread)}</span>
                          <span className="truncate text-[10px] text-muted-foreground">
                            {shortThreadId(thread.thread_id)} ·{" "}
                            {new Date(thread.updated_at).toLocaleString()}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="rounded-md border border-dashed border-border p-2 text-xs text-muted-foreground">
                  暂无会话，开始一次对话后会生成任务画布数据。
                </div>
              )}
              {selectedThread ? (
                <p className="line-clamp-2 text-[10px] leading-relaxed text-muted-foreground">
                  {getThreadSubtitle(selectedThread)}
                </p>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-md border border-border/70 bg-muted/30 p-2">
                <p className="text-muted-foreground">工具记录</p>
                <p className="mt-1 text-sm font-semibold">{state?.totalEntryCount ?? 0}</p>
              </div>
              <div className="rounded-md border border-border/70 bg-muted/30 p-2">
                <p className="text-muted-foreground">目录大小</p>
                <p className="mt-1 text-sm font-semibold">{formatSize(directorySize)}</p>
              </div>
              <div className="col-span-2 rounded-md border border-border/70 bg-muted/30 p-2">
                <p className="text-muted-foreground">最近编译</p>
                <p className="mt-1 truncate text-xs font-medium">
                  {formatDate(state?.lastCompiledAt ?? null)}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="block text-[11px] font-medium text-muted-foreground">
                编译模型
              </label>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-border/70 bg-muted/30 p-1">
                {(["economy", "premium"] as const).map((tier) => (
                  <button
                    key={tier}
                    className={cn(
                      "rounded-sm px-2 py-1.5 text-xs transition-colors",
                      currentSettings?.compileModelTier === tier
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-background/60"
                    )}
                    disabled={!currentSettings || saving}
                    onClick={() => updateSettings({ compileModelTier: tier })}
                  >
                    {tier === "economy" ? "经济" : "高级"}
                  </button>
                ))}
              </div>
              <div className="rounded-md border border-border/70 bg-muted/30 p-2 text-[11px] leading-relaxed">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-muted-foreground">实际使用</span>
                  <span className="shrink-0 text-muted-foreground">
                    {compileModelInfo ? formatModelSource(compileModelInfo.source) : "正在解析"}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs font-semibold">
                  {compileModelInfo?.name ?? "未配置可用模型"}
                </p>
                <p className="mt-0.5 truncate text-muted-foreground">
                  {compileModelInfo?.model ?? "会使用确定性兜底图谱"}
                </p>
                {compileModelInfo ? (
                  <p className="mt-0.5 truncate text-muted-foreground">
                    {formatTier(compileModelInfo.resolvedTier)} ·{" "}
                    {formatBaseUrl(compileModelInfo.baseUrl)}
                  </p>
                ) : null}
                {compileModelInfo?.reason ? (
                  <p className="mt-1 line-clamp-2 text-muted-foreground">
                    {compileModelInfo.reason}
                  </p>
                ) : null}
              </div>

              <label className="block text-[11px] font-medium text-muted-foreground">
                触发条数
              </label>
              <Input
                type="number"
                min={1}
                max={50}
                value={currentSettings?.l2NullThreshold ?? 4}
                disabled={!currentSettings || saving}
                onChange={(event) =>
                  updateSettings({ l2NullThreshold: Number(event.currentTarget.value) })
                }
              />
              <label className="block text-[11px] font-medium text-muted-foreground">
                触发间隔（秒）
              </label>
              <Input
                type="number"
                min={10}
                max={3600}
                value={currentSettings?.l2TimeoutSeconds ?? 300}
                disabled={!currentSettings || saving}
                onChange={(event) =>
                  updateSettings({ l2TimeoutSeconds: Number(event.currentTarget.value) })
                }
              />
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="flex-1" onClick={loadData}>
                {loading ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3" />
                )}
                刷新
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!snapshot?.mmd}
                onClick={() => exportText("task-map.mmd", snapshot?.mmd ?? "")}
              >
                <Download className="size-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                disabled={!threadId}
                onClick={clearThread}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>

            <div className="rounded-md border border-border/70 bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
              设置为全局生效。编译时只发送脱敏后的工具摘要到所选模型，不保存完整工具结果。
            </div>
          </div>

          <div className="space-y-2 p-2">
            {entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Route className="mb-2 size-8 opacity-40" />
                <p className="text-xs">暂无工具轨迹</p>
              </div>
            ) : (
              entries
                .slice()
                .reverse()
                .map((entry) => <EntryRow key={entry.id} entry={entry} />)
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md border border-border bg-muted/40">
              <Network className="size-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">当前任务画布</h3>
              <p className="truncate text-xs text-muted-foreground">
                {state?.compileStatus === "compiling"
                  ? "编译中"
                  : state?.compileStatus === "error"
                    ? state.lastError || "编译失败"
                    : state?.lastCompileMode === "fallback"
                      ? `使用兜底图谱${state.lastError ? `：${state.lastError}` : ""}`
                      : snapshot?.mmd
                        ? "已生成"
                        : "等待工具调用"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3" />
            <span>仅保存摘要</span>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            {!threadId ? (
              <div className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground">
                请先选择一个会话线程
              </div>
            ) : renderError ? (
              <pre className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive whitespace-pre-wrap">
                {renderError}
              </pre>
            ) : svg ? (
              <div className="relative">
                <div
                  ref={graphRef}
                  className="min-h-[360px] overflow-auto rounded-md border border-border bg-background p-4 [&_.node]:outline-none [&_svg]:max-w-none [&_svg]:overflow-visible"
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
                {graphTooltip ? (
                  <div
                    ref={graphTooltipRef}
                    className="pointer-events-auto fixed z-[100] max-h-72 cursor-text select-text overflow-auto whitespace-pre-wrap rounded-md border border-border bg-popover px-3 py-2 text-[11px] leading-relaxed text-popover-foreground shadow-lg"
                    style={{
                      left: graphTooltip.x,
                      top: graphTooltip.y,
                      width: "min(420px, calc(100vw - 24px))"
                    }}
                    onMouseEnter={handleGraphTooltipEnter}
                    onMouseLeave={handleGraphTooltipLeave}
                    onFocus={handleGraphTooltipEnter}
                    onBlur={handleGraphTooltipLeave}
                    onPointerDown={handleGraphTooltipPointerDown}
                    onPointerUp={handleGraphTooltipPointerUp}
                    onPointerCancel={handleGraphTooltipPointerUp}
                  >
                    {graphTooltip.text}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex min-h-[360px] flex-col items-center justify-center rounded-md border border-dashed border-border text-muted-foreground">
                <FileText className="mb-3 size-8 opacity-40" />
                <p className="text-sm">暂无 Mermaid 图</p>
                <p className="mt-1 text-xs">启用后，执行几次工具调用会自动生成</p>
              </div>
            )}

            {snapshot?.mmd ? (
              <pre
                className="mt-4 overflow-auto rounded-md border border-border/70 bg-muted/30 p-3 text-xs leading-relaxed"
                title={stripAnsiText(snapshot.mmd)}
              >
                {stripAnsiText(snapshot.mmd)}
              </pre>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
