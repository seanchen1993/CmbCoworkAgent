import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  Bot,
  Brain,
  CheckCircle2,
  ExternalLink,
  Eye,
  KeyRound,
  Loader2,
  Send
} from "lucide-react"
import { toast } from "sonner"
import { ChatContainer } from "@/components/chat/ChatContainer"
import { SubagentStreamPanel } from "@/components/chat/SubagentStreamPanel"
import {
  RequirementThreadSidebar,
  type RequirementSidebarMode
} from "@/components/sidebar/RequirementThreadSidebar"
import { FileTree, ResourcePreview } from "@/components/panels/RightPanel"
import MarkdownPreview from "@/components/ui/MarkdownPreview/MarkdownPreview"
import { Button } from "@/components/ui/button"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useAppStore } from "@/lib/store"
import { useThreadState, useThreadStream } from "@/lib/thread-context"
import { cn } from "@/lib/utils"
import {
  fromPersistedRequirement,
  isRequirementGenerated,
  isRequirementPublished,
  type RequirementPrdManifest,
  type RequirementRecord
} from "./requirement-data"

const REQUIREMENT_SPACE_PUBLISH_MESSAGE = "发布到需求空间"
const LEANSTAR_TOKEN_MESSAGE_PREFIX = "精益之星身份令牌-Token："
const REQUIREMENT_CONTINUATION_MESSAGE = "基于该需求已有资料和历史结论继续沟通。"

type PreviewTab = "expert-process" | "source" | "prd" | "requirement-space"

function getSourceTabLabel(sourceType: RequirementRecord["sourceType"]): string {
  if (sourceType === "file") return "旧需求（文件）"
  if (sourceType === "link") return "旧需求（链接）"
  return "旧需求（描述）"
}

function getInitialPreviewTab(requirement: RequirementRecord): PreviewTab {
  if (isRequirementPublished(requirement) || isRequirementGenerated(requirement)) return "requirement-space"
  return "source"
}

function normalizePrdFilePath(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/").replace(/^\/+/, "")
  return normalized === "prd" || normalized.startsWith("prd/")
    ? `/${normalized}`
    : `/prd/${normalized}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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
  return {
    prd: {
      name: asText(prd.name),
      status: normalizePrdStatus(prd.status),
      description: asText(prd.description),
      file: asText(prd.file),
      ...(asText(prd.prDetailUrl) ? { prDetailUrl: asText(prd.prDetailUrl) } : {})
    },
    functions: functions.map((item) => {
      const functionInfo = asRecord(item) ?? {}
      return {
        fr: asText(functionInfo.fr),
        name: asText(functionInfo.name),
        description: asText(functionInfo.description),
        file: asText(functionInfo.file),
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
  return manifest?.prd.status.toLowerCase() === "published"
}

function isRequirementPrdGenerationCompleted(
  manifest: RequirementPrdManifest | null | undefined
): boolean {
  const status = manifest?.prd.status.trim().toLowerCase()
  return status === "generated" || status === "published"
}

function buildRequirementMarkdown(requirement: RequirementRecord, sourcePreview: string): string {
  const preview = sourcePreview.trim()
  return `# ${requirement.title}
> 原始需求草稿 · ${requirement.id} · ${requirement.updatedAt}${requirement.sourceName ? ` · ${requirement.sourceName}` : ""}

${preview || "> 暂无可预览的原始需求内容。"}
`
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
  requirements,
  onSelectRequirement,
  onRequirementUpdated,
  onDeleteRequirement,
  onBack,
  onNew,
  autoGeneratePrd
}: {
  requirement: RequirementRecord
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
    requirement.threadIds[0] ?? null
  )
  const threadId = selectedThreadId ?? requirement.threadIds[0] ?? null
  const threadState = useThreadState(threadId)
  const subagents = useMemo(() => threadState?.subagents ?? [], [threadState?.subagents])
  const expertProcessRunning = subagents.some((item) => item.status === "running")
  const observedSubagentStatesRef = useRef(new Map<string, string>())
  // ChatContainer treats this stream state as the source of truth for an active turn.
  const streamLoading = useThreadStream(threadId ?? "").isLoading
  const autoQueuedPrdGenerationRef = useRef(false)
  const continuationMessageThreadIdsRef = useRef(new Set<string>())
  const conversationLoadingObservedRef = useRef(false)
  const publishRequestQueuedRef = useRef(false)
  const [previewTab, setPreviewTab] = useState<PreviewTab>(() => getInitialPreviewTab(requirement))
  const [selectedPrdPath, setSelectedPrdPath] = useState<string | null>(null)
  const [prdPreviewReloadToken, setPrdPreviewReloadToken] = useState(0)
  const [sourcePreview, setSourcePreview] = useState("")
  const [sourcePreviewLoading, setSourcePreviewLoading] = useState(false)
  const [sourcePreviewError, setSourcePreviewError] = useState<string | null>(null)
  const [requirementSpaceManifest, setRequirementSpaceManifest] =
    useState<RequirementPrdManifest | null>(() => requirement.prdManifest)
  const [manifestLoading, setManifestLoading] = useState(false)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [publishRequestQueued, setPublishRequestQueued] = useState(false)
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false)
  const [tokenDraft, setTokenDraft] = useState("")
  const [tokenSaving, setTokenSaving] = useState(false)
  const [hasStoredToken, setHasStoredToken] = useState(false)
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
  const defaultPrdPath = useMemo(
    () =>
      prdFiles.find((file) => !file.is_dir && file.path === "/prd/full-prd.md")?.path ??
      prdFiles.find((file) => !file.is_dir)?.path ??
      null,
    [prdFiles]
  )
  const effectiveSelectedPrdPath =
    selectedPrdPath && prdFiles.some((file) => !file.is_dir && file.path === selectedPrdPath)
      ? selectedPrdPath
      : defaultPrdPath
  const selectedPrdFile = prdFiles.find(
    (file) => !file.is_dir && file.path === effectiveSelectedPrdPath
  )
  const prdFileCount = prdFiles.filter((file) => !file.is_dir).length
  const manifestPrdPath =
    requirementSpaceManifest?.prd.file.trim() || requirement.prdManifest.prd.file.trim()
  const fallbackPrdPath = manifestPrdPath || "/prd/full-prd.md"
  const prdGenerationCompleted =
    isRequirementGenerated(requirement) ||
    isRequirementPublished(requirement) ||
    isRequirementPrdGenerationCompleted(requirementSpaceManifest)
  const requirementSpacePublished =
    requirementSpaceManifest !== null
      ? isRequirementSpacePublished(requirementSpaceManifest)
      : isRequirementPublished(requirement)
  const conversationLoading = streamLoading || threadState?.scheduledTaskLoading === true
  const hasThreadState = threadState !== null

  useEffect(() => {
    setSelectedThreadId((current) => {
      if (current && requirement.threadIds.includes(current)) return current
      return requirement.threadIds[0] ?? null
    })
  }, [requirement.id, requirement.threadIds])

  useEffect(() => {
    setRequirementSpaceManifest(requirement.prdManifest)
  }, [requirement.id, requirement.prdManifest])

  useEffect(() => {
    const sessionPaused =
      threadState?.queueAutoDrainSuppressed === true || threadState?.goalUi.goal?.status === "paused"
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

  const requirementSidebarMode = useMemo<RequirementSidebarMode>(
    () => ({
      requirements,
      onSelectRequirement: async (item, nextThreadId) => {
        if (nextThreadId) {
          setSelectedThreadId(nextThreadId)
          await onSelectRequirement(item, nextThreadId)
        } else {
          await onSelectRequirement(item)
        }
      },
      onCreateConversation: async (item) => {
        await window.api.expertAgents.setEnabled("analyst", true)
        const thread = await createThread(
          {
            title: `PRD 沟通 · ${item.title}`,
            requirementId: item.id,
            requirementTitle: item.title,
            requirementSystem: item.system,
            requirementSourceType: item.sourceType,
            requirementSourceName: item.sourceName,
            allowedSkills: ["requirement-to-prd"],
            allowedExperts: ["analyst"],
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
      onRefreshRequirementStatus: async (item) => {
        const manifestThreadId = item.threadIds[0]
        if (!manifestThreadId) return false
        const readResult = await window.api.workspace.readFile(
          manifestThreadId,
          "/prd/prd-manifest.json"
        )
        if (!readResult.success || readResult.content === undefined) {
          if (readResult.error?.includes("ENOENT")) return false
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
        return true
      },
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
      requirements,
      threadId,
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

  const loadRequirementSpaceManifest = useCallback(async (options?: { forceRead?: boolean }): Promise<RequirementPrdManifest | null> => {
    setManifestLoading(true)
    setManifestError(null)
    try {
      if (!options?.forceRead && isRequirementPrdGenerationCompleted(requirement.prdManifest)) {
        const manifest = requirement.prdManifest
        setRequirementSpaceManifest(manifest)
        if (isRequirementSpacePublished(manifest)) {
          publishRequestQueuedRef.current = false
          setPublishRequestQueued(false)
        }
        return manifest
      }
      if (!threadId) throw new Error("该需求尚未关联沟通会话")

      const result = await window.api.workspace.readFile(threadId, "/prd/prd-manifest.json")
      if (!result.success || result.content === undefined) {
        throw new Error(result.error || "读取 prd-manifest.json 失败")
      }

      let rawManifest: unknown = {}
      try {
        rawManifest = JSON.parse(result.content)
      } catch {
        // Invalid JSON is stored as the empty manifest shape.
      }
      const syncResult = await window.api.requirements.syncManifest({
        reqId: requirement.id,
        manifest: rawManifest
      })
      if (!syncResult.success) {
        throw new Error(syncResult.error || "同步 prd-manifest.json 失败")
      }
      const manifest = normalizeRequirementSpaceManifest(rawManifest)
      if (syncResult.requirement) {
        onRequirementUpdated(fromPersistedRequirement(syncResult.requirement, requirement.system))
      }
      setRequirementSpaceManifest(manifest)
      if (isRequirementSpacePublished(manifest)) {
        publishRequestQueuedRef.current = false
        setPublishRequestQueued(false)
      }
      return manifest
    } catch (error) {
      setRequirementSpaceManifest(null)
      setManifestError(error instanceof Error ? error.message : "读取需求空间数据失败")
      return null
    } finally {
      setManifestLoading(false)
    }
  }, [onRequirementUpdated, requirement.id, requirement.prdManifest, requirement.system, threadId])

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

  const handleFunctionFilePreview = useCallback(
    (filePath: string): void => {
      const targetPath = normalizePrdFilePath(filePath)
      const matchingFile = prdFiles.find(
        (file) => !file.is_dir && file.path.replace(/\\/g, "/") === targetPath
      )

      setPreviewTab("prd")
      setSelectedPrdPath(matchingFile?.path ?? targetPath)
    },
    [prdFiles]
  )

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
      (isRequirementGenerated(requirement) || isRequirementPublished(requirement)) ||
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
      const manifest = await loadRequirementSpaceManifest({ forceRead: true })
      if (cancelled) return
      const workspaceResult = await window.api.workspace.loadFromDisk(threadId)
      if (!cancelled && workspaceResult.success) {
        threadState.setWorkspaceFiles(workspaceResult.files)
      }
      if (isRequirementPrdGenerationCompleted(manifest)) {
        setPreviewTab("prd")
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
    if (previewTab !== "requirement-space" || !prdGenerationCompleted) return
    void loadRequirementSpaceManifest()
  }, [
    loadRequirementSpaceManifest,
    prdGenerationCompleted,
    previewTab
  ])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-background">
        <div className="grid h-full min-h-0 min-w-[1242px] grid-cols-[minmax(240px,0.5fr)_minmax(380px,1fr)_minmax(620px,1.5fr)] gap-x-[0.5px]">
          <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <RequirementThreadSidebar mode={requirementSidebarMode} />
          </aside>

          <main className="flex min-h-0 min-w-0 flex-col border-x border-border/60 bg-background">
            <div className="flex h-[37px] shrink-0 items-center justify-between gap-3 border-b border-border/80 bg-[#fffdf9] px-4">
              <div className="flex min-w-0 items-center gap-2.5 text-sm font-semibold text-foreground">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Bot className="size-3.5" />
                </span>
                <span className="truncate">{requirement.title}</span>
              </div>
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

          <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-white">
            {requirement.workspaceMissing ? (
              <div
                role="alert"
                className="flex shrink-0 items-center gap-2 border-b border-[#ead3a1] bg-[#fff9e9] px-4 py-2 text-sm leading-5 text-[#8f6a2a]"
              >
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>该需求的工作目录已被删除，当前内容可能不可用。</span>
              </div>
            ) : null}
            {requirement.coreFilesMissing && !requirement.workspaceMissing ? (
              <div
                role="alert"
                className="flex shrink-0 items-center gap-2 border-b border-status-critical/20 bg-status-critical/5 px-4 py-2 text-sm leading-5 text-status-critical"
              >
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>
                  {requirement.coreFilesMissingReason || "需求核心文件缺失，当前内容可能不可用。"}
                </span>
              </div>
            ) : null}
            <Tabs
              value={previewTab}
              onValueChange={(value) => {
                const nextTab: PreviewTab =
                  value === "expert-process"
                    ? "expert-process"
                    : value === "prd"
                      ? "prd"
                      : value === "requirement-space"
                        ? "requirement-space"
                        : "source"
                setPreviewTab(nextTab)
                if (nextTab === "expert-process") {
                  focusExpertProcess()
                }
              }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="shrink-0 border-b border-border/80 bg-[#fffdf9] px-3">
                <TabsList className="h-9 rounded-none bg-transparent p-0">
                  <TabsTrigger
                    value="expert-process"
                    className="h-9 gap-1.5 rounded-none border-b-2 border-transparent px-3 text-[12px] font-semibold data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
                  >
                    专家过程
                    {subagents.length > 0 ? (
                      <Brain
                        className={cn(
                          "size-3 text-status-info",
                          expertProcessRunning ? "animate-pulse" : undefined
                        )}
                      />
                    ) : null}
                  </TabsTrigger>
                  <TabsTrigger
                    value="source"
                    className="h-9 rounded-none border-b-2 border-transparent px-3 text-[12px] font-semibold data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none"
                  >
                    {getSourceTabLabel(requirement.sourceType)}
                  </TabsTrigger>
                  <TooltipProvider delayDuration={180}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <TabsTrigger
                            value="prd"
                            disabled={!prdGenerationCompleted}
                            className="h-9 gap-1.5 rounded-none border-b-2 border-transparent px-3 text-[12px] font-semibold data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            新PRD文件
                            <span
                              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                                requirement.coreFilesMissing || requirement.workspaceMissing
                                  ? "border-status-critical/30 bg-status-critical/10 text-status-critical"
                                  : prdGenerationCompleted
                                    ? "border-status-nominal/30 bg-status-nominal/15 text-status-nominal"
                                    : "border-status-info/30 bg-status-info/15 text-status-info"
                              }`}
                            >
                              {requirement.coreFilesMissing || requirement.workspaceMissing ? (
                                <AlertTriangle className="size-2.5" />
                              ) : prdGenerationCompleted ? (
                                <CheckCircle2 className="size-2.5" />
                              ) : (
                                <Loader2 className="size-2.5 animate-spin" />
                              )}
                              {requirement.coreFilesMissing || requirement.workspaceMissing
                                ? "异常"
                                : prdGenerationCompleted
                                  ? "生成完成"
                                  : "生成中"}
                            </span>
                          </TabsTrigger>
                        </span>
                      </TooltipTrigger>
                      {!prdGenerationCompleted ? (
                        <TooltipContent side="bottom" className="max-w-64 text-xs leading-relaxed">
                          需求文档还在生成中，请完成需求梳理后再试。
                        </TooltipContent>
                      ) : null}
                    </Tooltip>
                  </TooltipProvider>
                  <TooltipProvider delayDuration={180}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <TabsTrigger
                            value="requirement-space"
                            disabled={!prdGenerationCompleted}
                            className="h-9 gap-1.5 rounded-none border-b-2 border-transparent px-3 text-[12px] font-semibold data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            需求空间3.0
                            <span
                              className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                                requirementSpacePublished
                                  ? "border-status-nominal/30 bg-status-nominal/15 text-status-nominal"
                                  : "border-status-info/30 bg-status-info/15 text-status-info"
                              }`}
                            >
                              {requirementSpacePublished ? (
                                <CheckCircle2 className="size-2.5" />
                              ) : (
                                <Loader2 className="size-2.5" />
                              )}
                              {requirementSpacePublished ? "已发布" : "未发布"}
                            </span>
                          </TabsTrigger>
                        </span>
                      </TooltipTrigger>
                      {!prdGenerationCompleted ? (
                        <TooltipContent side="bottom" className="max-w-64 text-xs leading-relaxed">
                          需求文档还在生成中，请完成需求梳理后再试。
                        </TooltipContent>
                      ) : null}
                    </Tooltip>
                  </TooltipProvider>
                </TabsList>
              </div>

              <TabsContent value="expert-process" className="m-0 min-h-0 flex-1 overflow-hidden">
                {subagentFocusView?.threadId === threadId ? (
                  <SubagentStreamPanel showCloseButton={false} />
                ) : (
                  <div className="flex h-full min-h-[260px] items-center justify-center px-6 py-10 text-center">
                    <div className="flex max-w-xs flex-col items-center">
                      <div className="mb-4 flex size-14 items-center justify-center rounded-full border border-status-info/25 bg-status-info/10 text-status-info">
                        <Brain className="size-7" strokeWidth={1.7} />
                      </div>
                      <div className="text-sm font-semibold text-foreground">暂无专家执行记录</div>
                      <div className="mt-1.5 text-xs leading-5 text-muted-foreground">
                        专家分析启动后，执行过程会显示在这里
                      </div>
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="source" className="m-0 min-h-0 flex-1 overflow-y-auto">
                {sourcePreviewLoading ? (
                  <div className="flex h-full min-h-[260px] items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin text-primary" />
                    正在读取原始需求
                  </div>
                ) : sourcePreviewError ? (
                  <div className="flex h-full min-h-[260px] items-center justify-center px-6 text-center">
                    <div className="flex max-w-[340px] flex-col items-center gap-3">
                      <AlertTriangle className="size-5 text-status-critical" />
                      <p className="text-sm leading-5 text-status-critical">{sourcePreviewError}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-sm"
                        onClick={() => void loadSourcePreview()}
                      >
                        重新读取
                      </Button>
                    </div>
                  </div>
                ) : (
                  <MarkdownPreview
                    content={buildRequirementMarkdown(requirement, sourcePreview)}
                    showHeader={false}
                    showModeToggle={false}
                    whiteBackground
                    className="min-h-full -mt-7"
                  />
                )}
              </TabsContent>

              <TabsContent value="prd" className="m-0 flex min-h-0 flex-1 flex-col">
                {prdFileCount > 0 ? (
                  <div className="grid min-h-0 flex-1 grid-cols-[minmax(168px,25%)_minmax(0,1fr)] overflow-hidden">
                    <aside className="flex min-w-0 flex-col overflow-hidden border-r border-border/80 bg-white">
                      <div className="min-h-0 flex-1 overflow-y-auto py-1">
                        <FileTree
                          files={prdFiles}
                          threadId={threadId}
                          selectedPath={effectiveSelectedPrdPath}
                          onFileSelect={setSelectedPrdPath}
                          initialExpandedPaths={prdFiles
                            .filter((file) => file.is_dir)
                            .map((file) => file.path)}
                        />
                      </div>
                    </aside>
                    <section className="flex min-w-0 flex-col overflow-hidden bg-white">
                      <div className="min-h-0 flex-1 p-2">
                        {selectedPrdFile && threadId ? (
                          <ResourcePreview
                            key={`${selectedPrdFile.path}:${prdPreviewReloadToken}`}
                            filePath={selectedPrdFile.path.replace(/^\/+/, "")}
                            workspacePath={
                              threadState?.workspacePath ?? requirement.requirementPath
                            }
                            threadId={threadId}
                            reloadToken={prdPreviewReloadToken}
                            onReload={() => setPrdPreviewReloadToken((value) => value + 1)}
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-5 text-muted-foreground">
                            请选择文件预览
                          </div>
                        )}
                      </div>
                    </section>
                  </div>
                ) : threadId ? (
                  <section className="min-h-0 flex-1 overflow-hidden bg-white p-2">
                    <ResourcePreview
                      key={`${fallbackPrdPath}:${prdPreviewReloadToken}`}
                      filePath={fallbackPrdPath.replace(/^\/+/, "")}
                      workspacePath={threadState?.workspacePath ?? requirement.requirementPath}
                      threadId={threadId}
                      reloadToken={prdPreviewReloadToken}
                      onReload={() => setPrdPreviewReloadToken((value) => value + 1)}
                    />
                  </section>
                ) : null}
              </TabsContent>

              <TabsContent value="requirement-space" className="m-0 min-h-0 flex-1 overflow-y-auto">
                {manifestLoading ? (
                  <div className="flex h-full min-h-[260px] items-center justify-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin text-primary" />
                    正在读取需求空间数据
                  </div>
                ) : manifestError ? (
                  <div className="flex h-full min-h-[260px] items-center justify-center px-6 text-center">
                    <div className="flex max-w-[340px] flex-col items-center gap-3">
                      <AlertTriangle className="size-5 text-status-critical" />
                      <p className="text-sm leading-5 text-status-critical">{manifestError}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-sm"
                        onClick={() => void loadRequirementSpaceManifest()}
                      >
                        重新读取
                      </Button>
                    </div>
                  </div>
                ) : requirementSpaceManifest ? (
                  <div className="space-y-4 p-4">
                    <section className="border-b border-border/70 pb-4">
                      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="mb-1 text-[11px] font-semibold uppercase text-muted-foreground">
                            PRD
                          </p>
                          <div className="flex items-center gap-1.5">
                            <h3 className="text-base font-semibold leading-6 text-foreground">
                              {requirementSpaceManifest.prd.name || requirement.title}
                            </h3>
                            <IconPopoverButton
                              aria-label={
                                requirementSpaceManifest.prd.file
                                  ? "查看 PRD 总览详情"
                                  : "暂无关联 PRD 文件"
                              }
                              icon={<Eye className="size-3.5" />}
                              disabled={!requirementSpaceManifest.prd.file}
                              popoverContent={
                                requirementSpaceManifest.prd.file
                                  ? "点击查看详情"
                                  : "暂无关联 PRD 文件"
                              }
                              onClick={() =>
                                handleFunctionFilePreview(requirementSpaceManifest.prd.file)
                              }
                            />
                          </div>
                        </div>
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold",
                            isRequirementSpacePublished(requirementSpaceManifest)
                              ? "border-status-nominal/30 bg-status-nominal/10 text-status-nominal"
                              : "border-status-info/30 bg-status-info/10 text-status-info"
                          )}
                        >
                          {isRequirementSpacePublished(requirementSpaceManifest) ? (
                            <CheckCircle2 className="size-3" />
                          ) : (
                            <Loader2 className="size-3" />
                          )}
                          {isRequirementSpacePublished(requirementSpaceManifest)
                            ? "已发布到需求空间3.0"
                            : requirementSpaceManifest.prd.status || "未发布"}
                        </span>
                      </div>
                      <p className="text-sm leading-5 text-muted-foreground">
                        {requirementSpaceManifest.prd.description || "暂无 PRD 描述"}
                      </p>
                      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
                        {requirementSpaceManifest.prd.file ? (
                          <span>
                            文档文件{" "}
                            <strong className="font-medium text-foreground">
                              {requirementSpaceManifest.prd.file}
                            </strong>
                          </span>
                        ) : null}
                      </div>
                      <div className={"flex justify-between items-center"}>
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          {!isRequirementSpacePublished(requirementSpaceManifest) ? (
                            <TooltipProvider delayDuration={180}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="inline-flex">
                                    <Button
                                      type="button"
                                      size="sm"
                                      disabled={publishRequestQueued || conversationLoading}
                                      className="h-8 gap-1.5 rounded-[7px] px-3 text-sm"
                                      onClick={handlePublishToRequirementSpace}
                                    >
                                      {publishRequestQueued ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                      ) : (
                                        <Send className="size-3.5" />
                                      )}
                                      {publishRequestQueued ? "发布请求已发送" : "发布到需求空间3.0"}
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                {publishRequestQueued || conversationLoading ? (
                                  <TooltipContent side="top" className="max-w-56 text-xs leading-relaxed">
                                    {publishRequestQueued
                                      ? "发布请求已提交，请稍候。"
                                      : "当前正在处理需求，请稍候再发布。"}
                                  </TooltipContent>
                                ) : null}
                              </Tooltip>
                            </TooltipProvider>
                          ) : null}
                          {requirementSpaceManifest.prd.prDetailUrl ? (
                            <button
                              type="button"
                              className="mt-3 inline-flex max-w-full items-center gap-1.5 truncate text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                              title={requirementSpaceManifest.prd.prDetailUrl}
                              onClick={() => {
                                const url = requirementSpaceManifest.prd.prDetailUrl
                                if (url) void window.electron.openExternal(url)
                              }}
                            >
                              <Eye className="size-3.5 shrink-0" />
                              <span className="truncate">去需求空间3.0查看本需求详情</span>
                            </button>
                          ) : null}
                        </div>
                        {!isRequirementSpacePublished(requirementSpaceManifest) ? (
                          <TooltipProvider delayDuration={180}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="inline-flex">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    disabled={conversationLoading || tokenSaving}
                                    className="h-8 gap-1.5 rounded-[7px] px-3 text-sm"
                                    onClick={() => void handleSendLeanstarToken()}
                                  >
                                    {tokenSaving ? (
                                      <Loader2 className="size-3.5 animate-spin" />
                                    ) : (
                                      <KeyRound className="size-3.5" />
                                    )}
                                    {hasStoredToken ? "发送Token身份令牌" : "获取Token身份令牌"}
                                  </Button>
                                </span>
                              </TooltipTrigger>
                              {conversationLoading || tokenSaving ? (
                                  <TooltipContent side="top" className="max-w-56 text-xs leading-relaxed">
                                  {tokenSaving
                                    ? "身份验证正在处理中，请稍候。"
                                    : "当前正在处理需求，请稍候再进行身份验证。"}
                                </TooltipContent>
                              ) : null}
                            </Tooltip>
                          </TooltipProvider>
                        ) : null}
                      </div>
                    </section>

                    <section>
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h4 className="text-sm font-semibold text-foreground">功能清单</h4>
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {requirementSpaceManifest.functions.length} 项
                        </span>
                      </div>
                      {requirementSpaceManifest.functions.length > 0 ? (
                        <div className="divide-y divide-border/70 border-y border-border/70">
                          {requirementSpaceManifest.functions.map((functionInfo) => (
                            <article
                              key={`${functionInfo.fr}-${functionInfo.file}`}
                              className="py-3"
                            >
                              <div className="flex items-start gap-2">
                                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                                  {functionInfo.fr}
                                </span>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <h5 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
                                      {functionInfo.name || "未命名功能"}
                                    </h5>
                                    <IconPopoverButton
                                      aria-label={
                                        functionInfo.file
                                          ? `查看${functionInfo.name || functionInfo.fr}详情`
                                          : "暂无关联 PRD 文件"
                                      }
                                      icon={<Eye className="size-3.5" />}
                                      disabled={!functionInfo.file}
                                      popoverContent={
                                        functionInfo.file ? "点击查看详情" : "暂无关联 PRD 文件"
                                      }
                                      onClick={() => handleFunctionFilePreview(functionInfo.file)}
                                    />
                                  </div>
                                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                                    {functionInfo.description || "暂无功能描述"}
                                  </p>
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {functionInfo.keywords.map((keyword, keywordIndex) => (
                                      <span
                                        key={`${functionInfo.fr}-${keyword}-${keywordIndex}`}
                                        className="rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                                      >
                                        {keyword}
                                      </span>
                                    ))}
                                  </div>
                                  {functionInfo.file ? (
                                    <p className="mt-2 text-[11px] text-muted-foreground">
                                      文档文件 {functionInfo.file}
                                    </p>
                                  ) : null}
                                </div>
                              </div>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="border-y border-border/70 py-4 text-sm text-muted-foreground">
                          暂无功能数据
                        </p>
                      )}
                    </section>
                  </div>
                ) : (
                  <div className="flex h-full min-h-[260px] items-center justify-center text-sm text-muted-foreground">
                    暂无需求空间数据
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </aside>
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
  requirements,
  onSelectRequirement,
  onRequirementUpdated,
  onDeleteRequirement,
  onBack,
  onNew,
  autoGeneratePrd = false
}: {
  requirement: RequirementRecord
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
      key={requirement.id}
      requirement={requirement}
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
