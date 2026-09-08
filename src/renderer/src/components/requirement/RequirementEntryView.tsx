import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2 } from "lucide-react"
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
import { getSelectedRequirementSystem, useRequirementStore } from "./requirement-store"
import type { DesignSystemInfo } from "../design/types"
import { useAppStore } from "@/lib/store"

type EntryScreen = "history" | "system" | "conversation"

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
    let cancelled = false
    void loadRequirements()
      .then((nextRequirements) => {
        if (cancelled) return
        setRequirements(nextRequirements)
        setSelectedRequirement((current) => current ?? nextRequirements[0] ?? null)
        if (nextRequirements.length > 0) setScreen("conversation")
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
    requirement: RequirementRecord
  ): Promise<{ requirement: RequirementRecord; threadId: string }> => {
    const threadIds = getRequirementThreadIds(requirement)
    for (const threadId of threadIds) {
      const existingThread = await window.api.threads.get(threadId)
      if (existingThread) {
        return { requirement, threadId }
      }
    }

    await window.api.expertAgents.setEnabled("analyst", true)
    const thread = await createThread(
      {
        title: `PRD 沟通 · ${requirement.title}`,
        requirementId: requirement.id,
        requirementTitle: requirement.title,
        requirementSystem: requirement.system,
        requirementSourceType: requirement.sourceType,
        requirementSourceName: requirement.sourceName,
        allowedSkills: ["requirement-to-prd"],
        allowedExperts: ["analyst"],
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
    const threadIds = getRequirementThreadIds(requirement)
    for (const threadId of threadIds) {
      const thread = await window.api.threads.get(threadId)
      if (thread) await deleteThread(threadId)
    }

    const result = await window.api.requirements.delete(requirement.id)
    if (!result.success) {
      throw new Error(result.error || "删除需求失败")
    }

    setRequirements((current) => current.filter((item) => item.id !== requirement.id))
    if (selectedRequirement?.id === requirement.id) {
      setSelectedRequirement(null)
      setSelectedRequirementThreadId(null)
      setScreen("history")
    }
    toast.success("需求、关联会话和归档文件已删除")
  }

  if (!requirementsLoaded) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="加载需求" />
      </div>
    )
  }

  return (
    <>
      {screen === "history" && (
        <RequirementHistoryView
          requirements={requirements}
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
            const ensured = await ensureRequirementThread(requirement)
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
