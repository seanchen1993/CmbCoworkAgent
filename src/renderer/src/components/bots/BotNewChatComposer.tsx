import { useMemo, useRef, useLayoutEffect, useImperativeHandle } from "react"
import { ArrowUp, File, Plus, Upload, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { BOT_ATTACHMENT_COUNT, botFileByteLimit } from "../../../../shared/bot-files"
import { useBotComposerFiles, type BotAttachmentPickerHandle } from "@/lib/use-bot-composer-files"
import type { BotComposerDraft } from "@/lib/bot-composer-draft"
import { patchNewChatText, type NewChatLocalSession } from "@/lib/bot-new-chat-draft"
import {
  BotPromptEditorSurface,
  type BotPromptControls,
  type BotPromptDraftPort
} from "./BotPromptEditorSurface"

/** Real editor with a local owner. Recipient selection, not typing, adopts its draft. */
export function BotNewChatComposer({
  session,
  covered,
  navigationGuard,
  read,
  commit,
  changedFocus
}: {
  session: NewChatLocalSession
  covered: boolean
  navigationGuard: boolean
  read(): NewChatLocalSession | null
  commit(
    expectedRevision: string,
    changes: Partial<NewChatLocalSession>
  ): NewChatLocalSession | null
  changedFocus(focused: boolean): void
}) {
  const openNonce = session.openNonce
  const input = useRef<HTMLInputElement>(null)
  const controls = useRef<BotPromptControls>(null)
  const disabled = covered || session.phase !== "editing"
  const current = useRef({ read, commit, session, disabled })
  useLayoutEffect(() => {
    current.current = { read, commit, session, disabled }
  })
  const owner = useMemo<BotPromptDraftPort>(
    () => ({
      read: () =>
        current.current.read()?.openNonce === openNonce ? current.current.read()?.draft : undefined,
      commit: (revision, changes: Partial<BotComposerDraft>) => {
        const scope = current.current,
          live = scope.read()
        if (
          scope.disabled ||
          !revision ||
          live?.openNonce !== openNonce ||
          live.revision !== revision
        )
          return
        const next = scope.commit(revision, {
          draft: patchNewChatText(live.draft, changes)
        })
        return next?.draft
      },
      canInsertReference: () => false
    }),
    [openNonce]
  )
  const picker = useRef<BotAttachmentPickerHandle>(null)
  useImperativeHandle(
    picker,
    () => ({
      openPicker: () => {
        if (!current.current.disabled) input.current?.click()
      },
      acceptLocalBatch: () => ({ kind: "rejected", reason: "请先选择收件人" }),
      stageFiles: (files) => {
        const scope = current.current,
          live = scope.read()
        if (scope.disabled || !files.length || live?.openNonce !== openNonce) return
        if (files.length + live.files.length > BOT_ATTACHMENT_COUNT) {
          toast.error("每条消息最多 6 个附件")
          return
        }
        const tooLarge = files.find((file) => file.size > botFileByteLimit(file.name, file.type))
        if (tooLarge) {
          toast.error(`${tooLarge.name} 超过限制：普通文件 25 MiB，视频 200 MiB`)
          return
        }
        scope.commit(live.revision, {
          files: [
            ...live.files,
            ...files.map((file) => ({
              localId: crypto.randomUUID(),
              file,
              name: file.name,
              mime: file.type,
              size: file.size
            }))
          ]
        })
      }
    }),
    [openNonce]
  )
  const fileInput = useBotComposerFiles(disabled, picker, navigationGuard, !covered)
  return (
    <div className="bot-composer-dock bot-new-chat-composer-dock">
      {session.error && (
        <p className="bot-send-notice" role="status">
          {session.error}
        </p>
      )}
      <form
        className="bot-composer"
        data-multiline={session.draft.prompt.includes("\n") || undefined}
        data-dragging={fileInput.dragging || undefined}
        onSubmit={(event) => event.preventDefault()}
        onDragEnter={fileInput.onDragEnter}
        onDragOver={fileInput.onDragOver}
        onDragLeave={fileInput.onDragLeave}
        onDrop={fileInput.onDrop}
      >
        {fileInput.dragging && (
          <div className="bot-file-drop-overlay" role="status">
            <Upload size={18} />
            <span>松开以添加附件</span>
          </div>
        )}
        <input
          type="file"
          multiple
          hidden
          ref={input}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ""
            picker.current?.stageFiles(files)
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="bot-attachment-button"
          aria-label="添加附件"
          disabled={disabled}
          onClick={() => picker.current?.openPicker()}
        >
          <Plus size={20} />
        </Button>
        {session.files.length > 0 && (
          <div className="bot-composer-files">
            <div className="flex flex-wrap gap-1.5">
              {session.files.map((file) => (
                <span
                  key={file.localId}
                  className="flex max-w-52 items-center gap-1 rounded-md border px-2 py-1 text-xs"
                >
                  <File size={13} />
                  <span className="truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={`移除附件 ${file.name}`}
                    disabled={disabled}
                    onClick={() => {
                      const live = read()
                      if (live?.openNonce === openNonce)
                        commit(live.revision, {
                          files: live.files.filter((item) => item.localId !== file.localId)
                        })
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        <BotPromptEditorSurface
          key={openNonce}
          editorId={`bot-new-chat-composer-${openNonce}`}
          ariaLabel="新聊天消息"
          inlineReferences={false}
          disabled={disabled}
          owner={owner}
          draft={session.draft}
          controls={controls}
          placeholder="发消息给 Bot…"
          expanded={false}
          onFocus={changedFocus}
          onSelection={() => {}}
          onPaste={fileInput.onPaste}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.isComposing &&
              event.keyCode !== 229
            ) {
              event.preventDefault()
              return true
            }
            return false
          }}
        />
        <Button
          type="submit"
          size="icon"
          className="bot-send-button"
          disabled
          aria-label="发送消息"
          title="请先选择收件人"
        >
          <ArrowUp size={20} />
        </Button>
      </form>
    </div>
  )
}
