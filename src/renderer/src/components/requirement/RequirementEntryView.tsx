import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { LeanstarTokenDialog } from "./LeanstarTokenDialog"
import { NewRequirementDialog } from "./NewRequirementDialog"
import { RequirementConversationView } from "./RequirementConversationView"
import { RequirementHistoryView } from "./RequirementHistoryView"
import { RequirementListLoading } from "./RequirementListLoading"
import type { RequirementSourceFilter } from "./RequirementHistoryList"
import { RequirementSpaceDetailView } from "./RequirementSpaceDetailView"
import { SystemSelectionDialog } from "./SystemSelectionDialog"
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
import { getSelectedRequirementSystem, useRequirementStore } from "./requirement-store"
import type { DesignSystemInfo } from "../design/types"
import { useAppStore } from "@/lib/store"
import {
  REQUIREMENT_CONVERSATION_ENTRY_KEY,
  buildSpaceRequirementDesignPrompt,
  findRequirementDesignEntry,
  openRequirementDesign
} from "@/lib/requirement-design-entry"
import {
  USE_LEANSTAR_REQUIREMENTS_MOCK,
  leanstarRequirementsApi,
  type ProductRequirement
} from "@/api/leanstar-requirements"

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
  const sourceTime = item.updateTime || item.updatedAt || item.createTime || ""
  const parsedTime = sourceTime ? new Date(sourceTime) : null
  const hasValidTime = parsedTime !== null && Number.isFinite(parsedTime.getTime())
  const displayTime = hasValidTime
    ? parsedTime.toLocaleString("zh-CN", { hour12: false })
    : sourceTime
  return {
    id: `space:${implementGroupDevopsOrgId}:${item.code}`,
    threadIds: [],
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
    readOnly: true
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
  const [sourceFilter, setSourceFilter] = useState<RequirementSourceFilter>("local")
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false)
  const [tokenDraft, setTokenDraft] = useState("")
  const [tokenSaving, setTokenSaving] = useState(false)
  const [requirementSpaceRetryToken, setRequirementSpaceRetryToken] = useState(0)
  const [currentUser, setCurrentUser] = useState<CurrentRequirementUser | null>(null)
  const [currentUserOriginOrgId, setCurrentUserOriginOrgId] = useState("")
  const [currentUserOrgName, setCurrentUserOrgName] = useState("")
  const requirementSpaceLoadedRef = useRef(false)
  const [systemDialogOpen, setSystemDialogOpen] = useState(false)
  const [requirementDialogOpen, setRequirementDialogOpen] = useState(false)
  const selectedSystemId = useRequirementStore((state) => state.selectedSystemId)
  const setSelectedSystemId = useRequirementStore((state) => state.setSelectedSystemId)
  const setSystemList = useRequirementStore((state) => state.setSystemList)
  const selectedSystem = useRequirementStore((state) =>
    getSelectedRequirementSystem(state.selectedSystemId)
  )
  const createThread = useAppStore((state) => state.createThread)
  const deleteThread = useAppStore((state) => state.deleteThread)
  const selectThread = useAppStore((state) => state.selectThread)

  useEffect(() => {
    onListVisibilityChange?.(screen === "history")
  }, [onListVisibilityChange, screen])

  const loadRequirements = useCallback(async (): Promise<RequirementRecord[]> => {
    // 需求列表与系统列表并行加载，互不影响
    // 系统列表加载后缓存到 store，SystemSelectionDialog 打开时若已有数据则跳过请求
    const systemsPromise = window.api.design
      .listSystems()
      .then((systems) => {
        // 仅在 store 为空时填充，避免覆盖 SystemSelectionDialog 已加载的数据
        if (useRequirementStore.getState().systemList.length === 0) {
          setSystemList(systems)
        }
        return systems
      })
      .catch((error: unknown) => {
        console.error("加载系统列表失败", error)
        return [] as DesignSystemInfo[]
      })

    const [persistedRequirements, systems] = await Promise.all([
      window.api.requirements.list(),
      systemsPromise
    ])
    const systemNames = new Map(systems.map((system) => [system.id, system.name]))
    // 逐项容错：某条数据异常时跳过，避免整列加载失败
    const validRequirements = Array.isArray(persistedRequirements)
      ? persistedRequirements.flatMap((item) => {
          try {
            return [fromPersistedRequirement(item, systemNames.get(item.systemId) ?? item.systemId)]
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
        localStorage.removeItem(REQUIREMENT_CONVERSATION_ENTRY_KEY)
        const initialRequirement = returnRequirementId
          ? (nextRequirements.find((item) => item.id === returnRequirementId) ?? null)
          : null
        if (returnRequirementId && !initialRequirement) {
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
    if (
      screen !== "history" ||
      !requirementsLoaded ||
      (sourceFilter !== "all" && sourceFilter !== "space") ||
      requirementSpaceLoadedRef.current
    )
      return
    requirementSpaceLoadedRef.current = true
    const implementGroupDevopsOrgId = USE_LEANSTAR_REQUIREMENTS_MOCK
      ? currentUserOriginOrgId || "mock-origin-org"
      : currentUserOriginOrgId
    if (!implementGroupDevopsOrgId) {
      requirementSpaceLoadedRef.current = false
      return
    }
    setRequirementSpaceLoading(true)
    void leanstarRequirementsApi
      .listDeliveryRequirements(implementGroupDevopsOrgId)
      .then((page) =>
        (page.content ?? []).map((item) =>
          fromRequirementSpaceItem(item, implementGroupDevopsOrgId, currentUserOrgName)
        )
      )
      .then((spaceRequirements) => {
        setRequirements((current) => [
          ...current.filter((item) => item.origin !== "space"),
          ...spaceRequirements
        ])
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

  const startNewRequirement = (): void => {
    if (!selectedSystem) {
      setSystemDialogOpen(true)
      return
    }
    setRequirementDialogOpen(true)
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
        openRequirementDesign({
          source: "space",
          scope: "full-prd",
          requirementId: requirement.id,
          requirementName: requirement.title,
          functionName: requirement.title,
          workspacePath: existing?.workspacePath,
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
          onSourceFilterChange={setSourceFilter}
          onNew={startNewRequirement}
          onOpenRequirement={openRequirement}
          onDesignRequirement={designSpaceRequirement}
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
          onNew={startNewRequirement}
          autoGeneratePrd={autoGeneratePrd}
        />
      )}

      {screen === "space-detail" && selectedRequirement && (
        <RequirementSpaceDetailView
          requirement={selectedRequirement}
          onDesignRequirement={designSpaceRequirement}
          onBack={() => setScreen("history")}
        />
      )}

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

      {systemDialogOpen && (
        <SystemSelectionDialog
          initialSystemId={selectedSystemId}
          onCancel={() => setSystemDialogOpen(false)}
          onConfirm={(systemId) => {
            setSelectedSystemId(systemId)
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

      {requirementDialogOpen && selectedSystem && (
        <NewRequirementDialog
          open
          system={selectedSystem}
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
