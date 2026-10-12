import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react"
import { toast } from "sonner"
import type {
  BotAcceptedFileJob,
  BotFileBatchCompletion,
  BotLocalFileBatch
} from "./bot-new-chat-draft"
import {
  extractClipboardFiles,
  hasFileDragData
} from "@/components/bots/upstream/grok-composer-files"

export interface BotAttachmentPickerHandle {
  stageFiles(files: File[]): void
  openPicker(): void
  acceptLocalBatch(
    batch: BotLocalFileBatch,
    onCompletion: (result: BotFileBatchCompletion) => void
  ):
    | { kind: "accepted"; jobs: readonly BotAcceptedFileJob[] }
    | { kind: "rejected"; reason: string }
}

/** Grok's nested drag-depth interaction with Cmb's existing upload owner.
 * Only the composer stages files; a drop elsewhere cannot navigate Electron. */
export function useBotComposerFiles(
  disabled: boolean,
  picker: RefObject<BotAttachmentPickerHandle | null>,
  navigationGuard = true,
  active = true
) {
  const depth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const reset = () => {
    depth.current = 0
    setDragging(false)
  }
  useEffect(() => {
    if (!navigationGuard) return
    const preventFileNavigation = (event: globalThis.DragEvent) => {
      if (hasFileDragData(event.dataTransfer?.types)) event.preventDefault()
      if (event.type === "drop") {
        depth.current = 0
        setDragging(false)
      }
    }
    const finish = () => {
      depth.current = 0
      setDragging(false)
    }
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") finish()
    }
    document.addEventListener("dragover", preventFileNavigation, true)
    document.addEventListener("drop", preventFileNavigation, true)
    window.addEventListener("dragend", finish)
    window.addEventListener("blur", finish)
    window.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("dragover", preventFileNavigation, true)
      document.removeEventListener("drop", preventFileNavigation, true)
      window.removeEventListener("dragend", finish)
      window.removeEventListener("blur", finish)
      window.removeEventListener("keydown", key)
    }
  }, [navigationGuard])
  return {
    dragging: dragging && !disabled && active,
    onDragEnter(event: DragEvent) {
      if (!active || !hasFileDragData(event.dataTransfer.types)) return
      event.preventDefault()
      event.stopPropagation()
      depth.current++
      if (!disabled) setDragging(true)
    },
    onDragOver(event: DragEvent) {
      if (!active || !hasFileDragData(event.dataTransfer.types)) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = disabled ? "none" : "copy"
    },
    onDragLeave(event: DragEvent) {
      if (!active || !hasFileDragData(event.dataTransfer.types)) return
      event.preventDefault()
      event.stopPropagation()
      depth.current = Math.max(0, depth.current - 1)
      if (!depth.current) setDragging(false)
    },
    onDrop(event: DragEvent) {
      if (!active || !hasFileDragData(event.dataTransfer.types)) return
      event.preventDefault()
      event.stopPropagation()
      reset()
      if (disabled) {
        toast.error("请等待当前发送或上传完成后再添加附件")
        return
      }
      if (
        Array.from(event.dataTransfer.items).some((item) => item.webkitGetAsEntry?.()?.isDirectory)
      ) {
        toast.error("暂不支持上传文件夹，请选择文件或压缩后上传")
        return
      }
      picker.current?.stageFiles(Array.from(event.dataTransfer.files))
    },
    onPaste(event: { clipboardData: DataTransfer | null; preventDefault(): void }) {
      if (!active) return
      const files = extractClipboardFiles(event.clipboardData?.items)
      if (!files.length) return // Text paste retains native caret, undo and IME behavior.
      event.preventDefault()
      if (disabled) {
        toast.error("请等待当前发送或上传完成后再添加附件")
        return
      }
      picker.current?.stageFiles(files)
    }
  }
}
