import * as React from "react"
import { Loader2, SquareArrowOutUpRight } from "lucide-react"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"

function isAbsolutePath(filePath: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/)/.test(filePath)
}

function resolveWorkspaceFilePath(filePath: string, workspacePath: string | null): string {
  const input = filePath.trim().replace(/\\/g, "/")
  if (!workspacePath || isAbsolutePath(input)) return input
  const workspace = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "")
  return `${workspace}/${input.replace(/^\/+/, "")}`
}

type SupportedIde = "idea" | "vscode" | "webstorm"

type IdeSettings = {
  preferredIde: SupportedIde | null
  executablePaths: Partial<Record<SupportedIde, string>>
}

type ConfigurePreferredIdeResult = {
  status: "configured" | "needs_executable_path"
  settings: IdeSettings
  message?: string
}

const IDE_LABELS: Record<SupportedIde, string> = {
  idea: "IntelliJ IDEA",
  vscode: "VS Code",
  webstorm: "WebStorm"
}

const IDE_SETTINGS_EVENT = "cmb:ide-settings-changed"

const DEFAULT_IDE_SETTINGS: IdeSettings = {
  preferredIde: null,
  executablePaths: {}
}

let ideSettingsSnapshot: IdeSettings = DEFAULT_IDE_SETTINGS

function isSupportedIde(value: string): value is SupportedIde {
  return value === "idea" || value === "vscode" || value === "webstorm"
}

function normalizeIdeSettings(settings?: Partial<IdeSettings> | null): IdeSettings {
  return {
    preferredIde: settings?.preferredIde ?? null,
    executablePaths: settings?.executablePaths ?? {}
  }
}

function publishIdeSettings(settings: IdeSettings): void {
  ideSettingsSnapshot = normalizeIdeSettings(settings)
  window.dispatchEvent(
    new CustomEvent<IdeSettings>(IDE_SETTINGS_EVENT, { detail: ideSettingsSnapshot })
  )
}

function subscribeIdeSettings(callback: () => void): () => void {
  const handler = (): void => callback()
  window.addEventListener(IDE_SETTINGS_EVENT, handler)
  return () => window.removeEventListener(IDE_SETTINGS_EVENT, handler)
}

function getIdeSettingsSnapshot(): IdeSettings {
  return ideSettingsSnapshot
}

function useIdeSettings(): { settings: IdeSettings; loading: boolean } {
  const settings = React.useSyncExternalStore(
    subscribeIdeSettings,
    getIdeSettingsSnapshot,
    getIdeSettingsSnapshot
  )
  const [loading, setLoading] = React.useState(ideSettingsSnapshot === DEFAULT_IDE_SETTINGS)

  React.useEffect(() => {
    let cancelled = false

    void window.api.ide
      .getSettings()
      .then((value) => {
        if (cancelled) return
        publishIdeSettings(normalizeIdeSettings(value))
      })
      .catch((error) => {
        if (cancelled) return
        console.error("[OpenInIdeButton] Failed to load IDE settings:", error)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return { settings, loading }
}

type OpenInIdeButtonProps = {
  filePath: string
  workspacePath: string | null
  fileMissing?: boolean
  line?: number
  stopPropagation?: boolean
  align?: "start" | "center" | "end"
  onOpenStart?: () => void
  onOpenEnd?: () => void
  onOpenSuccess?: (result: {
    filePath: string
    ide: SupportedIde
    mode: "workspace+file+line" | "workspace+file" | "workspace"
  }) => void
  onOpenError?: (message: string) => void
}

function OpenInIdeButton({
  filePath,
  workspacePath,
  fileMissing = false,
  line,
  stopPropagation = false,
  align = "center",
  onOpenStart,
  onOpenEnd,
  onOpenSuccess,
  onOpenError
}: OpenInIdeButtonProps): React.JSX.Element {
  const { settings, loading } = useIdeSettings()
  const [opening, setOpening] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [selectedIde, setSelectedIde] = React.useState<SupportedIde>("vscode")
  const [manualExecutablePath, setManualExecutablePath] = React.useState("")
  const [pathInputVisible, setPathInputVisible] = React.useState(false)
  const [dialogMessage, setDialogMessage] = React.useState<string | null>(null)
  const preferredIde = settings.preferredIde

  const canOpen = !fileMissing && (Boolean(workspacePath) || isAbsolutePath(filePath))
  const hint = fileMissing ? "删除的文件无法打开" : opening ? "正在打开..." : "在本地 IDE 打开"

  React.useEffect(() => {
    if (preferredIde) {
      setSelectedIde(preferredIde)
      const savedPath = settings.executablePaths[preferredIde]
      if (savedPath) {
        setManualExecutablePath(savedPath)
      }
    }
  }, [preferredIde, settings.executablePaths])

  const openWithIde = React.useCallback(
    async (ide: SupportedIde): Promise<void> => {
      const resolvedWorkspacePath =
        workspacePath ||
        (isAbsolutePath(filePath) ? resolveWorkspaceFilePath(filePath, workspacePath) : null)
      if (!resolvedWorkspacePath) {
        onOpenError?.("当前没有可用的工作区路径，无法打开 IDE")
        return
      }

      setOpening(true)
      onOpenStart?.()

      try {
        const request = {
          ide,
          workspacePath: resolvedWorkspacePath,
          filePath: resolveWorkspaceFilePath(filePath, workspacePath),
          line
        }
        const result = await window.api.ide.open(request)
        onOpenSuccess?.({ filePath, ide, mode: result.mode })
      } catch (error) {
        onOpenError?.(error instanceof Error ? error.message : "打开文件失败")
      } finally {
        setOpening(false)
        onOpenEnd?.()
      }
    },
    [filePath, line, onOpenEnd, onOpenError, onOpenStart, onOpenSuccess, workspacePath]
  )

  const resetDialogState = React.useCallback((): void => {
    setPathInputVisible(false)
    setDialogMessage(null)
    const savedPath = settings.executablePaths[selectedIde]
    setManualExecutablePath(savedPath || "")
  }, [selectedIde, settings.executablePaths])

  const handleOpenDialog = React.useCallback((): void => {
    const currentIde = preferredIde || selectedIde
    setSelectedIde(currentIde)
    setManualExecutablePath(settings.executablePaths[currentIde] || "")
    setPathInputVisible(false)
    setDialogMessage(null)
    setDialogOpen(true)
  }, [preferredIde, selectedIde, settings.executablePaths])

  const handleOpen = React.useCallback(async (): Promise<void> => {
    if (!canOpen || opening || loading) return
    if (!preferredIde) {
      handleOpenDialog()
      return
    }
    if (!settings.executablePaths[preferredIde]) {
      handleOpenDialog()
      return
    }
    await openWithIde(preferredIde)
  }, [
    canOpen,
    handleOpenDialog,
    loading,
    openWithIde,
    opening,
    preferredIde,
    settings.executablePaths
  ])

  const applyConfigureResult = React.useCallback(
    (result: ConfigurePreferredIdeResult): void => {
      publishIdeSettings(result.settings)
      setDialogMessage(result.message || null)
      if (result.status === "needs_executable_path") {
        setPathInputVisible(true)
        setManualExecutablePath(
          result.settings.executablePaths[selectedIde] || manualExecutablePath
        )
        return
      }
      setDialogOpen(false)
      setPathInputVisible(false)
    },
    [manualExecutablePath, selectedIde]
  )

  const handleConfirmPreferredIde = React.useCallback(async (): Promise<void> => {
    const request = {
      preferredIde: selectedIde,
      executablePath: pathInputVisible ? manualExecutablePath.trim() : undefined
    }

    try {
      const result = await window.api.ide.configurePreferred(request)
      applyConfigureResult(result)
      if (result.status === "configured") {
        await openWithIde(selectedIde)
      }
    } catch (error) {
      setDialogMessage(error instanceof Error ? error.message : "保存 IDE 配置失败")
      setPathInputVisible(true)
    }
  }, [applyConfigureResult, manualExecutablePath, openWithIde, pathInputVisible, selectedIde])

  return (
    <>
      <IconPopoverButton
        icon={
          opening ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <SquareArrowOutUpRight className="size-3" />
          )
        }
        popoverContent={hint}
        disabled={!canOpen || opening || loading}
        aria-label={hint}
        align={align}
        stopPropagation={stopPropagation}
        onClick={() => {
          void handleOpen()
        }}
      />

      <Dialog
        open={dialogOpen}
        onOpenChange={(nextOpen) => {
          setDialogOpen(nextOpen)
          if (!nextOpen) resetDialogState()
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>选择默认 IDE</DialogTitle>
            <DialogDescription>
              {pathInputVisible
                ? "未找到 IDE 启动路径，请输入完整路径并保存。mac 可输入 .app，Windows/Linux 请输入可执行文件路径。"
                : "首次使用时选择一个默认 IDE。系统会先尝试自动查找其启动路径。"}
            </DialogDescription>
          </DialogHeader>

          <Select
            value={selectedIde}
            onValueChange={(value) => {
              if (!isSupportedIde(value)) return
              setSelectedIde(value)
              setManualExecutablePath(settings.executablePaths[value] || "")
              setPathInputVisible(false)
              setDialogMessage(null)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="选择默认 IDE" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="idea">{IDE_LABELS.idea}</SelectItem>
              <SelectItem value="vscode">{IDE_LABELS.vscode}</SelectItem>
              <SelectItem value="webstorm">{IDE_LABELS.webstorm}</SelectItem>
            </SelectContent>
          </Select>

          {pathInputVisible ? (
            <Input
              value={manualExecutablePath}
              onChange={(event) => setManualExecutablePath(event.target.value)}
              placeholder={
                window.electron.process.platform === "win32"
                  ? "例如 C:\\Program Files\\JetBrains\\WebStorm\\bin\\webstorm64.exe"
                  : window.electron.process.platform === "darwin"
                    ? "例如 /Applications/WebStorm.app"
                    : "输入 IDE 可执行文件完整路径"
              }
              autoFocus
            />
          ) : null}

          {dialogMessage ? <p className="text-sm text-muted-foreground">{dialogMessage}</p> : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={opening}>
              取消
            </Button>
            <Button
              onClick={() => void handleConfirmPreferredIde()}
              disabled={opening || (pathInputVisible && manualExecutablePath.trim().length === 0)}
            >
              保存并打开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export { OpenInIdeButton }
