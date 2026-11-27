import { useCallback, useRef, useState } from "react"
import { FolderOpen, Loader2, MessageSquare, Unlink2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  EnterpriseProjectSearchInput,
  cleanIpcError,
  useEnterpriseProjectCodeVerification
} from "../harness-board/EnterpriseProjectSearchInput"
import {
  CHAT_PROJECT_CODE_LIMIT,
  CHAT_PROJECT_NAME_LIMIT,
  readChatProject,
  type ChatProject
} from "../../../../shared/chat-project"

export interface ChatProjectTarget {
  kind: "thread" | "workspace" | "new-workspace"
  name: string
  id: string
  project: ChatProject | null
}

export function ChatProjectDialog({
  target,
  onClose,
  onSave
}: {
  target: ChatProjectTarget
  onClose: () => void
  onSave: (project: ChatProject | null) => Promise<void>
}) {
  const isNew = target.kind === "new-workspace"
  const isThread = target.kind === "thread"
  const Icon = isThread ? MessageSquare : FolderOpen
  const submitting = useRef(false)
  const [code, setCode] = useState(target.project?.code ?? "")
  const [name, setName] = useState(target.project?.name ?? "")
  const [lean, setLean] = useState(target.project?.fromLean ?? false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const verified = useCallback((value: boolean) => setLean(value), [])
  const valid = readChatProject({ code, fromLean: lean }) !== null
  const nameTooLong = name.trim().length > CHAT_PROJECT_NAME_LIMIT
  const verification = useEnterpriseProjectCodeVerification(valid, code, verified)
  const selected = (project: { projectCode: string; projectName: string }) => {
    setCode(project.projectCode)
    setName(project.projectName)
    setLean(true)
  }
  async function save(value: ChatProject | null) {
    if (submitting.current) return
    submitting.current = true
    setError("")
    setSaving(true)
    try {
      await onSave(value)
      onClose()
    } catch (e) {
      setError(cleanIpcError(e))
      submitting.current = false
      setSaving(false)
    }
  }
  function dismiss() {
    if (submitting.current) return
    if (isNew) void save(null)
    else onClose()
  }

  const codeError = !!code && !valid
  const project = readChatProject({ code, name, fromLean: lean })
  const hasChanges =
    code.trim() !== target.project?.code ||
    lean !== target.project?.fromLean ||
    name.trim() !== (target.project?.name ?? "")
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss()
      }}
    >
      <DialogContent
        ref={setContainer}
        className="w-[calc(100%-2rem)] max-w-xl gap-5 overflow-visible rounded-xl p-5 sm:p-6"
        onKeyDown={(event) => {
          if (event.key !== "Escape" || event.nativeEvent.isComposing) return
          // The suggestion list stops its own Escape. Handle keys targeting the form
          // even when a departing sidebar popover still owns Radix's top layer.
          event.preventDefault()
          dismiss()
        }}
      >
        <DialogHeader className="flex-row items-start gap-3 space-y-0 pr-5 text-left">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon aria-hidden="true" className="size-[18px]" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <DialogTitle className="text-base">
              {isThread ? "关联会话项目" : "关联工作区项目"}
            </DialogTitle>
            <DialogDescription className="m-0 text-xs leading-5">
              为「
              <span
                className="inline-block max-w-52 truncate align-bottom font-medium text-foreground"
                title={isThread ? target.name : target.id}
              >
                {target.name}
              </span>
              」选择精益项目，或填写自定义项目。
            </DialogDescription>
          </div>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (project && hasChanges && !verification.pending) void save(project)
          }}
        >
          <div className="rounded-lg border border-border bg-muted/30 p-3.5">
            <div className="grid items-start gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目编码
                <EnterpriseProjectSearchInput
                  autoFocus
                  value={code}
                  searchField="code"
                  searchLabel="项目编码"
                  placeholder="搜索或填写自定义编码"
                  normalizeValue={(value) => value.slice(0, CHAT_PROJECT_CODE_LIMIT + 1)}
                  portalContainer={container}
                  ariaInvalid={codeError}
                  onValueChange={(value) => {
                    setCode(value)
                    setLean(false)
                  }}
                  onSelect={selected}
                />
              </label>
              <label className="grid gap-1.5 text-xs font-medium text-muted-foreground">
                项目名称
                <EnterpriseProjectSearchInput
                  value={name}
                  searchField="name"
                  searchLabel="项目名称"
                  placeholder="搜索或填写项目名称（选填）"
                  showEmptyResults
                  ariaInvalid={nameTooLong}
                  normalizeValue={(value) => value.slice(0, CHAT_PROJECT_NAME_LIMIT)}
                  portalContainer={container}
                  onValueChange={setName}
                  onSelect={selected}
                />
                {nameTooLong && (
                  <span className="text-status-critical">
                    名称最多可填写 {CHAT_PROJECT_NAME_LIMIT} 个字符
                  </span>
                )}
              </label>
            </div>
            <div
              role="status"
              aria-live="polite"
              className={cn(
                "mt-3 flex min-h-4 items-center gap-1.5 text-xs text-muted-foreground",
                codeError && "text-status-critical"
              )}
            >
              {codeError ? (
                "编码限 15 个字符，可使用中文、英文、数字、- 和 _"
              ) : !code.trim() ? (
                name.trim() ? (
                  "填写项目编码即可保存，也可以从精益项目列表中选择。"
                ) : (
                  "按编码或名称搜索精益项目，选中后会自动填入两项。"
                )
              ) : verification.pending ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  正在校验项目编码…
                </>
              ) : verification.error ? (
                <>
                  {lean
                    ? "精益项目暂时无法校验，将保留当前关联。"
                    : "精益项目暂时无法校验，可先保存为自定义项目。"}
                </>
              ) : (
                <>
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      lean ? "bg-status-nominal" : "bg-muted-foreground"
                    )}
                  />
                  {lean ? "已关联精益项目" : "自定义项目"}
                </>
              )}
            </div>
          </div>
          <div className="space-y-1 text-xs leading-5 text-muted-foreground">
            <p className="font-medium text-foreground">统计归属</p>
            {!isThread && <p>新建会话会继承工作区项目，已有会话保留原项目。</p>}
            <p>
              {isThread
                ? "本会话历史和后续的代码生成与采纳都会计入所选项目。"
                : "每个会话都可以单独更改项目。更改后，该会话历史和后续的代码生成与采纳都会计入新项目。"}
            </p>
          </div>
          {error && (
            <p className="text-xs text-status-critical" role="alert">
              {error}
            </p>
          )}
          <DialogFooter className="flex-row items-center justify-end gap-2 space-x-0">
            {target.project && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mr-auto text-muted-foreground"
                disabled={saving}
                onClick={() => void save(null)}
              >
                <Unlink2 aria-hidden="true" className="size-3.5" />
                解除关联
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={dismiss} disabled={saving}>
              {isNew ? "暂不关联" : "取消"}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!project || !hasChanges || verification.pending || saving}
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {target.project ? "保存更改" : "关联项目"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
