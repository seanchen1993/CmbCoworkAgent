import React, { useRef, useEffect, useMemo, useCallback, useState } from "react"
import {
  Send,
  Square,
  AlertCircle,
  X,
  FileText,
  FileSpreadsheet,
  Presentation,
  Search,
  Palette,
  FlaskConical,
  Code2,
  LayoutTemplate,
  Settings2,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Info,
  Database,
  Layers,
  Clock,
  Notebook,
  Zap,
  Sparkles,
  Wrench,
  CircleAlert,
  FilePenLine,
  Plus,
  Loader2
} from "lucide-react"
import type { FileAttachment } from "@/types"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { useShallow } from "zustand/react/shallow"
import { useCurrentThread, useThreadStream } from "@/lib/thread-context"
import { ModelSwitcher } from "./ModelSwitcher"
import { WorkspacePicker } from "./WorkspacePicker"
import { ChatTodos } from "./ChatTodos"
import { ContextUsageIndicator } from "./ContextUsageIndicator"
import { GitBranchSwitcher } from "./GitBranchSwitcher"
import type { Message, SkillMetadata } from "@/types"
import { MessageBubble } from "./MessageBubble"
import { UpdateStatusCard } from "./UpdateStatusCard"
import {
  SkillCreateConfirmDialog,
  type SkillConfirmRequest
} from "./SkillCreateConfirmDialog"
import { uploadChatData, ChatReportPayload } from "@/api"
import { marketApi, MarketItem } from "../../api/market"
import { insertLog, updateMMJUserInfo } from "../../../js/mmjUtils"
import { UpdateDialog } from "../update/UpdateDialog"
import { toast } from "sonner"

interface AgentStreamValues {
  todos?: Array<{ id?: string; content?: string; status?: string }>
}

interface StreamMessage {
  id?: string
  type?: string
  content?: string | unknown[]
  tool_calls?: Message["tool_calls"]
  tool_call_id?: string
  name?: string
}

interface ChatContainerProps {
  threadId: string
  showGitChangeNotice?: boolean
  onOpenGitPanel?: () => void
  onThreadGitStatusChange?: (threadId: string, isGit: boolean) => void
}

interface SkillIntentBannerRequest {
  requestId: string
  summary: string
  toolCallCount: number
  mode: "mode_a_rule" | "mode_b_llm"
  recommendationReason?: string
  /** Opaque context — cached so the retry button can replay generation without a new threshold. */
  context: unknown
}

const THINKING_MESSAGES = [
  "我先想想...",
  "让我捋一捋...",
  "我去翻翻代码...",
  "我来找线索...",
  "先做个判断...",
  "我再核对一下...",
  "先把思路摊开...",
  "我来拼一下答案...",
  "我再压一遍细节...",
  "先看下上下文...",
  "我再过一遍日志...",
  "我来换个角度...",
  "先把重点抓出来...",
  "让我算一轮...",
  "我再确认一下...",
  "我先试条路...",
  "我去查个依据...",
  "我先把话说准...",
  "我再补一刀...",
  "我来收个尾...",
  "先别急，快到了...",
  "差最后一段了...",
  "我再润一润...",
  "再给我两秒...",
  "我来给你个稳妥版...",
  "我先把坑绕开...",
  "我再压压风险...",
  "先把答案打磨下...",
  "马上给你结果...",
  "就快好了..."
]

const SUPPORTED_EXTS = new Set([".txt", ".md", ".csv", ".docx", ".xlsx", ".xls"])
const MAX_ATTACHMENTS = 3
const MAX_TOTAL_CHARS = 24_000
const escXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const ROTATING_WORDS = [
  "编写代码", "调试问题", "创建技能", "管理任务",
  "重构项目", "解答疑惑", "审查代码", "优化性能",
  "编写测试", "设计方案", "分析日志", "部署上线"
]

function RotatingHeadline() {
  const [wordIndex, setWordIndex] = useState(0)
  const [displayed, setDisplayed] = useState("")
  const [phase, setPhase] = useState<"typing" | "showing" | "erasing">("typing")

  useEffect(() => {
    const word = ROTATING_WORDS[wordIndex]
    let timer: ReturnType<typeof setTimeout> | undefined

    if (phase === "typing") {
      if (displayed.length < word.length) {
        timer = setTimeout(() => setDisplayed(word.slice(0, displayed.length + 1)), 150)
      } else {
        setPhase("showing")
      }
    } else if (phase === "showing") {
      timer = setTimeout(() => setPhase("erasing"), 2000)
    } else if (phase === "erasing") {
      if (displayed.length > 0) {
        timer = setTimeout(() => setDisplayed(displayed.slice(0, -1)), 80)
      } else {
        setWordIndex((i) => (i + 1) % ROTATING_WORDS.length)
        setPhase("typing")
      }
    }

    return () => { if (timer) clearTimeout(timer) }
  }, [displayed, phase, wordIndex])

  return (
    <div className="mb-6 flex items-center justify-start">
      <div className="text-2xl md:text-3xl font-bold tracking-tight leading-none">
        <span className="text-foreground">为你</span>
        <span className="text-[#D97757] mx-3">{'>'}</span>
        <span className="text-[#D97757]">{displayed}</span>
      </div>
    </div>
  )
}

export function ChatContainer({
  threadId,
  showGitChangeNotice = false,
  onOpenGitPanel,
  onThreadGitStatusChange
}: ChatContainerProps): React.JSX.Element {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const isComposingRef = useRef(false)
  const [skills, setSkills] = useState<SkillMetadata[]>([])
  const [skillsLoading, setSkillsLoading] = useState(true)
  const [showAllGeneralSkills, setShowAllGeneralSkills] = useState(false)
  const [showAllProgrammingSkills, setShowAllProgrammingSkills] = useState(false)
  const [showAllCustomSkills, setShowAllCustomSkills] = useState(false)
  const [thinkingMessageIndex, setThinkingMessageIndex] = useState(0)
  // Skill creation human-confirmation state
  const [skillConfirmRequest, setSkillConfirmRequest] = useState<SkillConfirmRequest | null>(null)
  // Skill intent banner state ("Want to save as a skill?")
  const [skillIntentRequest, setSkillIntentRequest] = useState<SkillIntentBannerRequest | null>(null)

  // Skill generation state stored globally so RightPanel can render the virtual subagent card
  const { setSkillGenerationPhase, appendSkillGenerationToken, setSkillRetryContext } = useAppStore(
    useShallow((s) => ({
      setSkillGenerationPhase: s.setSkillGenerationPhase,
      appendSkillGenerationToken: s.appendSkillGenerationToken,
      setSkillRetryContext: s.setSkillRetryContext
    }))
  )
  const [yoloMode, setYoloMode] = useState(false)
  const [glowVisible, setGlowVisible] = useState(false)
  // NUX (first-run sandbox setup)
  const [showNux, setShowNux] = useState(false)
  const [nuxLoading, setNuxLoading] = useState(false)
  const [nuxError, setNuxError] = useState<string | null>(null)
  const [nuxLoadingStep, setNuxLoadingStep] = useState(0)

  const NUX_LOADING_STEPS = [
    "正在准备沙箱环境...",
    "等待管理员授权，请在弹出的窗口中点击「是」...",
    "正在创建沙箱隔离用户...",
    "正在配置目录访问权限...",
    "即将完成，请稍候...",
  ]
  const thinkingCycleRef = useRef(-1)
  const wasLoadingRef = useRef(false)
  const loadingMessageCountRef = useRef(0)
  const [needUpdateVersion, setNeedUpdateVersion] = useState(false)
  const [modelContextLimit, setModelContextLimit] = useState<number | undefined>(undefined)
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false)

  useEffect(() => {
    const { ipcRenderer } = window.electron

    // 主动请求版本，不依赖推送时序
    ipcRenderer.invoke("get-version").then((ver: unknown) => {
      console.log("版本 (invoke)：", ver)
      if (ver) {
        localStorage.setItem("version", ver as string)
        updateMMJUserInfo()
      }
    }).catch((e: unknown) => console.warn("get-version failed:", e))

    // 保留推送监听作为备用
    const removeListener = ipcRenderer.on("version", (ver: unknown) => {
      console.log("版本 (push)：", ver)
      localStorage.setItem("version", ver as string)
      updateMMJUserInfo()
    })

    return () => {
      if (typeof removeListener === "function") removeListener()
    }
  }, [])

  useEffect(() => {
    const { ipcRenderer } = window.electron

    // 主动请求 IP，不依赖推送时序
    ipcRenderer.invoke("get-local-ip").then((ip: unknown) => {
      console.log("local ip (invoke)：", ip)
      if (ip) {
        localStorage.setItem("localIp", ip as string)
        updateMMJUserInfo()
      }
    }).catch((e: unknown) => console.warn("get-local-ip failed:", e))

    // 保留推送监听作为备用（例如网络变化时主进程重新推送）
    const removeListener = ipcRenderer.on("ip", (ver: unknown) => {
      console.log("local ip (push)：", ver)
      if (ver) {
        localStorage.setItem("localIp", ver as string)
      }
    })

    return () => {
      if (typeof removeListener === "function") removeListener()
    }
  }, [])

  const {
    threads,
    models,
    loadThreads,
    generateTitleForFirstMessage,
    setShowCustomizeView
  } = useAppStore()

  const goodSkillsRef = useRef<MarketItem[]>([])
  const allSkillsRef = useRef<MarketItem[]>([])
  const [goodSkillsData, setGoodSkillsData] = useState<MarketItem[]>([])

  // Define loadSkills function at component level so it can be accessed everywhere
  const loadSkills = useCallback(async (): Promise<void> => {
    try {
      const [loadedSkills, disabledList] = await Promise.all([
        window.api.skills.list(),
        window.api.skills.getDisabled()
      ])
      const disabledSet = new Set(disabledList)
      // Include both built-in (project) and custom (user) skills
      const availableSkills = loadedSkills.filter(
        (s) => (s.source === "project" || s.source === "user") && !disabledSet.has(s.name)
      )
      setSkills([...availableSkills].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")))
    } catch (error) {
      console.error("[ChatContainer] Failed to load skills:", error)
      setSkills([])
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  const queryRemoteSkills = useCallback(async () => {
    try {
      const res = await marketApi.getSkills()
      const goodSkills = res?.data?.filter((it) => it.featured === "精品")
      goodSkillsRef.current = goodSkills || []
      allSkillsRef.current = res?.data || []
      setGoodSkillsData(goodSkills || [])

      // 自动安装所有精品技能
      if (goodSkills && goodSkills.length > 0) {
        await installAllGoodSkills(goodSkills)
        // 安装完成后重新加载技能列表
        await loadSkills()
      }
    } catch (error) {
      console.error("Failed to query remote skills:", error)
    }
  }, [loadSkills])

  const getSkillShowLabel=(name)=>{
    const target = allSkillsRef.current?.find((it) => it.name === name || it.chinese_name === name)
    return target?.chinese_name || name || ""
  }

  const getTargetRemoteSkill = useCallback((name: string) => {
    const target = allSkillsRef.current?.find((it) => it.name === name || it.chinese_name === name)
    return target?.guidance || ""
  }, [])

  const installAllGoodSkills = async (goodSkills: MarketItem[]) => {
    console.log("Starting automatic installation of good skills...")

    for (const skill of goodSkills) {
      try {
        const skillName = skill.name || skill.id || ""

        if (!skillName) {
          console.error("Skill name is required for installation:", skill)
          continue
        }

        console.log(`Installing skill: ${skillName}`)

        // 删除已存在的技能（如果有的话）
        try {
          const skillsMetadata = await window.api.skills.list()
          const existingSkill = skillsMetadata.find((s) => s.name === skillName)

          if (existingSkill) {
            console.log(`Deleting existing skill: ${existingSkill.path}`)
            await window.api.skills.delete(existingSkill.path)
          }
        } catch (deleteError) {
          console.warn(
            `Failed to delete existing skill ${skillName}, continuing with install:`,
            deleteError
          )
        }

        // 下载并安装技能
        const response = await marketApi.downloadItem(skillName, "skill", false)

        if (response.success) {
          console.log(`Successfully installed skill: ${skillName}`)
        } else {
          console.error(`Failed to install skill ${skillName}:`, response.error)
        }
      } catch (error) {
        console.error(`Failed to install skill ${skill.name}:`, error)
      }
    }

    console.log("Finished automatic installation of good skills")
  }

  // Get persisted thread state and actions from context
  const {
    messages: threadMessages,
    pendingApproval,
    todos,
    error: threadError,
    workspacePath,
    tokenUsage,
    currentModel,
    draftInput: input,
    scheduledTaskLoading,
    scheduledTaskId,
    modelRetry,
    setTodos,
    setPendingApproval,
    appendMessage,
    setError,
    clearError,
    setDraftInput: setInput
  } = useCurrentThread(threadId)

  // Get the stream data via subscription - reactive updates without re-rendering provider
  const streamData = useThreadStream(threadId)
  const stream = streamData.stream
  const [savedToolNameInput, setSavedToolNameInput] = useState("")
  const [savedToolDescriptionInput, setSavedToolDescriptionInput] = useState("")
  const [saveToolMetadataLoading, setSaveToolMetadataLoading] = useState(false)

  useEffect(() => {
    const approval = pendingApproval as unknown as Record<string, unknown> | null
    if (approval?.operation === "save_code_exec_tool") {
      setSaveToolMetadataLoading(false)
      setSavedToolNameInput(String(approval.savedToolName || ""))
      setSavedToolDescriptionInput(String(approval.savedToolDescription || ""))
      return
    }

    if (!pendingApproval || approval?.operation !== "prepare_save_code_exec_tool") {
      setSaveToolMetadataLoading(false)
    }

    setSavedToolNameInput("")
    setSavedToolDescriptionInput("")
  }, [pendingApproval])
  const isLoading = streamData.isLoading || scheduledTaskLoading

  // ── File attachments state ──
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [attachmentLoading, setAttachmentLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const attachmentsRef = useRef<FileAttachment[]>([])

  // Keep ref in sync with state
  useEffect(() => { attachmentsRef.current = attachments }, [attachments])


  const totalAttachmentChars = useMemo(
    () => attachments.reduce((sum, a) => sum + a.content.length, 0),
    [attachments]
  )

  const handleFileSelectByPath = useCallback(async (filePaths: string[]) => {
    if (filePaths.length === 0 || attachmentLoading) return
    setAttachmentLoading(true)
    clearError()
    try {
      const snapshot = attachmentsRef.current
      let currentCount = snapshot.length
      let currentChars = snapshot.reduce((sum, a) => sum + a.content.length, 0)
      const existingPaths = new Set(snapshot.map((a) => a.filePath))

      for (const filePath of filePaths) {
        // #7: skip duplicates
        if (existingPaths.has(filePath)) {
          const dupName = filePath.replace(/^.*[/\\]/, "") || filePath
          setError(`文件"${dupName}"已添加，跳过重复`)
          continue
        }

        // #6: check extension before calling backend
        const lastDot = filePath.lastIndexOf(".")
        const ext = lastDot >= 0 ? filePath.substring(lastDot).toLowerCase() : ""
        if (!ext || !SUPPORTED_EXTS.has(ext)) {
          const fileName = filePath.replace(/^.*[/\\]/, "") || filePath
          setError(`不支持的文件类型"${fileName}"，仅支持 txt、md、csv、docx、xlsx、xls`)
          continue
        }

        if (currentCount >= MAX_ATTACHMENTS) {
          setError(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`)
          break
        }

        const remaining = MAX_TOTAL_CHARS - currentChars
        if (remaining <= 0) {
          setError(`附件总内容已达上限（${MAX_TOTAL_CHARS.toLocaleString()} 字符）`)
          break
        }
        const result = await window.api.file.parse(filePath, remaining)
        if (result.success && result.attachment) {
          // #12: skip empty files
          if (!result.attachment.content.trim()) {
            setError(`文件 "${result.attachment.filename}" 内容为空`)
            continue
          }
          setAttachments((prev) => [...prev, result.attachment!])
          existingPaths.add(result.attachment.filePath)
          currentCount++
          currentChars += result.attachment.content.length
        } else {
          setError(result.error || "文件解析失败")
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "文件处理异常")
    } finally {
      setAttachmentLoading(false)
    }
  }, [setError, clearError, attachmentLoading])

  const handleAttachClick = useCallback(async () => {
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      setError(`最多只能添加 ${MAX_ATTACHMENTS} 个附件`)
      return
    }
    const result = await window.api.file.select()
    if (!result.canceled && result.filePaths.length > 0) {
      await handleFileSelectByPath(result.filePaths)
    }
  }, [handleFileSelectByPath, setError])

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const dropZoneRef = useRef<HTMLDivElement>(null)

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (attachmentLoading) return
    const files = e.dataTransfer.files
    if (files.length > 0) {
      const paths = Array.from(files)
        .map((f) => window.api.file.getFilePath(f))
        .filter((p) => !!p)
      if (paths.length > 0) {
        await handleFileSelectByPath(paths)
      }
    }
  }, [handleFileSelectByPath, attachmentLoading])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only show drag indicator if dragging files (not text)
    if (e.dataTransfer.types.includes("Files")) {
      setDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only clear if leaving the drop zone (not entering a child element)
    if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget as Node)) {
      setDragOver(false)
    }
  }, [])

  // Prevent Electron from navigating to dropped files (default browser behavior)
  // Use capture phase so it runs before React's synthetic events
  useEffect(() => {
    const preventNav = (e: DragEvent): void => {
      // Allow events on our drop zone to propagate to React handlers
      if (dropZoneRef.current?.contains(e.target as Node)) return
      e.preventDefault()
    }
    document.addEventListener("dragover", preventNav, true)
    document.addEventListener("drop", preventNav, true)
    return () => {
      document.removeEventListener("dragover", preventNav, true)
      document.removeEventListener("drop", preventNav, true)
    }
  }, [])

  // ── End file attachments ──

  // 从模型配置中获取用户设置的上下文窗口大小
  useEffect(() => {
    if (!currentModel || !currentModel.startsWith("custom:")) {
      setModelContextLimit(undefined)
      return
    }
    let ignore = false
    const id = currentModel.replace("custom:", "")
    window.api.models
      .getCustomConfigs()
      .then((configs) => {
        if (ignore) return
        const match = configs.find((c) => c.id === id)
        setModelContextLimit(match?.maxTokens)
      })
      .catch(() => {
        if (!ignore) setModelContextLimit(undefined)
      })
    return () => { ignore = true }
  }, [currentModel])

  const syncNeedUpdateVersion = useCallback(async () => {
    try {
      const status = await window.api.update.getStatus()
      setNeedUpdateVersion(Boolean(status.update) && status.status !== "idle")
    } catch (error) {
      console.warn("[ChatContainer] Failed to sync update status:", error)
      setNeedUpdateVersion(false)
    }
  }, [])

  useEffect(() => {
    const updateApi = window.api.update
    void syncNeedUpdateVersion()

    const removeAvailable = updateApi.onAvailable(() => {
      setNeedUpdateVersion(true)
    })
    const removeDownloaded = updateApi.onDownloaded(() => {
      setNeedUpdateVersion(true)
    })
    const removeError = updateApi.onError(() => {
      void syncNeedUpdateVersion()
    })

    return () => {
      removeAvailable()
      removeDownloaded()
      removeError()
    }
  }, [syncNeedUpdateVersion])

  useEffect(() => {
    if (!updateDialogOpen) {
      void syncNeedUpdateVersion()
    }
  }, [updateDialogOpen, syncNeedUpdateVersion])

  useEffect(() => {
    queryRemoteSkills()
    const fetchYoloMode = (): void => {
      window.api.sandbox
        .getYoloMode()
        .then(setYoloMode)
        .catch((e) => console.warn("[YoloMode] Failed to fetch:", e))
    }
    fetchYoloMode()
    return window.api.sandbox.onChanged(fetchYoloMode)
  }, []) // 移除queryRemoteSkills依赖，只在组件挂载时执行一次

  const uploadLoChatData = useCallback(async (msgs: Message[]) => {
    const lastMsg = msgs[msgs.length - 1]
    if (lastMsg) {
      if (lastMsg.role !== "user") {
        let lUidx = -1
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === "user") {
            lUidx = i
            break
          }
        }
        if (lUidx !== -1) {
          await uploadChatData(threadId, msgs.slice(lUidx) as ChatReportPayload[])
        }
      }
    }
  }, [threadId])

  // Check if NUX (first-run sandbox setup) is needed, then auto-start elevated setup.
  // If elevated setup fails (UAC cancelled, setup exe missing, etc.), the main process
  // automatically falls back to unelevated mode — so the app is always usable.
  useEffect(() => {
    window.api.sandbox.isNuxNeeded().then((needed) => {
      if (!needed) return
      setShowNux(true)
      setNuxLoading(true)
      setNuxError(null)
      window.api.sandbox.completeNux("elevated")
        .then(() => setShowNux(false))
        .catch(() => {
          // Elevated failed but main process already fell back to unelevated — just close NUX
          setShowNux(false)
        })
    }).catch((e) => console.warn("[NUX] Failed to check:", e))
  }, [])

  // Cycle loading step messages while NUX is configuring
  useEffect(() => {
    if (!nuxLoading) { setNuxLoadingStep(0); return }
    const timers = [
      setTimeout(() => setNuxLoadingStep(1), 3_000),
      setTimeout(() => setNuxLoadingStep(2), 12_000),
      setTimeout(() => setNuxLoadingStep(3), 30_000),
      setTimeout(() => setNuxLoadingStep(4), 60_000),
    ]
    return () => timers.forEach(clearTimeout)
  }, [nuxLoading])

  // Thinking messages: loading 时轮换提示语
  useEffect(() => {
    const currentMessageCount = streamData.messages.length

    if (!isLoading) {
      wasLoadingRef.current = false
      loadingMessageCountRef.current = 0
      return
    }

    // First entering loading for this turn.
    if (!wasLoadingRef.current) {
      thinkingCycleRef.current = (thinkingCycleRef.current + 1) % THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      loadingMessageCountRef.current = currentMessageCount
      wasLoadingRef.current = true
      return
    }

    // During the same turn, if new streamed messages arrive (e.g. tool round-trip),
    // switch to next slogan once to mimic "stage changed" feedback.
    if (currentMessageCount > loadingMessageCountRef.current) {
      thinkingCycleRef.current = (thinkingCycleRef.current + 1) % THINKING_MESSAGES.length
      setThinkingMessageIndex(thinkingCycleRef.current)
      loadingMessageCountRef.current = currentMessageCount
    }
  }, [isLoading, streamData.messages.length])

  useEffect(() => {
    uploadLoChatData(threadMessages)
  }, [threadMessages, uploadLoChatData])

  const handleApprovalDecision = useCallback(
    async (decision: "approve" | "approve_session" | "approve_permanent" | "reject" | "edit"): Promise<void> => {
      if (!pendingApproval) return

      // Check if this is an orchestrator-sourced approval (has requestId)
      const approvalAny = pendingApproval as unknown as Record<string, unknown>
      if (approvalAny._orchestratorRequestId) {
        const operation = approvalAny.operation as string | undefined
        if (operation === "prepare_save_code_exec_tool" && decision === "approve") {
          setSaveToolMetadataLoading(true)
        } else {
          setSaveToolMetadataLoading(false)
        }

        // Send decision to main process via the orchestrator's IPC channel
        window.api.sandbox.sendApprovalDecision({
          requestId: approvalAny._orchestratorRequestId as string,
          type: decision === "edit" ? "reject" : decision,
          tool_call_id: pendingApproval.tool_call?.id || "",
          ...(approvalAny.operation === "save_code_exec_tool" && decision === "approve"
            ? { savedToolName: savedToolNameInput }
            : {}),
          ...(approvalAny.operation === "save_code_exec_tool" && decision === "approve"
            ? { savedToolDescription: savedToolDescriptionInput }
            : {})
        })

        if (!(operation === "prepare_save_code_exec_tool" && decision === "approve")) {
          setPendingApproval(null)
        }
        return
      }

      // Legacy HITL approval path (non-execute tools)
      if (!stream) {
        setPendingApproval(null)
        return
      }
      setPendingApproval(null)

      try {
        const legacyDecision = (decision === "approve_session" || decision === "approve_permanent") ? "approve" : decision
        await stream.submit(null, {
          command: { resume: { decision: legacyDecision, pendingCount: pendingApproval.pendingCount } },
          config: { configurable: { thread_id: threadId, model_id: currentModel } }
        })
      } catch (err) {
        console.error("[ChatContainer] Resume command failed:", err)
      }
    },
    [currentModel, pendingApproval, savedToolDescriptionInput, savedToolNameInput, setPendingApproval, stream, threadId]
  )

  const agentValues = stream?.values as AgentStreamValues | undefined

  // Approval listeners are now registered globally in ThreadProvider for ALL active threads,
  // so approval requests are received even when this ChatContainer is not mounted (user viewing another tab).

  const streamTodos = agentValues?.todos
  useEffect(() => {
    if (Array.isArray(streamTodos)) {
      setTodos(
        streamTodos.map((t) => ({
          id: t.id || crypto.randomUUID(),
          content: t.content || "",
          status: (t.status || "pending") as "pending" | "in_progress" | "completed" | "cancelled"
        }))
      )
    }
  }, [streamTodos, setTodos])

  // Apple Intelligence glow: loading 时显示，淡出由 CSS animation + onAnimationEnd 控制
  useEffect(() => {
    if (isLoading) {
      setGlowVisible(true)
      return
    }
    // 兜底：如果 transitionEnd 未触发（快速切换等边界情况），3s 后强制隐藏
    const timer = setTimeout(() => setGlowVisible(false), 3000)
    return () => clearTimeout(timer)
  }, [isLoading])

  const prevLoadingRef = useRef(false)
  useEffect(() => {
    if (prevLoadingRef.current && !isLoading) {
      for (const rawMsg of streamData.messages) {
        const msg = rawMsg as StreamMessage
        if (msg.id) {
          const streamMsg = msg as StreamMessage & { id: string }

          let role: Message["role"] = "assistant"
          if (streamMsg.type === "human") role = "user"
          else if (streamMsg.type === "tool") role = "tool"  // ✅ 修复: tool 不应映射为 assistant
          else if (streamMsg.type === "ai") role = "assistant"

          const storeMsg: Message = {
            id: streamMsg.id,
            role,
            content: typeof streamMsg.content === "string" ? streamMsg.content : "",
            tool_calls: streamMsg.tool_calls,
            ...(role === "tool" &&
              streamMsg.tool_call_id && { tool_call_id: streamMsg.tool_call_id }),
            ...(role === "tool" && streamMsg.name && { name: streamMsg.name }),
            created_at: new Date()
          }
          appendMessage(storeMsg)
        }
      }
    }
    prevLoadingRef.current = isLoading
  }, [isLoading, streamData.messages, loadThreads, appendMessage])

  const displayMessages = useMemo(() => {
    const threadMessageIds = new Set(threadMessages.map((m) => m.id))

    const streamingMsgs: Message[] = ((streamData.messages || []) as StreamMessage[])
      .filter((m): m is StreamMessage & { id: string } => !!m.id && !threadMessageIds.has(m.id))
      .map((streamMsg) => {
        let role: Message["role"] = "assistant"
        if (streamMsg.type === "human") role = "user"
        else if (streamMsg.type === "tool") role = "tool"
        else if (streamMsg.type === "ai") role = "assistant"

        return {
          id: streamMsg.id,
          role,
          content: typeof streamMsg.content === "string" ? streamMsg.content : "",
          tool_calls: streamMsg.tool_calls,
          ...(role === "tool" &&
            streamMsg.tool_call_id && { tool_call_id: streamMsg.tool_call_id }),
          ...(role === "tool" && streamMsg.name && { name: streamMsg.name }),
          created_at: new Date()
        }
      })

    // Clean up attachment XML tags in user messages for display
    const allMessages = [...threadMessages, ...streamingMsgs]
    return allMessages.map((msg) => {
      if (msg.role !== "user" || typeof msg.content !== "string" || !msg.content.includes("<attachment ")) return msg
      // Extract filenames and user text separately, then reorder: filenames first
      const fileNames: string[] = []
      const textOnly = msg.content
        .replace(/<attachment\s+filename="([^"]*)"[^>]*>[\s\S]*?<\/attachment>/g, (_match, name) => {
          const decoded = name.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          fileNames.push(`📎 ${decoded}`)
          return ""
        })
        .trim()
      const cleaned = fileNames.length > 0
        ? `${fileNames.join("\n")}\n\n${textOnly}`.trim()
        : textOnly
      return { ...msg, content: cleaned }
    })
  }, [threadMessages, streamData.messages])

  // Build tool results map from tool messages
  const toolResults = useMemo(() => {
    const results = new Map<string, { content: string | unknown; is_error?: boolean }>()
    for (const msg of displayMessages) {
      if (msg.role === "tool" && msg.tool_call_id) {
        results.set(msg.tool_call_id, {
          content: msg.content,
          is_error: false // Could be enhanced to track errors
        })
      }
    }
    return results
  }, [displayMessages])

  // Get the actual scrollable viewport element from Radix ScrollArea
  const getViewport = useCallback((): HTMLDivElement | null => {
    return scrollRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLDivElement | null
  }, [])

  // Track scroll position to determine if user is at bottom
  const handleScroll = useCallback((): void => {
    const viewport = getViewport()
    if (!viewport) return

    const { scrollTop, scrollHeight, clientHeight } = viewport
    // Consider "at bottom" if within 50px of the bottom
    const threshold = 50
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < threshold
  }, [getViewport])

  // Attach scroll listener to viewport
  useEffect(() => {
    const viewport = getViewport()
    if (!viewport) return

    viewport.addEventListener("scroll", handleScroll)
    return () => viewport.removeEventListener("scroll", handleScroll)
  }, [getViewport, handleScroll])

  // Auto-scroll on new messages only if already at bottom
  useEffect(() => {
    const viewport = getViewport()
    if (viewport && isAtBottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [displayMessages, isLoading, getViewport])

  // Force scroll to bottom when an approval request arrives — the user must see and act on it
  useEffect(() => {
    if (!pendingApproval) return
    const viewport = getViewport()
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
      isAtBottomRef.current = true
    }
  }, [pendingApproval, getViewport])

  // Always scroll to bottom when switching threads
  useEffect(() => {
    const viewport = getViewport()
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight
      isAtBottomRef.current = true
    }
  }, [threadId, getViewport])

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [threadId])

  const handleDismissError = (): void => {
    clearError()
  }

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if ((!input.trim() && attachments.length === 0) || isLoading || !stream) return

    if (!currentModel) {
      setError("请先在下方选择模型后再发送消息。")
      return
    }

    const selectedModel = models.find((m) => m.id === currentModel)
    if (!selectedModel) {
      setError("当前线程模型不存在，请重新选择模型。")
      return
    }

    if (!selectedModel.available) {
      setError("当前模型不可用，请先在模型配置中设置 API 密钥。")
      return
    }

    if (!workspacePath) {
      setError("请先选择一个工作区文件夹再发送消息。")
      return
    }

    if (threadError) {
      clearError()
    }

    if (pendingApproval) {
      // P0 fix: notify main process to reject the pending approval instead of silently dropping it.
      // Otherwise the orchestrator's Promise hangs until the 5-minute timeout.
      const approvalAny = pendingApproval as unknown as Record<string, unknown>
      if (approvalAny._orchestratorRequestId) {
        window.api.sandbox.sendApprovalDecision({
          requestId: approvalAny._orchestratorRequestId as string,
          type: "reject",
          tool_call_id: pendingApproval.tool_call?.id || ""
        })
      }
      setPendingApproval(null)
    }

    const rawMessage = input.trim()
    const currentAttachments = attachments.length > 0 ? [...attachments] : undefined
    // If user only uploaded files without text, add a default prompt
    const userText = rawMessage || (currentAttachments ? "请分析以下文件内容。" : "")
    setInput("")
    setAttachments([])
    insertLog('send: '+userText)

    const isFirstMessage = threadMessages.length === 0

    // Build the full message with attachments as XML tags (sent to model)
    let fullMessage = userText
    if (currentAttachments && currentAttachments.length > 0) {
      const attachmentTexts = currentAttachments.map((att) => {
        const truncAttr = att.truncated ? ' truncated="true"' : ""
        const pathAttr = att.filePath ? ` path="${escXml(att.filePath)}"` : ""
        const safeContent = att.content.replace(/<\/attachment>/gi, "< /attachment>")
        return `\n\n<attachment filename="${escXml(att.filename)}"${pathAttr} type="${att.mimeType}" size="${att.size}"${truncAttr}>\n${safeContent}\n</attachment>`
      })
      fullMessage = userText + attachmentTexts.join("")
    }

    // Build display content: show attachment filenames in user bubble (not full content)
    let displayContent: string = userText
    if (currentAttachments && currentAttachments.length > 0) {
      const fileNames = currentAttachments.map((a) => `📎 ${a.filename}`).join("\n")
      displayContent = `${fileNames}\n\n${userText}`
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: displayContent,
      created_at: new Date()
    }
    appendMessage(userMessage)

    if (isFirstMessage) {
      const currentThread = threads.find((t) => t.thread_id === threadId)
      const hasDefaultTitle = currentThread?.title?.startsWith("Thread ")
      if (hasDefaultTitle) {
        generateTitleForFirstMessage(threadId, userText)
      }
    }

    await stream.submit(
      {
        messages: [{ type: "human", content: fullMessage }]
      },
      {
        config: {
          configurable: { thread_id: threadId, model_id: currentModel }
        }
      }
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // IME composing (Chinese/Japanese/Korean) should not trigger submit on Enter
    const isComposing = e.nativeEvent.isComposing || isComposingRef.current
    if (isComposing) return

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  // Auto-resize textarea based on content
  const adjustTextareaHeight = (): void => {
    const textarea = inputRef.current
    if (textarea) {
      textarea.style.height = "auto"
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
    }
  }

  useEffect(() => {
    adjustTextareaHeight()
  }, [input])

  const handleCancel = async (): Promise<void> => {
    if (scheduledTaskLoading && scheduledTaskId) {
      try {
        await window.api.scheduledTasks.cancel(scheduledTaskId)
      } catch (err) {
        console.error("[ChatContainer] Failed to cancel scheduled task:", err)
      }
    } else if (scheduledTaskLoading && threadId === "heartbeat") {
      try {
        await window.api.heartbeat.cancel()
      } catch (err) {
        console.error("[ChatContainer] Failed to cancel heartbeat:", err)
      }
    } else if (scheduledTaskLoading) {
      // ChatX bot thread: scheduledTaskLoading is true but no scheduledTaskId
      try {
        const cancelled = await window.api.chatx.cancelByThread(threadId)
        if (!cancelled) console.warn("[ChatContainer] ChatX thread not found for cancel:", threadId)
      } catch (err) {
        console.error("[ChatContainer] Failed to cancel ChatX thread:", err)
      }
    } else {
      // Stop frontend stream and kill backend child processes in parallel
      await Promise.all([
        stream?.stop(),
        window.api.agent.cancel(threadId)
      ])
    }
  }

  useEffect(() => {
    void loadSkills()
  }, [])

  // ── Skill creation human-confirmation listener ──────────
  useEffect(() => {
    console.log("[ChatContainer] Registering skill confirm listener")
    const cleanup = window.api.skillEvolution.onConfirmRequest((req) => {
      // Ignore events that belong to a different thread (stale background run)
      if (req.threadId && req.threadId !== useAppStore.getState().currentThreadId) return
      console.log("[ChatContainer] Received skill confirm request:", req.requestId, req.name)
      setSkillConfirmRequest(req)
      // Mark generation as done — RightPanel will switch the card to "completed"
      setSkillGenerationPhase("done")
    })
    return cleanup
  }, [setSkillGenerationPhase])

  const handleSkillApprove = useCallback((requestId: string): void => {
    console.log("[ChatContainer] Approving skill confirm request:", requestId)
    void window.api.skillEvolution.confirmResponse(requestId, true)
    setSkillConfirmRequest(null)
  }, [])

  const handleSkillReject = useCallback((requestId: string): void => {
    console.log("[ChatContainer] Rejecting skill confirm request:", requestId)
    void window.api.skillEvolution.confirmResponse(requestId, false)
    setSkillConfirmRequest(null)
  }, [])

  // ── Skill intent banner listener (Mode A: "Want to save as skill?") ──
  useEffect(() => {
    console.log("[ChatContainer] Registering skill intent listener")
    const cleanup = window.api.skillEvolution.onIntentRequest((req) => {
      // Ignore events that belong to a different thread (stale background run)
      if (req.threadId && req.threadId !== useAppStore.getState().currentThreadId) return
      console.log(
        "[ChatContainer] Received skill intent request:",
        req.requestId,
        req.mode,
        req.toolCallCount
      )
      setSkillIntentRequest(req)
    })
    return cleanup
  }, [])

  const handleSkillIntentYes = useCallback((): void => {
    if (!skillIntentRequest) return
    console.log("[ChatContainer] Accepting skill intent request:", skillIntentRequest.requestId)
    // Cache the proposal context so the user can retry if generation hangs or fails
    setSkillRetryContext({ context: skillIntentRequest.context, intentMode: skillIntentRequest.mode })
    setSkillGenerationPhase("generating")
    setSkillIntentRequest(null)
    void window.api.skillEvolution.intentResponse(skillIntentRequest.requestId, true)
  }, [skillIntentRequest, setSkillGenerationPhase, setSkillRetryContext])

  const handleSkillIntentNo = useCallback((): void => {
    if (!skillIntentRequest) return
    console.log("[ChatContainer] Skipping skill intent request:", skillIntentRequest.requestId)
    setSkillIntentRequest(null)
    void window.api.skillEvolution.intentResponse(skillIntentRequest.requestId, false)
  }, [skillIntentRequest])

  // ── Skill generation streaming progress — update global store so RightPanel shows progress ──
  useEffect(() => {
    const cleanup = window.api.skillEvolution.onGenerating((evt) => {
      // Ignore events that belong to a different thread (stale background run)
      if (evt.threadId && evt.threadId !== useAppStore.getState().currentThreadId) return
      if (evt.phase === "start") {
        setSkillGenerationPhase("generating")
      } else if (evt.phase === "token") {
        appendSkillGenerationToken(evt.text)
      } else if (evt.phase === "done") {
        // confirmRequest will arrive shortly — keep phase as "generating" until then
      } else if (evt.phase === "error") {
        setSkillGenerationPhase("error", evt.text || "生成失败")
      }
    })
    return cleanup
  }, [setSkillGenerationPhase, appendSkillGenerationToken])
  // ────────────────────────────────────────────────────────

  const getSkillId = useCallback((skill: SkillMetadata): string => {
    const fromPath = skill?.path?.split("/").slice(-2, -1)[0]
    return (fromPath || skill.name || "").toLowerCase()
  }, [])

  const buildSkillPrompt = useCallback(
    (skill: SkillMetadata): string => {
      const skillId = getSkillId(skill)

      // For custom skills, use the skill's description if available
      if (skill.source === "user") {
        const skillName = skill.name || skillId
        return [
          `请使用 ${skillName} 技能帮我处理相关任务。`,
          "需求说明：<请补充>",
          "输出：结果、关键改动、验证方式。"
        ].join("\n")
      }

      // Existing prompt mapping for built-in skills
      const promptMap: Record<string, string> = {
        "algorithmic-art": [
          "请帮我生成一套算法艺术方案。",
          "主题与风格：<请补充>",
          "输出：创意说明、实现步骤、可直接运行的代码。"
        ].join("\n"),
        "brand-guidelines": [
          "请按品牌规范统一这份内容的视觉风格。",
          "品牌调性：<请补充>",
          "输出：改造方案、关键规范、最终可用结果。"
        ].join("\n"),
        "canvas-design": [
          "请设计一张视觉海报。",
          "场景与受众：<请补充>",
          "输出：版式思路、配色建议、成稿方案。"
        ].join("\n"),
        docx: [
          "请帮我处理 Word 文档。",
          "具体需求：<新建/修改/排版/提取内容>",
          "输出：处理结果与修改要点。"
        ].join("\n"),
        "doc-coauthoring": [
          "请和我一起协作完善这份文档。",
          "文档类型与目标：<请补充>",
          "输出：结构优化建议和可直接使用的正文。"
        ].join("\n"),
        "frontend-design": [
          "请帮我设计并实现前端界面。",
          "页面目标与风格：<请补充>",
          "输出：页面方案、关键代码、验证方式。"
        ].join("\n"),
        "internal-comms": [
          "请帮我撰写内部沟通稿。",
          "沟通对象与目的：<请补充>",
          "输出：清晰版本正文与可选精简版。"
        ].join("\n"),
        "mcp-builder": [
          "请帮我搭建一个 MCP 服务。",
          "目标能力与外部系统：<请补充>",
          "输出：实现步骤、核心代码、联调说明。"
        ].join("\n"),
        pdf: [
          "请帮我处理 PDF 文档。",
          "具体操作：<提取/合并/拆分/转换/校对>",
          "输出：处理结果与关键说明。"
        ].join("\n"),
        pptx: [
          "请帮我制作或优化演示文稿。",
          "主题与页数预期：<请补充>",
          "输出：大纲、页面建议、可交付稿件。"
        ].join("\n"),
        "skill-creator": [
          "请使用skill-creator技能帮我创建一个新技能包。",
          "技能用途与触发场景：<请补充>",
          "输出：技能结构、说明文档、示例。"
        ].join("\n"),
        "slack-gif-creator": [
          "请帮我制作一个用于 Slack 的动图。",
          "内容主题：<请补充>",
          "输出：制作方案、参数建议、成品要求。"
        ].join("\n"),
        "theme-factory": [
          "请帮我应用统一主题风格。",
          "应用对象：<文档/页面/演示稿>",
          "输出：主题方案与落地结果。"
        ].join("\n"),
        "web-app-testing": [
          "请帮我测试这个 Web 应用。",
          "重点流程：<请补充>",
          "输出：测试步骤、问题清单、修复建议。"
        ].join("\n"),
        "webapp-testing": [
          "请帮我测试这个 Web 应用。",
          "重点流程：<请补充>",
          "输出：测试步骤、问题清单、修复建议。"
        ].join("\n"),
        "security-review": [
          "请使用 security-review 技能对当前分支变更做安全审查。",
          "要求：仅输出高置信度（>=8/10）的中高危漏洞，避免误报。",
          "输出：按 漏洞标题/严重级别/影响文件与位置/利用路径/修复建议 的结构化报告。"
        ].join("\n"),
        "web-artifacts-builder": [
          "请帮我构建一个交互页面。",
          "功能目标：<请补充>",
          "输出：页面结构、实现代码、使用说明。"
        ].join("\n"),
        xlsx: [
          "请帮我处理表格数据。",
          "任务内容：<清洗/计算/格式化/分析>",
          "输出：处理结果、公式或规则说明。"
        ].join("\n"),
        "code-review-expert": [
          "请使用 code-review-expert 技能对当前 git 变更做结构化代码审查。",
          "审查范围：SOLID 原则、安全漏洞、性能问题、错误处理、边界条件。",
          "输出：按 P0-P3 严重级别分类的结构化报告，完成后询问是否修复。"
        ].join("\n"),
        "vercel-react-best-practices": [
          "请基于 React 最佳实践审查/优化当前组件代码。",
          "关注点：渲染性能、组合模式、状态管理、异步处理、打包优化。",
          "输出：问题列表、优化建议、改造代码。"
        ].join("\n"),
        "audit-website": [
          "请对以下网站做全面安全审计。",
          "目标网址：<请补充>",
          "输出：漏洞清单、风险等级、修复建议。"
        ].join("\n"),
        "supabase-postgres-best-practices": [
          "请基于 PostgreSQL 最佳实践审查当前数据库设计或查询。",
          "关注点：索引优化、RLS 安全策略、连接池、N+1 查询、分区策略。",
          "输出：问题诊断、优化建议、改进 SQL。"
        ].join("\n"),
        "typescript-advanced-types": [
          "请帮我优化 TypeScript 类型定义，运用高级类型技巧。",
          "目标文件或模块：<请补充>",
          "输出：类型改进方案、重构代码、类型安全提升说明。"
        ].join("\n"),
        "api-design-principles": [
          "请基于 API 设计原则审查/设计当前接口。",
          "API 类型：<REST / GraphQL>",
          "输出：设计规范建议、接口定义、示例代码。"
        ].join("\n"),
        "architecture-patterns": [
          "请基于架构模式对当前项目结构提出改进方案。",
          "关注点：Clean Architecture、六边形架构、DDD 领域驱动设计。",
          "输出：架构诊断、重构方案、目录结构建议。"
        ].join("\n"),
        "error-handling-patterns": [
          "请审查当前代码的错误处理策略并提出改进。",
          "关注点：异常层次、重试机制、熔断器、优雅降级。",
          "输出：问题清单、模式建议、改进代码。"
        ].join("\n"),
        "planning-with-files": [
          "请使用文件驱动规划方式管理当前复杂任务。",
          "任务目标：<请补充>",
          "输出：task_plan.md、findings.md、progress.md 三份规划文档。"
        ].join("\n"),
        "scheduler-assistant": [
          "请帮我设置一个定时提醒或周期任务。",
          '需求：<请补充，如"5分钟后提醒我喝水"、"每天早上9点提醒我看邮件">',
          "输出：任务创建结果、下次执行时间。"
        ].join("\n")
      }
      return (
        promptMap[skillId] ||
        [
          "请帮我处理该技能相关任务。",
          "需求说明：<请补充>",
          "输出：结果、关键改动、验证方式。"
        ].join("\n")
      )
    },
    [getSkillId]
  )

  const getSkillSummary = useCallback(
    (skill: SkillMetadata): string => {
      const skillId = getSkillId(skill)

      // For custom skills, use the skill's name or description
      if (skill.source === "user") {
        return skill.name || skillId || "自定义技能"
      }

      // Built-in skill summaries
      const summaryMap: Record<string, string> = {
        "algorithmic-art": "生成艺术图案",
        "brand-guidelines": "统一品牌风格",
        "canvas-design": "设计视觉海报",
        docx: "编辑 Word 文档",
        "doc-coauthoring": "协作撰写文档",
        "frontend-design": "设计前端界面",
        "internal-comms": "撰写内部沟通稿",
        "mcp-builder": "搭建 MCP 服务",
        pdf: "处理 PDF 文档",
        pptx: "制作演示文稿",
        "skill-creator": "创建新技能包",
        "slack-gif-creator": "制作 Slack 动图",
        "theme-factory": "应用主题风格",
        "web-app-testing": "测试 Web 应用",
        "webapp-testing": "测试 Web 应用",
        "web-artifacts-builder": "构建交互页面",
        xlsx: "处理表格数据",
        "security-review": "安全代码审查",
        "code-review-expert": "结构化代码审查",
        "vercel-react-best-practices": "React 最佳实践",
        "audit-website": "网站安全审计",
        "supabase-postgres-best-practices": "PostgreSQL 优化",
        "typescript-advanced-types": "TS 高级类型优化",
        "api-design-principles": "API 设计原则",
        "architecture-patterns": "架构模式设计",
        "error-handling-patterns": "错误处理模式",
        "planning-with-files": "文件驱动规划",
        "scheduler-assistant": "定时任务管理"
      }
      return summaryMap[skillId] || "完成专项任务"
    },
    [getSkillId]
  )

  const getSkillIcon = useCallback(
    (skill: SkillMetadata): React.JSX.Element => {
      const skillId = getSkillId(skill)
      const iconMap: Record<string, React.JSX.Element> = {
        "algorithmic-art": <Palette className="size-4" />,
        "brand-guidelines": <Palette className="size-4" />,
        "canvas-design": <LayoutTemplate className="size-4" />,
        docx: <FileText className="size-4" />,
        "doc-coauthoring": <FileText className="size-4" />,
        "frontend-design": <LayoutTemplate className="size-4" />,
        "internal-comms": <FileText className="size-4" />,
        "mcp-builder": <Code2 className="size-4" />,
        pdf: <FileText className="size-4" />,
        pptx: <Presentation className="size-4" />,
        "skill-creator": <Settings2 className="size-4" />,
        "slack-gif-creator": <FlaskConical className="size-4" />,
        "theme-factory": <Palette className="size-4" />,
        "web-app-testing": <FlaskConical className="size-4" />,
        "webapp-testing": <FlaskConical className="size-4" />,
        "web-artifacts-builder": <LayoutTemplate className="size-4" />,
        xlsx: <FileSpreadsheet className="size-4" />,
        "security-review": <Code2 className="size-4" />,
        "code-review-expert": <Code2 className="size-4" />,
        "vercel-react-best-practices": <Code2 className="size-4" />,
        "audit-website": <ShieldCheck className="size-4" />,
        "supabase-postgres-best-practices": <Database className="size-4" />,
        "typescript-advanced-types": <Code2 className="size-4" />,
        "api-design-principles": <Layers className="size-4" />,
        "architecture-patterns": <Layers className="size-4" />,
        "error-handling-patterns": <AlertCircle className="size-4" />,
        "planning-with-files": <FileText className="size-4" />,
        "scheduler-assistant": <Clock className="size-4" />
      }
      return iconMap[skillId] || <Search className="size-4" />
    },
    [getSkillId]
  )

  const programmingSkillIds = useMemo(
    () =>
      new Set([
        "security-review",
        "code-review-expert",
        "vercel-react-best-practices",
        "audit-website",
        "supabase-postgres-best-practices",
        "typescript-advanced-types",
        "api-design-principles",
        "architecture-patterns",
        "error-handling-patterns",
        "planning-with-files",
        "mcp-builder",
        "webapp-testing",
        "frontend-design"
      ]),
    []
  )

  const isProgrammingSkill = useCallback(
    (skill: SkillMetadata): boolean => programmingSkillIds.has(getSkillId(skill)),
    [getSkillId, programmingSkillIds]
  )

  const { generalSkills, programmingSkills, customSkills } = useMemo(() => {
    const builtInSkills = skills.filter((skill) => skill.source === "project")
    const userSkills = skills.filter((skill) => skill.source === "user")

    const general = builtInSkills.filter((skill) => !isProgrammingSkill(skill))
    const programming = builtInSkills.filter(isProgrammingSkill)

    // 精品技能名称集合，从「我安装的技能」中剔除
    const goodSkillNames = new Set(goodSkillsData.map((g) => g.name))
    const pureCustomSkills = userSkills.filter((s) => !goodSkillNames.has(s.name)
    && s.name !== 'encrypt-password'
    )
    // todo  s.name !== 'encrypt-password' 这个逻辑在代码暂时写死，后面排查

    return {
      generalSkills: general,
      programmingSkills: programming,
      customSkills: pureCustomSkills,
    }
  }, [skills, isProgrammingSkill, goodSkillsData])

  // 精品技能：按 category 分组，匹配本地已安装的 SkillMetadata
  const goodSkillsByCategory = useMemo(() => {
    const localSkillMap = new Map(
      skills.filter((s) => s.source === "user").map((s) => [s.name, s])
    )
    const groups = new Map<
      string,
      Array<{ skill: SkillMetadata; label: string; marketItem: MarketItem }>
    >()
    for (const item of goodSkillsData) {
      const localSkill = localSkillMap.get(item.name)
      // if (!localSkill) continue
      const category = item.category || "精品技能"
      if (!groups.has(category)) groups.set(category, [])
      groups.get(category)!.push({
        skill: localSkill || {},
        label: item.chinese_name || item.name,
        marketItem: item,
      })
    }
    return groups
  }, [goodSkillsData, skills])

  const visibleGeneralSkillCards = useMemo(() => {
    const source = showAllGeneralSkills ? generalSkills : generalSkills.slice(0, 8)
    return source.map((skill) => ({
      skill,
      label: getSkillSummary(skill),
      icon: getSkillIcon(skill),
    }))
  }, [showAllGeneralSkills, generalSkills, getSkillSummary, getSkillIcon])

  const programmingSkillCards = useMemo(() => {
    const source = showAllProgrammingSkills ? programmingSkills : programmingSkills.slice(0, 8)
    return source.map((skill) => ({
      skill,
      label: getSkillSummary(skill),
      icon: getSkillIcon(skill),
    }))
  }, [showAllProgrammingSkills, programmingSkills, getSkillSummary, getSkillIcon])

  const customSkillCards = useMemo(() => {
    const source = showAllCustomSkills ? customSkills : customSkills.slice(0, 8)
    return source.map((skill) => ({
      skill,
      label: getSkillSummary(skill),
      icon: getSkillIcon(skill),
    }))
  }, [showAllCustomSkills, customSkills, getSkillSummary, getSkillIcon])

  const handleUseSkillPrompt = useCallback(
    (skill: SkillMetadata, label?: string): void => {
      const custPrompt = label ? getTargetRemoteSkill(label) : ""
      const prompt = buildSkillPrompt(skill)
      setInput(custPrompt || prompt)
      requestAnimationFrame(() => {
        const textarea = inputRef.current
        if (!textarea) return
        textarea.focus()
        const cursor = prompt.length
        textarea.setSelectionRange(cursor, cursor)
      })
    },
    [buildSkillPrompt, setInput, getTargetRemoteSkill]
  )

  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        toast.success("已复制目标链接到剪切板，请在浏览器中打开查看")
      },
      (err) => {
        console.error("Failed to copy text: ", err)
        toast.error("复制失败，请重试")
      }
    )
  }

  const extractMessageText = useCallback((content: Message["content"]): string => {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""

    return content
      .map((block) => {
        if (block.type === "text") return block.text ?? ""
        if (typeof block.content === "string") return block.content
        return ""
      })
      .filter(Boolean)
      .join("\n")
  }, [])

  const handleEditUserMessage = useCallback(
    (message: Message): void => {
      const original = extractMessageText(message.content)
      const withoutAttachmentPreview = original.replace(/^(?:📎[^\n]*\n)+(?:\n)?/u, "").trim()
      const nextInput = withoutAttachmentPreview || original
      setInput(nextInput)

      requestAnimationFrame(() => {
        const textarea = inputRef.current
        if (!textarea) return
        textarea.focus()
        const cursor = nextInput.length
        textarea.setSelectionRange(cursor, cursor)
      })
      toast.success("已填充到输入框，编辑后可重新发送")
    },
    [extractMessageText, setInput]
  )

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      {/* Skill creation confirmation dialog */}
      <SkillCreateConfirmDialog
        request={skillConfirmRequest}
        onApprove={handleSkillApprove}
        onReject={handleSkillReject}
      />

      {/* Skill intent banner — "Want to save this conversation as a skill?" */}
      {skillIntentRequest && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-violet-500/10 border-b border-violet-500/20 text-xs">
          <Sparkles className="size-3.5 text-violet-500 shrink-0" />
          <div className="flex-1 text-violet-700 dark:text-violet-300 leading-snug">
            {skillIntentRequest.mode === "mode_b_llm" ? (
              <>
                <div>
                  大模型判断这段流程具有复用价值，建议将它沉淀为可复用的技能。
                  本次累计使用了 <strong>{skillIntentRequest.toolCallCount}</strong> 次工具调用。
                </div>
                {skillIntentRequest.recommendationReason ? (
                  <div className="mt-0.5 text-[11px] text-violet-600/80 dark:text-violet-200/80">
                    推荐依据：{skillIntentRequest.recommendationReason}
                  </div>
                ) : null}
              </>
            ) : (
              <div>
                本次对话使用了 <strong>{skillIntentRequest.toolCallCount}</strong> 次工具调用，是否将它沉淀为可复用的技能？
              </div>
            )}
          </div>
          <button
            className="shrink-0 rounded px-2.5 py-1 bg-violet-500 text-white hover:bg-violet-600 transition-colors font-medium"
            onClick={handleSkillIntentYes}
          >
            创建技能
          </button>
          <button
            className="shrink-0 rounded px-2.5 py-1 text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleSkillIntentNo}
          >
            跳过
          </button>
        </div>
      )}

      {/* NUX: First-run sandbox setup dialog */}
      {showNux && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
          <div className="bg-background border border-border rounded-xl shadow-2xl p-6 max-w-md w-full mx-4 space-y-5">
            {/* Header */}
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" />
              <h2 className="text-lg font-bold">设置 Agent 沙箱环境</h2>
            </div>

            {/* Policy notice */}
            <div className="flex items-start gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-700 dark:text-amber-400">
              <Info className="size-4 shrink-0 mt-0.5" />
              <span>公司安全限制，默认选择 elevated 沙箱模式，确有其他需要请联系管理员。</span>
            </div>

            {/* Loading state */}
            {nuxLoading && (
              <div className="flex flex-col items-center gap-4 py-6">
                <div className="relative size-14">
                  <div className="absolute inset-0 size-14 rounded-full border-4 border-primary/15" />
                  <div className="absolute inset-0 size-14 rounded-full border-4 border-primary border-t-transparent animate-spin" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <ShieldCheck className="size-5 text-primary" />
                  </div>
                </div>
                <div className="text-center space-y-1.5">
                  <div className="text-sm font-medium transition-all duration-500">
                    {NUX_LOADING_STEPS[nuxLoadingStep]}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    首次配置可能需要 1&ndash;3 分钟，请勿关闭窗口
                  </div>
                </div>
                {/* Progress dots */}
                <div className="flex gap-1.5">
                  {NUX_LOADING_STEPS.map((_, i) => (
                    <div
                      key={i}
                      className={`size-1.5 rounded-full transition-all duration-500 ${
                        i <= nuxLoadingStep ? "bg-primary" : "bg-primary/20"
                      }`}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Error state */}
            {nuxError && (
              <div className="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-600 dark:text-red-400 space-y-2">
                <p className="font-medium">强隔离沙箱配置失败</p>
                <p className="text-xs opacity-80">{nuxError}</p>
                <p className="text-xs">可重试或选择受限沙箱模式继续使用。</p>
                <div className="flex gap-2 mt-1">
                  <button
                    className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                    onClick={() => {
                      setNuxError(null)
                      setNuxLoading(true)
                      window.api.sandbox.completeNux("elevated")
                        .then(() => setShowNux(false))
                        .catch(() => {
                          // Main process falls back to unelevated on failure
                          setShowNux(false)
                        })
                    }}
                  >
                    重试强隔离模式
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-accent transition-colors"
                    onClick={() => {
                      window.api.sandbox.completeNux("unelevated")
                        .then(() => setShowNux(false))
                        .catch(() => setShowNux(false))
                    }}
                  >
                    使用受限沙箱模式
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Skill generation progress is shown in the right panel's 代理 section */}
      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="p-4">
          <div className="max-w-3xl mx-auto space-y-4">
            {displayMessages.length === 0 && !isLoading && (
              <div className="pt-14 pb-8">
                <RotatingHeadline />
                {skillsLoading ? (
                  <div className="text-sm text-muted-foreground text-center py-10">正在加载技能列表...</div>
                ) : skills.length === 0 ? null : (
                  <div className="space-y-3">
                    {programmingSkillCards.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs text-muted-foreground font-medium tracking-wider">
                          编程场景
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          {programmingSkillCards.map(({ skill, label, icon }) => (
                            <button
                              key={label+skill.path}
                              type="button"
                              onClick={() => handleUseSkillPrompt(skill)}
                              className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors"
                            >
                              <div className="flex items-center gap-3">
                                <div
                                  className="rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                                  {icon}
                                </div>
                                <div className="text-xs text-foreground leading-5">{label}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                        {programmingSkills.length > 8 && (
                          <button
                            type="button"
                            onClick={() => setShowAllProgrammingSkills((prev) => !prev)}
                            className="mx-auto flex items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
                          >
                            {showAllProgrammingSkills ? (
                              <>
                                <ChevronUp className="size-3.5" />
                                <span>收起</span>
                              </>
                            ) : (
                              <>
                                <ChevronDown className="size-3.5" />
                                <span>展开更多（+{programmingSkills.length - 8}）</span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    )}
                    {visibleGeneralSkillCards.length > 0 && (
                      <div className="space-y-2">
                        <div className="text-xs text-muted-foreground font-medium tracking-wider">
                          通用场景
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                          {visibleGeneralSkillCards.map(({ skill, label, icon }) => (
                            <button
                              key={label+skill.path}
                              type="button"
                              onClick={() => handleUseSkillPrompt(skill)}
                              className=" group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors"
                            >
                              <div className="flex items-center gap-3">
                                <div
                                  className="rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                                  {icon}
                                </div>
                                <div className="text-xs text-foreground leading-5">{label}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {generalSkills.length > 8 && (
                      <button
                        type="button"
                        onClick={() => setShowAllGeneralSkills((prev) => !prev)}
                        className="mx-auto flex items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
                      >
                        {showAllGeneralSkills ? (
                          <>
                            <ChevronUp className="size-3.5" />
                            <span>收起</span>
                          </>
                        ) : (
                          <>
                            <ChevronDown className="size-3.5" />
                            <span>展开更多（+{generalSkills.length - 8}）</span>
                          </>
                        )}
                      </button>
                    )}
                    {/* 精品技能：按 category 分组展示 */}
                    {goodSkillsByCategory.size > 0 &&
                      Array.from(goodSkillsByCategory.entries()).map(([category, items]) => (
                        <div key={category} className="space-y-2">
                          <div className="text-xs text-muted-foreground font-medium tracking-wider flex items-center gap-1">
                            <Zap className="size-3 text-amber-500" />
                            <span>{category}</span>
                          </div>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                            {items.map(({ skill, label }) => (
                              <button
                                key={label+skill.path}
                                type="button"
                                onClick={() => handleUseSkillPrompt(skill, label)}
                                className="group w-full rounded-xl border border-amber-200/70 bg-amber-50/60 px-3 py-2 text-left hover:bg-amber-100/70 hover:border-amber-300 transition-colors"
                              >
                                <div className="flex items-center gap-3">
                                  <div className="rounded-md border border-amber-200/80 p-1.5 text-amber-500 group-hover:text-amber-600 transition-colors">
                                    <Zap className="size-4" />
                                  </div>
                                  <div className="text-xs text-foreground leading-5">{getSkillShowLabel(label)}</div>
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground font-medium tracking-wider">
                        <span>我安装的技能</span>
                        <span className={'ml-2'}>(  路径：自定义 / 应用市场 )</span>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        {customSkillCards?.length ? customSkillCards.map(({ skill, label }) => (
                          <button
                            key={label+skill.path}
                            type="button"
                            onClick={() => handleUseSkillPrompt(skill, label)}
                            className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <div className="rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                                <Wrench className={"size-4"} />
                              </div>
                              <div className="text-xs text-foreground leading-5">{getSkillShowLabel(label)}</div>
                            </div>
                          </button>
                        )) : (
                          <button
                            type="button"
                            className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <div className="rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                                <CircleAlert className={"size-4"} />
                              </div>
                              <div className="text-xs text-foreground leading-5">暂无</div>
                            </div>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs text-muted-foreground font-medium tracking-wider">
                        帮助
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                        <button
                          onClick={async () => {
                            const instructionUrl = import.meta.env.VITE_INTRUCTION_URL;
                            handleCopyToClipboard(instructionUrl);
                          }}
                          type="button"
                          className="group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className="rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors">
                              <Notebook size={14} />
                            </div>
                            <div className="text-xs text-foreground leading-5">操作说明文档</div>
                          </div>
                        </button>

                        <UpdateStatusCard
                          hasUpdate={needUpdateVersion}
                          onClick={() => {
                            setUpdateDialogOpen(true)
                          }}
                        />


                      </div>
                      {customSkills.length > 8 && (
                        <button
                          type="button"
                          onClick={() => setShowAllCustomSkills((prev) => !prev)}
                          className="mx-auto flex items-center gap-1 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
                        >
                          {showAllCustomSkills ? (
                            <>
                              <ChevronUp className="size-3.5" />
                              <span>收起</span>
                            </>
                          ) : (
                            <>
                              <ChevronDown className="size-3.5" />
                              <span>展开更多（+{customSkills.length - 8}）</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
            {displayMessages.map((message, index) => {
              const previousMessage = index > 0 ? displayMessages[index - 1] : null;
              const isLastMessage = index === displayMessages.length - 1;
              const nextNonToolMessage =
                displayMessages.slice(index + 1).find((m) => m.role !== "tool") ?? null;
              const showAssistantMeta =
                message.role !== "assistant" ||
                !nextNonToolMessage ||
                nextNonToolMessage.role !== "assistant";

              return (
                <MessageBubble
                  key={message.id}
                  message={message}
                  previousMessage={previousMessage}
                  isStreaming={isLastMessage && isLoading}
                  showAssistantMeta={showAssistantMeta}
                  toolResults={toolResults}
                  pendingApproval={pendingApproval}
                  onApprovalDecision={handleApprovalDecision}
                  onEditUserMessage={handleEditUserMessage}
                  threadId={threadId}
                />
              );
            })}


            {/*测试git diff功能*/}
            {/*<DisplayDiffTest/>*/}



            {/* Orchestrator standalone approval bar moved outside ScrollArea — see below */}
            {/* Model retry indicator — shown when the fetch layer is retrying a transient error */}
            {modelRetry && (
              <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                <span className="inline-block size-3 mt-0.5 rounded-full border-2 border-amber-500 border-t-transparent animate-spin shrink-0" />
                <div className="flex-1 min-w-0">
                  <span>
                    模型暂时不可用（{modelRetry.reason}），正在重试 {modelRetry.attempt}/{modelRetry.maxRetries}
                    {modelRetry.delayMs > 0 && <>（等待 {Math.round(modelRetry.delayMs / 100) / 10}s）</>}
                    …
                  </span>
                </div>
              </div>
            )}
            {/* Streaming indicator and inline TODOs */}
            {isLoading && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm">
                  <div className="rainbow-spinner" />
                  <span className="thinking-shimmer-text" data-text={THINKING_MESSAGES[thinkingMessageIndex]}>
                    {THINKING_MESSAGES[thinkingMessageIndex]}
                  </span>
                </div>
                {todos.length > 0 && <ChatTodos todos={todos} />}
              </div>
            )}
            {/* Error state */}
            {threadError && !isLoading && (
              <div className="flex items-start gap-3 rounded-md border border-destructive/50 bg-destructive/10 p-4">
                <AlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-destructive text-sm">代理出错</div>
                  <div className="text-sm text-muted-foreground mt-1 break-words">
                    {threadError}
                  </div>
                  <div className="text-xs text-muted-foreground mt-2">
                    你可以尝试发送新消息继续对话。
                  </div>
                </div>
                <button
                  onClick={handleDismissError}
                  className="shrink-0 rounded p-1 hover:bg-destructive/20 transition-colors"
                  aria-label="Dismiss error"
                >
                  <X className="size-4 text-muted-foreground" />
                </button>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
      {/* Orchestrator approval bar — placed outside ScrollArea so it's always visible */}
      {pendingApproval && (pendingApproval as unknown as Record<string, unknown>)._orchestratorRequestId && (
        <div className="px-4 pb-2">
          {(() => {
            const approval = pendingApproval as unknown as Record<string, unknown>
            const operation = approval.operation
            const isFileApproval = operation === "write_file" || operation === "edit_file"
            const isCodeExecApproval = operation === "code_exec"
            const isPrepareSaveCodeExecToolApproval = operation === "prepare_save_code_exec_tool"
            const isSaveCodeExecToolApproval = operation === "save_code_exec_tool"
            const isManualSaveCodeExecToolApproval = isSaveCodeExecToolApproval && Boolean(approval.savedToolMetadataError)
            const approvalParams = approval.params ?? pendingApproval.tool_call?.args?.params ?? {}
            const hasApprovalParams =
              approvalParams &&
              typeof approvalParams === "object" &&
              !Array.isArray(approvalParams) &&
              Object.keys(approvalParams as Record<string, unknown>).length > 0
            const isSaveToolApprovalInvalid =
              isSaveCodeExecToolApproval &&
              (
                !savedToolDescriptionInput.trim() ||
                (isManualSaveCodeExecToolApproval && !savedToolNameInput.trim())
              )
            const approvalTypes = Array.isArray(approval._approvalTypes)
              ? approval._approvalTypes as Array<"approve" | "approve_session" | "approve_permanent" | "reject">
              : ["approve", "approve_session", "approve_permanent", "reject"]

            return (
          <div className={`max-w-3xl mx-auto rounded-lg border-2 p-4 space-y-3 ${
            isFileApproval
              ? "border-blue-500/50 bg-blue-500/5"
              : isCodeExecApproval || isPrepareSaveCodeExecToolApproval || isSaveCodeExecToolApproval
                ? "border-emerald-500/50 bg-emerald-500/5"
                : "border-amber-500/50 bg-amber-500/5"
          }`}>
            <div className="flex items-center gap-2">
              {isFileApproval
                ? <FilePenLine className="size-4 text-blue-500" />
                : isCodeExecApproval
                  ? <Code2 className="size-4 text-emerald-500" />
                : isPrepareSaveCodeExecToolApproval
                  ? <Wrench className="size-4 text-emerald-500" />
                : isSaveCodeExecToolApproval
                  ? <Wrench className="size-4 text-emerald-500" />
                : <ShieldCheck className="size-4 text-amber-500" />}
              <span className="text-sm font-medium">
                {operation === "write_file"
                  ? "写入文件需要审批"
                  : operation === "edit_file"
                    ? "编辑文件需要审批"
                    : isCodeExecApproval
                      ? "执行 MCP 脚本需要审批"
                    : isPrepareSaveCodeExecToolApproval
                      ? "是否将脚本注册为工具，便于后续复用"
                    : isSaveCodeExecToolApproval
                      ? "保存脚本工具需要确认"
                    : "命令需要审批"}
              </span>
            </div>
            {isCodeExecApproval || isPrepareSaveCodeExecToolApproval || isSaveCodeExecToolApproval ? (
              <>
                {isSaveCodeExecToolApproval && (
                  <div className="grid gap-2 md:grid-cols-2">
                    <div className="rounded-md bg-muted/30 px-3 py-2 text-xs overflow-auto">
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                        {isManualSaveCodeExecToolApproval ? "tool_name" : "tool_id"}
                      </div>
                      {isManualSaveCodeExecToolApproval ? (
                        <>
                          <input
                            className="w-full rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
                            value={savedToolNameInput}
                            onChange={(event) => setSavedToolNameInput(event.target.value)}
                            placeholder="例如：list_github_issues"
                          />
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            最终 tool_id 会基于 tool_name 规范化生成。
                          </div>
                        </>
                      ) : (
                        <div className="font-mono break-all">
                          {String(approval.savedToolId || pendingApproval.tool_call?.args?.toolId || "")}
                        </div>
                      )}
                    </div>
                    <div className="rounded-md bg-muted/30 px-3 py-2 text-xs overflow-auto">
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">description</div>
                      <textarea
                        className="min-h-20 w-full resize-y rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
                        value={savedToolDescriptionInput}
                        onChange={(event) => setSavedToolDescriptionInput(event.target.value)}
                      />
                    </div>
                  </div>
                )}
                {isManualSaveCodeExecToolApproval && (
                  <div className="text-xs text-amber-600 dark:text-amber-400">
                    {String(approval.savedToolMetadataError)}
                  </div>
                )}
                <div className="rounded-md bg-muted/50 px-3 py-2 font-mono text-sm whitespace-pre-wrap break-all overflow-auto max-h-64">
                  {String(approval.code || pendingApproval.tool_call?.args?.code || "")}
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  {hasApprovalParams && (
                    <div className="rounded-md bg-muted/30 px-3 py-2 text-xs overflow-auto">
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">params</div>
                      <pre className="whitespace-pre-wrap break-all font-mono">
                        {JSON.stringify(approvalParams, null, 2)}
                      </pre>
                    </div>
                  )}
                  <div className="rounded-md bg-muted/30 px-3 py-2 text-xs">
                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">timeout</div>
                    <div className="font-mono">
                      {String(approval.timeoutMs ?? pendingApproval.tool_call?.args?.timeoutMs ?? "default")} ms
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <pre className="rounded-md bg-muted/50 px-3 py-2 font-mono text-sm whitespace-pre-wrap break-words overflow-auto max-h-40">
                {isFileApproval
                  ? `${operation === "write_file" ? "写入" : "编辑"}: ${String(approval.filePath || pendingApproval.tool_call?.args?.filePath || "unknown")}`
                  : approval.command
                    ? String(approval.command)
                    : pendingApproval.tool_call?.args?.command
                      ? String(pendingApproval.tool_call.args.command)
                      : "unknown command"}
              </pre>
            )}
            {Boolean(approval._retryReason) && (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                {String(approval._retryReason)}
              </div>
            )}
            {Boolean(approval.reason) && (
              <div className="text-xs text-muted-foreground">
                原因：{String(approval.reason)}
              </div>
            )}
            <div className="flex items-center gap-2">
              {approval._retryReason ? (
                <>
                  <button
                    className="px-3 py-1.5 text-xs bg-amber-500 text-white rounded-md hover:bg-amber-600 transition-colors"
                    onClick={() => handleApprovalDecision("approve")}
                  >
                    无沙箱重试
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-muted transition-colors"
                    onClick={() => handleApprovalDecision("reject")}
                  >
                    拒绝
                  </button>
                </>
              ) : (
                <>
                  {isPrepareSaveCodeExecToolApproval && saveToolMetadataLoading ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      正在生成工具信息，请稍候...
                    </div>
                  ) : (
                    <>
                  {approvalTypes.includes("approve") && (
                    <button
                      className={cn(
                        "px-3 py-1.5 text-xs rounded-md transition-colors",
                        isSaveToolApprovalInvalid
                          ? "bg-primary/50 text-primary-foreground/80 cursor-not-allowed"
                          : "bg-primary text-primary-foreground hover:bg-primary/90"
                      )}
                      onClick={() => handleApprovalDecision("approve")}
                      disabled={isSaveToolApprovalInvalid}
                    >
                      {isFileApproval
                        ? "允许"
                        : isCodeExecApproval
                          ? "执行脚本"
                        : isPrepareSaveCodeExecToolApproval
                          ? "允许注册为工具"
                        : isSaveCodeExecToolApproval
                          ? "保存为工具"
                          : "运行"}
                    </button>
                  )}
                  {approvalTypes.includes("approve_session") && (
                    <button
                      className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                      onClick={() => handleApprovalDecision("approve_session")}
                    >
                      本会话允许
                    </button>
                  )}
                  {approvalTypes.includes("approve_permanent") && (
                    <button
                      className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                      onClick={() => handleApprovalDecision("approve_permanent")}
                    >
                      始终允许
                    </button>
                  )}
                  {approvalTypes.includes("reject") && (
                    <button
                      className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-muted transition-colors"
                      onClick={() => handleApprovalDecision("reject")}
                    >
                      拒绝
                    </button>
                  )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
            )
          })()}
        </div>
      )}
      {/* Input */}
      <div className="p-4">
        {showGitChangeNotice && (
          <div className="max-w-3xl mx-auto mb-2 flex items-center justify-between gap-3 rounded-xl border border-status-warning/40 bg-status-warning/10 px-3 py-2">
            <div className="min-w-0 flex items-center gap-2 text-[12px] text-foreground">
              <AlertCircle className="size-3.5 shrink-0 text-status-warning" />
              <span className="truncate">检测到文件变更，可打开 Git 面板查看。</span>
            </div>
            <button
              type="button"
              onClick={onOpenGitPanel}
              disabled={!onOpenGitPanel}
              className="shrink-0 rounded-md bg-status-warning px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-status-warning/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              打开
            </button>
          </div>
        )}
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
          <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <div
                ref={dropZoneRef}
                className={cn(
                  "relative flex-1 min-w-0 flex flex-col rounded-3xl border border-border  transition-colors duration-300",
                  glowVisible ? "bg-white/80" : "bg-white",
                  dragOver && "border-primary"
                )}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                {glowVisible && (
                  <div
                    className={cn('siri-bg-glow rounded-xl', !isLoading && 'siri-bg-glow-out')}
                    onAnimationEnd={(e) => { if (e.animationName === 'siri-fade-out' && e.target === e.currentTarget && !isLoading) setGlowVisible(false) }}
                  />
                )}
                {dragOver && (
                  <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5">
                    <span className="text-sm text-primary">拖放文件到这里</span>
                  </div>
                )}
                {/* Attachment chips inside input box */}
                {attachments.length > 0 && (
                  <div className="flex flex-col gap-1 px-3 pt-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {attachments.map((att, idx) => (
                        <div
                          key={`${att.filename}-${idx}`}
                          className="flex items-center gap-1.5 px-2 py-1 bg-muted/50 rounded-md text-xs group"
                        >
                          <FileText className="size-3 text-muted-foreground shrink-0" />
                          <span className="truncate max-w-[160px]" title={att.filePath}>{att.filename}</span>
                          {att.truncated && <span className="text-amber-500" title="内容已截取">⚠</span>}
                          <button
                            type="button"
                            onClick={() => removeAttachment(idx)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      ))}
                      {attachmentLoading && <Loader2 className="size-4 animate-spin text-muted-foreground self-center" />}
                    </div>
                    <div className="text-[10px] text-muted-foreground/50">
                      {attachments.length}/{MAX_ATTACHMENTS} 个文件 · {totalAttachmentChars.toLocaleString()}/{MAX_TOTAL_CHARS.toLocaleString()} 字符
                    </div>
                  </div>
                )}
                {/* Textarea */}
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onCompositionStart={() => {
                    isComposingRef.current = true
                  }}
                  onCompositionEnd={() => {
                    isComposingRef.current = false
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={attachments.length > 0 ? "输入消息或直接发送文件..." : "输入消息..."}
                  disabled={isLoading}
                  className={cn(
                    "relative z-[1] w-full resize-none bg-transparent overflow-y-auto",
                    "p-4 text-sm placeholder:text-muted-foreground",
                    "focus:outline-none disabled:opacity-70",
                    attachments.length > 0 && "pt-1.5"
                  )}
                  rows={3}
                  style={{ minHeight: "44px", maxHeight: "200px" }}
                />
                {/* Bottom bar: + button left, send button right */}
                <div className="flex items-center justify-between px-3 pb-2">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={isLoading || attachmentLoading || attachments.length >= MAX_ATTACHMENTS || totalAttachmentChars >= MAX_TOTAL_CHARS}
                      onClick={handleAttachClick}
                      title="添加文件 (txt, md, csv, docx, xlsx)"
                      className="flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Plus className="size-4" />
                    </button>
                    <div className="w-px h-4 bg-border mx-1" />
                    <ModelSwitcher threadId={threadId} />
                    <div className="w-px h-4 bg-border mx-1" />
                    <WorkspacePicker threadId={threadId} onGitStatusChange={onThreadGitStatusChange} />

                  </div>
                  <div className="flex items-center gap-2">
                    {isLoading ? (
                      <button
                        type="button"
                        onClick={handleCancel}
                        aria-label="停止生成"
                        className="flex items-center justify-center size-7 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                      >
                        <Square className="size-3 fill-current" />
                      </button>
                    ) : (
                      <button
                        type="submit"
                        disabled={!input.trim() && attachments.length === 0}
                        className="flex items-center justify-center size-7 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Send className="size-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            {/*chat container bottom panel — moved inside input box above */}
            <div className={'flex items-center justify-between'}>
             <div className={'flex items-center space-x-4'}>
               {yoloMode && (
                 <button
                   type="button"
                   title="点击打开设置"
                   onClick={() => setShowCustomizeView(true, "sandbox")}
                   className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 transition-colors cursor-pointer"
                 >
                   <Zap className="size-3" />
                   YOLO
                 </button>
               )}
               {tokenUsage && (
                 <ContextUsageIndicator tokenUsage={tokenUsage} modelId={currentModel}
                                        contextLimit={modelContextLimit} />
               )}
             </div>
            {/*  GitBranch */}
            {/*<GitBranchSwitcher workspacePath={workspacePath} />*/}
            </div>
          </div>
        </form>
      </div>
      <UpdateDialog open={updateDialogOpen} onOpenChange={setUpdateDialogOpen} />
    </div>
  )
}
