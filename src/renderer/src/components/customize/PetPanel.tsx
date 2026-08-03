import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, ImageIcon, Loader2, PawPrint, RefreshCw, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type PetSource = "builtin" | "custom"

type PetItem = {
  id: string
  directoryId: string
  source: PetSource
  key: string
  canDelete: boolean
  name?: string
  displayName?: string
  description?: string
  spritesheetPath: string
  frameWidth?: number
  frameHeight?: number
  columns?: number
  rows?: number
}

type PetSettings = {
  enabled: boolean
  selectedPetKey: string | null
}

const DEFAULT_SETTINGS: PetSettings = {
  enabled: false,
  selectedPetKey: null
}
const DEFAULT_PET_COLUMNS = 8
const DEFAULT_PET_ROWS = 9
// 设置页只画第一帧预览，仍需限制解码后像素与单帧尺寸，避免异常自定义资源撑爆 renderer。
const MAX_PREVIEW_FRAME_SIZE = 1024
const MAX_PREVIEW_SPRITE_PIXELS = 16 * 1024 * 1024
const PREVIEW_CANVAS_WIDTH = 96
const PREVIEW_CANVAS_HEIGHT = 104

function getPetName(pet: PetItem): string {
  return pet.displayName || pet.name || pet.id || pet.directoryId
}

function getPetDescription(pet: PetItem): string {
  return pet.description || "暂无详情"
}

function PetSpritePreview(props: {
  pet: PetItem
  queueSpritePreview: (load: () => Promise<void>) => void
}): React.JSX.Element {
  const { pet, queueSpritePreview } = props
  const { columns, directoryId, frameHeight, frameWidth, rows, source } = pet
  const previewRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const requestedRef = useRef(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (requestedRef.current) return
    const preview = previewRef.current
    if (!preview) return
    let disposed = false
    let activeImage: HTMLImageElement | null = null
    let activeObjectUrl: string | null = null
    let finishActiveLoad: (() => void) | null = null

    const releaseImage = (): void => {
      if (activeImage) {
        activeImage.onload = null
        activeImage.onerror = null
        activeImage.src = ""
        activeImage = null
      }
      if (activeObjectUrl) {
        URL.revokeObjectURL(activeObjectUrl)
        activeObjectUrl = null
      }
      const finish = finishActiveLoad
      finishActiveLoad = null
      finish?.()
    }

    const requestSprite = (): void => {
      if (requestedRef.current) return
      requestedRef.current = true
      queueSpritePreview(async () => {
        if (disposed) return
        try {
          const result = await window.api.pet.getSpriteBytes(directoryId, source)
          if (disposed || !result.success || !result.bytes || !result.mimeType) return

          const bytes = new Uint8Array(result.bytes)
          activeObjectUrl = URL.createObjectURL(new Blob([bytes.buffer], { type: result.mimeType }))
          const image = new Image()
          activeImage = image
          await new Promise<void>((resolve) => {
            finishActiveLoad = resolve
            image.onload = (): void => {
              if (disposed) {
                releaseImage()
                return
              }
              // 先检查整图解码后的像素数，再创建 canvas，防止小体积高分辨率图片造成内存尖峰。
              if (
                image.naturalWidth < 1 ||
                image.naturalHeight < 1 ||
                image.naturalWidth * image.naturalHeight > MAX_PREVIEW_SPRITE_PIXELS
              ) {
                releaseImage()
                return
              }

              const columnCount = columns || DEFAULT_PET_COLUMNS
              const rowCount = rows || DEFAULT_PET_ROWS
              const sourceFrameWidth = frameWidth || Math.floor(image.naturalWidth / columnCount)
              const sourceFrameHeight = frameHeight || Math.floor(image.naturalHeight / rowCount)
              if (
                sourceFrameWidth < 1 ||
                sourceFrameHeight < 1 ||
                sourceFrameWidth > MAX_PREVIEW_FRAME_SIZE ||
                sourceFrameHeight > MAX_PREVIEW_FRAME_SIZE
              ) {
                releaseImage()
                return
              }

              const canvas = canvasRef.current
              const context = canvas?.getContext("2d")
              if (!canvas || !context) {
                releaseImage()
                return
              }

              canvas.width = PREVIEW_CANVAS_WIDTH
              canvas.height = PREVIEW_CANVAS_HEIGHT
              context.imageSmoothingEnabled = false
              context.clearRect(0, 0, PREVIEW_CANVAS_WIDTH, PREVIEW_CANVAS_HEIGHT)
              const previewScale = Math.min(
                PREVIEW_CANVAS_WIDTH / sourceFrameWidth,
                PREVIEW_CANVAS_HEIGHT / sourceFrameHeight
              )
              const previewWidth = Math.max(1, Math.round(sourceFrameWidth * previewScale))
              const previewHeight = Math.max(1, Math.round(sourceFrameHeight * previewScale))
              context.drawImage(
                image,
                0,
                0,
                sourceFrameWidth,
                sourceFrameHeight,
                Math.round((PREVIEW_CANVAS_WIDTH - previewWidth) / 2),
                Math.round((PREVIEW_CANVAS_HEIGHT - previewHeight) / 2),
                previewWidth,
                previewHeight
              )
              setLoaded(true)
              releaseImage()
            }
            image.onerror = releaseImage
            image.src = activeObjectUrl!
          })
        } catch (error) {
          console.warn("[PetPanel] Failed to load pet sprite:", error)
          releaseImage()
        }
      })
    }

    if (typeof IntersectionObserver === "undefined") {
      requestSprite()
      return () => {
        disposed = true
        requestedRef.current = false
        releaseImage()
      }
    }

    // 预览图按进入视口懒加载，避免打开宠物页时一次性把所有 spritesheet 通过 IPC 拉进来。
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          requestSprite()
          observer.disconnect()
        }
      },
      { rootMargin: "160px" }
    )
    observer.observe(preview)

    return () => {
      disposed = true
      requestedRef.current = false
      observer.disconnect()
      releaseImage()
    }
  }, [columns, directoryId, frameHeight, frameWidth, queueSpritePreview, rows, source])

  return (
    <div ref={previewRef} className="flex size-full items-center justify-center">
      <canvas
        ref={canvasRef}
        aria-label={getPetName(pet)}
        className={cn("max-h-full max-w-full [image-rendering:pixelated]", !loaded && "hidden")}
      />
      {!loaded && <ImageIcon className="size-6 text-muted-foreground" />}
    </div>
  )
}

export function PetPanel(): React.JSX.Element {
  const [pets, setPets] = useState<PetItem[]>([])
  const [settings, setSettings] = useState<PetSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [deletingKey, setDeletingKey] = useState<string | null>(null)
  const spriteLoadQueueRef = useRef<Promise<void>>(Promise.resolve())

  const builtinPets = useMemo(() => pets.filter((pet) => pet.source === "builtin"), [pets])
  const customPets = useMemo(() => pets.filter((pet) => pet.source === "custom"), [pets])
  const selectedPetKey = settings.selectedPetKey ?? pets[0]?.key ?? null

  const loadPets = useCallback(async () => {
    setLoading(true)
    try {
      const [nextPets, nextSettings] = await Promise.all([
        window.api.pet.list() as Promise<PetItem[]>,
        window.api.pet.getSettings()
      ])
      setPets(nextPets)
      setSettings(nextSettings)
    } catch (error) {
      console.error("[PetPanel] Failed to load pets:", error)
      toast.error("宠物列表加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  const queueSpritePreview = useCallback((load: () => Promise<void>): void => {
    const request = spriteLoadQueueRef.current.then(load)
    spriteLoadQueueRef.current = request.catch((error) => {
      console.warn("[PetPanel] Failed to process pet sprite preview:", error)
    })
  }, [])

  useEffect(() => {
    void loadPets()
  }, [loadPets])

  const updateSettings = useCallback(async (partial: Partial<PetSettings>) => {
    try {
      const nextSettings = await window.api.pet.updateSettings(partial)
      setSettings(nextSettings)
    } catch (error) {
      console.error("[PetPanel] Failed to update pet settings:", error)
      toast.error("宠物设置保存失败")
    }
  }, [])

  const handleToggleEnabled = (): void => {
    void updateSettings({ enabled: !settings.enabled })
  }

  const handleSelectPet = (pet: PetItem): void => {
    void updateSettings({ selectedPetKey: pet.key })
  }

  const handleUpload = async (): Promise<void> => {
    setUploading(true)
    try {
      const result = await window.api.pet.uploadCustomFolder()
      if (!result.success) {
        if (result.error && result.error !== "已取消选择") toast.error(result.error)
        return
      }
      toast.success("宠物已上传")
      await loadPets()
    } catch (error) {
      console.error("[PetPanel] Failed to upload pet:", error)
      toast.error("宠物上传失败")
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (pet: PetItem): Promise<void> => {
    if (!pet.canDelete) return
    const confirmed = window.confirm(`删除自定义宠物「${getPetName(pet)}」？`)
    if (!confirmed) return

    setDeletingKey(pet.key)
    try {
      const result = await window.api.pet.deleteCustom(pet.directoryId)
      if (!result.success) {
        toast.error(result.error || "删除失败")
        return
      }
      toast.success("自定义宠物已删除")
      await loadPets()
    } catch (error) {
      console.error("[PetPanel] Failed to delete pet:", error)
      toast.error("删除失败")
    } finally {
      setDeletingKey(null)
    }
  }

  const renderPetCard = (pet: PetItem): React.JSX.Element => {
    const selected = selectedPetKey === pet.key

    return (
      <Card
        key={pet.key}
        className={cn(
          "overflow-hidden border transition-colors",
          selected ? "border-primary bg-primary/5" : "border-border bg-card"
        )}
      >
        <CardContent className="flex gap-3 p-3">
          <button
            className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40"
            onClick={() => handleSelectPet(pet)}
            aria-label={`选择${getPetName(pet)}`}
          >
            <PetSpritePreview pet={pet} queueSpritePreview={queueSpritePreview} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-sm font-semibold">{getPetName(pet)}</h3>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {getPetDescription(pet)}
                </p>
              </div>
              {selected && (
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <Check className="size-3" />
                </span>
              )}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                variant={selected ? "default" : "outline"}
                className="h-7 px-2 text-xs"
                onClick={() => handleSelectPet(pet)}
              >
                {selected ? "已选择" : "选择"}
              </Button>
              {pet.canDelete && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                  disabled={deletingKey === pet.key}
                  onClick={() => void handleDelete(pet)}
                >
                  {deletingKey === pet.key ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Trash2 className="size-3" />
                  )}
                  删除
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  const renderSection = (
    title: string,
    items: PetItem[],
    emptyText: string,
    action?: React.ReactNode
  ): React.JSX.Element => (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex items-center gap-2">
          {action}
          <span className="text-xs text-muted-foreground">{items.length} 个</span>
        </div>
      </div>
      {items.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{items.map(renderPetCard)}</div>
      ) : (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {emptyText}
        </div>
      )}
    </section>
  )

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <PawPrint className="size-5" />
              宠物
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              管理桌面宠物的显示、选择和自定义资源。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void loadPets()} disabled={loading}>
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              刷新
            </Button>
            <Button size="sm" onClick={() => void handleUpload()} disabled={uploading}>
              {uploading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              上传宠物包文件夹
            </Button>
          </div>
        </div>

        <div
          className={cn(
            "flex items-center justify-between gap-4 rounded-md border px-4 py-3 transition-colors",
            settings.enabled ? "border-primary/30 bg-primary/5" : "border-border bg-muted/20"
          )}
        >
          <div>
            <div className="text-sm font-medium">显示桌面宠物</div>
            <div className="text-xs text-muted-foreground">
              点击右侧开关可开启或关闭；关闭后进入 App 也不会展示宠物窗口。
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            aria-label={settings.enabled ? "关闭桌面宠物" : "开启桌面宠物"}
            title={settings.enabled ? "点击关闭桌面宠物" : "点击开启桌面宠物"}
            className={cn(
              "group inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-full border px-2.5 py-1.5 text-xs font-medium shadow-sm transition-all",
              "hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              settings.enabled
                ? "border-primary/40 bg-primary text-primary-foreground"
                : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"
            )}
            onClick={handleToggleEnabled}
          >
            <span>{settings.enabled ? "已开启" : "已关闭"}</span>
            <span
              className={cn(
                "relative inline-flex h-5 w-9 rounded-full border-2 border-transparent transition-colors",
                settings.enabled ? "bg-primary-foreground/25" : "bg-muted-foreground/30"
              )}
              aria-hidden="true"
            >
              <span
                className={cn(
                  "inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                  settings.enabled ? "translate-x-4" : "translate-x-0"
                )}
              />
            </span>
            <span className="text-[11px] opacity-85">
              {settings.enabled ? "点击关闭" : "点击开启"}
            </span>
          </button>
        </div>

        <div className={cn("space-y-6", !settings.enabled && "opacity-60")}>
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              正在加载宠物列表
            </div>
          ) : (
            <>
              {renderSection("内置宠物列表", builtinPets, "暂无内置宠物")}
              {renderSection(
                "自定义宠物列表",
                customPets,
                "还没有上传自定义宠物",
                <span className="text-xs text-muted-foreground">
                  （可到行外 https://petdex.crafter.run/zh 下载宠物）
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
