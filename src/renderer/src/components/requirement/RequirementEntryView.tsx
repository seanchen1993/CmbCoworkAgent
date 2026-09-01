import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { NewRequirementDialog } from "./NewRequirementDialog"
import { RequirementConversationView } from "./RequirementConversationView"
import { RequirementHistoryView } from "./RequirementHistoryView"
import { SystemSelectionDialog } from "./SystemSelectionDialog"
import {
  fromPersistedRequirement,
  sortRequirementsByUpdatedAt,
  type RequirementRecord
} from "./requirement-data"
import { getSelectedRequirementSystem, useRequirementStore } from "./requirement-store"
import { useAppStore } from "@/lib/store"

type EntryScreen = "history" | "system" | "conversation"

export function RequirementEntryView(): React.JSX.Element {
  const [screen, setScreen] = useState<EntryScreen>("history")
  const [selectedRequirement, setSelectedRequirement] = useState<RequirementRecord | null>(null)
  const [autoGeneratePrd, setAutoGeneratePrd] = useState(false)
  const [requirements, setRequirements] = useState<RequirementRecord[]>([])
  const [systemDialogOpen, setSystemDialogOpen] = useState(false)
  const [requirementDialogOpen, setRequirementDialogOpen] = useState(false)
  const setSystemList = useRequirementStore((state) => state.setSystemList)
  const selectedSystemId = useRequirementStore((state) => state.selectedSystemId)
  const setSelectedSystemId = useRequirementStore((state) => state.setSelectedSystemId)
  const selectedSystem = useRequirementStore((state) =>
    getSelectedRequirementSystem(state.selectedSystemId)
  )
  const createThread = useAppStore((state) => state.createThread)
  const deleteThread = useAppStore((state) => state.deleteThread)
  const selectThread = useAppStore((state) => state.selectThread)

  const loadRequirements = useCallback(async (): Promise<void> => {
    const [systems, persistedRequirements] = await Promise.all([
      window.api.design.listSystems(),
      window.api.requirements.list()
    ])
    setSystemList(systems)
    const systemNames = new Map(systems.map((system) => [system.id, system.name]))
    setRequirements(
      sortRequirementsByUpdatedAt(
        persistedRequirements.map((item) =>
          fromPersistedRequirement(item, systemNames.get(item.systemId) ?? item.systemId)
        )
      )
    )
  }, [setSystemList])

  useEffect(() => {
    let cancelled = false
    void loadRequirements().catch((error: unknown) => {
      if (!cancelled) {
        toast.error(error instanceof Error ? error.message : "加载需求历史失败")
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

  const replaceRequirement = (requirement: RequirementRecord): void => {
    setRequirements((current) => {
      const existingIndex = current.findIndex((item) => item.id === requirement.id)
      if (existingIndex >= 0) {
        const next = [...current]
        next[existingIndex] = requirement
        return sortRequirementsByUpdatedAt(next)
      }
      return sortRequirementsByUpdatedAt([...current, requirement])
    })
  }

  const ensureRequirementThread = async (
    requirement: RequirementRecord
  ): Promise<RequirementRecord> => {
    if (requirement.threadId) {
      const existingThread = await window.api.threads.get(requirement.threadId)
      if (existingThread) {
        await selectThread(requirement.threadId, { preserveView: true })
        return requirement
      }
    }

    const thread = await createThread(
      {
        title: `PRD 沟通 · ${requirement.title}`,
        requirementId: requirement.id,
        requirementTitle: requirement.title,
        requirementSystem: requirement.system,
        requirementSourceType: requirement.sourceType,
        requirementSourceName: requirement.sourceName,
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
    return fromPersistedRequirement(result.requirement, systemName)
  }

  const openRequirement = async (requirement: RequirementRecord): Promise<void> => {
    try {
      const nextRequirement = await ensureRequirementThread(requirement)
      replaceRequirement(nextRequirement)
      setSelectedRequirement(nextRequirement)
      setAutoGeneratePrd(false)
      setScreen("conversation")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "打开需求会话失败")
    }
  }

  const deleteRequirement = async (requirement: RequirementRecord): Promise<void> => {
    if (requirement.threadId) {
      const thread = await window.api.threads.get(requirement.threadId)
      if (thread) {
        await deleteThread(requirement.threadId)
      }
    }

    const result = await window.api.requirements.delete(requirement.id)
    if (!result.success) {
      throw new Error(result.error || "删除需求失败")
    }

    setRequirements((current) => current.filter((item) => item.id !== requirement.id))
    if (selectedRequirement?.id === requirement.id) {
      setSelectedRequirement(null)
      setScreen("history")
    }
    toast.success("需求、关联会话和归档文件已删除")
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
          requirements={requirements}
          onSelectRequirement={openRequirement}
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
            const nextRequirement = await ensureRequirementThread(requirement)
            replaceRequirement(nextRequirement)
            setRequirementDialogOpen(false)
            setSelectedRequirement(nextRequirement)
            setAutoGeneratePrd(options?.autoGeneratePrd ?? true)
            setScreen("conversation")
          }}
        />
      )}
    </>
  )
}
