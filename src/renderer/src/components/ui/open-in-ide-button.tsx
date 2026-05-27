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

const IDE_LABELS: Record<SupportedIde, string> = {
  idea: "IntelliJ IDEA",
  vscode: "VS Code",
  webstorm: "WebStorm"
}

function isSupportedIde(value: string): value is SupportedIde {
  return value === "idea" || value === "vscode" || value === "webstorm"
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
  const [opening, setOpening] = React.useState(false)
  const [preferredIde, setPreferredIde] = React.useState<SupportedIde | null>(null)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [selectedIde, setSelectedIde] = React.useState<SupportedIde>("vscode")
  const [loadingPreference, setLoadingPreference] = React.useState(true)

  const canOpen = !fileMissing && (Boolean(workspacePath) || isAbsolutePath(filePath))
  const hint = fileMissing
    ? "删除的文件无法打开"
    : opening
      ? "正在打开..."
      : "在本地 IDE 打开"

  React.useEffect(() => {
    let canceled = false
    void window.api.ide
      .getPreferred()
      .then((value) => {
        if (canceled) return
        setPreferredIde(value)
        if (value) setSelectedIde(value)
      })
      .catch((error) => {
        if (canceled) return
        console.error("[OpenInIdeButton] Failed to load preferred IDE:", error)
      })
      .finally(() => {
        if (!canceled) setLoadingPreference(false)
      })

    return () => {
      canceled = true
    }
  }, [])

  const openWithIde = React.useCallback(async (ide: SupportedIde): Promise<void> => {
    const resolvedWorkspacePath =
      workspacePath || (isAbsolutePath(filePath) ? resolveWorkspaceFilePath(filePath, workspacePath) : null)
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
  }, [filePath, line, onOpenEnd, onOpenError, onOpenStart, onOpenSuccess, workspacePath])

  const handleOpen = React.useCallback(async (): Promise<void> => {
    if (!canOpen || opening || loadingPreference) return
    if (!preferredIde) {
      setDialogOpen(true)
      return
    }
    await openWithIde(preferredIde)
  }, [canOpen, loadingPreference, openWithIde, opening, preferredIde])

  const handleConfirmPreferredIde = React.useCallback(async (): Promise<void> => {
    const saved = await window.api.ide.setPreferred(selectedIde)
    setPreferredIde(saved)
    setDialogOpen(false)
    if (saved) {
      await openWithIde(saved)
    }
  }, [openWithIde, selectedIde])

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
        disabled={!canOpen || opening || loadingPreference}
        aria-label={hint}
        align={align}
        stopPropagation={stopPropagation}
        onClick={() => {
          void handleOpen()
        }}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>选择默认 IDE</DialogTitle>
            <DialogDescription>首次使用时选择一个默认 IDE，后续会直接用它打开。</DialogDescription>
          </DialogHeader>

          <Select
            value={selectedIde}
            onValueChange={(value) => {
              if (isSupportedIde(value)) {
                setSelectedIde(value)
              }
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

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={opening}>
              取消
            </Button>
            <Button onClick={() => void handleConfirmPreferredIde()} disabled={opening}>
              保存并打开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export { OpenInIdeButton }
