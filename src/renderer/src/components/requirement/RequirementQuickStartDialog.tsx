import { useEffect, useState } from "react"
import {
  ArrowRight,
  Check,
  ChevronLeft,
  FileText,
  Link,
  Plus,
  Sparkles,
  Upload
} from "lucide-react"
import businessRoleImage from "@/assets/requirement-roles/business.avif"
import designerRoleImage from "@/assets/requirement-roles/designer.avif"
import developerRoleImage from "@/assets/requirement-roles/developer.png"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export type RequirementQuickStartSelection = {
  source: "text" | "space" | "file" | "link"
  target: "conversation" | "design" | "development" | "space"
}
export const REQUIREMENT_QUICK_START_EVENT = "requirement:quick-start"
const REQUIREMENT_PERSONA_STORAGE_KEY = "requirement:quick-start-persona"
const REQUIREMENT_PERSONA_SKIP_STORAGE_KEY = "requirement:quick-start-skip-persona"

type RequirementPersona = "business" | "design" | "development"

const personas: Array<{
  value: RequirementPersona
  title: string
  description: string
  image: string
  featureColorLight: string
  tagClassName: string
}> = [
  {
    value: "business",
    title: "业务人员",
    description: "从 0 到 1 梳理并创建新的业务需求",
    image: businessRoleImage,
    featureColorLight: "rgba(255, 224, 177, 0.82)",
    tagClassName: "bg-[#ef941e] text-white shadow-[0_5px_12px_-6px_rgba(239,148,30,0.9)]"
  },
  {
    value: "development",
    title: "开发人员",
    description: "创建技术需求，原型设计，需求开发",
    image: developerRoleImage,
    featureColorLight: "rgba(190, 224, 255, 0.82)",
    tagClassName: "bg-[#3495ed] text-white shadow-[0_5px_12px_-6px_rgba(52,149,237,0.9)]"
  },
  {
    value: "design",
    title: "设计人员",
    description: "基于已有需求开始UI设计",
    image: designerRoleImage,
    featureColorLight: "rgba(222, 202, 255, 0.82)",
    tagClassName: "bg-[#8547ef] text-white shadow-[0_5px_12px_-6px_rgba(133,71,239,0.9)]"
  }
]

function readStoredPersona(): RequirementPersona | null {
  const stored = localStorage.getItem(REQUIREMENT_PERSONA_STORAGE_KEY)
  return stored === "business" || stored === "design" || stored === "development" ? stored : null
}

function readSkipPersonaSelection(): boolean {
  return localStorage.getItem(REQUIREMENT_PERSONA_SKIP_STORAGE_KEY) === "true"
}

function initialStep(): "persona" | "source" {
  const persona = readStoredPersona()
  return readSkipPersonaSelection() && persona && persona !== "business" ? "source" : "persona"
}

const quickStartItems: Array<{
  source: RequirementQuickStartSelection["source"]
  title: string
  description: string
  actions: Array<{ label: string; target: RequirementQuickStartSelection["target"] }>
  icon: typeof Plus
}> = [
  {
    source: "text",
    title: "从 0 到 1 新建技术需求",
    description: "白纸起步，边聊边把需求梳理清楚",
    actions: [{ label: "新建", target: "conversation" }],
    icon: Plus
  },
  {
    source: "space",
    title: "使用需求空间3.0已有的需求",
    description: "直接选择一条已沉淀的需求",
    actions: [{ label: "去 Tab", target: "space" }],
    icon: FileText
  },
  {
    source: "file",
    title: "上传需求文件",
    description: "docx / md / txt，读取全文后开始",
    actions: [
      { label: "设计原型", target: "design" },
      { label: "直接开发", target: "development" }
    ],
    icon: Upload
  },
  {
    source: "link",
    title: "粘贴线上的需求链接",
    description: "内置浏览器整篇读取，读取全文后开始",
    actions: [
      { label: "设计原型", target: "design" },
      { label: "直接开发", target: "development" }
    ],
    icon: Link
  }
]

export function RequirementQuickStartDialog({
  open,
  onOpenChange,
  onSelect
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (selection: RequirementQuickStartSelection) => void
}): React.JSX.Element {
  const [step, setStep] = useState<"persona" | "source">(() => initialStep())
  const [persona, setPersona] = useState<RequirementPersona | null>(() => readStoredPersona())
  const [skipPersonaSelection, setSkipPersonaSelection] = useState(() => readSkipPersonaSelection())

  useEffect(() => {
    if (!open || !readSkipPersonaSelection() || readStoredPersona() !== "business") return
    onOpenChange(false)
    onSelect({ source: "text", target: "conversation" })
  }, [onOpenChange, onSelect, open])

  const changeOpen = (nextOpen: boolean): void => {
    if (!nextOpen) {
      const storedPersona = readStoredPersona()
      setStep(
        readSkipPersonaSelection() && storedPersona && storedPersona !== "business"
          ? "source"
          : "persona"
      )
      setPersona(storedPersona)
      setSkipPersonaSelection(readSkipPersonaSelection())
    }
    onOpenChange(nextOpen)
  }

  const selectSource = (selection: RequirementQuickStartSelection): void => {
    changeOpen(false)
    onSelect(selection)
  }

  const continueWithPersona = (): void => {
    if (!persona) return
    localStorage.setItem(REQUIREMENT_PERSONA_STORAGE_KEY, persona)
    localStorage.setItem(REQUIREMENT_PERSONA_SKIP_STORAGE_KEY, String(skipPersonaSelection))
    if (persona === "business") {
      selectSource({ source: "text", target: "conversation" })
      return
    }
    setStep("source")
  }

  const availableItems = quickStartItems
    .filter((item) => persona === "development" || item.source !== "text")
    .map((item) => ({
      ...item,
      actions:
        persona === "design"
          ? item.actions.filter((action) => action.target !== "development")
          : item.actions
    }))

  return (
    <>
      {open && step === "persona" ? (
        <section className="fixed inset-0 z-40 flex min-h-0 flex-col overflow-auto bg-background">
          <div className="flex flex-1 items-center justify-center px-6 py-12">
            <div className="w-full max-w-6xl">
              <div className="mb-8 text-center">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                  选择你的角色
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  我们会根据你的角色，提供最合适的需求入口
                </p>
              </div>

              <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
                {personas.map((item, index) => {
                  const selected = persona === item.value
                  const cardStyle = {
                    "--feature-color-light": item.featureColorLight,
                    animationDelay: `${index * 70}ms`,
                    background:
                      "radial-gradient(circle at 50% 30%, var(--feature-color-light) 0%, transparent 70%)"
                  } as React.CSSProperties & { "--feature-color-light": string }
                  return (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setPersona(item.value)}
                      className={cn(
                        "group relative h-[410px] overflow-hidden rounded-[24px] border p-6 text-left shadow-[0_3px_10px_rgba(15,23,42,0.08)]",
                        "transition-all duration-300 ease-out hover:-translate-y-2 hover:scale-[1.015] hover:shadow-[0_22px_45px_-18px_rgba(15,23,42,0.28)]",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c48654]/50 focus-visible:ring-offset-2",
                        selected
                          ? "-translate-y-1 border-[#c48654] ring-2 ring-[#c48654]/20"
                          : "border-[#dedede] hover:border-[#c7c7c7]"
                      )}
                      style={cardStyle}
                    >
                      <span className="relative flex items-start justify-end">
                        <span
                          className={cn(
                            "flex size-6 items-center justify-center rounded-full border transition-all duration-200",
                            selected
                              ? "scale-100 border-[#c48654] bg-[#c48654] text-white"
                              : "scale-90 border-border bg-background text-transparent group-hover:scale-100 group-hover:border-[#d9b18e]"
                          )}
                        >
                          <Check className="size-3.5" strokeWidth={3} />
                        </span>
                      </span>

                      <span className="absolute inset-x-0 top-[62px] flex h-[210px] items-center justify-center overflow-hidden">
                        <img
                          src={item.image}
                          alt={item.title}
                          className="size-[190px] object-contain drop-shadow-[0_14px_14px_rgba(15,23,42,0.16)] transition-transform duration-500 ease-out group-hover:scale-[1.16]"
                        />
                      </span>

                      <span className="absolute inset-x-6 bottom-6 rounded-[18px] border border-black/10 bg-white/95 p-5 shadow-sm backdrop-blur-sm transition-transform duration-300 group-hover:-translate-y-1">
                        <span
                          className={cn(
                            "inline-flex rounded-full px-4 py-1.5 text-sm font-bold tracking-wide transition-transform duration-300 group-hover:scale-105",
                            item.tagClassName
                          )}
                        >
                          {item.title}
                        </span>
                        <span className="mt-3 block text-base font-semibold leading-6 text-[#171717]">
                          {item.description}
                        </span>
                        <span className="mt-3 flex items-center gap-1 text-xs font-medium text-[#737373] opacity-0 transition-all duration-300 group-hover:translate-x-1 group-hover:opacity-100">
                          选择此角色 <ArrowRight className="size-3.5" />
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>

              <div className="mt-8 flex flex-col items-center gap-3">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => changeOpen(false)}
                    className="min-w-28 rounded-xl border border-border bg-background px-6 py-3 text-sm font-semibold text-muted-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-[#d9b18e] hover:bg-[#fdf8f3] hover:text-[#a96736]"
                  >
                    关闭
                  </button>
                  <button
                    type="button"
                    disabled={!persona}
                    onClick={continueWithPersona}
                    className="group flex min-w-40 items-center justify-center gap-2 rounded-xl bg-[#c48654] px-7 py-3 text-sm font-semibold text-white shadow-[0_10px_24px_-12px_rgba(169,103,54,0.8)] transition-all duration-200 hover:-translate-y-0.5 hover:bg-[#ad7345] hover:shadow-[0_14px_28px_-12px_rgba(169,103,54,0.9)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:translate-y-0"
                  >
                    下一步
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                  <label className="ml-2 flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={skipPersonaSelection}
                      onChange={(event) => setSkipPersonaSelection(event.target.checked)}
                      className="size-4 rounded border-border accent-[#c48654]"
                    />
                    <span>下次直接使用此角色，无需展示</span>
                  </label>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  角色会保存在本机，下次将自动为你选中
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <Dialog open={open && step === "source"} onOpenChange={changeOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[520px]">
          <DialogHeader className="border-b border-border/70 px-5 pb-4 pt-5 text-left">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-[#f8eee4] text-[#c48654]">
                <Sparkles className="size-4" />
              </span>
              <div>
                <DialogTitle className="flex items-center gap-1 text-base">
                  <button
                    type="button"
                    aria-label="返回选择角色"
                    onClick={() => setStep("persona")}
                    className="-ml-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <ChevronLeft className="size-4" />
                  </button>
                  快速开始一个新任务
                </DialogTitle>
                <DialogDescription className="mt-1 text-xs">
                  选择需求来源，后续流程将沿用当前已实现的能力
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="space-y-1.5 p-3">
            {availableItems.map((item) => {
              const Icon = item.icon
              return (
                <div
                  key={item.source}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-3 text-left",
                    "transition-colors hover:border-[#ead7c5] hover:bg-[#fdf8f3]"
                  )}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#f8eee4] text-[#c48654] transition-colors group-hover:bg-[#f4e3d3]">
                    <Icon className="size-[18px]" strokeWidth={1.8} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-foreground">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                      {item.description}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {item.actions.map((action) => (
                      <button
                        key={action.target}
                        type="button"
                        onClick={() => selectSource({ source: item.source, target: action.target })}
                        className={cn(
                          "rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          action.target === "development"
                            ? "border-border bg-white text-foreground hover:border-[#c99366] hover:text-[#a96736]"
                            : "border-[#ead7c5] bg-[#f8eee4] text-[#a96736] hover:bg-[#c99366] hover:text-white"
                        )}
                      >
                        {action.label}
                      </button>
                    ))}
                  </span>
                </div>
              )
            })}
          </div>

          <p className="border-t border-border/70 px-5 py-3 text-[11px] text-muted-foreground">
            选择来源后进入对应的现有流程，已实现的提示词、归档与会话能力保持不变。
          </p>
        </DialogContent>
      </Dialog>
    </>
  )
}
