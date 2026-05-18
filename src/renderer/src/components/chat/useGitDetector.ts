import { useState, useEffect, useCallback } from "react"

interface GitStatus {
  hasChanges: boolean
  changedFiles: string[]
  untrackedFiles: string[]
  stagedFiles: string[]
}

interface UseGitDetectorOptions {
  autoDetect?: boolean
  checkInterval?: number
  onChangesDetected?: (status: GitStatus) => void
}

export function useGitDetector({
  autoDetect = false,
  checkInterval = 5000,
  onChangesDetected
}: UseGitDetectorOptions = {}) {
  const [gitStatus, setGitStatus] = useState<GitStatus>({
    hasChanges: false,
    changedFiles: [],
    untrackedFiles: [],
    stagedFiles: []
  })

  const [isChecking, setIsChecking] = useState(false)
  const [lastCheck, setLastCheck] = useState<Date | null>(null)

  // 检查Git状态
  const checkGitStatus = useCallback(async (): Promise<GitStatus> => {
    setIsChecking(true)

    try {
      // 获取Git状态
      const result = await window.electron.ipcRenderer.invoke("git-status") as GitStatus

      const status: GitStatus = {
        hasChanges: result.hasChanges || false,
        changedFiles: result.changedFiles || [],
        untrackedFiles: result.untrackedFiles || [],
        stagedFiles: result.stagedFiles || []
      }

      setGitStatus(status)
      setLastCheck(new Date())

      // 如果检测到变更且有回调函数，则触发
      if (status.hasChanges && onChangesDetected) {
        onChangesDetected(status)
      }

      return status
    } catch (error) {
      console.error("检查Git状态失败:", error)
      const emptyStatus: GitStatus = {
        hasChanges: false,
        changedFiles: [],
        untrackedFiles: [],
        stagedFiles: []
      }
      setGitStatus(emptyStatus)
      return emptyStatus
    } finally {
      setIsChecking(false)
    }
  }, [onChangesDetected])

  // 手动触发检查
  const manualCheck = useCallback(() => {
    return checkGitStatus()
  }, [checkGitStatus])

  // 自动检测逻辑
  useEffect(() => {
    if (!autoDetect) return

    // 立即检查一次
    checkGitStatus()

    // 设置定时检查
    const interval = setInterval(() => {
      checkGitStatus()
    }, checkInterval)

    return () => {
      clearInterval(interval)
    }
  }, [autoDetect, checkInterval, checkGitStatus])

  return {
    gitStatus,
    isChecking,
    lastCheck,
    checkGitStatus: manualCheck,
    hasChanges: gitStatus.hasChanges,
    allChangedFiles: [...gitStatus.changedFiles, ...gitStatus.untrackedFiles]
  }
}
