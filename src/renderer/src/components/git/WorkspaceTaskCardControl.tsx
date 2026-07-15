import { useEffect, useRef, useState } from "react"
import { TaskCardPicker } from "@/components/git/TaskCardPicker"
import { useWorkspaceTaskCard } from "@/components/git/use-workspace-task-card"
import type { AgentAutoCommitSettings } from "@/types"
import { cn } from "@/lib/utils"

const AUTO_COMMIT_SETTINGS_CHANGED_EVENT = "cmb:auto-commit-settings-changed"

const DEFAULT_AUTO_COMMIT_SETTINGS: AgentAutoCommitSettings = {
  mode: "off",
  push: false,
  messageStrategy: "prompt"
}

interface WorkspaceTaskCardControlProps {
  workspacePath?: string | null
}

function normalizeSettings(settings: AgentAutoCommitSettings | null): AgentAutoCommitSettings {
  return { ...DEFAULT_AUTO_COMMIT_SETTINGS, ...(settings ?? {}) }
}

export function WorkspaceTaskCardControl({
  workspacePath
}: WorkspaceTaskCardControlProps): React.JSX.Element | null {
  const [settings, setSettings] = useState<AgentAutoCommitSettings>(DEFAULT_AUTO_COMMIT_SETTINGS)
  const [isGitRepo, setIsGitRepo] = useState<boolean | null>(null)
  const mountedRef = useRef(true)
  const { cardNumber, loading: cardLoading, handleCardNumberChange } =
    useWorkspaceTaskCard(workspacePath)

  useEffect(() => {
    mountedRef.current = true

    const loadSettings = async (): Promise<void> => {
      try {
        const current = await window.api.autoCommit.getSettings()
        if (mountedRef.current) setSettings(normalizeSettings(current))
      } catch {
        if (mountedRef.current) setSettings(DEFAULT_AUTO_COMMIT_SETTINGS)
      }
    }

    const handleSettingsChanged = (event: Event): void => {
      const detail = (event as CustomEvent<AgentAutoCommitSettings>).detail
      if (detail) setSettings(normalizeSettings(detail))
    }

    void loadSettings()
    window.addEventListener(AUTO_COMMIT_SETTINGS_CHANGED_EVENT, handleSettingsChanged)
    return () => {
      mountedRef.current = false
      window.removeEventListener(AUTO_COMMIT_SETTINGS_CHANGED_EVENT, handleSettingsChanged)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function checkGitRepo(): Promise<void> {
      if (!workspacePath?.trim()) {
        setIsGitRepo(null)
        return
      }
      setIsGitRepo(null)
      try {
        const gitInfo = await window.api.workspace.isGit(workspacePath, { includeWorktrees: false })
        if (!cancelled) setIsGitRepo(gitInfo.isGit)
      } catch {
        if (!cancelled) setIsGitRepo(false)
      }
    }

    void checkGitRepo()
    return () => {
      cancelled = true
    }
  }, [workspacePath])

  if (!workspacePath || settings.mode === "off" || isGitRepo === false) {
    return null
  }

  const loading = cardLoading || isGitRepo === null

  return (
    <TaskCardPicker
      value={cardNumber}
      onValueChange={handleCardNumberChange}
      placeholder={loading ? "加载任务卡" : "选择任务卡"}
      disabled={loading}
      autoSelect={false}
      compact
      popoverSide="top"
      popoverAlign="end"
      popoverWidth="panel"
      className={cn(
        !cardNumber.trim() && !loading && "border-amber-500/70 text-amber-600 dark:text-amber-400"
      )}
    />
  )
}
