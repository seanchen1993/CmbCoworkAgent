import { useEffect, useRef, useState } from "react"
import {
  ArrowRight,
  BadgeCheck,
  FileText,
  FolderOpen,
  Link,
  Loader2,
  Sparkles,
  Upload
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { marketApi } from "@/api/market"
import {
  isMarketVersionDifferent,
  marketInstalledVersionStorage,
  normalizeMarketVersion
} from "../customize/MarketPanel/MarketUpdateBadge"
import { fromPersistedRequirement, type RequirementRecord } from "./requirement-data"
import { MAX_ATTACHMENT_FILE_BYTES } from "../../../../shared/file-attachment"
import {
  enableRequirementSessionExperts,
  getRequirementSessionCapabilities,
  REQUIREMENT_BOUND_EXPERTS,
  REQUIREMENT_BOUND_SKILLS,
  type RequirementSessionCapabilities
} from "./requirement-session-capabilities"
import type { DesignSystemInfo } from "../design/types"

type UploadSource = "file" | "text" | "link"

async function ensureRequirementSkills(): Promise<void> {
  const boundSkills = REQUIREMENT_BOUND_SKILLS.map((skill) => ({
    ...skill,
    normalizedName: skill.id.trim().toLowerCase()
  }))
  const [installedSkills, marketResponse] = await Promise.all([
    window.api.skills.list(),
    marketApi.getSkills()
  ])

  if (!marketResponse.success || !marketResponse.data) {
    const missingSkill = boundSkills.find(
      (boundSkill) =>
        !installedSkills.some(
          (installedSkill) => installedSkill.name.trim().toLowerCase() === boundSkill.normalizedName
        )
    )
    if (!missingSkill) return
    throw new Error(marketResponse.error || "无法读取公共市场技能")
  }

  for (const boundSkill of boundSkills) {
    const existingSkill = installedSkills.find(
      (skill) => skill.name.trim().toLowerCase() === boundSkill.normalizedName
    )
    const marketSkill = marketResponse.data.find(
      (item) => item.name.trim().toLowerCase() === boundSkill.normalizedName
    )
    if (!marketSkill) {
      if (existingSkill) continue
      throw new Error(`公共市场未找到技能「${boundSkill.id}」`)
    }

    const recordedVersion = marketInstalledVersionStorage.getVersion(boundSkill.id, "skill")
    const installedVersion = normalizeMarketVersion(existingSkill?.version || recordedVersion)
    const marketVersion = normalizeMarketVersion(marketSkill.version)
    const needsInstall =
      !existingSkill ||
      !installedVersion ||
      (Boolean(marketVersion) && isMarketVersionDifferent(installedVersion, marketVersion))

    if (!needsInstall) continue

    if (existingSkill) {
      const deleteResult = await window.api.skills.delete(existingSkill.path)
      if (!deleteResult.success) {
        throw new Error(deleteResult.error || `删除旧版技能「${boundSkill.id}」失败`)
      }
    }

    const installResult = await marketApi.downloadItem(
      boundSkill.id,
      "skill",
      false,
      marketSkill.featured === "精品",
      marketSkill,
      { allowNestedNameDuplicates: true }
    )
    if (!installResult.success) {
      throw new Error(installResult.error || `安装技能「${boundSkill.id}」失败`)
    }
    marketInstalledVersionStorage.setVersion(boundSkill.id, "skill", marketSkill.version)
  }
}

function getRequirementTitleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim() || "新需求草稿"
}

function getLinkSnapshot(value: string, systemName: string): string {
  return `# 原始需求链接

- 业务系统：${systemName}
- 需求链接：${value}
- 保存时间：${new Date().toLocaleString("zh-CN", { hour12: false })}

> 该文件保存了原始需求链接，后续可在同目录中与规范 PRD 一起查看。
`
}

export function NewRequirementDialog({
  open,
  onOpenChange,
  system,
  onStartConversation
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  system: DesignSystemInfo
  onStartConversation: (
    requirement: RequirementRecord,
    options?: { autoGeneratePrd?: boolean } & Partial<RequirementSessionCapabilities>
  ) => void | Promise<void>
}): React.JSX.Element {
  const [source, setSource] = useState<UploadSource>("file")
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState("")
  const [url, setUrl] = useState("")
  const [initialDescription, setInitialDescription] = useState("")
  const [workDir, setWorkDir] = useState<string | null>(null)
  const [workDirLoading, setWorkDirLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preparingSkill, setPreparingSkill] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const lastAutoFilledTitleRef = useRef("")

  useEffect(() => {
    let cancelled = false
    void window.api.requirements
      .getWorkDir()
      .then((lastWorkDir) => {
        if (!cancelled) setWorkDir(lastWorkDir)
      })
      .catch(() => {
        if (!cancelled) setWorkDir(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const updateFile = (nextFile: File | null): void => {
    if (nextFile && !nextFile.name.toLocaleLowerCase().endsWith(".docx")) {
      toast.error("仅支持 .docx 格式的需求草稿")
      return
    }
    if (nextFile && nextFile.size > MAX_ATTACHMENT_FILE_BYTES) {
      toast.error("需求草稿超过 5MB 限制")
      return
    }
    setFile(nextFile)
    const nextAutoFilledTitle = nextFile ? getRequirementTitleFromFileName(nextFile.name) : ""
    setTitle((currentTitle) => {
      const trimmedTitle = currentTitle.trim()
      if (!trimmedTitle || trimmedTitle === lastAutoFilledTitleRef.current) {
        return nextAutoFilledTitle
      }
      return currentTitle
    })
    lastAutoFilledTitleRef.current = nextAutoFilledTitle
  }

  const handleConfirm = async (): Promise<void> => {
    if (source === "file" && !file) {
      toast.error("请先选择需求草稿文件")
      return
    }
    if (source === "link" && !url.trim()) {
      toast.error("请填写需求链接")
      return
    }
    if (source === "text" && !initialDescription.trim()) {
      toast.error("请简要描述需求")
      return
    }
    if (!workDir) {
      toast.error("请先选择需求工作目录")
      return
    }
    const normalizedTitle = title.trim()
    if (!normalizedTitle) {
      toast.error("请填写需求名称")
      return
    }
    const normalizedUrl = url.trim()
    const sourceName = source === "file" ? file?.name || "新需求草稿.docx" : null

    setSaving(true)
    try {
      setPreparingSkill(true)
      const capabilities = getRequirementSessionCapabilities()
      try {
        await Promise.all([
          ensureRequirementSkills(),
          enableRequirementSessionExperts(capabilities.allowedExperts)
        ])
      } catch (prepareError) {
        // 公共市场不可用或技能安装失败时，不应阻断需求归档；降级为记录日志后继续创建。
        console.warn("[Requirement] 准备专家/技能失败，继续创建需求：", prepareError)
      } finally {
        setPreparingSkill(false)
      }
      const sourceBytes = source === "file" && file ? await file.arrayBuffer() : undefined
      const sourcePayload =
        source === "file"
          ? {
              fileName: sourceName || "新需求草稿.docx",
              bytes: sourceBytes
            }
          : source === "link"
            ? {
                fileName: "原始需求链接.md",
                url: normalizedUrl,
                content: getLinkSnapshot(normalizedUrl, system.name)
              }
            : {
                fileName: "",
                initialDescription: initialDescription.trim()
              }
      const result = await window.api.requirements.create({
        systemId: system.id,
        title: normalizedTitle,
        workDir,
        source: {
          type: source,
          ...sourcePayload
        }
      })
      if (!result.success || !result.requirement) {
        throw new Error(result.error || "保存需求草稿失败")
      }

      const requirement = fromPersistedRequirement(result.requirement, system.name)
      onOpenChange(false)
      toast.success("需求草稿已归档")
      // Every new requirement starts with a visible workbench prompt. For a
      // Text requirements use the prompt to begin discovery from the user's
      // initial description.
      // conversation; uploaded/link sources additionally point to `source/`.
      await onStartConversation(requirement, { autoGeneratePrd: true, ...capabilities })
    } catch (error) {
      setPreparingSkill(false)
      toast.error(error instanceof Error ? error.message : "保存需求草稿失败")
    } finally {
      setSaving(false)
    }
  }

  const selectWorkDir = async (): Promise<void> => {
    setWorkDirLoading(true)
    try {
      const result = await window.api.requirements.selectWorkDir()
      if (!result.success) {
        throw new Error(result.error || "选择需求工作目录失败")
      }
      if (result.workDir) setWorkDir(result.workDir)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "选择需求工作目录失败")
    } finally {
      setWorkDirLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[680px]">
        <DialogHeader>
          <div className="px-6 pt-5">
            <DialogTitle>
              {`新增需求 · ${source === "file" ? "文件" : source === "text" ? "文本" : "链接"}`}
            </DialogTitle>
            <DialogDescription className="mt-1.5">
              已选择「{system.name}
              」；先选择归档工作目录，再选择文件、文本或链接作为需求来源。
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 pb-5 pt-4">
          <div className="rounded-xl border-[1.5px] border-border bg-[#fdfbf7] p-4">
            <div className="mb-2 flex items-center gap-2">
              <FolderOpen className="size-4 text-primary" />
              <span className="text-sm font-semibold text-foreground">需求工作目录</span>
              <span className="text-sm text-muted-foreground">
                默认使用上次选择的目录（多个需求可共用同一个根目录，无需分别设置）
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1 truncate rounded-lg border border-border bg-white px-3 py-2 text-sm text-foreground">
                {workDir || "尚未选择需求工作目录"}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={workDirLoading || saving}
                onClick={() => void selectWorkDir()}
              >
                <FolderOpen className="size-3.5" />
                {workDirLoading ? "选择中..." : workDir ? "更换目录" : "选择目录"}
              </Button>
            </div>
            <p className="mt-2 text-[12px] leading-5 text-muted-foreground">
              系统会在目录下为各需求创建独立子文件夹，规范 PRD 文件将存放于对应需求的独立文件夹下。
            </p>
          </div>

          <TooltipProvider delayDuration={150}>
            <div className="inline-flex w-fit rounded-lg bg-[#f3ede6] p-1">
              {[
                { id: "file" as const, label: "文件", icon: Upload },
                { id: "text" as const, label: "文本", icon: ArrowRight },
                { id: "link" as const, label: "链接", icon: Link }
              ].map((item) => {
                const Icon = item.icon
                const disabled = item.id === "link"
                const tab = (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setSource(item.id)}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded px-3 text-sm font-semibold transition-colors",
                      disabled
                        ? "cursor-not-allowed text-muted-foreground/50"
                        : source === item.id
                          ? "bg-white text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
                          : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="size-3.5" />
                    {item.label}
                  </button>
                )

                return disabled ? (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">{tab}</span>
                    </TooltipTrigger>
                    <TooltipContent side="top">敬请期待</TooltipContent>
                  </Tooltip>
                ) : (
                  <span key={item.id}>{tab}</span>
                )
              })}
            </div>
          </TooltipProvider>

          {source === "file" ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                updateFile(event.dataTransfer.files.item(0))
              }}
              className="flex min-h-44 w-full flex-col items-center justify-center rounded-xl border-[1.5px] border-dashed border-[#d8cbbb] bg-[#fdfbf7] px-6 text-center transition-colors hover:border-primary/60 hover:bg-primary/5 focus-visible:border-primary focus-visible:outline-none"
            >
              <Upload className="mb-3 size-7 text-primary" />
              <span className="text-sm font-semibold text-foreground">
                {file ? file.name : "拖拽文件到此处，或点击上传"}
              </span>
              <span className="mt-1 text-sm text-muted-foreground">
                仅支持 .docx 格式 · 请将旧版 .doc 文件另存为 .docx 后上传
              </span>
              {file ? (
                <span className="mt-3 flex w-full items-center gap-2 rounded-lg border border-border bg-[#fbf8f4] px-3 py-2 text-left">
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[#f8f0df] text-[#8f6a2a]">
                    <FileText className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-semibold text-foreground">
                      {file.name}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {Math.ceil(file.size / 1024)} KB · 草稿已就绪
                    </span>
                  </span>
                </span>
              ) : null}
              <input
                ref={inputRef}
                type="file"
                accept=".docx"
                className="hidden"
                onChange={(event) => {
                  updateFile(event.target.files?.item(0) ?? null)
                  event.target.value = ""
                }}
              />
            </button>
          ) : source === "link" ? (
            <div className="rounded-xl border-[1.5px] border-border bg-[#fdfbf7] p-5">
              <label
                className="mb-2 block text-sm font-semibold text-foreground"
                htmlFor="requirement-link"
              >
                粘贴需求链接
              </label>
              <div className="relative">
                <Link className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-primary" />
                <Input
                  id="requirement-link"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://docs.example.com/prd/..."
                  className="h-10 bg-white pl-9"
                />
              </div>
              <p className="mt-3 text-sm leading-5 text-muted-foreground">
                支持飞书文档、腾讯文档、语雀、Confluence 和普通网页链接，链接信息会一起归档。
              </p>
            </div>
          ) : (
            <div className="rounded-xl border-[1.5px] border-primary/25 bg-primary/5 p-5">
              <label
                className="mb-2 block text-sm font-semibold text-foreground"
                htmlFor="requirement-initial-description"
              >
                简要描述需求
              </label>
              <textarea
                id="requirement-initial-description"
                value={initialDescription}
                onChange={(event) => setInitialDescription(event.target.value)}
                placeholder="例如：为柜员增加批量导入客户资料的能力，并在失败时展示原因。"
                className="min-h-32 w-full resize-y rounded-md border border-input bg-white px-3 py-2 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                disabled={saving}
              />
              <p className="mt-3 text-sm leading-5 text-muted-foreground">
                这段说明会作为首条消息主动发送到需求会话，用于开始澄清和整理。
              </p>
            </div>
          )}
          <div className="rounded-xl border-[1.5px] border-border bg-[#fdfbf7] p-5">
            <label
              className="mb-2 block text-sm font-semibold text-foreground"
              htmlFor="requirement-title"
            >
              需求名称
            </label>
            <Input
              id="requirement-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={
                source === "file" ? "上传文件后会自动回填，也可手动输入" : "例如：支付流程优化需求"
              }
              className="h-10 bg-white"
              disabled={saving}
            />
            <p className="mt-3 text-sm leading-5 text-muted-foreground">
              {source === "file"
                ? "上传需求文件后会默认带出文件名，支持继续编辑。"
                : "建议填写一个便于检索和沟通的需求名称。"}
            </p>
          </div>
          <div className="space-y-4 border-t border-border pt-4">
            <section className="rounded-xl border-[1.5px] border-border bg-[#fdfbf7] p-4">
              <div className="mb-3 flex items-center gap-2">
                <BadgeCheck className="size-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">已绑定专家</h3>
                <span className="text-[12px] font-normal text-muted-foreground">自动启用</span>
              </div>
              {REQUIREMENT_BOUND_EXPERTS.map((expert) => {
                const Icon = expert.icon
                return (
                  <div
                    key={expert.id}
                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-2.5 py-2 text-sm font-semibold text-foreground"
                  >
                    <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-3.5" />
                    </span>
                    {expert.label}
                  </div>
                )
              })}
            </section>
            <section className="rounded-xl border-[1.5px] border-border bg-[#fdfbf7] p-4">
              <div className="mb-3 flex items-center gap-2">
                <Sparkles className="size-4 text-primary" />
                <h3 className="text-sm font-semibold text-foreground">已绑定技能</h3>
                <span className="text-[12px] font-normal text-muted-foreground">
                  自动安装或更新
                </span>
              </div>
              {REQUIREMENT_BOUND_SKILLS.map((skill) => {
                const Icon = skill.icon
                return (
                  <div
                    key={skill.id}
                    className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-2.5 py-2 text-sm font-semibold text-foreground"
                  >
                    <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                      <Icon className="size-3.5" />
                    </span>
                    {skill.label}
                  </div>
                )
              })}
            </section>
          </div>
        </div>
        <DialogFooter className="border-t border-border bg-[#fbf8f4] px-6 py-3">
          <span className="mr-auto text-[12px] text-muted-foreground">
            {source === "file"
              ? "草稿与后续 PRD 会归档到已选需求工作目录"
              : source === "link"
                ? "链接快照与后续 PRD 会归档到已选需求工作目录"
                : "会话内容与后续 PRD 会归档到已选需求工作目录"}
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button type="button" onClick={() => void handleConfirm()} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {preparingSkill
              ? "正在准备专家和技能..."
              : source === "file"
                ? "上传并开始沟通"
                : source === "link"
                  ? "保存并开始沟通"
                  : "创建并开始沟通"}
            {!saving ? <ArrowRight className="size-4" /> : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
