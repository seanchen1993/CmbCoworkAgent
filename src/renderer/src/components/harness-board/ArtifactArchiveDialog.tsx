import { useEffect, useState } from "react"
import { Archive, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { KnowledgeBaseSelector } from "./KnowledgeBaseSelector"
import type { HarnessArchiveArtifactsOptions } from "../../../../shared/harness-board-types"
import type { KnowledgeBaseListItem } from "../../../../shared/knowledge-base-types"

interface ArchiveDialogProps {
  projectId: string
  slug: string
  knowledgeBases: KnowledgeBaseListItem[]
  formatError: (error: unknown) => string
  onArchived: (knowledgeBaseId: string) => void
}

function toggleSelection(values: Set<string>, value: string): Set<string> {
  const next = new Set(values)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  return next
}

export function ArtifactArchiveDialog({
  disabled,
  ...props
}: ArchiveDialogProps & { disabled: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" disabled={disabled}>
          <Archive className="size-4" />
          产物归档
        </Button>
      </DialogTrigger>
      {open && (
        <ArtifactArchiveForm
          {...props}
          submitting={submitting}
          onSubmittingChange={setSubmitting}
          onClose={() => setOpen(false)}
        />
      )}
    </Dialog>
  )
}

function ArtifactArchiveForm({
  projectId,
  slug,
  knowledgeBases,
  formatError,
  onArchived,
  submitting,
  onSubmittingChange,
  onClose
}: ArchiveDialogProps & {
  submitting: boolean
  onSubmittingChange: (submitting: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const [options, setOptions] = useState<HarnessArchiveArtifactsOptions | null>(null)
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([])
  const [artifactPaths, setArtifactPaths] = useState(() => new Set<string>())
  const [deployUnitIds, setDeployUnitIds] = useState(() => new Set<string>())
  const [loadError, setLoadError] = useState("")
  const [submitError, setSubmitError] = useState("")
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.harnessBoard.getArchiveArtifactsOptions(projectId, slug).then(
      (result) => {
        if (cancelled) return
        setOptions(result)
        setDeployUnitIds(new Set(result.defaultDeployUnitIds))
      },
      (error) => {
        if (!cancelled) setLoadError(formatError(error))
      }
    )
    return () => {
      cancelled = true
    }
  }, [projectId, slug, formatError])

  const writableKnowledgeBases = knowledgeBases.filter((item) =>
    item.workspaces.some(
      (workspace) => workspace.role === "write" && workspace.localValid && !workspace.syncing
    )
  )
  const knowledgeBaseId = knowledgeBaseIds[0]
  const canSubmit =
    Boolean(options) &&
    writableKnowledgeBases.some((item) => item.idKey === knowledgeBaseId) &&
    artifactPaths.size > 0 &&
    !submitting

  async function submit(): Promise<void> {
    if (!canSubmit) return
    onSubmittingChange(true)
    setSubmitError("")
    try {
      await window.api.harnessBoard.archiveArtifacts({
        projectId,
        slug,
        knowledgeBaseId,
        artifactPaths: [...artifactPaths],
        deployUnitIds: [...deployUnitIds]
      })
      onClose()
      onArchived(knowledgeBaseId)
    } catch (error) {
      setSubmitError(formatError(error))
    } finally {
      onSubmittingChange(false)
    }
  }

  return (
    <DialogContent
      ref={setPortalContainer}
      aria-describedby={undefined}
      className="z-[60] max-w-xl"
    >
      <DialogHeader>
        <DialogTitle>产物归档</DialogTitle>
      </DialogHeader>
      <div className="max-h-[65vh] space-y-4 overflow-y-auto">
        <KnowledgeBaseSelector
          items={writableKnowledgeBases}
          selectedIds={knowledgeBaseIds}
          supportsKnowledgeBaseContext
          disabled={submitting}
          portalContainer={portalContainer}
          placeholder="请选择产物归档目标知识库"
          onChange={setKnowledgeBaseIds}
        />
        {loadError && (
          <p role="alert" className="text-sm text-status-critical">
            {loadError}
          </p>
        )}
        {!options && !loadError && (
          <p role="status" className="text-sm">
            正在加载产物和发布单元…
          </p>
        )}
        {options && (
          <>
            <fieldset disabled={submitting} className="space-y-2">
              <legend className="text-sm font-medium">产物</legend>
              {options.artifacts.length === 0 && (
                <p className="text-sm text-muted-foreground">暂无可归档产物</p>
              )}
              <ScrollArea
                type="auto"
                className="rounded-md [&>[data-radix-scroll-area-viewport]]:max-h-48"
              >
                {options.artifacts.map(({ path, label }) => (
                  <label
                    key={path}
                    className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={artifactPaths.has(path)}
                      onChange={() => setArtifactPaths((values) => toggleSelection(values, path))}
                    />
                    <span className="min-w-0">
                      <span className="block break-words text-sm">{label}</span>
                      <span className="block break-all text-xs text-muted-foreground">{path}</span>
                    </span>
                  </label>
                ))}
              </ScrollArea>
            </fieldset>
            <fieldset disabled={submitting} className="space-y-2">
              <legend className="text-sm font-medium">发布单元</legend>
              <ScrollArea
                type="auto"
                className="rounded-md [&>[data-radix-scroll-area-viewport]]:max-h-32"
              >
                {options.deployUnits.map((unit) => (
                  <label
                    key={unit.deployUnitId}
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      checked={deployUnitIds.has(unit.deployUnitId)}
                      onChange={() =>
                        setDeployUnitIds((values) => toggleSelection(values, unit.deployUnitId))
                      }
                    />
                    <span className="min-w-0 break-words">
                      {unit.deployUnitId}
                      {unit.description && ` · ${unit.description}`}
                    </span>
                  </label>
                ))}
              </ScrollArea>
            </fieldset>
          </>
        )}
        {submitError && (
          <p role="alert" className="break-words text-sm text-status-critical">
            {submitError}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
          取消
        </Button>
        <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {submitting ? "正在归档" : "确认归档"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
