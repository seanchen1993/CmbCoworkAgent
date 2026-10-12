import { botApi } from "@/lib/bot-api"
import { useLayoutEffect, useRef, useState } from "react"
import { ImagePlus, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { useBotAvatarImages } from "@/lib/use-bot-avatar-images"
import {
  acknowledgePendingAvatar,
  inspectPendingAvatar,
  discardPendingAvatar,
  rememberPendingAvatar
} from "@/lib/bot-avatar-pending"
import type { CoworkBot } from "../../../../shared/bot-types"
import type { BotAvatarChange } from "../../../../shared/bot-avatar"
import { BotAvatar } from "./BotAvatar"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import {
  browserAvatarImageCodec,
  initialAvatarCrop,
  clampAvatarCrop,
  panAvatarCrop,
  AVATAR_STAGE_SIZE,
  type AvatarImage,
  type AvatarCrop
} from "./upstream/grok-avatar-crop"

/** Grok's staged upload/crop interaction, using Cmb dialogs and durable mutation receipts. */
export function BotAvatarEditor({ bot, close }: { bot: CoworkBot; close(): void }) {
  const persistedImage = useBotAvatarImages([bot.id])[bot.id]
  const dataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch ?? "initial")
  const supported = useBotWorkspaceStore(
    (state) => state.host?.capabilities?.includes("mutation-data-epoch-v2") ?? false
  )
  const [editingEpoch] = useState(dataEpoch)
  const [record, setRecord] = useState(() => inspectPendingAvatar(bot.id, editingEpoch))
  const acknowledged = useRef<{ input: BotAvatarChange; rejected?: string } | null>(null)
  const pending = record.kind === "valid" ? record.input : (acknowledged.current?.input ?? null)
  const blocked = record.kind !== "empty" && record.kind !== "valid"
  const refreshRecord = () => setRecord(inspectPendingAvatar(bot.id, editingEpoch))
  const [source, setSource] = useState<AvatarImage | null>(null)
  const [crop, setCrop] = useState<AvatarCrop | null>(null)
  const [fileName, setFileName] = useState("")
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null)
  const generation = useRef(0),
    alive = useRef(true),
    locked = useRef(false)
  const [authorityRetired, setAuthorityRetired] = useState(false)
  const restored = authorityRetired || editingEpoch !== dataEpoch
  const disabled = busy || blocked || !!pending || restored || !supported
  const currentEpoch = () =>
    (useBotWorkspaceStore.getState().snapshot?.dataEpoch ?? "initial") === editingEpoch
  const live = () => alive.current && currentEpoch()
  useLayoutEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const ingest = async (file: File) => {
    if (locked.current || blocked || pending || !supported || !live()) return
    const token = ++generation.current
    setReading(true)
    setError(null)
    try {
      const image = await browserAvatarImageCodec.normalizeDataUrl(
        await browserAvatarImageCodec.readFile(file)
      )
      if (!live() || token !== generation.current) return
      setSource(image)
      setCrop(initialAvatarCrop(image.width, image.height))
      setFileName(file.name || "粘贴的图片")
    } catch (failure) {
      if (live() && token === generation.current)
        setError(failure instanceof Error ? failure.message : "图片无法读取")
    } finally {
      if (alive.current && token === generation.current) setReading(false)
    }
  }
  const save = async (remove = false) => {
    if (
      locked.current ||
      !supported ||
      blocked ||
      !live() ||
      reading ||
      (!pending && !remove && (!source || !crop))
    )
      return
    locked.current = true
    setBusy(true)
    setError(null)
    let request = pending
    try {
      request ??= {
        botId: bot.id,
        revision: bot.revision,
        nonce: crypto.randomUUID(),
        expectedDataEpoch: editingEpoch,
        pngBase64: remove ? null : await browserAvatarImageCodec.encodePng(source!, crop!)
      }
      if (!live()) return
      if (!acknowledged.current) rememberPendingAvatar(request, editingEpoch)
      refreshRecord()
      let receipt = acknowledged.current
      if (!receipt) {
        try {
          await botApi.changeAvatar(request)
          receipt = { input: request }
        } catch (failure) {
          const code = (failure as { code?: string } | null)?.code
          if (code === "data_epoch") {
            if (live()) {
              setAuthorityRetired(true)
              setError("工作区数据已恢复，请重新打开并核对原操作。原记录仍保留。")
            }
            return
          }
          if (
            !code ||
            ![
              "invalid_input",
              "avatar_invalid",
              "not_found",
              "revision_conflict",
              "nonce_conflict"
            ].includes(code)
          )
            throw failure
          receipt = {
            input: request,
            rejected: failure instanceof Error ? failure.message : "头像保存被拒绝"
          }
        }
      }
      if (!currentEpoch()) return
      acknowledged.current = receipt
      if (!acknowledgePendingAvatar(request, editingEpoch)) {
        if (live()) setError("头像结果已确认，本机记录尚未清除。重试只核对原记录。")
        return
      }
      if (!live()) return
      refreshRecord()
      if (receipt.rejected) {
        acknowledged.current = null
        setError(receipt.rejected)
        return
      }
      await useBotWorkspaceStore.getState().refresh()
      if (live()) {
        acknowledged.current = null
        close()
      }
    } catch (failure) {
      if (live()) {
        refreshRecord()
        setError(
          acknowledged.current
            ? "头像结果已确认，列表同步失败。重试只重新读取列表并核对原记录。"
            : failure instanceof Error
              ? failure.message
              : "保存结果尚未确认，请核对原操作"
        )
      }
    } finally {
      locked.current = false
      if (alive.current) setBusy(false)
    }
  }
  const scale =
    source && crop ? (AVATAR_STAGE_SIZE / Math.min(source.width, source.height)) * crop.zoom : 1
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="max-h-[90vh] max-w-md overflow-y-auto"
        onPaste={(event) => {
          const file = Array.from(event.clipboardData.files).find((item) =>
            item.type.startsWith("image/")
          )
          if (file) {
            event.preventDefault()
            event.stopPropagation()
            void ingest(file)
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>头像图片 · {bot.name}</DialogTitle>
          <DialogDescription>上传或粘贴图片，拖动调整位置后保存。</DialogDescription>
        </DialogHeader>
        {blocked && (
          <BotPendingSaveRecovery
            record={record}
            dataEpoch={editingEpoch}
            operationLabel="头像修改"
            discard={(raw) => discardPendingAvatar(bot.id, editingEpoch, raw)}
            onRepaired={() => {
              acknowledged.current = null
              refreshRecord()
              setError(null)
            }}
          />
        )}
        <div className="flex flex-col items-center gap-4">
          <div
            className={`relative grid shrink-0 touch-none select-none place-items-center overflow-hidden rounded-full border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring ${dragging ? "ring-2 ring-primary" : ""}`}
            style={{ width: AVATAR_STAGE_SIZE, height: AVATAR_STAGE_SIZE }}
            role="img"
            aria-label={source ? "头像裁剪区域，方向键调整位置" : "当前头像"}
            tabIndex={source ? 0 : -1}
            onDragOver={(event) => {
              event.preventDefault()
              if (!disabled) setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setDragging(false)
              const file = event.dataTransfer.files[0]
              if (file) void ingest(file)
            }}
            onPointerDown={(event) => {
              if (disabled || !source || !crop || event.button !== 0) return
              event.currentTarget.setPointerCapture(event.pointerId)
              pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
            }}
            onPointerMove={(event) => {
              const previous = pointer.current
              if (disabled || !source || !previous || previous.id !== event.pointerId) return
              setCrop(
                (value) =>
                  value &&
                  panAvatarCrop(
                    source,
                    value,
                    event.clientX - previous.x,
                    event.clientY - previous.y
                  )
              )
              pointer.current = { id: previous.id, x: event.clientX, y: event.clientY }
            }}
            onPointerUp={(event) => {
              pointer.current = null
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId)
            }}
            onLostPointerCapture={() => {
              pointer.current = null
            }}
            onKeyDown={(event) => {
              if (disabled || !source || !crop) return
              const directions: Record<string, [number, number]> = {
                ArrowLeft: [-8, 0],
                ArrowRight: [8, 0],
                ArrowUp: [0, -8],
                ArrowDown: [0, 8]
              }
              const delta = directions[event.key]
              if (delta) {
                event.preventDefault()
                setCrop(panAvatarCrop(source, crop, delta[0], delta[1]))
              }
            }}
          >
            {source && crop ? (
              <img
                alt=""
                draggable={false}
                src={source.dataUrl}
                className="pointer-events-none absolute left-0 top-0 max-w-none"
                style={{
                  width: source.width * scale,
                  height: source.height * scale,
                  transform: `translate(${130 - crop.centerX * scale}px, ${130 - crop.centerY * scale}px)`
                }}
              />
            ) : persistedImage ? (
              <img
                alt="当前头像图片"
                draggable={false}
                src={persistedImage}
                className="h-full w-full object-cover"
              />
            ) : (
              <BotAvatar agentId={bot.id} size="xl" isStatic />
            )}
          </div>
          {source && crop && (
            <div className="w-full space-y-2 px-4">
              <label className="flex items-center gap-3 text-sm">
                缩放
                <input
                  className="min-w-0 flex-1 accent-primary"
                  aria-label="头像缩放"
                  type="range"
                  min="1"
                  max="5"
                  step="0.01"
                  value={crop.zoom}
                  disabled={disabled || reading}
                  onChange={(event) =>
                    setCrop(clampAvatarCrop(source, { ...crop, zoom: Number(event.target.value) }))
                  }
                />
              </label>
              <p className="truncate text-center text-xs text-muted-foreground">{fileName}</p>
            </div>
          )}
          <input
            ref={input}
            type="file"
            className="hidden"
            aria-label="上传头像图片"
            accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ""
              if (file) void ingest(file)
            }}
          />
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => input.current?.click()}
            >
              <ImagePlus size={15} />
              {reading ? "读取中…" : source ? "更换图片" : "上传图片"}
            </Button>
            {source && (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled || reading}
                onClick={() => setCrop(initialAvatarCrop(source.width, source.height))}
              >
                <RotateCcw size={14} />
                居中
              </Button>
            )}
            {bot.avatarHash && !source && (
              <Button
                type="button"
                variant="ghost"
                disabled={disabled || reading}
                onClick={() => void save(true)}
              >
                <Trash2 size={14} />
                移除图片
              </Button>
            )}
          </div>
          <p className="text-center text-xs text-muted-foreground">
            支持 PNG、JPEG、WebP、GIF、BMP、AVIF，最大 25 MiB。
            <br />
            保存为静态头像；移除图片后恢复 Bot 形象。
          </p>
        </div>
        {!supported && (
          <p role="alert" className="text-xs text-muted-foreground">
            当前 Bot 后台不支持恢复保护，请更新并重新连接后操作。
          </p>
        )}
        {restored && (
          <p role="alert" className="text-sm text-destructive">
            数据已恢复，请关闭后重新打开。
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {pending && (
          <p className="text-sm text-muted-foreground">
            有一次保存尚未确认。核对原操作后再更换图片。
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>
            取消
          </Button>
          <Button
            type="button"
            disabled={busy || blocked || reading || restored || !supported || (!pending && !source)}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : pending ? "核对原操作" : "保存头像"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
