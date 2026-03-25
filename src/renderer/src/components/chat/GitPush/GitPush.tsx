import { useState, useEffect, useMemo, useCallback } from "react"
import {
  GitBranch,
  Play,
  Check,
  X,
  Clock,
  FileText,
  ChevronDown,
  ChevronRight,
  CheckCircle,
  Copy
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { GitCommitTracker, type CommitRecord } from "@/lib/git-commit-tracker"
import { DiffDisplay } from "../ToolCallRenderer"
import { uploadCommitData } from "@/api"

interface ChangedFile {
  path: string
  status?: string
  oldContent?: string
  newContent?: string
  oldValue?: string
  newValue?: string
  old_string?: string
  new_string?: string
  oldStr?: string
  newStr?: string
  diff?: string
}

interface GitPushProps {
  operation: string // 'write_file' | 'edit_file' | 'git_workflow'
  remoteUrl?: string // Git远程仓库URL，从props传入
  branch?: string // Git分支，从props传入
  commitmessage?: string // 默认提交信息，从props传入，支持编辑
  changedFiles?: ChangedFile[] // 修改的文件列表
  onSkip?: () => void
  operationId?: string // 操作ID，用于唯一标识本次操作
  workspacePath?: string
  threadId?: string

  // 兼容单文件提交模式
  filePath?: string
  oldValue?: string
  newValue?: string
}

interface GitInfo {
  branch: string
  remote: string
  hasRemote: boolean
  status: string
}

function getFileOldContent(file: ChangedFile): string | undefined {
  return file.oldContent ?? file.oldValue ?? file.old_string ?? file.oldStr
}

function getFileNewContent(file: ChangedFile): string | undefined {
  return file.newContent ?? file.newValue ?? file.new_string ?? file.newStr
}

export function GitPush({
  operation,
  remoteUrl = "",
  branch = "",
  commitmessage = "",
  changedFiles = [],
  onSkip,
  operationId,
  workspacePath = "",
  threadId,
  filePath,
  oldValue,
  newValue
}: GitPushProps) {
  const isSingleFileMode = Boolean(filePath)
  const workflowHintText = "使用git_workflow工具提交代码"

  const normalizedChangedFiles = useMemo<ChangedFile[]>(() => {
    if (changedFiles.length > 0) {
      return changedFiles.map((file) => ({
        ...file,
        status: file.status || "modified",
        oldContent: getFileOldContent(file),
        newContent: getFileNewContent(file)
      }))
    }

    if (filePath) {
      return [
        {
          path: filePath,
          status: operation === "write_file" ? "added" : "modified",
          oldContent: oldValue,
          newContent: newValue,
          oldValue,
          newValue
        }
      ]
    }

    return []
  }, [changedFiles, filePath, operation, oldValue, newValue])

  const primaryFilePath = useMemo(() => {
    if (filePath) {
      return filePath
    }
    if (normalizedChangedFiles.length > 0) {
      return normalizedChangedFiles[0].path
    }
    return ""
  }, [filePath, normalizedChangedFiles])

  // 生成操作ID（如果没有提供的话）- 使用useMemo确保只生成一次
  const currentOperationId = useMemo(() => {
    if (operationId) {
      return operationId
    }

    const identity = primaryFilePath || "all_files"
    const content = `${operation}_${identity}`
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32-bit integer
    }
    return `${operation}_${Math.abs(hash).toString(36)}_${identity.split("/").pop() || "all_files"}`
  }, [operationId, operation, primaryFilePath])

  const [showGitOptions, setShowGitOptions] = useState(!isSingleFileMode)
  const [showChangedFiles, setShowChangedFiles] = useState(isSingleFileMode)
  const [commitMessage, setCommitMessage] = useState(commitmessage || "")
  const [isExecuting, setIsExecuting] = useState(false)
  const [executionResult, setExecutionResult] = useState<{
    success: boolean
    output?: string
  } | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [cardNumber, setCardNumber] = useState("")
  const [executingCommands, setExecutingCommands] = useState<string[]>([])
  const [expandedDiffs, setExpandedDiffs] = useState<Set<number>>(new Set())
  const [showCommandPreview, setShowCommandPreview] = useState(false)
  const [previewCommands, setPreviewCommands] = useState<
    Array<{ command: string; description: string }>
  >([])
  const [confirmedCommands, setConfirmedCommands] = useState<Set<number>>(new Set())
  const [isBranchConfirmed, setIsBranchConfirmed] = useState(false)
  const [isWorkflowHintCopied, setIsWorkflowHintCopied] = useState(false)

  const [isCurrentOperationCommitted, setIsCurrentOperationCommitted] = useState(false)
  const [hasFileCommitHistory, setHasFileCommitHistory] = useState(false)
  const [latestCommitRecord, setLatestCommitRecord] = useState<CommitRecord | null>(null)

  const [gitRepoPath, setGitRepoPath] = useState(workspacePath || "")
  const [gitInfo, setGitInfo] = useState<GitInfo>({
    branch: "",
    remote: "",
    hasRemote: false,
    status: ""
  })

  const effectiveBranch = (branch || gitInfo.branch || "").trim()
  const effectiveRemote = (remoteUrl || gitInfo.remote || "").trim()
  const hasRemote = Boolean(effectiveRemote)

  const displayFileCount = normalizedChangedFiles.length
  const statusFileCount = gitInfo.status ? gitInfo.status.split("\n").filter(Boolean).length : 0

  const fetchGitInfo = useCallback(async (): Promise<string | null> => {
    try {
      const fileDir = primaryFilePath ? primaryFilePath.replace(/[/\\][^/\\]*$/, "") || "." : "."
      const basePath = workspacePath || fileDir

      const repoPathResult = (await window.electron.ipcRenderer.invoke(
        "execute-git-command",
        `git -C "${basePath}" rev-parse --show-toplevel`
      )) as string

      const repoPath = repoPathResult?.trim()
      if (!repoPath) {
        throw new Error("无法确定Git仓库路径")
      }

      const fetchedBranch = (await window.electron.ipcRenderer.invoke(
        "execute-git-command",
        `git -C "${repoPath}" rev-parse --abbrev-ref HEAD`
      )) as string

      let fetchedRemote = ""
      let hasFetchedRemote = false

      try {
        const remotesVerbose = (await window.electron.ipcRenderer.invoke(
          "execute-git-command",
          `git -C "${repoPath}" remote -v`
        )) as string

        if (remotesVerbose?.trim()) {
          const lines = remotesVerbose.trim().split("\n")
          const remoteMap = new Map<string, string>()

          for (const line of lines) {
            const parts = line.trim().split(/\s+/)
            if (parts.length >= 2) {
              remoteMap.set(parts[0], parts[1])
            }
          }

          const firstRemote = Array.from(remoteMap.values())[0]
          if (firstRemote) {
            fetchedRemote = firstRemote
            hasFetchedRemote = true
          }
        }
      } catch (error) {
        console.warn("Failed to get remotes:", error)
      }

      const status = (await window.electron.ipcRenderer.invoke(
        "execute-git-command",
        `git -C "${repoPath}" status --porcelain`
      )) as string

      setGitRepoPath(repoPath)
      setGitInfo({
        branch: fetchedBranch?.trim() || "",
        remote: fetchedRemote,
        hasRemote: hasFetchedRemote,
        status: status?.trim() || ""
      })

      return repoPath
    } catch (error) {
      console.error("获取Git信息失败:", error)
      setGitInfo((prev) => ({
        branch: prev.branch || branch || "unknown",
        remote: prev.remote || remoteUrl || "",
        hasRemote: prev.hasRemote || Boolean(remoteUrl),
        status: prev.status || ""
      }))
      return null
    }
  }, [primaryFilePath, workspacePath, branch, remoteUrl])

  const buildCommandItems = useCallback(
    (repoPath: string) => {
      const addCommand =
        isSingleFileMode && primaryFilePath
          ? `git -C "${repoPath}" add "${primaryFilePath}"`
          : `git -C "${repoPath}" add .`

      const commitCommand = `git -C "${repoPath}" commit -m "${cardNumber.trim()} #comment fix: ${commitMessage.trim()} #CMBDevClaw"`

      const commandItems: Array<{ command: string; description: string }> = [
        {
          command: addCommand,
          description: isSingleFileMode ? "添加当前文件到暂存区" : "添加所有修改的文件到暂存区"
        },
        {
          command: commitCommand,
          description: "提交更改并添加提交信息"
        }
      ]

      if (hasRemote) {
        commandItems.push({
          command: `git -C "${repoPath}" push`,
          description: `推送到远程仓库 (${effectiveRemote})`
        })
      }

      return commandItems
    },
    [isSingleFileMode, primaryFilePath, cardNumber, commitMessage, hasRemote, effectiveRemote]
  )

  // 当props中的commitmessage变化时，更新本地状态
  useEffect(() => {
    if (commitmessage?.trim()) {
      setCommitMessage(commitmessage)
      return
    }

    setCommitMessage((prev) => {
      if (prev.trim()) {
        return prev
      }

      if (isSingleFileMode && primaryFilePath) {
        const fileName = primaryFilePath.split("/").pop() || primaryFilePath
        const actionText = operation === "edit_file" ? "更新" : "创建"
        return `${actionText}: ${fileName}`
      }

      const actionText = operation === "edit_file" ? "更新" : "创建"
      return `${actionText}: 批量文件提交`
    })
  }, [commitmessage, isSingleFileMode, primaryFilePath, operation])

  useEffect(() => {
    if (workspacePath?.trim()) {
      setGitRepoPath(workspacePath.trim())
    }
  }, [workspacePath])

  useEffect(() => {
    // 检查当前操作是否已经提交过
    const isCurrentOpCommitted = GitCommitTracker.hasCommittedOperation(currentOperationId)
    setIsCurrentOperationCommitted(isCurrentOpCommitted)

    // 单文件模式下兼容历史记录提示
    if (isSingleFileMode && primaryFilePath) {
      const hasFileHistory = GitCommitTracker.hasCommittedFile(primaryFilePath, operation)
      setHasFileCommitHistory(hasFileHistory)
      setLatestCommitRecord(
        hasFileHistory ? GitCommitTracker.getLatestCommitRecord(primaryFilePath, operation) : null
      )
    } else {
      setHasFileCommitHistory(false)
      setLatestCommitRecord(null)
    }

    // 清理过期记录
    GitCommitTracker.cleanupExpiredRecords()
  }, [operation, currentOperationId, isSingleFileMode, primaryFilePath])

  useEffect(() => {
    if (!showGitOptions) {
      return
    }

    if (!gitRepoPath || !effectiveBranch) {
      void fetchGitInfo()
    }
  }, [showGitOptions, gitRepoPath, effectiveBranch, fetchGitInfo])

  const toggleDiffExpansion = (index: number) => {
    setExpandedDiffs((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(index)) {
        newSet.delete(index)
      } else {
        newSet.add(index)
      }
      return newSet
    })
  }

  const handleShowGitOptions = async () => {
    setShowGitOptions(true)
    await fetchGitInfo()
  }

  const handleHideGitOptions = () => {
    setShowGitOptions(false)
    setExecutionResult(null)
    setCurrentStep(0)
    setShowCommandPreview(false)
  }

  const generateCommandPreview = async () => {
    try {
      let repoPath = gitRepoPath.trim()
      if (!repoPath) {
        repoPath = (await fetchGitInfo()) || ""
      }

      if (!repoPath) {
        setExecutionResult({ success: false, output: "无法确定Git仓库路径" })
        return
      }

      const commands = buildCommandItems(repoPath)
      setPreviewCommands(commands)
      setShowCommandPreview(true)
      setConfirmedCommands(new Set())
    } catch (error) {
      console.error("无法生成命令预览:", error)
      setExecutionResult({ success: false, output: "无法生成命令预览" })
    }
  }

  const handleCopyWorkflowHint = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(workflowHintText)
    } catch {
      const textarea = document.createElement("textarea")
      textarea.value = workflowHintText
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand("copy")
      document.body.removeChild(textarea)
    }

    setIsWorkflowHintCopied(true)
    window.setTimeout(() => {
      setIsWorkflowHintCopied(false)
    }, 1500)
  }, [workflowHintText])

  const executeGitCommands = async () => {
    setIsExecuting(true)
    setExecutionResult(null)

    try {
      let repoPath = gitRepoPath.trim()
      if (!repoPath) {
        repoPath = (await fetchGitInfo()) || ""
      }

      if (!repoPath) {
        setExecutionResult({ success: false, output: "无法确定Git仓库路径" })
        return
      }

      const commandItems = buildCommandItems(repoPath)
      const commands = commandItems.map((item) => item.command)

      setExecutingCommands(commands)

      let commitHash = ""

      for (let i = 0; i < commands.length; i++) {
        setCurrentStep(i)
        try {
          const result = await window.electron.ipcRenderer.invoke(
            "execute-git-command",
            commands[i]
          )
          console.log(`Git命令执行成功: ${commands[i]}`, result)

          // 如果是commit命令，尝试获取commit hash
          if (i === 1 && result) {
            try {
              const hashResult = await window.electron.ipcRenderer.invoke(
                "execute-git-command",
                `git -C "${repoPath}" rev-parse HEAD`
              )
              if (hashResult && typeof hashResult === "string") {
                commitHash = hashResult.trim().substring(0, 7)
              }
            } catch (hashError) {
              console.warn("Failed to get commit hash:", hashError)
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          setExecutionResult({ success: false, output: errorMessage })
          console.error(`Git命令执行失败: ${commands[i]}`, error)
          return
        }
      }

      setExecutionResult({ success: true, output: "所有Git命令执行成功" })

      const commitFilePath = isSingleFileMode && primaryFilePath ? primaryFilePath : "all_files"
      GitCommitTracker.recordCommit(
        currentOperationId,
        commitFilePath,
        operation,
        commitMessage.trim(),
        cardNumber.trim(),
        commitHash
      )

      try {
        await uploadCommitData(threadId || currentOperationId, {
          remoteUrl: effectiveRemote || "",
          branch: effectiveBranch || "",
          commitMessage: commitMessage.trim(),
          changedFiles: normalizedChangedFiles,
          workspacePath: repoPath,
          commands,
          commitHash
        })
      } catch (uploadError) {
        console.warn("[Upload] 提交数据上报失败:", uploadError)
      }

      setIsCurrentOperationCommitted(true)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error("执行Git命令时发生错误:", error)
      setExecutionResult({
        success: false,
        output: errorMessage
      })

      if (operationId && operationId.startsWith("git_workflow_")) {
        try {
          await window.electron.ipcRenderer.invoke(
            "complete-git-workflow",
            operationId,
            false,
            `执行Git命令时发生错误: ${errorMessage}`
          )
          console.log("通知Git工具操作失败:", operationId, errorMessage)
        } catch (notifyError) {
          console.warn("通知Git工具失败:", notifyError)
        }
      }
    } finally {
      setIsExecuting(false)
      setCurrentStep(0)
    }
  }

  // 如果当前操作已提交，显示已提交状态
  if (isCurrentOperationCommitted) {
    const currentRecord = GitCommitTracker.getOperationCommitRecord(currentOperationId)

    if (currentRecord) {
      return (
        <div className="flex items-start gap-2 p-2 bg-green-50/90 dark:bg-green-950/90 border border-green-200 dark:border-green-800 rounded">
          <Check className="size-4 text-green-600 dark:text-green-400 mt-0.5" />
          <div className="flex-1 text-xs">
            <div className="font-medium text-green-800 dark:text-green-200">
              本次操作已提交到Git
            </div>
            <div className="text-green-700 dark:text-green-300 mt-1 space-y-1">
              <div className="flex items-center gap-2">
                <GitBranch className="size-3" />
                <span>
                  分支:{" "}
                  <span className="font-mono font-medium">{effectiveBranch || "unknown"}</span>
                </span>
              </div>
              <div className="flex items-center gap-2">
                <FileText className="size-3" />
                <span>
                  修改文件: <span className="font-medium">{displayFileCount || 1} 个</span>
                </span>
              </div>
              <div>提交信息: {currentRecord.commitMessage}</div>
              {currentRecord.cardNumber && <div>卡片编号: {currentRecord.cardNumber}</div>}
              {currentRecord.commitHash && (
                <div className="font-mono">提交哈希: {currentRecord.commitHash}</div>
              )}
              <div className="flex items-center gap-1">
                <Clock className="size-3" />
                <span>{new Date(currentRecord.timestamp).toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>
      )
    }
  }

  // 没有变更时提示无需提交
  if (!isCurrentOperationCommitted && normalizedChangedFiles.length === 0) {
    return (
      <div className="flex items-start gap-2 p-2 bg-muted/50 border border-border rounded">
        <Check className="size-4 text-muted-foreground mt-0.5" />
        <div className="flex-1 text-xs">
          <div className="font-medium text-muted-foreground">本目录下没有文件改动，无需提交</div>
          <div className="text-muted-foreground/70 mt-1">
            当前没有检测到任何文件变更，无需执行 Git 提交操作。
          </div>
        </div>
      </div>
    )
  }

  if (!showGitOptions) {
    return (
      <div className="flex items-start gap-2 p-2 bg-blue-50/90 dark:bg-blue-950/90 border border-blue-200 dark:border-blue-800 rounded">
        <GitBranch className="size-4 text-blue-600 dark:text-blue-400 mt-0.5" />
        <div className="flex-1 text-xs">
          <div className="font-medium text-blue-800 dark:text-blue-200">
            文件已{operation === "edit_file" ? "修改" : "创建"}
          </div>
          <div className="text-blue-700 dark:text-blue-300 mt-1">
            <span>是否要提交到Git？</span>
            {isSingleFileMode && (
              <span className="inline-flex items-center gap-1">
                <span>（你也可以最后告诉大模型“{workflowHintText}”进行批量提交）</span>
                <button
                  type="button"
                  onClick={handleCopyWorkflowHint}
                  title={isWorkflowHintCopied ? "已复制" : "复制指令"}
                  className="inline-flex items-center justify-center text-blue-700/80 hover:text-blue-900 dark:text-blue-300/80 dark:hover:text-blue-100 transition-colors"
                >
                  {isWorkflowHintCopied ? (
                    <Check className="size-3 text-status-nominal" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </button>
                {isWorkflowHintCopied && (
                  <span className="text-[10px] text-status-nominal">已复制</span>
                )}
              </span>
            )}
          </div>

          {hasFileCommitHistory && latestCommitRecord && (
            <div className="text-blue-600 dark:text-blue-400 mt-1 text-[10px]">
              💡 此文件已有提交记录: {latestCommitRecord.commitMessage}(
              {new Date(latestCommitRecord.timestamp).toLocaleString()})
            </div>
          )}

          <div className="flex gap-2 mt-2">
            <button
              onClick={handleShowGitOptions}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              <GitBranch className="size-3" />
              提交到Git
            </button>
            <button
              onClick={() => {
                if (onSkip) {
                  onSkip()
                }
              }}
              className="px-2 py-1 text-xs border border-blue-200 dark:border-blue-700 rounded hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors"
            >
              暂时跳过
            </button>
          </div>
        </div>
      </div>
    )
  }

  const addLabel = isSingleFileMode ? "添加文件到暂存区" : "添加所有文件到暂存区"
  const addFallbackCommand =
    isSingleFileMode && primaryFilePath
      ? `git -C "${gitRepoPath}" add "${primaryFilePath}"`
      : `git -C "${gitRepoPath}" add .`

  return (
    <div className="space-y-3 border border-border rounded p-3 bg-background-elevated">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-status-info" />
          <span className="text-sm font-medium">Git 提交</span>
          <Badge variant="outline" className="text-xs">
            {isSingleFileMode ? primaryFilePath.split("/").pop() || primaryFilePath : "所有文件"}
          </Badge>
        </div>

        {normalizedChangedFiles.length > 0 && (
          <div className="space-y-2">
            <button
              onClick={() => setShowChangedFiles(!showChangedFiles)}
              className="flex my-4 items-center text-sm gap-2 font-medium text-status-info hover:text-status-info/80 transition-colors"
            >
              {showChangedFiles ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
              <FileText className="size-4" />
              本目录下修改的文件 ({normalizedChangedFiles.length})
            </button>

            <div className="text-xs text-muted-foreground bg-background/50 border border-border/40 rounded px-2 py-1">
              仅会提交本目录下修改的文件，不会提交其他目录的文件。
            </div>

            {showChangedFiles && (
              <div className="space-y-4 pl-4 border-l border-border/50">
                {normalizedChangedFiles.map((file, index) => {
                  const oldContent = getFileOldContent(file)
                  const newContent = getFileNewContent(file)
                  const hasDiffData =
                    oldContent !== undefined || newContent !== undefined || Boolean(file.diff)

                  return (
                    <div
                      key={index}
                      className="space-y-1 px-3 py-2 border border-border/30 rounded-md bg-background/30"
                    >
                      <div className="flex justify-between text-xs border-b border-border/20">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium text-foreground">{file.path}</span>
                        </div>

                        {hasDiffData && (
                          <button
                            onClick={() => toggleDiffExpansion(index)}
                            className="ml-4 w-[100px] flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                          >
                            变更详情
                            {expandedDiffs.has(index) ? (
                              <ChevronDown className="size-3" />
                            ) : (
                              <ChevronRight className="size-3" />
                            )}
                          </button>
                        )}
                      </div>

                      {hasDiffData ? (
                        <div className="space-y-2">
                          {expandedDiffs.has(index) && (
                            <div className="rounded border border-border/30 overflow-hidden">
                              <DiffDisplay
                                diff={file.diff}
                                oldValue={oldContent}
                                newValue={newContent}
                              />
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="space-y-2">
                          <div className="text-xs text-muted-foreground italic py-2">
                            文件变更检测中 - 差异信息暂时不可用
                          </div>
                          <div className="text-xs text-muted-foreground bg-background/50 p-2 rounded border border-border/20">
                            💡 这通常发生在：
                            <ul className="mt-1 ml-4 list-disc space-y-1">
                              <li>新创建的文件</li>
                              <li>二进制文件</li>
                              <li>文件路径包含特殊字符</li>
                              <li>Git状态解析问题</li>
                            </ul>
                            <div className="mt-2 text-xs">
                              文件路径:{" "}
                              <code className="bg-muted px-1 rounded text-foreground">
                                {file.path}
                              </code>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 text-xs bg-background/50 p-2 rounded border">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">分支:</span>
            <Badge variant="secondary" className="text-xs font-mono">
              {effectiveBranch || "unknown"}
            </Badge>
            {isBranchConfirmed ? (
              <button
                onClick={() => setIsBranchConfirmed(false)}
                disabled={isExecuting}
                className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border bg-status-nominal text-background border-status-nominal hover:bg-status-nominal/80 transition-colors"
              >
                <Check className="size-3" />
                分支已确认
              </button>
            ) : (
              <button
                onClick={() => setIsBranchConfirmed(true)}
                disabled={isExecuting}
                className="flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-amber-400 text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors"
              >
                <div className="size-3 rounded border border-current" />
                确认分支
              </button>
            )}
          </div>

          {hasRemote ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">远程:</span>
              <span className="font-mono text-xs truncate">{effectiveRemote}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">远程:</span>
              <Badge variant="warning" className="text-xs">
                未配置远程仓库
              </Badge>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">目录:</span>
            <span className="font-mono text-xs truncate">
              {gitRepoPath || workspacePath || "unknown"}
            </span>
          </div>

          {statusFileCount > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">状态:</span>
              <span className="text-xs">{statusFileCount} 个文件有变更</span>
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium">
          <span className="text-red-500">*</span> 提交信息:
        </div>
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          disabled={isExecuting || showCommandPreview}
          placeholder="请输入提交信息..."
          className="w-full p-2 text-xs border border-border rounded resize-none"
          rows={2}
        />
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium">
          <span className="text-red-500">*</span> 卡片编号:
        </div>
        <input
          type="text"
          value={cardNumber}
          onChange={(e) => setCardNumber(e.target.value)}
          disabled={isExecuting || showCommandPreview}
          placeholder="请输入卡片编号， 案例：Z998877-12345"
          className="w-full p-2 text-xs border border-border rounded"
        />
      </div>

      <div className="space-y-2">
        {showCommandPreview && previewCommands.length > 0 && (
          <div className="bg-background/50 border border-border rounded p-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              即将执行的Git命令（请逐条确认无误）:
            </div>
            <div className="space-y-2">
              {previewCommands.map((cmd, index) => {
                const isConfirmed = confirmedCommands.has(index)
                return (
                  <div
                    key={index}
                    className={cn(
                      "space-y-1 border rounded p-2 transition-colors",
                      isConfirmed ? "border-status-nominal/40 bg-status-nominal/5" : "border-border"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium text-foreground">
                        {index + 1}. {cmd.description}
                      </div>
                      <button
                        onClick={() => {
                          setConfirmedCommands((prev) => {
                            const next = new Set(prev)
                            if (next.has(index)) {
                              next.delete(index)
                            } else {
                              next.add(index)
                            }
                            return next
                          })
                        }}
                        disabled={isExecuting}
                        className={cn(
                          "flex items-center gap-1 px-2 py-0.5 text-xs rounded border transition-colors shrink-0",
                          isConfirmed
                            ? "bg-status-nominal text-background border-status-nominal hover:bg-status-nominal/80"
                            : "border-border hover:bg-background-interactive"
                        )}
                      >
                        {isConfirmed ? (
                          <Check className="size-3" />
                        ) : (
                          <div className="size-3 rounded border border-current" />
                        )}
                        {isConfirmed ? "已确认" : "确认"}
                      </button>
                    </div>
                    <div className="bg-muted p-2 rounded">
                      <code className="text-xs font-mono text-foreground break-all">
                        {cmd.command}
                      </code>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="text-xs text-muted-foreground mt-2">
              {confirmedCommands.size < previewCommands.length
                ? `💡 还需确认 ${previewCommands.length - confirmedCommands.size} 条命令后才能提交`
                : "✅ 所有命令已确认，可以点击【确认提交】执行"}
            </div>
          </div>
        )}
      </div>

      {(isExecuting || executionResult) && (
        <div className="space-y-2">
          <div className="text-xs font-medium">执行进度:</div>
          <div className="space-y-1">
            {[
              {
                step: 0,
                label: addLabel,
                command: executingCommands[0] ?? addFallbackCommand,
                info:
                  isSingleFileMode && primaryFilePath
                    ? `将 ${primaryFilePath.split("/").pop() || primaryFilePath} 添加到暂存区`
                    : "将所有修改的文件添加到暂存区"
              },
              {
                step: 1,
                label: "提交更改",
                command: executingCommands[1] ?? `git commit -m "..."`,
                info: `分支: ${effectiveBranch || "unknown"} | 信息: ${commitMessage.trim()}`
              },
              ...(hasRemote
                ? [
                    {
                      step: 2,
                      label: "推送到远程仓库",
                      command: executingCommands[2] ?? `git -C "${gitRepoPath}" push`,
                      info: `推送到 ${
                        effectiveRemote
                          ? effectiveRemote.split("/").pop()?.replace(".git", "")
                          : "origin"
                      } / ${effectiveBranch || "main"}`
                    }
                  ]
                : [])
            ].map(({ step, label, command, info }) => (
              <div
                key={step}
                className={cn(
                  "flex flex-col gap-1 p-2 rounded text-xs border",
                  currentStep === step && isExecuting && "bg-status-info/10 border-status-info/20",
                  currentStep > step && "bg-status-nominal/10 border-status-nominal/20",
                  currentStep < step && "bg-background border-border/50"
                )}
              >
                <div className="flex items-center gap-2">
                  {currentStep > step ? (
                    <Check className="size-3 text-status-nominal" />
                  ) : currentStep === step && isExecuting ? (
                    <div className="size-3 border border-status-info rounded-full border-t-transparent animate-spin" />
                  ) : (
                    <div className="size-3 rounded-full border border-border" />
                  )}
                  <div className="flex-1">
                    <div className="font-medium">{label}</div>
                    <div className="font-mono text-muted-foreground text-[10px]">{command}</div>
                  </div>
                  {currentStep === step && isExecuting && (
                    <Badge variant="outline" className="animate-pulse">
                      执行中
                    </Badge>
                  )}
                  {currentStep > step && <Badge variant="nominal">完成</Badge>}
                </div>
                <div className="text-[10px] text-muted-foreground ml-5 pl-1 border-l border-border/30">
                  {info}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {executionResult && (
        <div className="space-y-2">
          <div
            className={cn(
              "p-2 rounded text-xs border",
              executionResult.success
                ? "bg-status-nominal/10 border-status-nominal/20 text-status-nominal"
                : "bg-status-critical/10 border-status-critical/20 text-status-critical"
            )}
          >
            <div className="flex items-center gap-2 font-medium">
              {executionResult.success ? <Check className="size-3" /> : <X className="size-3" />}
              {executionResult.success ? "Git提交成功" : "Git提交失败"}
            </div>
            {executionResult.output && (
              <pre className="mt-1 text-xs whitespace-pre-wrap">{executionResult.output}</pre>
            )}
            {executionResult.success && (
              <div className="mt-2 text-[10px] text-status-nominal/70">
                ✓ {isSingleFileMode ? "文件" : "所有文件"}已添加到Git历史记录
                {hasRemote && " ✓ 更改已推送到远程仓库"}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        {!showCommandPreview && (
          <button
            onClick={generateCommandPreview}
            disabled={
              isExecuting ||
              !commitMessage.trim() ||
              !cardNumber.trim() ||
              !isBranchConfirmed ||
              executionResult?.success === true
            }
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-status-nominal text-background rounded hover:bg-status-nominal/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <CheckCircle className="size-3" />
            编辑完成
          </button>
        )}

        {showCommandPreview && (
          <button
            onClick={executeGitCommands}
            disabled={
              isExecuting ||
              !commitMessage.trim() ||
              !cardNumber.trim() ||
              previewCommands.length === 0 ||
              confirmedCommands.size < previewCommands.length ||
              executionResult?.success === true
            }
            className="flex items-center gap-1 px-3 py-1.5 text-xs bg-status-nominal text-background rounded hover:bg-status-nominal/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Play className="size-3" />
            {isExecuting ? "提交中..." : executionResult?.success ? "已提交" : "确认提交"}
          </button>
        )}

        <button
          onClick={handleHideGitOptions}
          disabled={isExecuting}
          className="px-3 py-1.5 text-xs border border-border rounded hover:bg-background-interactive disabled:opacity-50 transition-colors"
        >
          {executionResult ? "关闭" : "取消"}
        </button>

        {!hasRemote && <span className="text-xs text-amber-600">⚠️ 仅本地提交 (无远程仓库)</span>}

        {!isBranchConfirmed && <span className="text-xs text-amber-600">⚠️ 请先核对分支</span>}

        {showCommandPreview && confirmedCommands.size < previewCommands.length && (
          <span className="text-xs text-blue-600">💡 请逐条确认所有Git命令后再提交</span>
        )}
      </div>
    </div>
  )
}
