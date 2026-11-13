import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { LeanstarTokenDialog } from "./LeanstarTokenDialog"
import { NewRequirementDialog } from "./NewRequirementDialog"
import type { UploadSource } from "./NewRequirementDialog"
import {
  RequirementQuickStartDialog,
  REQUIREMENT_QUICK_START_EVENT,
  type RequirementQuickStartSelection
} from "./RequirementQuickStartDialog"
import {
  RequirementQuickStartPreparationDialog,
  type QuickStartPreparedInput
} from "./RequirementQuickStartPreparationDialog"
import { RequirementConversationView } from "./RequirementConversationView"
import { RequirementHistoryView } from "./RequirementHistoryView"
import { RequirementListLoading } from "./RequirementListLoading"
import type { RequirementSourceFilter } from "./RequirementHistoryList"
import { RequirementSpaceDetailView } from "./RequirementSpaceDetailView"
import { SystemSelectionDialog } from "./SystemSelectionDialog"
import { RequirementWorkDirDialog } from "./RequirementWorkDirPicker"
import {
  fromPersistedRequirement,
  getRequirementThreadIds,
  sortRequirementsByUpdatedAt,
  type RequirementRecord
} from "./requirement-data"
import {
  enableRequirementSessionExperts,
  getRequirementSessionCapabilities,
  type RequirementSessionCapabilities
} from "./requirement-session-capabilities"
import {
  getRequirementSystemName,
  getSelectedRequirementSystem,
  useRequirementStore
} from "./requirement-store"
import { useAppStore } from "@/lib/store"
import {
  REQUIREMENT_CONVERSATION_ENTRY_KEY,
  buildRequirementDesignPrompt,
  buildSpaceRequirementDesignPrompt,
  findRequirementDesignEntry,
  listAllRequirementDesignEntries,
  removeRequirementDesignAssociations,
  openRequirementDesign
} from "@/lib/requirement-design-entry"
import { createPromptDesignSession } from "@/components/design/session-client"
import {
  leanstarRequirementsApi,
  type ProductRequirement,
  type RichComponent
} from "@/api/leanstar-requirements"
import {
  REQUIREMENT_SPACE_MOCK,
  REQUIREMENT_SPACE_MOCK_ENABLED
} from "@/api/leanstar-requirements.mock"
import {
  buildRequirementDevelopmentPrompt,
  findRequirementDevelopmentThreads,
  REQUIREMENT_DEVELOPMENT_ONBOARDING_EVENT,
  REQUIREMENT_DEVELOPMENT_ONBOARDING_KEY,
  writeRequirementDevelopmentIntent
} from "@/lib/requirement-development"
import {
  REQUIREMENT_SPACE_LIST_EVENT,
  REQUIREMENT_SPACE_LIST_QUERY_KEY
} from "./requirement-navigation"

type EntryScreen = "history" | "system" | "conversation" | "space-detail"

type CurrentRequirementUser = { id: string; name: string }

const REQUIREMENT_SPACE_STATUS_LABELS: Record<string, string> = {
  CREATED: "已创建",
  IN_ANALYSIS: "分析中",
  TO_BE_SUPPLEMENTED: "待补充",
  TO_BE_REVIEWED: "待评审",
  IN_REVIEW: "评审中",
  REVIEWED: "评审通过",
  TO_BE_CHECKED: "待送审",
  CHECKING: "审批中",
  CHECKED_FAILURE: "审批不通过",
  CHECKED_SUCCESS: "审批通过",
  PROJECT_INITIATING: "立项中",
  PROJECT_REJECTED: "立项不通过",
  IN_OPERATION: "实施中",
  ABANDONED: "已删除",
  ARCHIVED: "已归档",
  PARTIALLY_RELEASED: "部分上线",
  RELEASED: "已交付",
  COMPLETED: "已完成",
  UNKNOWN: "未知",
  // 兼容旧接口曾返回的状态值。
  DEVELOPING: "开发中",
  CHECKING_SUCCESS: "审批通过"
}

function appendRichComponentDescriptions(
  markdown: string,
  components: RichComponent[],
  descriptions: Map<string, string>
): string {
  let content = markdown
  for (const component of components) {
    const description = descriptions.get(component.id)?.trim()
    if (!description) continue
    const escapedId = component.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    content = content.replace(
      new RegExp(`(!\\[[^\\]]*\\]\\((?:pic)?${escapedId}\\))`, "g"),
      `$1\n\n> **${component.resourceName || "附件"}描述：** ${description.replace(/\n/g, " ")}`
    )
  }
  return content
}

function fromRequirementSpaceItem(
  item: ProductRequirement,
  implementGroupDevopsOrgId: string,
  organizationName: string
): RequirementRecord {
  const owner = item.ownerName
    ? { id: item.ownerSapId || item.ownerName, name: item.ownerName }
    : typeof item.owner === "string"
      ? { id: item.owner, name: item.owner }
      : item.owner
  const sourceTime = item.createTime || ""
  // Leanstar returns local wall-clock time without an offset. Keep that wall-clock value instead
  // of letting Date reinterpret it using an environment-dependent timezone.
  const normalizedTime = sourceTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/)
  const parsedTime = sourceTime ? new Date(sourceTime) : null
  const hasValidTime = parsedTime !== null && Number.isFinite(parsedTime.getTime())
  const displayTime = normalizedTime
    ? `${normalizedTime[1]}/${normalizedTime[2]}/${normalizedTime[3]} ${normalizedTime[4]}:${normalizedTime[5]}:${normalizedTime[6]}`
    : hasValidTime
      ? parsedTime.toLocaleString("zh-CN", { hour12: false })
      : sourceTime
  return {
    id: `space:${implementGroupDevopsOrgId}:${item.code}`,
    threadIds: [],
    developmentThreadIds: [],
    systemId: `space:${implementGroupDevopsOrgId}`,
    title: item.title,
    requirementPath: "",
    workspaceMissing: false,
    coreFilesMissing: false,
    coreFilesMissingReason: null,
    updatedAt: displayTime,
    updatedAtTimestamp: hasValidTime ? parsedTime.getTime() : 0,
    system: organizationName || "需求空间3.0",
    status: REQUIREMENT_SPACE_STATUS_LABELS[item.status || ""] || item.status || "",
    fileName: "",
    link: "",
    sourceType: "link",
    sourceName: item.code,
    initialDescription: `需求编号 ${item.code}${item.priority ? ` · 优先级 ${item.priority}` : ""}`,
    needDesign: "",
    prdManifest: {
      prd: {
        name: item.title,
        status: "published",
        description: "",
        file: "",
        currentStep: 5,
        needDesign: "",
        htmlFile: "",
        htmlId: ""
      },
      functions: []
    },
    prd: "是",
    origin: "space",
    owner:
      owner?.name || owner?.id
        ? { id: owner.id || owner.name || item.code, name: owner.name || owner.id || "需求负责人" }
        : undefined,
    readOnly: true,
    functionCount: item.functionRequirements?.length ?? item.functionList?.length ?? 0
  }
}

export function RequirementEntryView({
  onListVisibilityChange
}: {
  onListVisibilityChange?: (visible: boolean) => void
}): React.JSX.Element {
  const [screen, setScreen] = useState<EntryScreen>("history")
  const [selectedRequirement, setSelectedRequirement] = useState<RequirementRecord | null>(null)
  const [selectedRequirementThreadId, setSelectedRequirementThreadId] = useState<string | null>(
    null
  )
  const openRequirementRequestRef = useRef(0)
  const [autoGeneratePrd, setAutoGeneratePrd] = useState(false)
  const [requirements, setRequirements] = useState<RequirementRecord[]>([])
  const [requirementsLoaded, setRequirementsLoaded] = useState(false)
  const [requirementSpaceLoading, setRequirementSpaceLoading] = useState(false)
  const [requirementSpaceTotal, setRequirementSpaceTotal] = useState(0)
  const [requirementSpacePage, setRequirementSpacePage] = useState(0)
  const [sourceFilter, setSourceFilter] = useState<RequirementSourceFilter>("local")
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false)
  const [tokenDraft, setTokenDraft] = useState("")
  const [tokenSaving, setTokenSaving] = useState(false)
  const [requirementSpaceRetryToken, setRequirementSpaceRetryToken] = useState(0)
  const [currentUser, setCurrentUser] = useState<CurrentRequirementUser | null>(null)
  const [currentUserOriginOrgId, setCurrentUserOriginOrgId] = useState("")
  const [currentUserOrgName, setCurrentUserOrgName] = useState("")
  const requirementSpaceLoadedRef = useRef(false)

  useEffect(() => {
    const openSpaceList = (event: Event): void => {
      const title = (event as CustomEvent<{ title?: string }>).detail?.title?.trim() || ""
      window.sessionStorage.setItem(REQUIREMENT_SPACE_LIST_QUERY_KEY, title)
      requirementSpaceLoadedRef.current = false
      setRequirementSpacePage(0)
      setSourceFilter("space")
      setScreen("history")
    }
    window.addEventListener(REQUIREMENT_SPACE_LIST_EVENT, openSpaceList)
    return () => window.removeEventListener(REQUIREMENT_SPACE_LIST_EVENT, openSpaceList)
  }, [])
  const [systemDialogOpen, setSystemDialogOpen] = useState(false)
  const [draftSystemId, setDraftSystemId] = useState<string | null>(null)
  const [requirementDialogOpen, setRequirementDialogOpen] = useState(false)
  const [quickStartDialogOpen, setQuickStartDialogOpen] = useState(false)
  const [pendingDevelopmentRequirement, setPendingDevelopmentRequirement] =
    useState<RequirementRecord | null>(null)
  const [newRequirementSource, setNewRequirementSource] = useState<UploadSource>("file")
  const [quickStartPreparation, setQuickStartPreparation] = useState<{
    source: "file" | "link"
    target: "design" | "development"
  } | null>(null)
  const selectedSystemId = useRequirementStore((state) => state.selectedSystemId)
  const setSystemList = useRequirementStore((state) => state.setSystemList)
  const selectedSystem = useRequirementStore((state) =>
    getSelectedRequirementSystem(state.selectedSystemId)
  )
  const draftSystem = useRequirementStore((state) =>
    getSelectedRequirementSystem(draftSystemId)
  )
  const createThread = useAppStore((state) => state.createThread)
  const deleteThread = useAppStore((state) => state.deleteThread)
  const selectThread = useAppStore((state) => state.selectThread)
  const setShowHarnessBoardView = useAppStore((state) => state.setShowHarnessBoardView)

  useEffect(() => {
    onListVisibilityChange?.(screen === "history")
  }, [onListVisibilityChange, screen])

  useEffect(() => {
    const openQuickStart = (): void => setQuickStartDialogOpen(true)
    window.addEventListener(REQUIREMENT_QUICK_START_EVENT, openQuickStart)
    return () => window.removeEventListener(REQUIREMENT_QUICK_START_EVENT, openQuickStart)
  }, [])

  const loadRequirements = useCallback(async (): Promise<RequirementRecord[]> => {
    // 需求列表与系统列表并行加载，互不影响
    // 系统列表加载后缓存到 store，SystemSelectionDialog 打开时若已有数据则跳过请求
    const systemsPromise = window.api.design
      .listSystems()
      .then((systems) => {
        setSystemList(systems)
      })
      .catch((error: unknown) => {
        console.error("加载系统列表失败", error)
      })

    const [persistedRequirements] = await Promise.all([
      window.api.requirements.list(),
      systemsPromise
    ])
    // 逐项容错：某条数据异常时跳过，避免整列加载失败
    const validRequirements = Array.isArray(persistedRequirements)
      ? persistedRequirements.flatMap((item) => {
          try {
            return [fromPersistedRequirement(item, getRequirementSystemName(item.systemId))]
          } catch (error) {
            console.error("解析需求项失败，已跳过", item?.reqId, error)
            return []
          }
        })
      : []
    return sortRequirementsByUpdatedAt(validRequirements)
  }, [setSystemList])

  useEffect(() => {
    void window.api.models.getUserInfo().then((userInfo) => {
      if (!userInfo) return
      setCurrentUser({
        id: userInfo.sapId?.trim() || userInfo.ystId?.trim() || "current-user",
        name: userInfo.userName?.trim() || userInfo.sapId?.trim() || "当前用户"
      })
      setCurrentUserOriginOrgId(userInfo.originOrgId?.trim() || "")
      setCurrentUserOrgName(userInfo.orgName?.trim() || "")
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadRequirements()
      .then((nextRequirements) => {
        if (cancelled) return
        setRequirements(nextRequirements)
        const returnRequirementId = localStorage.getItem(REQUIREMENT_CONVERSATION_ENTRY_KEY)
        const returningToSpaceRequirement = returnRequirementId?.startsWith("space:") ?? false
        if (returningToSpaceRequirement) setSourceFilter("space")
        else localStorage.removeItem(REQUIREMENT_CONVERSATION_ENTRY_KEY)
        const initialRequirement =
          returnRequirementId && !returningToSpaceRequirement
            ? (nextRequirements.find((item) => item.id === returnRequirementId) ?? null)
            : null
        if (returnRequirementId && !returningToSpaceRequirement && !initialRequirement) {
          toast.error("未找到关联的需求会话")
        }
        if (initialRequirement) {
          setSelectedRequirement(initialRequirement)
          const threadId = getRequirementThreadIds(initialRequirement)[0] ?? null
          setSelectedRequirementThreadId(threadId)
          if (threadId) void selectThread(threadId, { preserveView: true })
          setScreen("conversation")
        }
        setRequirementsLoaded(true)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "加载需求历史失败")
          setRequirementsLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [loadRequirements, selectThread])

  useEffect(() => {
    if (sourceFilter !== "space") requirementSpaceLoadedRef.current = false
  }, [sourceFilter])

  useEffect(() => {
    if (
      screen !== "history" ||
      !requirementsLoaded ||
      sourceFilter !== "space" ||
      requirementSpaceLoadedRef.current
    )
      return
    requirementSpaceLoadedRef.current = true
    const implementGroupDevopsOrgId = currentUserOriginOrgId
    if (REQUIREMENT_SPACE_MOCK_ENABLED && requirementSpacePage === 0) {
      const mockRequirement = fromRequirementSpaceItem(
        REQUIREMENT_SPACE_MOCK,
        implementGroupDevopsOrgId || "mock-org",
        currentUserOrgName || "需求空间3.0"
      )
      setRequirementSpaceTotal((current) => Math.max(1, current))
      setRequirements((current) => [
        ...current.filter(
          (item) => item.origin !== "space" || item.sourceName !== REQUIREMENT_SPACE_MOCK.code
        ),
        mockRequirement
      ])
    }
    if (!implementGroupDevopsOrgId) {
      requirementSpaceLoadedRef.current = false
      return
    }
    setRequirementSpaceLoading(true)
    void leanstarRequirementsApi
      .listDeliveryRequirements(implementGroupDevopsOrgId, requirementSpacePage)
      .then((page) => {
        setRequirementSpaceTotal(page.total ?? page.content?.length ?? 0)
        return (page.content ?? []).map((item) =>
          fromRequirementSpaceItem(item, implementGroupDevopsOrgId, currentUserOrgName)
        )
      })
      .then((spaceRequirements) => {
        setRequirements((current) => [
          ...current.filter((item) => item.origin !== "space"),
          ...spaceRequirements
        ])
        const returnRequirementId = localStorage.getItem(REQUIREMENT_CONVERSATION_ENTRY_KEY)
        if (!returnRequirementId?.startsWith("space:")) return
        const returnRequirement = spaceRequirements.find((item) => item.id === returnRequirementId)
        localStorage.removeItem(REQUIREMENT_CONVERSATION_ENTRY_KEY)
        if (!returnRequirement) {
          toast.error("未找到关联的需求")
          return
        }
        setSelectedRequirement(returnRequirement)
        setSelectedRequirementThreadId(null)
        setScreen("space-detail")
      })
      .catch((error: unknown) => {
        requirementSpaceLoadedRef.current = false
        if (error instanceof Error && error.message.includes("Leanstar Access Token")) {
          setTokenDraft("")
          setTokenDialogOpen(true)
          return
        }
        console.warn("加载需求空间3.0列表失败", error)
      })
      .finally(() => setRequirementSpaceLoading(false))
  }, [
    currentUserOrgName,
    currentUserOriginOrgId,
    requirementSpaceRetryToken,
    requirementSpacePage,
    requirementsLoaded,
    screen,
    sourceFilter
  ])

  const saveLeanstarTokenAndRetry = async (): Promise<void> => {
    const token = tokenDraft.trim()
    if (!token) {
      toast.error("请填写精益之星身份令牌-Token")
      return
    }
    setTokenSaving(true)
    try {
      const result = await window.api.requirements.saveToken(token)
      if (!result.success) throw new Error(result.error || "保存 Token 失败")
      requirementSpaceLoadedRef.current = false
      setTokenDialogOpen(false)
      setRequirementSpaceRetryToken((value) => value + 1)
      toast.success("Token 已保存，正在重新加载需求空间数据")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 Token 失败")
    } finally {
      setTokenSaving(false)
    }
  }

  const startNewRequirement = (source: UploadSource = "file"): void => {
    setNewRequirementSource(source)
    setDraftSystemId(selectedSystemId)
    if (!selectedSystem) {
      setSystemDialogOpen(true)
      return
    }
    setRequirementDialogOpen(true)
  }

  const selectQuickStartSource = (selection: RequirementQuickStartSelection): void => {
    if (selection.target === "space") {
      setSourceFilter("space")
      return
    }
    if (
      (selection.source === "file" || selection.source === "link") &&
      (selection.target === "design" || selection.target === "development")
    ) {
      setQuickStartPreparation({ source: selection.source, target: selection.target })
      return
    }
    startNewRequirement("text")
  }

  const completeQuickStart = async (prepared: QuickStartPreparedInput): Promise<void> => {
    if (quickStartPreparation?.target === "design") {
      const prompt = prepared.url
        ? [
            "请先使用内置浏览器打开以下在线需求文档：",
            prepared.url,
            "",
            "完整读取并逐字输出全部需求内容，不得总结、改写、压缩或遗漏。然后继续执行以下任务：",
            "",
            "上述需求内容是业务范围、流程和规则的主要依据；其他资料仅作补充，冲突时以需求内容为准。请覆盖核心流程及必要的空状态、异常状态，输出可独立运行、主要流程可交互的单页 HTML。关键信息缺失时先提问确认。"
          ].join("\n")
        : buildRequirementDesignPrompt(prepared.title, prepared.sourceName)
      await createPromptDesignSession({
        title: prepared.title,
        prompt,
        ...(prepared.url
          ? {}
          : {
              attachment: {
                filename: prepared.sourceName,
                filePath: prepared.sourceName,
                content: prepared.content,
                mimeType: "text/markdown",
                size: new TextEncoder().encode(prepared.content).byteLength,
                truncated: false
              }
            })
      })
      setQuickStartPreparation(null)
      return
    }
    const prompt = prepared.url
      ? [
          "请先使用内置浏览器打开并完整读取以下在线 PRD：",
          prepared.url,
          "",
          "必须读取全部需求内容，不得总结、改写、压缩或遗漏。读取完成后，结合当前工作区确认功能范围、交互和验收要求，并完成开发与必要验证；信息不足或存在歧义时先向我确认。"
        ].join("\n")
      : `PRD需求文档的地址：${prepared.sourcePath || prepared.sourceName}`
    writeRequirementDevelopmentIntent({
      action: "create-development",
      requirementId: prepared.id,
      requirementTitle: prepared.title,
      prompt,
      requirementFilePath: prepared.url || prepared.sourcePath || prepared.sourceName,
      prototypeFilePaths: [],
      functionCount: 0,
      hasPrototype: false
    })
    setQuickStartPreparation(null)
    setShowHarnessBoardView(true)
    window.dispatchEvent(new Event(REQUIREMENT_DEVELOPMENT_ONBOARDING_EVENT))
  }

  const replaceRequirement = useCallback((requirement: RequirementRecord): void => {
    setRequirements((current) => {
      const existingIndex = current.findIndex((item) => item.id === requirement.id)
      if (existingIndex >= 0) {
        const next = [...current]
        next[existingIndex] = requirement
        return sortRequirementsByUpdatedAt(next)
      }
      return sortRequirementsByUpdatedAt([...current, requirement])
    })
    setSelectedRequirement((current) => (current?.id === requirement.id ? requirement : current))
  }, [])

  const startSpaceRequirementDevelopment = useCallback(
    async (requirement: RequirementRecord, selectedWorkDir?: string): Promise<boolean> => {
      try {
        const workDir = selectedWorkDir || (await window.api.requirements.getWorkDir())
        if (!workDir) {
          setPendingDevelopmentRequirement(requirement)
          return false
        }
        const document = await leanstarRequirementsApi.getRequirementDocumentContent(
          requirement.sourceName
        )
        const rawContent = document?.documentTextContent?.trim() || ""
        const components = document?.richComponents ?? []
        let requirementContent = rawContent
        if (components.length) {
          try {
            const descriptions =
              await leanstarRequirementsApi.getMultimodalComponentDescriptions(components)
            requirementContent = appendRichComponentDescriptions(
              rawContent,
              components,
              descriptions
            )
          } catch {
            // 描述查询失败不阻断携带主 PRD 文件。
          }
        }
        if (!requirementContent) throw new Error("需求文档内容为空，无法开始开发")
        const saved = await window.api.requirements.saveFiles({
          workspacePath: workDir,
          requirementId: requirement.id,
          prd: {
            filename: `需求空间3.0-${requirement.sourceName}.md`,
            content: requirementContent
          }
        })
        if (!saved.success || !saved.prdPath) {
          throw new Error(saved.error || "保存需求文件失败")
        }
        const requirementFilePath = saved.prdPath
        const prototypeFilePaths = listAllRequirementDesignEntries(requirement.id)
          .map((entry) => entry.htmlFile?.trim() || "")
          .filter(Boolean)
        const uniquePrototypeFilePaths = [...new Set(prototypeFilePaths)]
        writeRequirementDevelopmentIntent({
          action: "create-development",
          requirementId: requirement.id,
          requirementTitle: requirement.title,
          prompt: buildRequirementDevelopmentPrompt({
            title: requirement.title,
            requirementFilePath,
            prototypeFilePaths: uniquePrototypeFilePaths
          }),
          requirementFilePath,
          prototypeFilePaths: uniquePrototypeFilePaths,
          functionCount: requirement.functionCount ?? 0,
          hasPrototype: uniquePrototypeFilePaths.length > 0
        })
        setShowHarnessBoardView(true)
        window.dispatchEvent(new Event(REQUIREMENT_DEVELOPMENT_ONBOARDING_EVENT))
        setPendingDevelopmentRequirement(null)
        return true
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "读取需求文件失败")
        return false
      }
    },
    [setShowHarnessBoardView]
  )

  const continueSpaceRequirementDevelopment = useCallback(
    (requirement: RequirementRecord, threadId: string): void => {
      window.sessionStorage.setItem(
        REQUIREMENT_DEVELOPMENT_ONBOARDING_KEY,
        JSON.stringify({
          action: "open-session",
          threadId,
          requirementTitle: requirement.title
        })
      )
      setShowHarnessBoardView(true)
      window.dispatchEvent(new Event(REQUIREMENT_DEVELOPMENT_ONBOARDING_EVENT))
    },
    [setShowHarnessBoardView]
  )

  const resetSpaceRequirementDevelopment = useCallback(
    async (requirement: RequirementRecord): Promise<void> => {
      const threads = findRequirementDevelopmentThreads(
        requirement.id,
        useAppStore.getState().threads
      )
      const patchThreadMetadata = useAppStore.getState().patchThreadMetadata
      await Promise.all(
        threads.map((thread) =>
          patchThreadMetadata(thread.thread_id, { remove: ["requirementDevelopment"] })
        )
      )
    },
    []
  )

  const ensureRequirementThread = async (
    requirement: RequirementRecord,
    capabilities: RequirementSessionCapabilities = getRequirementSessionCapabilities()
  ): Promise<{ requirement: RequirementRecord; threadId: string }> => {
    const threadIds = getRequirementThreadIds(requirement)
    if (threadIds[0]) return { requirement, threadId: threadIds[0] }

    await enableRequirementSessionExperts(capabilities.allowedExperts)
    const thread = await createThread(
      {
        title: `PRD 沟通 · ${requirement.title}`,
        requirementId: requirement.id,
        requirementTitle: requirement.title,
        requirementSystem: requirement.system,
        requirementSourceType: requirement.sourceType,
        requirementSourceName: requirement.sourceName,
        allowedSkills: capabilities.allowedSkills,
        allowedExperts: capabilities.allowedExperts,
        ...(requirement.requirementPath ? { workspacePath: requirement.requirementPath } : {})
      },
      { preserveView: true }
    )
    const result = await window.api.requirements.attachThread({
      reqId: requirement.id,
      threadId: thread.thread_id
    })
    if (!result.success || !result.requirement) {
      throw new Error(result.error || "保存需求会话失败")
    }
    const systemName =
      getSelectedRequirementSystem(requirement.systemId)?.name ?? requirement.system
    return {
      requirement: fromPersistedRequirement(result.requirement, systemName),
      threadId: thread.thread_id
    }
  }

  const openRequirement = async (
    requirement: RequirementRecord,
    threadId?: string
  ): Promise<void> => {
    const requestId = ++openRequirementRequestRef.current
    if (requirement.readOnly) {
      if (!requirement.sourceName.trim()) {
        toast.error("该需求缺少需求编号，无法读取需求文档")
        return
      }
      setSelectedRequirement(requirement)
      setSelectedRequirementThreadId(null)
      setScreen("space-detail")
      return
    }
    try {
      const ensured = threadId
        ? { requirement, threadId }
        : await ensureRequirementThread(requirement)
      if (requestId !== openRequirementRequestRef.current) return
      const nextRequirement = ensured.requirement
      const nextThreadId = ensured.threadId
      if (nextThreadId) await selectThread(nextThreadId, { preserveView: true })
      if (requestId !== openRequirementRequestRef.current) return
      replaceRequirement(nextRequirement)
      setSelectedRequirement(nextRequirement)
      setSelectedRequirementThreadId(nextThreadId)
      setAutoGeneratePrd(false)
      setScreen("conversation")
    } catch (error) {
      if (requestId === openRequirementRequestRef.current) {
        toast.error(error instanceof Error ? error.message : "打开需求会话失败")
      }
    }
  }

  const designSpaceRequirement = useCallback(
    async (requirement: RequirementRecord, suppliedContent?: string): Promise<void> => {
      try {
        const content =
          suppliedContent?.trim() ||
          (
            await leanstarRequirementsApi.getRequirementDocumentContent(
              requirement.sourceName.trim()
            )
          )?.documentTextContent?.trim() ||
          ""
        if (!content) throw new Error("需求文档内容为空，无法开始设计")
        const existing = findRequirementDesignEntry(requirement.id)
        const createdWorkspace = existing?.workspacePath
          ? null
          : await window.api.requirements.createDesignWorkspace({
              requirementId: requirement.id,
              title: requirement.title
            })
        if (createdWorkspace && !createdWorkspace.success) {
          throw new Error(createdWorkspace.error || "创建设计工作区失败")
        }
        openRequirementDesign({
          source: "space",
          scope: "full-prd",
          requirementId: requirement.id,
          requirementName: requirement.title,
          functionName: requirement.title,
          workspacePath: existing?.workspacePath || createdWorkspace?.workspacePath || undefined,
          requirementFilePath: `space://${requirement.sourceName.trim()}`,
          requirementContent: content,
          prompt: buildSpaceRequirementDesignPrompt(requirement.title),
          htmlId: existing?.htmlId ?? "",
          htmlFile: existing?.htmlFile
        })
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "打开需求设计失败")
      }
    },
    []
  )

  const resetSpaceRequirementDesign = useCallback(
    async (requirement: RequirementRecord): Promise<void> => {
      const sessionIds = listAllRequirementDesignEntries(requirement.id).map(
        (entry) => entry.htmlId
      )
      removeRequirementDesignAssociations(sessionIds)
    },
    []
  )

  const deleteRequirement = async (requirement: RequirementRecord): Promise<void> => {
    const deletedRequirementIndex = requirements.findIndex((item) => item.id === requirement.id)
    const remainingRequirements = requirements.filter((item) => item.id !== requirement.id)
    const adjacentRequirement =
      deletedRequirementIndex >= 0
        ? (remainingRequirements[deletedRequirementIndex] ??
          remainingRequirements[deletedRequirementIndex - 1] ??
          null)
        : null
    const shouldOpenAdjacentRequirement =
      screen === "conversation" && selectedRequirement?.id === requirement.id

    const threadIds = getRequirementThreadIds(requirement)
    for (const threadId of threadIds) await deleteThread(threadId)

    const result = await window.api.requirements.delete(requirement.id)
    if (!result.success) {
      throw new Error(result.error || "删除需求失败")
    }

    setRequirements(remainingRequirements)
    if (shouldOpenAdjacentRequirement) {
      if (adjacentRequirement) {
        await openRequirement(adjacentRequirement)
      } else {
        setSelectedRequirement(null)
        setSelectedRequirementThreadId(null)
        setScreen("history")
      }
    } else if (selectedRequirement?.id === requirement.id) {
      setSelectedRequirement(null)
      setSelectedRequirementThreadId(null)
    }
    toast.success("需求、关联会话和归档文件已删除")
  }

  if (!requirementsLoaded) {
    return <RequirementListLoading />
  }

  return (
    <>
      {screen === "history" && (
        <RequirementHistoryView
          requirements={requirements}
          currentUser={currentUser}
          sourceFilter={sourceFilter}
          requirementSpaceLoading={requirementSpaceLoading}
          requirementSpaceTotal={requirementSpaceTotal}
          requirementSpacePage={requirementSpacePage}
          onRequirementSpacePageChange={(page) => {
            requirementSpaceLoadedRef.current = false
            setRequirementSpacePage(page)
          }}
          onSourceFilterChange={(filter) => {
            if (filter === "space") {
              requirementSpaceLoadedRef.current = false
              setRequirementSpacePage(0)
            }
            setSourceFilter(filter)
          }}
          onNew={() => startNewRequirement()}
          onOpenRequirement={openRequirement}
          onDeleteRequirement={deleteRequirement}
        />
      )}

      {screen === "conversation" && selectedRequirement && (
        <RequirementConversationView
          requirement={selectedRequirement}
          selectedThreadId={selectedRequirementThreadId}
          requirements={requirements}
          onSelectRequirement={openRequirement}
          onRequirementUpdated={replaceRequirement}
          onDeleteRequirement={deleteRequirement}
          onBack={() => setScreen("history")}
          onNew={() => startNewRequirement()}
          autoGeneratePrd={autoGeneratePrd}
        />
      )}

      {screen === "space-detail" && selectedRequirement && (
        <RequirementSpaceDetailView
          requirement={selectedRequirement}
          onDesignRequirement={designSpaceRequirement}
          onResetDesign={() => resetSpaceRequirementDesign(selectedRequirement)}
          onStartDevelopment={async () => {
            await startSpaceRequirementDevelopment(selectedRequirement)
          }}
          onContinueDevelopment={(threadId) =>
            continueSpaceRequirementDevelopment(selectedRequirement, threadId)
          }
          onResetDevelopment={() => resetSpaceRequirementDevelopment(selectedRequirement)}
          onBack={() => setScreen("history")}
        />
      )}

      <RequirementWorkDirDialog
        open={Boolean(pendingDevelopmentRequirement)}
        onOpenChange={(open) => {
          if (!open) setPendingDevelopmentRequirement(null)
        }}
        onConfirm={async (workDir) => {
          if (!pendingDevelopmentRequirement) return
          await startSpaceRequirementDevelopment(pendingDevelopmentRequirement, workDir)
        }}
      />

      <LeanstarTokenDialog
        open={tokenDialogOpen}
        onOpenChange={setTokenDialogOpen}
        value={tokenDraft}
        onValueChange={setTokenDraft}
        saving={tokenSaving}
        onConfirm={saveLeanstarTokenAndRetry}
        description="加载需求空间3.0需要身份令牌。保存后将自动重新加载当前列表。"
        confirmLabel="保存并加载"
      />

      <RequirementQuickStartDialog
        open={quickStartDialogOpen}
        onOpenChange={setQuickStartDialogOpen}
        onSelect={selectQuickStartSource}
      />

      {quickStartPreparation ? (
        <RequirementQuickStartPreparationDialog
          source={quickStartPreparation.source}
          target={quickStartPreparation.target}
          onBack={() => {
            setQuickStartPreparation(null)
            setQuickStartDialogOpen(true)
          }}
          onPrepared={completeQuickStart}
        />
      ) : null}

      {systemDialogOpen && (
        <SystemSelectionDialog
          initialSystemId={draftSystemId}
          onCancel={() => setSystemDialogOpen(false)}
          onConfirm={(systemId) => {
            setDraftSystemId(systemId)
            setSystemDialogOpen(false)
            setRequirementDialogOpen(true)
          }}
          title={requirementDialogOpen ? "切换业务系统" : "新增需求 · 选择业务系统"}
          description={
            requirementDialogOpen
              ? "切换后，本次需求将关联新的业务系统；已填写的内容会保留。"
              : "先关联需求使用的业务系统，需求内容和规范 PRD 将归档到对应目录。"
          }
          confirmLabel={requirementDialogOpen ? "确认切换" : "确认并创建需求"}
        />
      )}

      {requirementDialogOpen && draftSystem && (
        <NewRequirementDialog
          open
          system={draftSystem}
          initialSource={newRequirementSource}
          onChangeSystem={() => setSystemDialogOpen(true)}
          onOpenChange={setRequirementDialogOpen}
          onStartConversation={async (requirement, options) => {
            const capabilities = {
              allowedSkills:
                options?.allowedSkills ?? getRequirementSessionCapabilities().allowedSkills,
              allowedExperts:
                options?.allowedExperts ?? getRequirementSessionCapabilities().allowedExperts
            }
            const ensured = await ensureRequirementThread(requirement, capabilities)
            const nextRequirement = ensured.requirement
            const nextThreadId = ensured.threadId
            if (nextThreadId) await selectThread(nextThreadId, { preserveView: true })
            replaceRequirement(nextRequirement)
            setRequirementDialogOpen(false)
            setSelectedRequirement(nextRequirement)
            setSelectedRequirementThreadId(nextThreadId)
            setAutoGeneratePrd(options?.autoGeneratePrd ?? true)
            setScreen("conversation")
          }}
        />
      )}
    </>
  )
}
