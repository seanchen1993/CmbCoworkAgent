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
  enabled: true,
  selectedPetKey: null
}

function getPetName(pet: PetItem): string {
  return pet.displayName || pet.name || pet.id || pet.directoryId
}

function getPetDescription(pet: PetItem): string {
  return pet.description || "暂无详情"
}

function PetSpritePreview(props: { pet: PetItem; spriteUrl?: string }): React.JSX.Element {
  const { pet, spriteUrl } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!spriteUrl || !canvasRef.current) return

    const image = new Image()
    image.onload = (): void => {
      const columns = pet.columns || 8
      const frameWidth = pet.frameWidth || Math.floor(image.naturalWidth / columns)
      const frameHeight = pet.frameHeight || Math.floor(image.naturalHeight / (pet.rows || 9))
      const canvas = canvasRef.current
      const context = canvas?.getContext("2d")
      if (!canvas || !context || !frameWidth || !frameHeight) return

      canvas.width = frameWidth
      canvas.height = frameHeight
      context.imageSmoothingEnabled = false
      context.clearRect(0, 0, frameWidth, frameHeight)
      context.drawImage(image, 0, 0, frameWidth, frameHeight, 0, 0, frameWidth, frameHeight)
    }
    image.src = spriteUrl
  }, [pet.columns, pet.frameHeight, pet.frameWidth, pet.rows, spriteUrl])

  if (!spriteUrl) {
    return <ImageIcon className="size-6 text-muted-foreground" />
  }

  return (
    <canvas
      ref={canvasRef}
      aria-label={getPetName(pet)}
      className="max-h-full max-w-full [image-rendering:pixelated]"
    />
  )
}

export function PetPanel(): React.JSX.Element {
  const [pets, setPets] = useState<PetItem[]>([])
  const [settings, setSettings] = useState<PetSettings>(DEFAULT_SETTINGS)
  const [spriteUrls, setSpriteUrls] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [deletingKey, setDeletingKey] = useState<string | null>(null)

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

      const nextSpriteUrls: Record<string, string> = {}
      await Promise.all(
        nextPets.map(async (pet) => {
          const result = await window.api.pet.getSpriteDataUrl(pet.directoryId, pet.source)
          if (result.success && result.dataUrl) {
            nextSpriteUrls[pet.key] = result.dataUrl
          }
        })
      )
      setSpriteUrls(nextSpriteUrls)
    } catch (error) {
      console.error("[PetPanel] Failed to load pets:", error)
      toast.error("宠物列表加载失败")
    } finally {
      setLoading(false)
    }
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
    const spriteUrl = spriteUrls[pet.key]

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
            <PetSpritePreview pet={pet} spriteUrl={spriteUrl} />
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

        <div className="flex items-center justify-between rounded-md border border-border px-4 py-3">
          <div>
            <div className="text-sm font-medium">显示桌面宠物</div>
            <div className="text-xs text-muted-foreground">关闭后进入 App 也不会展示宠物窗口。</div>
          </div>
          <Button
            size="sm"
            variant={settings.enabled ? "default" : "outline"}
            className="min-w-20"
            onClick={handleToggleEnabled}
          >
            {settings.enabled ? "已开启" : "已关闭"}
          </Button>
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
