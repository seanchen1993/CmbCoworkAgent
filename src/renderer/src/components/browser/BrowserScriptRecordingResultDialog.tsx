import { Download, FileCode2, Loader2, Save, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { BrowserScriptEditor } from "./BrowserScriptEditor"
import type {
  BrowserRecordedAction,
  BrowserRecordingSession
} from "../../../../shared/browser-types"

interface BrowserScriptRecordingResultDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scriptRecording: BrowserRecordingSession
  recordingLabel: string
  selectedActionIds: string[]
  onToggleActionSelection: (actionId: string) => void
  variableActionIds: string[]
  onToggleActionVariable: (actionId: string) => void
  variableActionNames: Record<string, string>
  onVariableActionNameChange: (actionId: string, value: string) => void
  draftScript: string
  onDraftScriptChange: (value: string) => void
  isDraftDirty: boolean
  canSaveDraft: boolean
  isDraftSaveSubmitting: boolean
  onSaveDraft: () => void
  saveDisplayName: string
  onSaveDisplayNameChange: (value: string) => void
  isSaveSubmitting: boolean
  hasWorkspace: boolean
  hasUnnamedVariableActions: boolean
  onConfirmSave: () => void
}

function describeScriptRecordedAction(action: BrowserRecordedAction): string {
  switch (action.kind) {
    case "navigate":
      return `打开页面 ${action.url}`
    case "click":
      return action.doubleClick
        ? `双击 ${action.target || "目标元素"}`
        : `点击 ${action.target || "目标元素"}`
    case "fill":
      return action.sensitive
        ? `填写 ${action.target || "输入框"}（敏感值已脱敏）`
        : `填写 ${action.target || "输入框"} = ${action.value || "(空值)"}`
    case "selectOption":
      return `在 ${action.target || "下拉框"} 中选择 ${action.values.join(", ") || "(空值)"}`
    case "fileUpload":
      return action.paths.length > 0 ? `上传文件 ${action.paths.join(", ")}` : "取消文件选择"
    case "press":
      return action.target ? `在 ${action.target} 上按下 ${action.key}` : `按下 ${action.key}`
  }
}

function describeScriptRecordedActionKind(kind: BrowserRecordedAction["kind"]): string {
  switch (kind) {
    case "navigate":
      return "导航"
    case "click":
      return "点击"
    case "fill":
      return "输入"
    case "selectOption":
      return "选择"
    case "fileUpload":
      return "上传"
    case "press":
      return "按键"
  }
}

function getScriptRecordedActionTone(kind: BrowserRecordedAction["kind"]): string {
  switch (kind) {
    case "navigate":
      return "border-status-info/25 bg-status-info/10 text-status-info"
    case "click":
      return "border-primary/25 bg-primary/10 text-foreground"
    case "fill":
      return "border-status-warning/25 bg-status-warning/10 text-status-warning"
    case "selectOption":
      return "border-status-nominal/25 bg-status-nominal/10 text-status-nominal"
    case "fileUpload":
      return "border-status-info/25 bg-status-info/10 text-status-info"
    case "press":
      return "border-border/70 bg-background/80 text-muted-foreground"
  }
}

function canScriptRecordedActionUseVariable(action: BrowserRecordedAction): boolean {
  switch (action.kind) {
    case "navigate":
    case "fill":
    case "selectOption":
    case "fileUpload":
      return true
    case "click":
      return Boolean(
        action.locator?.textContent ??
        action.locator?.accessibleName ??
        action.locator?.label ??
        action.locator?.placeholder ??
        action.locator?.target ??
        action.target
      )
    default:
      return false
  }
}

export function BrowserScriptRecordingResultDialog({
  open,
  onOpenChange,
  scriptRecording,
  recordingLabel,
  selectedActionIds,
  onToggleActionSelection,
  variableActionIds,
  onToggleActionVariable,
  variableActionNames,
  onVariableActionNameChange,
  draftScript,
  onDraftScriptChange,
  isDraftDirty,
  canSaveDraft,
  isDraftSaveSubmitting,
  onSaveDraft,
  saveDisplayName,
  onSaveDisplayNameChange,
  isSaveSubmitting,
  hasWorkspace,
  hasUnnamedVariableActions,
  onConfirmSave
}: BrowserScriptRecordingResultDialogProps): React.JSX.Element {
  const actionCount = scriptRecording.actions.length
  const scriptReady = draftScript.trim().length > 0
  const scriptLineCount = scriptReady ? draftScript.split(/\r?\n/).length : 0
  const showDraftSaveControls = scriptRecording.status === "paused"
  const showExistingLibraryUpdateControls =
    scriptRecording.status === "completed" && Boolean(scriptRecording.libraryFileName?.trim())
  const showLibrarySaveControls =
    scriptRecording.status === "completed" && !showExistingLibraryUpdateControls
  const baseSaveDisabled = !scriptReady || isSaveSubmitting || hasUnnamedVariableActions
  const saveDisabled = !saveDisplayName.trim() || !hasWorkspace || baseSaveDisabled
  const statusBadge =
    scriptRecording.status === "recording"
      ? {
          label: "录制中",
          variant: "info" as const
        }
      : scriptRecording.status === "paused"
        ? {
            label: "已暂停",
            variant: "warning" as const
          }
        : actionCount > 0 || scriptReady
          ? {
              label: "已生成",
              variant: "nominal" as const
            }
          : {
              label: "就绪",
              variant: "outline" as const
            }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-[1300px] gap-0 overflow-hidden border-border/70 p-0 shadow-2xl">
        <DialogHeader className="gap-3 border-b border-border/70 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--primary)_9%,transparent),transparent)] px-5 py-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                  <Sparkles className="size-4" strokeWidth={1.9} />
                </div>
                <div className="min-w-0">
                  <DialogTitle className="text-base">录制脚本结果</DialogTitle>
                  <DialogDescription className="mt-1 text-[12px] leading-5">
                    {scriptRecording.status === "recording"
                      ? "你在内置浏览器里的真实操作会实时沉淀为 Playwright 草稿。"
                      : scriptRecording.status === "paused"
                        ? "当前录制已暂停，你可以继续录制、终止录制，或先检查当前脚本草稿。"
                        : `下面是最近一次${recordingLabel}生成的步骤和 Playwright 脚本初稿。`}
                  </DialogDescription>
                </div>
              </div>
            </div>

            <div className="mr-8 flex flex-wrap items-center gap-2">
              <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
              <span className="inline-flex items-center rounded-full border border-border/70 bg-background/80 px-2 py-1 text-[11px] text-muted-foreground">
                <span className="mr-1 font-medium text-foreground">{actionCount}</span>
                个步骤
              </span>
              <span className="inline-flex items-center rounded-full border border-border/70 bg-background/80 px-2 py-1 text-[11px] text-muted-foreground">
                <span className="mr-1 font-medium text-foreground">{scriptLineCount}</span>
                行脚本
              </span>
            </div>
          </div>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 bg-background md:grid-cols-[300px_minmax(0,1fr)]">
          <div className="border-b border-border/70 bg-muted/20 md:border-b-0 md:border-r">
            <div className="border-b border-border/70 px-4 py-3">
              <p className="text-sm font-medium text-foreground">步骤列表</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                共 {actionCount}{" "}
                步，默认全选；导航、输入、选择、上传和点击文本步骤可标记为变量，并手动填写变量名。
              </p>
            </div>
            <div className="max-h-[58vh] space-y-2.5 overflow-auto px-3 py-3">
              {scriptRecording.actions.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border/80 bg-background/90 px-4 py-5 text-[12px] leading-5 text-muted-foreground shadow-sm">
                  <div className="mb-3 flex size-9 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
                    <Sparkles className="size-4" strokeWidth={1.8} />
                  </div>
                  还没有采集到可生成脚本的操作。先开始录制脚本，再在内置浏览器里手动导航、点击、输入或选择。
                </div>
              ) : (
                scriptRecording.actions.map((action, index) => {
                  const isSelected = selectedActionIds.includes(action.id)
                  const canUseVariable = canScriptRecordedActionUseVariable(action)
                  const isVariable = variableActionIds.includes(action.id)
                  const variableName = variableActionNames[action.id] ?? ""
                  const hasVariableName = variableName.trim().length > 0

                  return (
                    <div
                      key={action.id}
                      className={cn(
                        "flex items-start gap-3 rounded-xl border px-3 py-3 transition-colors",
                        scriptRecording.status === "recording" &&
                          index === scriptRecording.actions.length - 1 &&
                          isSelected
                          ? "border-status-info/35 bg-status-info/10 shadow-sm"
                          : "border-gray-200 bg-background/90 hover:border-border-emphasis",
                        !isSelected && "opacity-55"
                      )}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <label className="flex min-w-0 cursor-pointer items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded-full border border-border/60 bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground/80">
                                Step {index + 1}
                              </span>
                              <span
                                className={cn(
                                  "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                                  getScriptRecordedActionTone(action.kind)
                                )}
                              >
                                {describeScriptRecordedActionKind(action.kind)}
                              </span>
                            </div>
                            <p className="mt-1.5 break-all text-[12px] leading-5 text-foreground/90">
                              {describeScriptRecordedAction(action)}
                            </p>
                          </div>
                          <span className="flex w-[50px] items-center space-x-2">
                            <span className="inline-block w-[30px] text-xs">使用</span>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => onToggleActionSelection(action.id)}
                              className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-border/80 text-primary focus:ring-primary"
                            />
                          </span>
                        </label>

                        {canUseVariable ? (
                          <div className="flex space-x-2 border-t pt-2">
                            <label
                              className={cn(
                                "flex h-[30px] shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                                isVariable
                                  ? "border-primary/35 bg-primary/10 text-primary"
                                  : "border-border/70 bg-background/70 text-muted-foreground hover:border-border-emphasis",
                                !isSelected && "cursor-not-allowed"
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={isVariable}
                                disabled={!isSelected}
                                onChange={() => onToggleActionVariable(action.id)}
                                className="size-3 shrink-0 cursor-pointer rounded border-border/80 text-primary focus:ring-primary disabled:cursor-not-allowed"
                              />
                              变量
                            </label>

                            {isVariable ? (
                              <div className="space-y-1">
                                <Input
                                  type="text"
                                  value={variableName}
                                  disabled={!isSelected}
                                  onChange={(event) =>
                                    onVariableActionNameChange(action.id, event.target.value)
                                  }
                                  placeholder="变量名，例如：用户名 / 分支名 / 流水线名称"
                                  className="h-8 rounded-lg border-border/80 bg-background text-xs shadow-none"
                                />
                                {!hasVariableName ? (
                                  <p className="text-[11px] text-status-warning">
                                    变量名必填，复制执行提示时会展示给用户。
                                  </p>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="border-b border-border/70 px-4 py-3">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <div className="flex size-8 items-center justify-center rounded-lg border border-slate-700/70 bg-slate-900 text-slate-200">
                      <FileCode2 className="size-4" strokeWidth={1.8} />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">Playwright 脚本</p>
                      <p className="mt-1 max-w-[200px] text-[11px] text-muted-foreground">
                        {showDraftSaveControls
                          ? `${recordingLabel}草稿支持直接编辑；暂停时可先保存草稿，后续继续录制会沿用当前内容。`
                          : showExistingLibraryUpdateControls
                            ? `${recordingLabel}终止后会直接保存到当前继续录制所基于的原脚本。`
                            : `${recordingLabel}草稿支持直接编辑；终止后可填写文件中文名并保存到录制列表。`}
                      </p>
                    </div>
                  </div>
                </div>

                {showExistingLibraryUpdateControls ? (
                  <div className="flex flex-1 items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/25 p-3 xl:max-w-[420px]">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">保存到原脚本</p>
                      <p className="mt-1 break-all text-[11px] text-muted-foreground">
                        {scriptRecording.libraryDisplayName?.trim() || "原脚本"}
                      </p>
                      <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground/90">
                        {scriptRecording.libraryFileName}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center justify-between gap-3">
                      <Button
                        type="button"
                        size="sm"
                        className="h-9 shrink-0 rounded-lg"
                        disabled={baseSaveDisabled}
                        onClick={onConfirmSave}
                      >
                        {isSaveSubmitting ? (
                          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                        ) : (
                          <Save className="size-3.5" strokeWidth={1.8} />
                        )}
                        保存
                      </Button>
                    </div>
                  </div>
                ) : null}

                {showLibrarySaveControls ? (
                  <div className="flex flex-1 gap-2 rounded-xl border border-border/70 bg-muted/25 p-3 xl:max-w-[360px]">
                    <Input
                      autoFocus
                      type="text"
                      value={saveDisplayName}
                      onChange={(event) => onSaveDisplayNameChange(event.target.value)}
                      placeholder="文件中文名（必填）"
                      className="h-9 rounded-lg border-border/80 bg-background text-xs shadow-none placeholder:text-muted-foreground/80"
                    />
                    <div className="flex items-center justify-between gap-3">
                      <Button
                        type="button"
                        size="sm"
                        className="h-9 shrink-0 rounded-lg"
                        disabled={saveDisabled}
                        onClick={onConfirmSave}
                      >
                        {isSaveSubmitting ? (
                          <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                        ) : (
                          <Download className="size-3.5" strokeWidth={1.8} />
                        )}
                        保存
                      </Button>
                    </div>
                    {!hasWorkspace ? (
                      <p className="text-[11px] text-status-warning">
                        当前会话还没有选择工作区，暂时无法保存。
                      </p>
                    ) : hasUnnamedVariableActions ? (
                      <p className="text-[11px] text-status-warning">
                        已勾选变量的步骤需要先填写变量名。
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {showDraftSaveControls ? (
                  <div className="flex flex-1 items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/25 p-3 xl:max-w-[360px]">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">当前草稿</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {isDraftDirty
                          ? "你修改过当前脚本，保存后继续录制会沿用这份内容。"
                          : "当前草稿已经保存，继续录制会沿用这份内容。"}
                      </p>
                    </div>
                    {canSaveDraft ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[10px]",
                            isDraftDirty
                              ? "border-status-warning/40 bg-status-warning/10 text-status-warning"
                              : "border-status-nominal/30 bg-status-nominal/10 text-status-nominal"
                          )}
                        >
                          {isDraftDirty ? "未保存" : "已保存"}
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          className="h-9 rounded-lg px-3 shadow-none"
                          disabled={!isDraftDirty || !scriptReady || isDraftSaveSubmitting}
                          onClick={onSaveDraft}
                        >
                          {isDraftSaveSubmitting ? (
                            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                          ) : (
                            <Save className="size-3.5" strokeWidth={1.8} />
                          )}
                          保存草稿
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="min-h-0 flex-1 p-4 pt-3">
              <BrowserScriptEditor
                className="h-full min-h-[420px]"
                contentClassName="h-[300px] min-h-[300px]"
                title={<span>playwright.spec.ts 草稿 (可编辑)</span>}
                value={draftScript}
                onChange={onDraftScriptChange}
                ariaLabel="Playwright 脚本草稿编辑器"
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
