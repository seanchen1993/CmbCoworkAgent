import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bot, ExternalLink, Loader2, PanelRightOpen } from "lucide-react"
import { toast } from "sonner"
import { ChatContainer } from "@/components/chat/ChatContainer"
import {
  RequirementThreadSidebar,
  type RequirementSidebarMode
} from "@/components/sidebar/RequirementThreadSidebar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useAppStore } from "@/lib/store"
import { assembleBoundedTextPreview } from "@/lib/text-preview-pages"
import { useThreadState, useThreadStream } from "@/lib/thread-context"
import { cn } from "@/lib/utils"
import {
  beginOpenResourcePreviewIntent,
  emitOpenResourcePreview
} from "@/lib/resource-preview-events"
import type { WorkspaceFilePreviewReadResult } from "../../../../shared/workspace-file-preview"
import {
  fromPersistedRequirement,
  normalizeRequirementHtmlFilePath,
  type NeedDesignChoice,
  isRequirementGenerated,
  isRequirementPublished,
  type RequirementPrdManifest,
  type RequirementRecord
} from "./requirement-data"
import { buildRequirementDesignPrompt, openRequirementDesign } from "@/lib/requirement-design-entry"
import {
  enableRequirementSessionExperts,
  getRequirementSessionCapabilities
} from "./requirement-session-capabilities"
import { RequirementStepsPanel } from "./RequirementStepsPanel"

const REQUIREMENT_SPACE_PUBLISH_MESSAGE = "发布到需求空间"
const LEANSTAR_TOKEN_MESSAGE_PREFIX = "精益之星身份令牌-Token："
const REQUIREMENT_CONTINUATION_MESSAGE = "基于该需求已有资料和历史结论继续沟通。"

type PreviewTab = "expert-process" | "source" | "prd" | "prototype" | "requirement-space"
type PrototypeRoute = "design" | "skip" | null

function getPreviewTabForStep(currentStep: number): PreviewTab {
  if (currentStep >= 5) return "requirement-space"
  if (currentStep >= 4) return "prototype"
  if (currentStep >= 3) return "prd"
  if (currentStep >= 2) return "expert-process"
  return "source"
}

function getPrototypeFunctionKey(functionInfo: { fr: string; file: string }): string {
  return `${functionInfo.fr}:${functionInfo.file}`
}

function normalizePrdFilePath(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/").replace(/^\/+/, "")
  const prdMarker = normalized.toLowerCase().lastIndexOf("/prd/")
  if (prdMarker >= 0) return `/${normalized.slice(prdMarker + 1)}`
  return normalized.toLowerCase() === "prd" || normalized.toLowerCase().startsWith("prd/")
    ? `/${normalized}`
    : `/prd/${normalized}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalizeNeedDesign(value: unknown): NeedDesignChoice {
  if (value === "1" || value === "0") return value
  return ""
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function normalizePrdStatus(value: unknown): RequirementPrdManifest["prd"]["status"] {
  const status = asText(value).trim().toLowerCase()
  return status === "init" || status === "draft" || status === "generated" || status === "published"
    ? status
    : ""
}

function normalizeRequirementSpaceManifest(value: unknown): RequirementPrdManifest {
  const parsed = asRecord(value) ?? {}
  const prd = asRecord(parsed.prd) ?? {}
  const functions = Array.isArray(parsed.functions) ? parsed.functions : []
  const status = normalizePrdStatus(prd.status)
  const fallbackStep =
    status === "published"
      ? 5
      : status === "generated"
        ? 3
        : status === "init" || status === "draft"
          ? 2
          : 1
  return {
    prd: {
      name: asText(prd.name),
      status,
      description: asText(prd.description),
      file: asText(prd.file),
      currentStep:
        typeof prd.currentStep === "number" && Number.isFinite(prd.currentStep)
          ? Math.max(1, Math.min(5, Math.trunc(prd.currentStep)))
          : fallbackStep,
      needDesign: normalizeNeedDesign(prd.needDesign),
      ...(asText(prd.prDetailUrl) ? { prDetailUrl: asText(prd.prDetailUrl) } : {})
    },
    functions: functions.map((item) => {
      const functionInfo = asRecord(item) ?? {}
      const id = asText(functionInfo.id)
      return {
        ...(id ? { id } : {}),
        fr: asText(functionInfo.fr),
        name: asText(functionInfo.name),
        description: asText(functionInfo.description),
        file: asText(functionInfo.file),
        htmlFile: asText(functionInfo.htmlFile),
        htmlId: asText(functionInfo.htmlId),
        needDesign: normalizeNeedDesign(functionInfo.needDesign),
        keywords:
          Array.isArray(functionInfo.keywords) &&
          functionInfo.keywords.every((keyword) => typeof keyword === "string")
            ? [...functionInfo.keywords]
            : []
      }
    })
  }
}

function isRequirementSpacePublished(manifest: RequirementPrdManifest | null): boolean {
  return (
    manifest?.prd.status.toLowerCase() === "published" || Boolean(manifest?.prd.prDetailUrl?.trim())
  )
}

function isRequirementPrdGenerationCompleted(
  manifest: RequirementPrdManifest | null | undefined
): boolean {
  const status = manifest?.prd.status.trim().toLowerCase()
  return status === "generated" || status === "published"
}

const REQUIREMENT_WORKSPACE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
const REQUIREMENT_WORKSPACE_PREVIEW_MAX_PAGES = 64

// The raw workspace read channel was replaced by the bounded, cancellable preview
// API. Requirements still need whole-file text (prd-manifest.json), so page through
// the preview until the file is complete or the safety budget is exhausted.
async function readRequirementWorkspaceTextFile(
  threadId: string,
  filePath: string,
  lanePrefix: string
): Promise<{ success: boolean; content?: string; notFound?: boolean; error?: string }> {
  const requestToken = globalThis.crypto.randomUUID()
  const lane = `${lanePrefix}:${threadId}:${requestToken}`
  const readPage = (offset: number): Promise<WorkspaceFilePreviewReadResult> =>
    window.api.workspace.readFilePreview({
      source: { threadId, filePath },
      offset,
      lane,
      requestToken
    })

  const first = await readPage(0)
  if (!first.success) {
    return { success: false, error: first.error, notFound: first.errorCode === "not-found" }
  }
  const assembled = await assembleBoundedTextPreview(
    first,
    async (offset) => {
      const page = await readPage(offset)
      return page.success ? page : null
    },
    {
      maxBytes: REQUIREMENT_WORKSPACE_PREVIEW_MAX_BYTES,
      maxPages: REQUIREMENT_WORKSPACE_PREVIEW_MAX_PAGES
    }
  )
  return { success: true, content: assembled.content }
}

function buildRequirementInitializationMessage(requirement: RequirementRecord): string {
  const sourceInstruction =
    requirement.sourceType === "text"
      ? "请通过对话从零梳理需求，先了解目标和使用场景"
      : "请先基于 source 文件夹中的原始需求资料完成需求分析"
  const initialDescription = requirement.initialDescription.trim()
  return `为「${requirement.title}」撰写一份产品需求文档。${sourceInstruction}，梳理目标用户、使用场景、用户故事、关键流程、业务规则、异常处理、权限、通知机制、成功指标和验收标准；先与我确认待澄清事项，再生成正式 PRD。${initialDescription ? `\n\n用户的初始需求描述：\n${initialDescription}` : ""}`
}

function RequirementConversationSession({
  requirement,
  selectedThreadId: activeThreadId,
  requirements,
  onSelectRequirement,
  onRequirementUpdated,
  onDeleteRequirement,
  onBack,
  onNew,
  autoGeneratePrd
}: {
  requirement: RequirementRecord
  selectedThreadId: string | null
  requirements: RequirementRecord[]
  onSelectRequirement: (requirement: RequirementRecord, threadId?: string) => Promise<void>
  onRequirementUpdated: (requirement: RequirementRecord) => void
  onDeleteRequirement: (requirement: RequirementRecord) => Promise<void>
  onBack: () => void
  onNew: () => void
  autoGeneratePrd: boolean
}): React.JSX.Element {
  const selectThread = useAppStore((state) => state.selectThread)
  const createThread = useAppStore((state) => state.createThread)
  const deleteThread = useAppStore((state) => state.deleteThread)
  const openSubagentFocusView = useAppStore((state) => state.openSubagentFocusView)
  const subagentFocusView = useAppStore((state) => state.subagentFocusView)
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    activeThreadId && requirement.threadIds.includes(activeThreadId)
      ? activeThreadId
      : (requirement.threadIds[0] ?? null)
  )
  const threadId =
    activeThreadId && requirement.threadIds.includes(activeThreadId)
      ? activeThreadId
      : selectedThreadId && requirement.threadIds.includes(selectedThreadId)
        ? selectedThreadId
        : (requirement.threadIds[0] ?? null)
  const currentThreadIdRef = useRef(threadId)
  currentThreadIdRef.current = threadId
  const threadState = useThreadState(threadId)
  const setWorkspaceFiles = threadState?.setWorkspaceFiles
  const subagents = useMemo(() => threadState?.subagents ?? [], [threadState?.subagents])
  const expertProcessRunning = subagents.some((item) => item.status === "running")
  const observedSubagentStatesRef = useRef(new Map<string, string>())
  // ChatContainer treats this stream state as the source of truth for an active turn.
  const streamLoading = useThreadStream(threadId ?? "").isLoading
  const autoQueuedPrdGenerationRef = useRef(false)
  const continuationMessageThreadIdsRef = useRef(new Set<string>())
  const conversationLoadingObservedRef = useRef(false)
  const restoredManifestThreadRef = useRef<string | null>(null)
  const manifestRequestRef = useRef(0)
  // The selected conversation renders its own validated manifest snapshot, so
  // "刷新状态" (which syncs the requirement record) must also re-read that file to
  // flip the PRD tabs without switching the conversation away and back.
  const reloadRequirementManifestRef = useRef<(() => void) | null>(null)
  const publishRequestQueuedRef = useRef(false)
  // A requirement can own multiple conversations. Do not render a requirement-level PRD
  // cache before the selected conversation's manifest has been read and validated.
  const [previewTab, setPreviewTab] = useState<PreviewTab>("source")
  const [prototypeRoute, setPrototypeRoute] = useState<PrototypeRoute>(null)
  const prdPreviewReloadToken = 0
  const [sourcePreview, setSourcePreview] = useState("")
  const [sourcePreviewLoading, setSourcePreviewLoading] = useState(false)
  const [sourcePreviewError, setSourcePreviewError] = useState<string | null>(null)
  const [requirementSpaceManifest, setRequirementSpaceManifest] =
    useState<RequirementPrdManifest | null>(null)
  const [manifestThreadId, setManifestThreadId] = useState<string | null>(null)
  const [manifestLoading, setManifestLoading] = useState(false)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [publishRequestQueued, setPublishRequestQueued] = useState(false)
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false)
  const [tokenDraft, setTokenDraft] = useState("")
  const [tokenSaving, setTokenSaving] = useState(false)
  const [hasStoredToken, setHasStoredToken] = useState(false)
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false)
  const [functionWorkspaceOpen, setFunctionWorkspaceOpen] = useState(false)
  const [statusRefreshing, setStatusRefreshing] = useState(false)
  const handleFunctionWorkspaceChange = useCallback((open: boolean) => {
    setFunctionWorkspaceOpen(open)
    if (open) setRightPanelCollapsed(false)
  }, [])
  const focusExpertProcess = useCallback((): boolean => {
    if (!threadId || subagents.length === 0) return false
    const isAnalyst = (item: (typeof subagents)[number]): boolean => {
      const identity = `${item.subagentType ?? ""} ${item.name}`.toLowerCase()
      return identity.includes("analyst")
    }
    const runningSubagents = subagents.filter((item) => item.status === "running")
    const subagent =
      runningSubagents.find(isAnalyst) ??
      runningSubagents[0] ??
      [...subagents].reverse().find(isAnalyst) ??
      subagents[subagents.length - 1]

    openSubagentFocusView({
      threadId,
      subagentId: subagent.id,
      name: subagent.name,
      description: subagent.description,
      status: subagent.status
    })
    return true
  }, [openSubagentFocusView, subagents, threadId])
  useEffect(() => {
    const previous = observedSubagentStatesRef.current
    const runningSubagents = subagents.filter((item) => item.status === "running")
    const started =
      runningSubagents.find((item) => {
        const identity = `${item.subagentType ?? ""} ${item.name}`.toLowerCase()
        return identity.includes("analyst")
      }) ?? runningSubagents[0]

    if (started && previous.get(started.id) !== "running" && focusExpertProcess()) {
      setPreviewTab("expert-process")
    }

    observedSubagentStatesRef.current = new Map(
      subagents.map((subagent) => [subagent.id, subagent.status])
    )
  }, [focusExpertProcess, subagents])
  useEffect(() => {
    if (previewTab !== "expert-process" || subagentFocusView?.threadId === threadId) return
    focusExpertProcess()
  }, [focusExpertProcess, previewTab, subagentFocusView?.threadId, threadId])
  const prdFiles = useMemo(
    () =>
      (threadState?.workspaceFiles ?? []).filter(
        (file) => file.path === "/prd" || file.path.startsWith("/prd/")
      ),
    [threadState?.workspaceFiles]
  )
  const sourceFiles = useMemo(
    () =>
      (threadState?.workspaceFiles ?? []).filter(
        (file) => file.path === "/source" || file.path.startsWith("/source/")
      ),
    [threadState?.workspaceFiles]
  )
  const sourceDocumentFiles = useMemo(
    () => sourceFiles.filter((file) => !file.is_dir),
    [sourceFiles]
  )
  const prdFileCount = prdFiles.filter((file) => !file.is_dir).length
  const manifestBelongsToCurrentThread = manifestThreadId === threadId
  const prdGenerationCompleted =
    manifestBelongsToCurrentThread && isRequirementPrdGenerationCompleted(requirementSpaceManifest)
  const requirementSpacePublished =
    manifestBelongsToCurrentThread && isRequirementSpacePublished(requirementSpaceManifest)
  const prototypeFunctions = useMemo(
    () => requirementSpaceManifest?.functions ?? [],
    [requirementSpaceManifest?.functions]
  )
  const prototypeStatuses = useMemo(
    () =>
      prototypeFunctions.map((functionInfo) => {
        const prototypePath = normalizeRequirementHtmlFilePath(functionInfo.htmlFile)
        const generated = prototypePath !== ""
        const choiceMade = generated || functionInfo.needDesign !== ""
        const skipped = prototypeRoute === "skip" || functionInfo.needDesign === "0"
        return {
          functionInfo,
          prototypePath,
          generated,
          skipped,
          complete: generated || skipped,
          choiceMade
        }
      }),
    [prototypeFunctions, prototypeRoute]
  )
  const completedPrototypeCount = prototypeStatuses.filter((item) => item.complete).length
  const generatedPrototypeCount = prototypeStatuses.filter((item) => item.generated).length
  const skippedPrototypeCount = prototypeStatuses.filter((item) => item.skipped).length
  const allPrototypeFunctionsCompleted =
    prototypeStatuses.length > 0 && completedPrototypeCount === prototypeStatuses.length
  const expertAnalysisStarted = subagents.length > 0 || prdGenerationCompleted
  const expertAnalysisCompleted =
    prdGenerationCompleted || (subagents.length > 0 && !expertProcessRunning)
  const prototypeStepCompleted =
    prototypeRoute === "skip" || allPrototypeFunctionsCompleted || requirementSpacePublished
  const prototypeStepEnabled =
    prdGenerationCompleted && (prototypeRoute !== null || requirementSpacePublished)
  const requirementSpaceStepEnabled =
    (requirementSpaceManifest?.prd.currentStep ?? 0) >= 5 ||
    (prdGenerationCompleted && (prototypeStepCompleted || requirementSpacePublished))
  const conversationLoading = streamLoading || threadState?.scheduledTaskLoading === true
  const persistPrototypeState = useCallback(
    async (
      route: PrototypeRoute,
      reachedStep: number,
      changedChoice?: { functionKey: string; needDesign: NeedDesignChoice }
    ): Promise<void> => {
      const result = await window.api.requirements.saveStepState({
        reqId: requirement.id,
        needDesign: route === null ? "" : route === "design" ? "1" : "0",
        currentStep: Math.max(requirementSpaceManifest?.prd.currentStep ?? 1, reachedStep),
        functions: prototypeFunctions.flatMap((functionInfo) => {
          if (
            changedChoice &&
            changedChoice.functionKey !== getPrototypeFunctionKey(functionInfo)
          ) {
            return []
          }
          return {
            fr: functionInfo.fr,
            file: functionInfo.file,
            htmlFile: functionInfo.htmlFile,
            needDesign:
              route === "skip"
                ? "0"
                : changedChoice?.functionKey === getPrototypeFunctionKey(functionInfo)
                  ? changedChoice.needDesign
                  : functionInfo.needDesign
          }
        })
      })
      if (!result.success || !result.requirement) {
        throw new Error(result.error || "保存原型流程状态失败")
      }
      if (result.manifestStatus === "missing") {
        toast.warning("未找到 prd/prd-manifest.json，步骤状态仅保存到需求索引")
      } else if (result.manifestStatus === "invalid") {
        toast.warning("prd-manifest.json 格式异常，已保留原文件且仅更新需求索引")
      }
      if (result.manifest) {
        setRequirementSpaceManifest(normalizeRequirementSpaceManifest(result.manifest))
      }
      onRequirementUpdated(fromPersistedRequirement(result.requirement, requirement.system))
    },
    [
      onRequirementUpdated,
      prototypeFunctions,
      requirement.id,
      requirement.system,
      requirementSpaceManifest?.prd.currentStep
    ]
  )
  const choosePrototypeRoute = useCallback(
    (route: Exclude<PrototypeRoute, null>): void => {
      setPrototypeRoute(route)
      setPreviewTab(route === "design" ? "prototype" : "requirement-space")
      void persistPrototypeState(route, route === "design" ? 4 : 5).catch((error) => {
        console.error("[RequirementConversation] Failed to save prototype route:", error)
        toast.error("保存原型选择失败")
      })
    },
    [persistPrototypeState]
  )
  const updatePrototypeFunctionDesign = useCallback(
    (functionInfo: { fr: string; file: string }, needDesign: NeedDesignChoice): void => {
      const functionKey = getPrototypeFunctionKey(functionInfo)
      void persistPrototypeState("design", 4, {
        functionKey,
        needDesign
      }).catch((error) => {
        console.error("[RequirementConversation] Failed to update prototype choice:", error)
        toast.error("保存原型设计选择失败")
      })
    },
    [persistPrototypeState]
  )
  const completePrototypeDesign = useCallback(async (): Promise<void> => {
    await persistPrototypeState("design", 5)
    setPreviewTab("requirement-space")
  }, [persistPrototypeState])
  const requestPrototypeDesign = useCallback(
    (functionInfo: { fr: string; name: string; file: string; htmlId?: string }): void => {
      if (conversationLoading) return
      const workspacePath = threadState?.workspacePath ?? requirement.requirementPath
      const workspaceRoot = workspacePath.replace(/[\\/]+$/, "")
      const relativeFile = normalizePrdFilePath(functionInfo.file).replace(/^\/+/, "")
      const relativeOverviewFile = normalizePrdFilePath(
        requirementSpaceManifest?.prd.file ?? ""
      ).replace(/^\/+/, "")
      const separator = workspacePath.includes("\\") ? "\\" : "/"
      const requirementFilePath = `${workspaceRoot}${separator}${relativeFile.replace(/\//g, separator)}`
      const requirementOverviewFilePath = relativeOverviewFile
        ? `${workspaceRoot}${separator}${relativeOverviewFile.replace(/\//g, separator)}`
        : undefined
      openRequirementDesign({
        requirementId: requirement.id,
        requirementName: requirement.title,
        functionName: `${functionInfo.fr} ${functionInfo.name}`.trim(),
        workspacePath,
        previewThreadId: threadId ?? undefined,
        requirementOverviewFilePath,
        requirementFilePath,
        prompt: buildRequirementDesignPrompt(
          `${functionInfo.fr} ${functionInfo.name}`,
          relativeFile
        ),
        htmlId: functionInfo.htmlId?.trim() ?? ""
      })
    },
    [
      conversationLoading,
      requirement.id,
      requirement.requirementPath,
      requirement.title,
      requirementSpaceManifest?.prd.file,
      threadId,
      threadState?.workspacePath
    ]
  )
  const revealRequirementFile = useCallback(
    (filePath: string): void => {
      const workspacePath = threadState?.workspacePath ?? requirement.requirementPath
      const normalizedWorkspace = workspacePath.replace(/[\\/]+$/, "")
      const normalizedFile = normalizePrdFilePath(filePath).replace(/^\/+/, "")
      const absolutePath = `${normalizedWorkspace}/${normalizedFile}`
      void window.electron.ipcRenderer
        .invoke("show-item-in-folder", absolutePath)
        .then((result) => {
          if (result && typeof result === "object" && "success" in result && !result.success) {
            toast.error("无法在文件夹中显示该文件")
          }
        })
        .catch(() => toast.error("无法在文件夹中显示该文件"))
    },
    [requirement.requirementPath, threadState?.workspacePath]
  )
  const openWorkspaceFilePreview = useCallback(
    (filePath: string): void => {
      if (!threadId) return
      emitOpenResourcePreview({
        threadId,
        filePath,
        workspacePathKind: "relative",
        intentId: beginOpenResourcePreviewIntent(threadId)
      })
    },
    [threadId]
  )
  const hasThreadState = threadState !== null

  useEffect(() => {
    conversationLoadingObservedRef.current = false
    manifestRequestRef.current += 1
    setManifestLoading(false)
    setManifestError(null)
    setRequirementSpaceManifest(null)
    setManifestThreadId(null)
    setPrototypeRoute(null)
    setPreviewTab("source")
    restoredManifestThreadRef.current = null
    publishRequestQueuedRef.current = false
    setPublishRequestQueued(false)
    observedSubagentStatesRef.current.clear()
  }, [requirement.id, threadId])

  useEffect(() => {
    if (!manifestBelongsToCurrentThread || !requirementSpaceManifest) return
    if (restoredManifestThreadRef.current === manifestThreadId) return
    restoredManifestThreadRef.current = manifestThreadId
    const currentStep = requirementSpaceManifest.prd.currentStep
    const route: PrototypeRoute =
      currentStep >= 4
        ? requirementSpaceManifest.prd.needDesign === "1"
          ? "design"
          : requirementSpaceManifest.prd.needDesign === "0"
            ? "skip"
            : null
        : null
    setPrototypeRoute(route)
    setPreviewTab(getPreviewTabForStep(currentStep))
  }, [manifestBelongsToCurrentThread, manifestThreadId, requirementSpaceManifest])

  useEffect(() => {
    if (!manifestBelongsToCurrentThread || !requirementSpaceManifest) return
    if (
      requirementSpaceManifest.prd.status === "generated" &&
      requirementSpaceManifest.prd.currentStep === 3 &&
      prototypeRoute === null &&
      (previewTab === "prototype" || previewTab === "requirement-space")
    ) {
      setPreviewTab("prd")
    }
  }, [manifestBelongsToCurrentThread, previewTab, prototypeRoute, requirementSpaceManifest])

  useEffect(() => {
    setSelectedThreadId(
      activeThreadId && requirement.threadIds.includes(activeThreadId)
        ? activeThreadId
        : (requirement.threadIds[0] ?? null)
    )
  }, [activeThreadId, requirement.id, requirement.threadIds])

  useEffect(() => {
    const sessionPaused =
      threadState?.queueAutoDrainSuppressed === true ||
      threadState?.goalUi.goal?.status === "paused"
    if (!sessionPaused || !publishRequestQueuedRef.current) return
    publishRequestQueuedRef.current = false
    setPublishRequestQueued(false)
  }, [threadState?.goalUi.goal?.status, threadState?.queueAutoDrainSuppressed])

  const attachConversation = useCallback(
    async (
      nextRequirement: RequirementRecord,
      nextThreadId: string
    ): Promise<RequirementRecord> => {
      const result = await window.api.requirements.attachThread({
        reqId: nextRequirement.id,
        threadId: nextThreadId
      })
      if (!result.success || !result.requirement)
        throw new Error(result.error || "保存需求会话失败")
      const updated = fromPersistedRequirement(result.requirement, requirement.system)
      onRequirementUpdated(updated)
      return updated
    },
    [onRequirementUpdated, requirement.system]
  )

  const modeDetachConversation = useCallback(
    async (item: RequirementRecord, deletedThreadId: string): Promise<void> => {
      const result = await window.api.requirements.detachThread({
        reqId: item.id,
        threadId: deletedThreadId
      })
      if (!result.success || !result.requirement)
        throw new Error(result.error || "更新需求会话失败")
      const updated = fromPersistedRequirement(result.requirement, requirement.system)
      onRequirementUpdated(updated)
      if (deletedThreadId === threadId) {
        const nextThreadId = updated.threadIds[0] ?? null
        setSelectedThreadId(nextThreadId)
        if (nextThreadId) await onSelectRequirement(updated, nextThreadId)
      }
    },
    [onRequirementUpdated, onSelectRequirement, requirement.system, threadId]
  )

  const refreshRequirementStatus = useCallback(
    async (item: RequirementRecord): Promise<boolean> => {
      const manifestThreadId = item.threadIds[0]
      if (!manifestThreadId) return false
      const readResult = await readRequirementWorkspaceTextFile(
        manifestThreadId,
        "/prd/prd-manifest.json",
        "requirement-status"
      )
      if (!readResult.success || readResult.content === undefined) {
        if (readResult.notFound) return false
        throw new Error(readResult.error || "未找到 prd-manifest.json")
      }
      let manifest: unknown
      try {
        manifest = JSON.parse(readResult.content)
      } catch {
        throw new Error("prd-manifest.json 格式无效")
      }
      const syncResult = await window.api.requirements.syncManifest({
        reqId: item.id,
        manifest
      })
      if (!syncResult.success || !syncResult.requirement) {
        throw new Error(syncResult.error || "同步 prd-manifest.json 失败")
      }
      onRequirementUpdated(fromPersistedRequirement(syncResult.requirement, item.system))
      // The list status comes from the requirement record, but the open
      // conversation renders its own manifest snapshot. Re-read it here so the
      // PRD tabs (生成中/生成完成) update immediately instead of only after a
      // conversation switch.
      if (item.id === requirement.id) reloadRequirementManifestRef.current?.()
      return true
    },
    [onRequirementUpdated, requirement.id]
  )

  // Same effect as the sidebar's "刷新状态": re-read and re-sync prd-manifest.json.
  const handleRefreshStatus = useCallback(async (): Promise<void> => {
    if (statusRefreshing) return
    setStatusRefreshing(true)
    try {
      if (await refreshRequirementStatus(requirement)) {
        toast.success("需求状态已刷新")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新需求状态失败")
    } finally {
      setStatusRefreshing(false)
    }
  }, [refreshRequirementStatus, requirement, statusRefreshing])

  const requirementSidebarMode = useMemo<RequirementSidebarMode>(
    () => ({
      requirements: requirements.filter((item) => item.origin === "local"),
      onSelectRequirement: async (item, nextThreadId) => {
        if (nextThreadId && item.id === requirement.id) {
          setSelectedThreadId(nextThreadId)
          await onSelectRequirement(item, nextThreadId)
        } else {
          // Preserve the clicked conversation when switching requirements. Without
          // this, the parent opens the target requirement's default (first) thread.
          await onSelectRequirement(item, nextThreadId)
        }
      },
      onCreateConversation: async (item) => {
        const capabilities = getRequirementSessionCapabilities()
        await enableRequirementSessionExperts(capabilities.allowedExperts)
        const conversationNumber = String(item.threadIds.length + 1).padStart(3, "0")
        const thread = await createThread(
          {
            title: `${conversationNumber}-PRD-${item.title}`,
            requirementId: item.id,
            requirementTitle: item.title,
            requirementSystem: item.system,
            requirementSourceType: item.sourceType,
            requirementSourceName: item.sourceName,
            allowedSkills: capabilities.allowedSkills,
            allowedExperts: capabilities.allowedExperts,
            workspacePath: item.requirementPath
          },
          { preserveView: true }
        )
        const updated = await attachConversation(item, thread.thread_id)
        continuationMessageThreadIdsRef.current.add(thread.thread_id)
        setSelectedThreadId(thread.thread_id)
        await onSelectRequirement(updated, thread.thread_id)
      },
      onAttachConversation: attachConversation,
      onDeleteConversation: modeDetachConversation,
      onDeleteRequirement,
      onDeleteAllConversations: async (item, threadIds) => {
        for (const id of threadIds) {
          const result = await window.api.requirements.detachThread({
            reqId: item.id,
            threadId: id
          })
          if (!result.success) throw new Error(result.error || "更新需求会话失败")
          if (result.requirement)
            onRequirementUpdated(fromPersistedRequirement(result.requirement, requirement.system))
          await deleteThread(id)
        }
        if (threadId && threadIds.includes(threadId)) setSelectedThreadId(null)
      },
      onRenameRequirement: async (item, title) => {
        const result = await window.api.requirements.rename({ reqId: item.id, title })
        if (!result.success || !result.requirement)
          throw new Error(result.error || "重命名需求失败")
        onRequirementUpdated(fromPersistedRequirement(result.requirement, requirement.system))
      },
      onRefreshRequirementStatus: refreshRequirementStatus,
      onNewRequirement: onNew,
      onBackToHistory: onBack
    }),
    [
      attachConversation,
      createThread,
      deleteThread,
      modeDetachConversation,
      onBack,
      onDeleteRequirement,
      onNew,
      onRequirementUpdated,
      onSelectRequirement,
      refreshRequirementStatus,
      requirements,
      threadId,
      requirement.id,
      requirement.system
    ]
  )
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const result = await window.api.requirements.getToken()
        if (!cancelled) setHasStoredToken(result.success ? Boolean(result.token) : false)
      } catch {
        if (!cancelled) setHasStoredToken(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const loadSourcePreview = useCallback(async (): Promise<void> => {
    setSourcePreviewLoading(true)
    setSourcePreviewError(null)
    try {
      const result = await window.api.requirements.getSourcePreview(requirement.id)
      if (!result.success) {
        throw new Error(result.error || "读取原始需求预览失败")
      }
      setSourcePreview(result.content ?? "")
    } catch (error) {
      setSourcePreview("")
      setSourcePreviewError(error instanceof Error ? error.message : "读取原始需求预览失败")
    } finally {
      setSourcePreviewLoading(false)
    }
  }, [requirement.id])

  useEffect(() => {
    void loadSourcePreview()
  }, [loadSourcePreview])

  const loadRequirementSpaceManifest =
    useCallback(async (): Promise<RequirementPrdManifest | null> => {
      const requestId = ++manifestRequestRef.current
      const requestThreadId = threadId
      const requestToken = `${Date.now()}-${globalThis.crypto.randomUUID()}`
      const isCurrentRequest = (): boolean =>
        requestId === manifestRequestRef.current && requestThreadId === currentThreadIdRef.current
      setManifestLoading(true)
      setManifestError(null)
      try {
        if (!threadId) throw new Error("该需求尚未关联沟通会话")

        const beginResult = await window.api.requirements.beginManifestSync({
          reqId: requirement.id,
          threadId,
          requestId: requestToken
        })
        if (!beginResult.success) throw new Error(beginResult.error || "开始读取需求空间数据失败")

        const result = await readRequirementWorkspaceTextFile(
          threadId,
          "/prd/prd-manifest.json",
          "requirement-manifest"
        )
        if (!result.success && !result.notFound) {
          throw new Error(result.error || "读取 prd-manifest.json 失败")
        }

        let rawManifest: unknown = {}
        let manifestCanSync = false
        if (result.content !== undefined) {
          try {
            rawManifest = JSON.parse(result.content)
            manifestCanSync = true
          } catch {
            // Invalid JSON cannot safely update the requirement-level index.
          }
        }
        // Do not let a read from a previous session overwrite the active UI state.
        if (!isCurrentRequest()) return null
        if (manifestCanSync) {
          const syncResult = await window.api.requirements.syncManifest({
            reqId: requirement.id,
            threadId: requestThreadId,
            requestId: requestToken,
            manifest: rawManifest
          })
          if (!isCurrentRequest()) return null
          if (!syncResult.success)
            throw new Error(syncResult.error || "同步 prd-manifest.json 失败")
          if (syncResult.requirement) {
            onRequirementUpdated(
              fromPersistedRequirement(syncResult.requirement, requirement.system)
            )
          }
          if (syncResult.manifest) rawManifest = syncResult.manifest
        }
        const syncedManifest = normalizeRequirementSpaceManifest(rawManifest)
        setRequirementSpaceManifest(syncedManifest)
        setManifestThreadId(requestThreadId)
        if (isRequirementSpacePublished(syncedManifest)) {
          publishRequestQueuedRef.current = false
          setPublishRequestQueued(false)
        }
        return syncedManifest
      } catch (error) {
        if (!isCurrentRequest()) return null
        setRequirementSpaceManifest(null)
        setManifestThreadId(null)
        setManifestError(error instanceof Error ? error.message : "读取需求空间数据失败")
        return null
      } finally {
        if (isCurrentRequest()) setManifestLoading(false)
      }
    }, [onRequirementUpdated, requirement.id, requirement.system, threadId])

  reloadRequirementManifestRef.current = loadRequirementSpaceManifest

  useEffect(() => {
    if (!threadId) return
    void loadRequirementSpaceManifest()
  }, [loadRequirementSpaceManifest, threadId])

  const handlePublishToRequirementSpace = useCallback(async (): Promise<void> => {
    if (
      !threadState ||
      conversationLoading ||
      isRequirementSpacePublished(requirementSpaceManifest) ||
      publishRequestQueuedRef.current
    ) {
      return
    }

    publishRequestQueuedRef.current = true
    setPublishRequestQueued(true)
    let publishMessage = REQUIREMENT_SPACE_PUBLISH_MESSAGE
    try {
      const tokenResult = await window.api.requirements.getToken()
      const token = tokenResult.success ? tokenResult.token.trim() : ""
      if (token) {
        publishMessage = `${publishMessage}\n\n${LEANSTAR_TOKEN_MESSAGE_PREFIX}${token}`
      }
    } catch {
      // A token is optional; publish requests must still be deliverable without one.
    }
    threadState.addQueuedMessage({
      id: crypto.randomUUID(),
      text: publishMessage,
      created_at: new Date(),
      updated_at: new Date()
    })
    toast.success("已向对话发送发布到需求空间请求")
  }, [conversationLoading, requirementSpaceManifest, threadState])

  const queueLeanstarToken = useCallback(
    (token: string): void => {
      const normalized = token.trim()
      if (!threadState || !normalized) return
      threadState.addQueuedMessage({
        id: crypto.randomUUID(),
        text: `${LEANSTAR_TOKEN_MESSAGE_PREFIX}${normalized}`,
        created_at: new Date(),
        updated_at: new Date()
      })
      toast.success("已向对话发送身份令牌")
    },
    [threadState]
  )

  const handleSendLeanstarToken = useCallback(async (): Promise<void> => {
    if (!threadState || conversationLoading) return
    setTokenSaving(true)
    try {
      const result = await window.api.requirements.getToken()
      if (!result.success) throw new Error(result.error || "读取 Token 失败")
      if (result.token) {
        queueLeanstarToken(result.token)
        return
      }
      setTokenDraft("")
      setTokenDialogOpen(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "读取 Token 失败")
    } finally {
      setTokenSaving(false)
    }
  }, [conversationLoading, queueLeanstarToken, threadState])

  const handleConfirmLeanstarToken = useCallback(async (): Promise<void> => {
    const token = tokenDraft.trim()
    if (!token) {
      toast.error("请填写精益之星身份令牌-Token")
      return
    }
    setTokenSaving(true)
    try {
      const result = await window.api.requirements.saveToken(token)
      if (!result.success) throw new Error(result.error || "保存 Token 失败")
      setHasStoredToken(true)
      setTokenDialogOpen(false)
      queueLeanstarToken(token)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 Token 失败")
    } finally {
      setTokenSaving(false)
    }
  }, [queueLeanstarToken, tokenDraft])

  const handleOpenLeanstarTokenPage = useCallback((): void => {
    const url = import.meta.env.VITE_LEANSTAR_PERSONAL_TOKEN_URL?.trim() || ""
    if (!url) {
      toast.error("未配置精益之星 Token 获取链接")
      return
    }
    void window.electron.openExternal(url).catch(() => toast.error("打开 Token 获取页面失败"))
  }, [])

  useEffect(() => {
    if (
      (previewTab !== "prd" && previewTab !== "source" && previewTab !== "prototype") ||
      !threadId
    )
      return
    void window.api.workspace.loadFromDisk(threadId).then((result) => {
      if (result.success) setWorkspaceFiles?.(result.files)
    })
  }, [previewTab, setWorkspaceFiles, threadId])

  useEffect(() => {
    if (threadId) {
      void selectThread(threadId, { preserveView: true })
    }
  }, [selectThread, threadId])

  useEffect(() => {
    if (
      !threadId ||
      !continuationMessageThreadIdsRef.current.has(threadId) ||
      !threadState ||
      threadState.historyLoading
    ) {
      return
    }

    continuationMessageThreadIdsRef.current.delete(threadId)
    threadState.addQueuedMessage({
      id: crypto.randomUUID(),
      text: REQUIREMENT_CONTINUATION_MESSAGE,
      contextLabel: "requirement-workbench",
      created_at: new Date(),
      updated_at: new Date()
    })
  }, [threadId, threadState, threadState?.historyLoading])

  useEffect(() => {
    if (
      !autoGeneratePrd ||
      autoQueuedPrdGenerationRef.current ||
      isRequirementGenerated(requirement) ||
      isRequirementPublished(requirement) ||
      !threadState ||
      threadState.historyLoading ||
      threadState.messages.length > 0 ||
      threadState.queuedMessages.length > 0
    ) {
      return
    }

    autoQueuedPrdGenerationRef.current = true
    threadState.addQueuedMessage({
      id: crypto.randomUUID(),
      text: buildRequirementInitializationMessage(requirement),
      contextLabel: "requirement-workbench",
      created_at: new Date(),
      updated_at: new Date()
    })
  }, [
    autoGeneratePrd,
    requirement,
    threadState,
    threadState?.historyLoading,
    threadState?.messages.length,
    threadState?.queuedMessages.length
  ])

  useEffect(() => {
    if (conversationLoading) {
      conversationLoadingObservedRef.current = true
      return
    }
    if (
      !conversationLoadingObservedRef.current ||
      !threadId ||
      !hasThreadState ||
      requirement.workspaceMissing ||
      requirement.coreFilesMissing
    ) {
      return
    }

    conversationLoadingObservedRef.current = false
    let cancelled = false

    const checkPrdCompletion = async (): Promise<void> => {
      const manifest = await loadRequirementSpaceManifest()
      if (cancelled || !manifest || currentThreadIdRef.current !== threadId) return
      const workspaceResult = await window.api.workspace.loadFromDisk(threadId)
      if (!cancelled && workspaceResult.success) {
        threadState.setWorkspaceFiles(workspaceResult.files)
      }
      if (isRequirementPrdGenerationCompleted(manifest)) {
        setPreviewTab(isRequirementSpacePublished(manifest) ? "requirement-space" : "prd")
      }
      // Reset publish queue when the conversation ended without a successful publish
      if (!isRequirementSpacePublished(manifest)) {
        publishRequestQueuedRef.current = false
        setPublishRequestQueued(false)
      }
    }

    void checkPrdCompletion().catch((error) => {
      console.warn("[RequirementConversationView] Failed to check PRD completion:", error)
    })

    return () => {
      cancelled = true
    }
  }, [
    conversationLoading,
    hasThreadState,
    loadRequirementSpaceManifest,
    requirement.coreFilesMissing,
    requirement.workspaceMissing,
    threadId,
    threadState
  ])

  useEffect(() => {
    if (!prdGenerationCompleted && (previewTab === "prd" || previewTab === "requirement-space")) {
      setPreviewTab("source")
    }
  }, [prdGenerationCompleted, previewTab])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-background">
        <div
          className={cn(
            "grid h-full min-h-0 gap-x-[0.5px]",
            // The requirement list column is a fixed width so collapsing the right
            // panel keeps the list (and chat) from being stretched.
            functionWorkspaceOpen
              ? "min-w-[900px] grid-cols-[240px_minmax(660px,1fr)]"
              : rightPanelCollapsed
                ? "min-w-[620px] grid-cols-[240px_minmax(380px,1fr)]"
                : "min-w-[1242px] grid-cols-[240px_minmax(380px,1fr)_minmax(560px,1.3fr)]"
          )}
        >
          <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <RequirementThreadSidebar mode={requirementSidebarMode} />
          </aside>

          <main
            className={cn(
              "min-h-0 min-w-0 flex-col border-x border-border/60 bg-background",
              functionWorkspaceOpen ? "hidden" : "flex"
            )}
          >
            <div className="flex h-[37px] shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-[#fffdf9] px-4">
              <div className="flex min-w-0 items-center gap-2.5 text-sm font-semibold text-foreground">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Bot className="size-3.5" />
                </span>
                <span className="truncate">{requirement.title}</span>
                <span className="inline-flex shrink-0 items-center rounded-full border border-status-info/20 bg-status-info/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-status-info">
                  需求工作台
                </span>
              </div>
              {rightPanelCollapsed ? (
                <TooltipProvider delayDuration={180}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setRightPanelCollapsed(false)}
                        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background-interactive hover:text-foreground"
                        aria-label="展开右侧面板"
                      >
                        <PanelRightOpen className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      展开右侧面板
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
            </div>
            {threadId ? (
              <ChatContainer key={threadId} threadId={threadId} surface="requirement-session" />
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                <span>该需求尚未关联沟通会话</span>
                <Button type="button" variant="outline" size="sm" onClick={onBack}>
                  返回需求历史
                </Button>
              </div>
            )}
          </main>

          <RequirementStepsPanel
            requirement={requirement}
            manifest={requirementSpaceManifest}
            prototypeStatuses={prototypeStatuses}
            previewTab={previewTab}
            prototypeRoute={prototypeRoute}
            collapsed={rightPanelCollapsed}
            threadId={threadId}
            workspacePath={threadState?.workspacePath ?? requirement.requirementPath}
            sourcePreview={sourcePreview}
            sourcePreviewLoading={sourcePreviewLoading}
            sourcePreviewError={sourcePreviewError}
            sourceDocumentFiles={sourceDocumentFiles}
            manifestLoading={manifestLoading}
            manifestError={manifestError}
            statusRefreshing={statusRefreshing}
            conversationLoading={conversationLoading}
            tokenSaving={tokenSaving}
            hasStoredToken={hasStoredToken}
            publishRequestQueued={publishRequestQueued}
            expertAnalysisStarted={expertAnalysisStarted}
            expertAnalysisCompleted={expertAnalysisCompleted}
            expertProcessRunning={expertProcessRunning}
            prdGenerationCompleted={prdGenerationCompleted}
            prototypeStepEnabled={prototypeStepEnabled}
            prototypeStepCompleted={prototypeStepCompleted}
            requirementSpaceStepEnabled={requirementSpaceStepEnabled}
            requirementSpacePublished={requirementSpacePublished}
            allPrototypeFunctionsCompleted={allPrototypeFunctionsCompleted}
            completedPrototypeCount={completedPrototypeCount}
            generatedPrototypeCount={generatedPrototypeCount}
            skippedPrototypeCount={skippedPrototypeCount}
            prdFileCount={prdFileCount}
            prdPreviewReloadToken={prdPreviewReloadToken}
            showExpertProcess={subagentFocusView?.threadId === threadId}
            onPreviewTabChange={setPreviewTab}
            onFunctionWorkspaceChange={handleFunctionWorkspaceChange}
            onFocusExpertProcess={() => {
              focusExpertProcess()
            }}
            onRefreshStatus={handleRefreshStatus}
            onCollapse={() => setRightPanelCollapsed(true)}
            onReloadSource={loadSourcePreview}
            onReloadManifest={loadRequirementSpaceManifest}
            onOpenWorkspaceFilePreview={openWorkspaceFilePreview}
            onChoosePrototypeRoute={choosePrototypeRoute}
            onRevealRequirementFile={revealRequirementFile}
            onRequestPrototypeDesign={requestPrototypeDesign}
            onUpdatePrototypeFunctionDesign={updatePrototypeFunctionDesign}
            onCompletePrototypeDesign={completePrototypeDesign}
            onPublishToRequirementSpace={handlePublishToRequirementSpace}
            onSendLeanstarToken={handleSendLeanstarToken}
          />
        </div>
      </div>
      <Dialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>精益之星身份令牌-Token</DialogTitle>
            <DialogDescription>
              填写 Token 后会保存到本地需求配置，并自动发送到当前会话。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder="请输入 Token"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  void handleConfirmLeanstarToken()
                }
              }}
            />
            <button
              type="button"
              className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              onClick={handleOpenLeanstarTokenPage}
            >
              打开链接获取 Token
              <ExternalLink className="size-3" />
            </button>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTokenDialogOpen(false)}
              disabled={tokenSaving}
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void handleConfirmLeanstarToken()}
              disabled={tokenSaving}
            >
              {tokenSaving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              确定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function RequirementConversationView({
  requirement,
  selectedThreadId,
  requirements,
  onSelectRequirement,
  onRequirementUpdated,
  onDeleteRequirement,
  onBack,
  onNew,
  autoGeneratePrd = false
}: {
  requirement: RequirementRecord
  selectedThreadId: string | null
  requirements: RequirementRecord[]
  onSelectRequirement: (requirement: RequirementRecord, threadId?: string) => Promise<void>
  onRequirementUpdated: (requirement: RequirementRecord) => void
  onDeleteRequirement: (requirement: RequirementRecord) => Promise<void>
  onBack: () => void
  onNew: () => void
  autoGeneratePrd?: boolean
}): React.JSX.Element {
  return (
    <RequirementConversationSession
      key={`${requirement.id}:${selectedThreadId ?? requirement.threadIds[0] ?? ""}`}
      requirement={requirement}
      selectedThreadId={selectedThreadId}
      requirements={requirements}
      onSelectRequirement={onSelectRequirement}
      onRequirementUpdated={onRequirementUpdated}
      onDeleteRequirement={onDeleteRequirement}
      onBack={onBack}
      onNew={onNew}
      autoGeneratePrd={autoGeneratePrd}
    />
  )
}
