import { useEffect, useRef, useState } from "react"
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  Check,
  FileText,
  Link,
  Loader2,
  RefreshCw,
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
  REQUIREMENT_BOUND_SKILLS
} from "./requirement-session-capabilities"
import type { DesignSystemInfo } from "../design/types"
import { RequirementWorkDirPicker } from "./RequirementWorkDirPicker"
import {
  RequirementBackgroundMaterialsField,
  type RequirementBackgroundMaterialsFieldHandle
} from "./RequirementBackgroundMaterialsField"
import { RequirementFileDropzone } from "./RequirementFileDropzone"

export type UploadSource = "file" | "text" | "link"

type RequirementSkillStatus =
  | { phase: "absent" }
  | { phase: "installed"; version: string }
  | { phase: "installing" }
  | { phase: "updating"; version: string }
  | { phase: "failed"; action: "install" | "update" }

type BrowserControlState = "loading" | "enabled" | "restart-required" | "error"

function BrowserControlTag({
  state,
  restarting,
  onRestart
}: {
  state: BrowserControlState
  restarting: boolean
  onRestart: () => void
}): React.JSX.Element {
  if (state === "restart-required") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
        <Check className="size-3" />
        内置浏览器已帮你开启，需重启
        <button
          type="button"
          className="ml-0.5 inline-flex items-center gap-1 rounded-full bg-amber-600 px-2 py-0.5 text-white hover:bg-amber-700 disabled:opacity-60"
          disabled={restarting}
          onClick={onRestart}
        >
          {restarting ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          重启 App
        </button>
      </span>
    )
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        state === "enabled"
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : state === "error"
            ? "border-red-200 bg-red-50 text-red-700"
            : "border-border bg-muted/40 text-muted-foreground"
      )}
    >
      {state === "enabled" ? (
        <Check className="size-3" />
      ) : state === "loading" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : null}
      {state === "enabled"
        ? "内置浏览器已开启"
        : state === "error"
          ? "内置浏览器开启失败"
          : "正在检测内置浏览器"}
    </span>
  )
}

async function ensureRequirementSkills(
  onStatusChange: (skillId: string, status: RequirementSkillStatus) => void
): Promise<void> {
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

    if (!needsInstall) {
      onStatusChange(boundSkill.id, {
        phase: "installed",
        version: installedVersion || existingSkill?.version || "v1.0.0"
      })
      continue
    }

    onStatusChange(
      boundSkill.id,
      existingSkill
        ? { phase: "updating", version: installedVersion || existingSkill.version }
        : { phase: "installing" }
    )

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
    onStatusChange(boundSkill.id, {
      phase: "installed",
      version: normalizeMarketVersion(marketSkill.version) || marketSkill.version || "v1.0.0"
    })
  }
}

function getRequirementTitleFromFileName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").trim() || "新需求草稿"
}

export function NewRequirementDialog({
  open,
  onOpenChange,
  system,
  onChangeSystem,
  initialSource = "file",
  onStartConversation
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  system: DesignSystemInfo
  onChangeSystem: () => void
  initialSource?: UploadSource
  onStartConversation: (
    requirement: RequirementRecord,
    options?: { autoGeneratePrd?: boolean }
  ) => void | Promise<void>
}): React.JSX.Element {
  const [source, setSource] = useState<UploadSource>(initialSource)
  const [file, setFile] = useState<File | null>(null)
  const [attachments, setAttachments] = useState<File[]>([])
  const [backgroundUrls, setBackgroundUrls] = useState<string[]>([])
  const [title, setTitle] = useState("")
  const [url, setUrl] = useState("")
  const [initialDescription, setInitialDescription] = useState("")
  const [workDir, setWorkDir] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [preparingSkill, setPreparingSkill] = useState(false)
  const [enabledExperts, setEnabledExperts] = useState<Set<string>>(new Set())
  const [skillStatuses, setSkillStatuses] = useState<Record<string, RequirementSkillStatus>>({})
  const [browserControlState, setBrowserControlState] = useState<BrowserControlState>("loading")
  const [restartingApp, setRestartingApp] = useState(false)
  const backgroundMaterialsRef = useRef<RequirementBackgroundMaterialsFieldHandle>(null)
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

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.all([window.api.expertAgents.list(), window.api.skills.list()])
      .then(([experts, skills]) => {
        if (cancelled) return
        setEnabledExperts(
          new Set(experts.filter((expert) => expert.enabled).map((expert) => expert.name))
        )
        setSkillStatuses(
          Object.fromEntries(
            REQUIREMENT_BOUND_SKILLS.map((boundSkill) => {
              const installed = skills.find(
                (skill) => skill.name.trim().toLowerCase() === boundSkill.id.trim().toLowerCase()
              )
              return [
                boundSkill.id,
                installed ? { phase: "installed", version: installed.version } : { phase: "absent" }
              ]
            })
          )
        )
      })
      .catch((error) => console.warn("[Requirement] 读取本地专家/技能状态失败：", error))
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setBrowserControlState("loading")
    window.api.browser
      .getCdpConfig()
      .then(async (config) => {
        if (config.enabled) return "enabled" as const
        await window.api.browser.saveCdpConfig({ enabled: true })
        return "restart-required" as const
      })
      .then((state) => {
        if (!cancelled) setBrowserControlState(state)
      })
      .catch((error) => {
        console.error("[Requirement] 开启内置浏览器失败：", error)
        if (!cancelled) {
          setBrowserControlState("error")
          toast.error("开启内置浏览器失败，请前往设置中手动开启")
        }
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const restartApp = (): void => {
    setRestartingApp(true)
    void window.api.app.restart().catch((error) => {
      console.error("[Requirement] 重启应用失败：", error)
      setRestartingApp(false)
      toast.error("重启应用失败，请稍后手动重启")
    })
  }

  const browserControlTag = (
    <BrowserControlTag
      state={browserControlState}
      restarting={restartingApp}
      onRestart={restartApp}
    />
  )

  const updateSkillStatus = (skillId: string, status: RequirementSkillStatus): void => {
    setSkillStatuses((current) => ({ ...current, [skillId]: status }))
  }

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
    const pendingBackgroundUrls = backgroundMaterialsRef.current?.getUrlsForSubmit()
    if (pendingBackgroundUrls === null) return
    const submittedBackgroundUrls = pendingBackgroundUrls ?? backgroundUrls

    setSaving(true)
    try {
      setPreparingSkill(true)
      const capabilities = getRequirementSessionCapabilities()
      await Promise.all([
        ensureRequirementSkills(updateSkillStatus),
        enableRequirementSessionExperts(capabilities.experts).then(() =>
          setEnabledExperts(new Set(capabilities.experts))
        )
      ])
      setPreparingSkill(false)
      const sourceBytes = source === "file" && file ? await file.arrayBuffer() : undefined
      const attachmentPayload = await Promise.all(
        attachments.map(async (attachment) => ({
          fileName: attachment.name,
          bytes: await attachment.arrayBuffer()
        }))
      )
      const sourcePayload =
        source === "file"
          ? {
              fileName: sourceName || "新需求草稿.docx",
              bytes: sourceBytes,
              attachments: attachmentPayload,
              backgroundUrls: submittedBackgroundUrls
            }
          : source === "link"
            ? {
                fileName: "",
                url: normalizedUrl,
                attachments: attachmentPayload,
                backgroundUrls: submittedBackgroundUrls
              }
            : {
                fileName: "",
                initialDescription: initialDescription.trim(),
                attachments: attachmentPayload,
                backgroundUrls: submittedBackgroundUrls
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
      // Every new requirement starts with a visible workbench prompt. For a
      // text requirement, use the prompt to begin discovery from the user's
      // initial description; uploaded/link sources additionally point to `source/`.
      await onStartConversation(requirement, { autoGeneratePrd: true })
    } catch (error) {
      setPreparingSkill(false)
      setSkillStatuses((current) =>
        Object.fromEntries(
          Object.entries(current).map(([skillId, status]) => [
            skillId,
            status.phase === "installing"
              ? { phase: "failed", action: "install" }
              : status.phase === "updating"
                ? { phase: "failed", action: "update" }
                : status
          ])
        )
      )
      toast.error(error instanceof Error ? error.message : "保存需求草稿失败")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1100px]">
        <DialogHeader>
          <div className="px-6 pt-5">
            <DialogTitle>
              {`新增需求 · ${source === "file" ? "文件" : source === "text" ? "文本" : "链接"}`}
            </DialogTitle>
            <DialogDescription className="mt-1.5">
              完善需求来源与背景信息后，开始需求沟通。
            </DialogDescription>
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-4">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_3rem_minmax(0,1fr)] lg:gap-5">
            <div className="min-w-0 space-y-4">
              <div className="rounded-xl border-[1.5px] border-primary/30 bg-primary/5 p-4">
                <div className="flex items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Building2 className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-muted-foreground">业务系统</div>
                    <div className="truncate text-sm font-semibold text-foreground">
                      {system.name}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      默认沿用上次选择的系统
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={onChangeSystem}
                  >
                    切换系统
                  </Button>
                </div>
              </div>

              <RequirementWorkDirPicker
                workDir={workDir}
                onWorkDirChange={setWorkDir}
                disabled={saving}
              />

              <div className="inline-flex w-fit rounded-lg bg-[#f3ede6] p-1">
                {[
                  { id: "file" as const, label: "文件", icon: Upload },
                  { id: "text" as const, label: "文本", icon: ArrowRight },
                  { id: "link" as const, label: "链接", icon: Link }
                ].map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setSource(item.id)}
                      className={cn(
                        "flex h-8 items-center gap-1.5 rounded px-3 text-sm font-semibold transition-colors",
                        source === item.id
                          ? "bg-white text-foreground shadow-[0_1px_3px_rgba(0,0,0,0.08)]"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <Icon className="size-3.5" />
                      {item.label}
                    </button>
                  )
                })}
              </div>

              {source === "file" ? (
                <div className="space-y-3">
                  <RequirementFileDropzone
                    accept=".docx"
                    disabled={saving}
                    onFilesSelected={(files) => updateFile(files[0] ?? null)}
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
                  </RequirementFileDropzone>
                </div>
              ) : source === "link" ? (
                <div className="rounded-xl border-[1.5px] border-border bg-[#fdfbf7] p-5">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <label
                      className="text-sm font-semibold text-foreground"
                      htmlFor="requirement-link"
                    >
                      粘贴需求链接
                    </label>
                    {browserControlTag}
                  </div>
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
                    支持 WPS、Wiki 等链接，链接信息会一起归档。
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
                    source === "file"
                      ? "上传文件后会自动回填，也可手动输入"
                      : "例如：支付流程优化需求"
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
            </div>

            <div
              className="relative hidden min-h-full items-center justify-center lg:flex"
              aria-hidden="true"
            >
              <span className="h-full w-[2px] rounded-full bg-gradient-to-b from-transparent via-primary/70 to-transparent shadow-[0_0_10px_rgba(196,134,84,0.3)]" />
              <span className="absolute size-2.5 rotate-45 rounded-[2px] border border-primary/80 bg-primary ring-4 ring-background shadow-[0_0_10px_rgba(196,134,84,0.5)]" />
            </div>

            <div
              className="h-[2px] rounded-full bg-gradient-to-r from-transparent via-primary/70 to-transparent shadow-[0_0_8px_rgba(196,134,84,0.25)] lg:hidden"
              aria-hidden="true"
            />

            <div className="min-w-0 space-y-4">
              <RequirementBackgroundMaterialsField
                ref={backgroundMaterialsRef}
                files={attachments}
                urls={backgroundUrls}
                disabled={saving}
                browserControlTag={browserControlTag}
                onFilesChange={setAttachments}
                onUrlsChange={setBackgroundUrls}
              />
              <div className="space-y-4">
                <section className="rounded-xl border-[1.5px] border-border bg-[#fdfbf7] p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <BadgeCheck className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold text-foreground">已绑定专家</h3>
                    <span className="text-[12px] font-normal text-muted-foreground">
                      自动启用，无需你手动操作
                    </span>
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
                        {enabledExperts.has(expert.id) ? (
                          <Check className="size-4 shrink-0 text-emerald-600" aria-label="已启用" />
                        ) : null}
                      </div>
                    )
                  })}
                </section>
                <section className="rounded-xl border-[1.5px] border-border bg-[#fdfbf7] p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" />
                    <h3 className="text-sm font-semibold text-foreground">已绑定技能</h3>
                    <span className="text-[12px] font-normal text-muted-foreground">
                      自动安装最新版本，无需你手动操作
                    </span>
                  </div>
                  {REQUIREMENT_BOUND_SKILLS.map((skill) => {
                    const Icon = skill.icon
                    const status = skillStatuses[skill.id]
                    return (
                      <div
                        key={skill.id}
                        className="inline-flex items-center gap-2 rounded-lg border border-border bg-white px-2.5 py-2 text-sm font-semibold text-foreground"
                      >
                        <span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Icon className="size-3.5" />
                        </span>
                        {skill.label}
                        {status?.phase === "installing" || status?.phase === "updating" ? (
                          <span className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                            <Loader2 className="size-3.5 animate-spin" />
                            {status.phase === "installing" ? "安装中" : "更新中"}
                          </span>
                        ) : status?.phase === "installed" ? (
                          <span className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
                            <Check className="size-4" aria-hidden="true" />
                            {status.version}
                          </span>
                        ) : status?.phase === "failed" ? (
                          <span className="ml-1 text-xs font-medium text-destructive">
                            {status.action === "install" ? "安装失败" : "更新失败"}
                          </span>
                        ) : null}
                      </div>
                    )
                  })}
                </section>
              </div>
            </div>
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
