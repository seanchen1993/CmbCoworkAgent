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
  Megaphone,
  Zap,
  Sparkles,
  Wrench,
  CircleAlert,
  FilePenLine
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAppStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { useShallow } from "zustand/react/shallow"
import { useCurrentThread, useThreadStream } from "@/lib/thread-context"
import { ModelSwitcher } from "./ModelSwitcher"
import { WorkspacePicker } from "./WorkspacePicker"
import { ChatTodos } from "./ChatTodos"
import { ContextUsageIndicator } from "./ContextUsageIndicator"
import type { Message, SkillMetadata } from "@/types"
import { MessageBubble } from "./MessageBubble"
import {
  SkillCreateConfirmDialog,
  type SkillConfirmRequest
} from "./SkillCreateConfirmDialog"
import { uploadChatData, ChatReportPayload } from "@/api"
import { marketApi, MarketItem } from "../../api/market"
import { insertLog, updateMMJUserInfo } from "../../../js/mmjUtils"
import DisplayDiffTest from "./DisplayDiffTest"

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

export function ChatContainer({ threadId }: ChatContainerProps): React.JSX.Element {
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
  const [showCopyNotification, setShowCopyNotification] = useState(false)
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
  const [latestVersion, setLatestVersion] = useState("")
  const [modelContextLimit, setModelContextLimit] = useState<number | undefined>(undefined)

  const [version, setVersion] = useState("")

  useEffect(() => {
    const { ipcRenderer } = window.electron

    // 主动请求版本，不依赖推送时序
    ipcRenderer.invoke("get-version").then((ver: unknown) => {
      console.log("版本 (invoke)：", ver)
      if (ver) setVersion(ver as string)
    }).catch((e: unknown) => console.warn("get-version failed:", e))

    // 保留推送监听作为备用
    const removeListener = ipcRenderer.on("version", (ver: unknown) => {
      console.log("版本 (push)：", ver)
      setVersion(ver as string)

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
  const isLoading = streamData.isLoading || scheduledTaskLoading

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

  const queryLatestVersion = useCallback(async () => {
    try {
      const response = await fetch(
        import.meta.env.VITE_API_BASE_URL + "/api/trajectories/cmbdevclaw/versions/list",
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json"
            // Remove placeholder auth token for now
          }
        }
      )
      const data = await response.json()
      setLatestVersion(data?.current?.version)
    } catch (e) {
      console.log(e)
    }
  }, [])

  const needUpdateVersion = useMemo(() => {
    return latestVersion !== version
  }, [latestVersion, version])

  useEffect(() => {
    queryRemoteSkills()
    queryLatestVersion()
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
      if (!pendingApproval || !stream) return

      // Check if this is an orchestrator-sourced approval (has requestId)
      const approvalAny = pendingApproval as Record<string, unknown>
      if (approvalAny._orchestratorRequestId) {
        // Send decision to main process via the orchestrator's IPC channel
        window.api.sandbox.sendApprovalDecision({
          requestId: approvalAny._orchestratorRequestId as string,
          type: decision === "edit" ? "reject" : decision,
          tool_call_id: pendingApproval.tool_call?.id || ""
        })
        setPendingApproval(null)
        return
      }

      // Legacy HITL approval path (non-execute tools)
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
    [pendingApproval, setPendingApproval, stream, threadId, currentModel]
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

    return [...threadMessages, ...streamingMsgs]
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
    if (!input.trim() || isLoading || !stream) return

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
      const approvalAny = pendingApproval as Record<string, unknown>
      if (approvalAny._orchestratorRequestId) {
        window.api.sandbox.sendApprovalDecision({
          requestId: approvalAny._orchestratorRequestId as string,
          type: "reject",
          tool_call_id: pendingApproval.tool_call?.id || ""
        })
      }
      setPendingApproval(null)
    }

    const message = input.trim()
    setInput("")
    insertLog('send: '+message)

    const isFirstMessage = threadMessages.length === 0

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: message,
      created_at: new Date()
    }
    appendMessage(userMessage)

    if (isFirstMessage) {
      const currentThread = threads.find((t) => t.thread_id === threadId)
      const hasDefaultTitle = currentThread?.title?.startsWith("Thread ")
      if (hasDefaultTitle) {
        generateTitleForFirstMessage(threadId, message)
      }
    }

    await stream.submit(
      {
        messages: [{ type: "human", content: message }]
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
    let mounted = true


    void loadSkills()

    return () => {
      mounted = false
    }
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
        setShowCopyNotification(true)
        setTimeout(() => setShowCopyNotification(false), 2000)
      },
      (err) => console.error("Failed to copy text: ", err)
    )
  }

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
      {/* Copy notification */}
      {showCopyNotification && (
        <div className="fixed top-[20vh] right-[40vw] z-50 animate-in fade-in-0 slide-in-from-top-2">
          <div className="rounded-lg border border-border bg-background/95 backdrop-blur-sm px-4 py-2 shadow-lg">
            <div className="flex items-center gap-2 text-sm text-foreground">
              <div className="size-4 rounded-full bg-green-500 flex items-center justify-center">
                <svg className="size-2.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              </div>
              <span>已复制目标链接到剪切板，请在浏览器中打开查看</span>
            </div>
          </div>
        </div>
      )}
      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0" ref={scrollRef}>
        <div className="p-4">
          <div className="max-w-3xl mx-auto space-y-4">
            {displayMessages.length === 0 && !isLoading && (
              <div className="pt-14 pb-8">
                <div className="mb-6 flex items-center justify-start">
                  <div className="text-2xl md:text-3xl font-bold tracking-tight text-foreground leading-none">
                    我能帮你做什么？
                  </div>
                </div>
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

                        {/*版本check*/}
                        <button
                          onClick={async () => {
                            const viteappdownloadurl = import.meta.env.VITE_APP_DOWNLOAD_URL;
                            handleCopyToClipboard(viteappdownloadurl);
                          }}
                          type="button"
                          className={`group relative w-full rounded-xl ${
                            needUpdateVersion
                              ? 'border-red-400/60 bg-gradient-to-br from-red-50/90 to-red-100/70 hover:border-red-500 hover:from-red-100 hover:to-red-150/80 shadow-red-100/50'
                              : 'group w-full rounded-xl border border-border/70 bg-background/90 px-3 py-2 text-left hover:bg-accent/35 hover:border-border transition-colors '
                          } px-4 py-3.5 text-left transition-all duration-300 ease-out hover:shadow-lg hover:scale-[1.01] active:scale-[0.99] backdrop-blur-sm`}
                        >
                          <div className="flex items-center gap-3.5">
                            <div
                              className={`${
                                needUpdateVersion
                                  ? 'bg-red-100 text-red-600 border-red-200 group-hover:bg-red-200 group-hover:text-red-700 group-hover:shadow-red-200/50'
                                  : 'rounded-md border border-border/80 p-1.5 text-muted-foreground group-hover:text-foreground transition-colors'
                              } rounded-lg border p-1 transition-all duration-300 shadow-sm group-hover:shadow-md`}>
                              <Megaphone size={14} className="drop-shadow-sm" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className={`text-sm font-semibold leading-5 ${
                                needUpdateVersion ? 'text-red-700' : ''
                              } transition-colors duration-200`}>
                                {needUpdateVersion? '发现新版本！' : '版本列表'}
                              </div>
                            </div>
                            {needUpdateVersion && (
                              <div className="flex items-center gap-2">
                                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse shadow-sm"></div>
                              </div>
                            )}
                          </div>

                          {/* 悬浮时的渐变覆盖层 */}
                          <div className={`absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none ${
                            needUpdateVersion
                              ? 'bg-gradient-to-br from-red-400/8 via-transparent to-red-500/6'
                              : 'bg-gradient-to-br from-blue-400/8 via-transparent to-indigo-500/6'
                          }`}></div>

                          {/* 边框光效 */}
                          <div className={`absolute inset-0 rounded-xl opacity-0 group-hover:opacity-30 transition-opacity duration-300 pointer-events-none border ${
                            needUpdateVersion ? 'border-red-300' : 'border-blue-300'
                          } blur-sm`}></div>
                        </button>


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

              return (
                <MessageBubble
                  key={message.id}
                  message={message}
                  previousMessage={previousMessage}
                  isStreaming={isLastMessage && isLoading}
                  toolResults={toolResults}
                  pendingApproval={pendingApproval}
                  onApprovalDecision={handleApprovalDecision}
                  threadId={threadId}
                />
              );
            })}


            {/*测试git diff功能*/}
            {/*<DisplayDiffTest/>*/}



            {/* Orchestrator standalone approval bar moved outside ScrollArea — see below */}
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
      {pendingApproval && (pendingApproval as Record<string, unknown>)._orchestratorRequestId && (
        <div className="px-4 pb-2">
          <div className={`max-w-3xl mx-auto rounded-lg border-2 p-4 space-y-3 ${
            (pendingApproval as Record<string, unknown>).operation === "write_file" || (pendingApproval as Record<string, unknown>).operation === "edit_file"
              ? "border-blue-500/50 bg-blue-500/5"
              : "border-amber-500/50 bg-amber-500/5"
          }`}>
            <div className="flex items-center gap-2">
              {(pendingApproval as Record<string, unknown>).operation === "write_file" || (pendingApproval as Record<string, unknown>).operation === "edit_file"
                ? <FilePenLine className="size-4 text-blue-500" />
                : <ShieldCheck className="size-4 text-amber-500" />}
              <span className="text-sm font-medium">
                {(pendingApproval as Record<string, unknown>).operation === "write_file"
                  ? "写入文件需要审批"
                  : (pendingApproval as Record<string, unknown>).operation === "edit_file"
                    ? "编辑文件需要审批"
                    : "命令需要审批"}
              </span>
            </div>
            <div className="rounded-md bg-muted/50 px-3 py-2 font-mono text-sm break-all overflow-hidden">
              {(pendingApproval as Record<string, unknown>).operation === "write_file" || (pendingApproval as Record<string, unknown>).operation === "edit_file"
                ? `${(pendingApproval as Record<string, unknown>).operation === "write_file" ? "写入" : "编辑"}: ${String((pendingApproval as Record<string, unknown>).filePath || pendingApproval.tool_call?.args?.filePath || "unknown")}`
                : (pendingApproval as Record<string, unknown>).command
                  ? String((pendingApproval as Record<string, unknown>).command)
                  : pendingApproval.tool_call?.args?.command
                    ? String(pendingApproval.tool_call.args.command)
                    : "unknown command"}
            </div>
            {(pendingApproval as Record<string, unknown>)._retryReason && (
              <div className="text-xs text-amber-600 dark:text-amber-400">
                {String((pendingApproval as Record<string, unknown>)._retryReason)}
              </div>
            )}
            {(pendingApproval as Record<string, unknown>).reason && (
              <div className="text-xs text-muted-foreground">
                原因：{String((pendingApproval as Record<string, unknown>).reason)}
              </div>
            )}
            <div className="flex items-center gap-2">
              {(pendingApproval as Record<string, unknown>)._retryReason ? (
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
                  <button
                    className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
                    onClick={() => handleApprovalDecision("approve")}
                  >
                    {(pendingApproval as Record<string, unknown>).operation === "write_file" || (pendingApproval as Record<string, unknown>).operation === "edit_file" ? "允许" : "运行"}
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
                    onClick={() => handleApprovalDecision("approve_session")}
                  >
                    本会话允许
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
                    onClick={() => handleApprovalDecision("approve_permanent")}
                  >
                    始终允许
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-muted transition-colors"
                    onClick={() => handleApprovalDecision("reject")}
                  >
                    拒绝
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Input */}
      <div className="p-4">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto">
          <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <div className="relative flex-1 min-w-0 flex">
                {glowVisible && (
                  <div
                    className={cn('siri-bg-glow rounded-xl', !isLoading && 'siri-bg-glow-out')}
                    // 只响应 siri-fade-out 结束，过滤掉 siri-fade-in 和 ::before 的 siri-spin（infinite 不触发）
                    onAnimationEnd={(e) => { if (e.animationName === 'siri-fade-out' && e.target === e.currentTarget && !isLoading) setGlowVisible(false) }}
                  />
                )}
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
                  placeholder="输入消息..."
                  disabled={isLoading}
                  className={cn(
                    "relative z-[1] flex-1 resize-none rounded-xl border border-border",
                    "px-4 py-3 text-sm placeholder:text-muted-foreground",
                    "focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-70 shadow-sm",
                    "transition-colors duration-300",
                    glowVisible ? "bg-white/80" : "bg-white"
                  )}
                  rows={1}
                  style={{ minHeight: "48px", maxHeight: "200px" }}
                />
              </div>
              <div className="flex items-center justify-center shrink-0 h-12">
                {isLoading ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    onClick={handleCancel}
                    aria-label="停止生成"
                    className="rounded-md shadow-sm"
                  >
                    <Square className="size-3.5 fill-current" />
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    variant="default"
                    size="icon"
                    disabled={!input.trim()}
                    className="rounded-md"
                  >
                    <Send className="size-4" />
                  </Button>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ModelSwitcher threadId={threadId} />
                <div className="w-px h-4 bg-border" />
                <WorkspacePicker threadId={threadId} />
                {yoloMode && (
                  <>
                    <div className="w-px h-4 bg-border" />
                    <button
                      type="button"
                      title="点击打开设置"
                      onClick={() => setShowCustomizeView(true, "sandbox")}
                      className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25 transition-colors cursor-pointer"
                    >
                      <Zap className="size-3" />
                      YOLO
                    </button>
                  </>
                )}
              </div>
              {tokenUsage && (
                <ContextUsageIndicator tokenUsage={tokenUsage} modelId={currentModel} contextLimit={modelContextLimit} />
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
