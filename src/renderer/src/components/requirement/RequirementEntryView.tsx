import { useCallback, useEffect, useRef, useState } from "react"
import { ClipboardList } from "lucide-react"
import { toast } from "sonner"
import { NewRequirementDialog } from "./NewRequirementDialog"
import { RequirementConversationView } from "./RequirementConversationView"
import { RequirementHistoryView } from "./RequirementHistoryView"
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
  leanstarRequirementsApi,
  type NamespaceTreeNode,
  type ProductRequirement
} from "@/api/leanstar-requirements"

type EntryScreen = "history" | "system" | "conversation"

type CurrentRequirementUser = { id: string; name: string }

function findRequirementSpaceNamespace(
  nodes: NamespaceTreeNode[],
  pathName: string
): NamespaceTreeNode | null {
  for (const node of nodes) {
    if (node.pathName.trim() === pathName && node.accessible !== false) return node
    const match = findRequirementSpaceNamespace(node.children ?? [], pathName)
    if (match) return match
  }
  return null
}

function fromRequirementSpaceItem(
  item: ProductRequirement,
  namespace: NamespaceTreeNode
): RequirementRecord {
  const owner = typeof item.owner === "string" ? { id: item.owner, name: item.owner } : item.owner
  return {
    id: `space:${namespace.devopsOrgId}:${item.code}`,
    threadIds: [],
    systemId: `space:${namespace.devopsOrgId}`,
    title: item.title,
    requirementPath: "",
    workspaceMissing: false,
    coreFilesMissing: false,
    coreFilesMissingReason: null,
    updatedAt: item.createTime ?? "",
    updatedAtTimestamp: item.createTime ? new Date(item.createTime).getTime() || 0 : 0,
    system: namespace.pathName.split("/").filter(Boolean).at(-1) || namespace.pathName,
    status: "",
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
        needDesign: ""
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

export function RequirementEntryView(): React.JSX.Element {
  const [screen, setScreen] = useState<EntryScreen>("history")
  const [selectedRequirement, setSelectedRequirement] = useState<RequirementRecord | null>(null)
  const [selectedRequirementThreadId, setSelectedRequirementThreadId] = useState<string | null>(
    null
  )
  const openRequirementRequestRef = useRef(0)
  const [autoGeneratePrd, setAutoGeneratePrd] = useState(false)
  const [requirements, setRequirements] = useState<RequirementRecord[]>([])
  const [requirementsLoaded, setRequirementsLoaded] = useState(false)
  const [currentUser, setCurrentUser] = useState<CurrentRequirementUser | null>(null)
  const [currentUserPathName, setCurrentUserPathName] = useState("")
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
      setCurrentUserPathName(userInfo.pathName?.trim() || "")
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadRequirements()
      .then((nextRequirements) => {
        if (cancelled) return
        setRequirements(nextRequirements)
        const firstLocalRequirement =
          nextRequirements.find((item) => item.origin !== "space") ?? null
        setSelectedRequirement((current) => current ?? firstLocalRequirement)
        if (firstLocalRequirement) setScreen("conversation")
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
  }, [loadRequirements])

  useEffect(() => {
    if (
      screen !== "history" ||
      !requirementsLoaded ||
      !currentUserPathName ||
      requirementSpaceLoadedRef.current
    )
      return
    requirementSpaceLoadedRef.current = true
    void leanstarRequirementsApi
      .getNamespaceTree()
      .then(async ({ namespaceTreeList = [] }) => {
        const namespace = findRequirementSpaceNamespace(namespaceTreeList, currentUserPathName)
        if (!namespace) return []
        const page = await leanstarRequirementsApi.listProductRequirements(
          namespace.devopsOrgId,
          namespace.namespaceType ?? ""
        )
        return (page.content ?? []).map((item) => fromRequirementSpaceItem(item, namespace))
      })
      .then((spaceRequirements) => {
        setRequirements((current) => [
          ...current.filter((item) => item.origin !== "space"),
          ...spaceRequirements
        ])
      })
      .catch((error: unknown) => {
        requirementSpaceLoadedRef.current = false
        console.warn("加载需求空间3.0列表失败", error)
      })
  }, [currentUserPathName, requirementsLoaded, screen])

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
    if (requirement.readOnly) {
      toast.info("需求空间3.0详情跳转暂未接入")
      return
    }
    const requestId = ++openRequirementRequestRef.current
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
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 bg-gradient-to-b from-background to-muted/30 px-6 py-10">
        <div className="flex flex-col items-center gap-4">
          <div className="relative flex size-16 items-center justify-center">
            <div className="absolute inset-0 animate-ping rounded-2xl bg-primary/15" />
            <div className="absolute inset-1 rounded-2xl bg-primary/8" />
            <div className="relative flex size-16 items-center justify-center rounded-2xl bg-primary/8 ring-1 ring-primary/15">
              <ClipboardList className="size-7 text-primary/70" strokeWidth={1.8} />
            </div>
          </div>
          <div className="flex flex-col items-center gap-2">
            <p className="text-sm font-medium text-foreground/80">正在加载需求列表</p>
            <div className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-primary/50 animate-bounce [animation-delay:-0.3s]" />
              <span className="size-1.5 rounded-full bg-primary/50 animate-bounce [animation-delay:-0.15s]" />
              <span className="size-1.5 rounded-full bg-primary/50 animate-bounce" />
            </div>
          </div>
        </div>
        <div className="flex w-full max-w-md flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-3 py-3"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className="size-2 shrink-0 rounded-full bg-muted animate-pulse" />
              <div className="h-2.5 w-20 shrink-0 rounded bg-muted animate-pulse" />
              <div className="h-2.5 flex-1 rounded bg-muted animate-pulse" />
              <div className="h-2.5 w-12 shrink-0 rounded bg-muted animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <>
      {screen === "history" && (
        <RequirementHistoryView
          requirements={requirements}
          currentUser={currentUser}
          onNew={startNewRequirement}
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
          onNew={startNewRequirement}
          autoGeneratePrd={autoGeneratePrd}
        />
      )}

      {systemDialogOpen && (
        <SystemSelectionDialog
          initialSystemId={selectedSystemId}
          onCancel={() => setSystemDialogOpen(false)}
          onConfirm={(systemId) => {
            setSelectedSystemId(systemId)
            setSystemDialogOpen(false)
            setRequirementDialogOpen(true)
          }}
          title="新增需求 · 选择业务系统"
          description="先关联需求使用的业务系统，需求内容和规范 PRD 将归档到对应目录。"
          confirmLabel="确认并创建需求"
        />
      )}

      {requirementDialogOpen && selectedSystem && (
        <NewRequirementDialog
          open
          system={selectedSystem}
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
