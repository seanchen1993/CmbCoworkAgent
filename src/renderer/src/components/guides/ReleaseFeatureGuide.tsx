import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as Dialog from "@radix-ui/react-dialog"
import { ArrowRight, BookOpen, Copy, Maximize2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { AnchoredGuide, type AnchoredGuideStep } from "./AnchoredGuide"
import { subscribeApplicationUsageGuide } from "./application-usage-guide"
import { revealGuideSettings } from "./release-guide-navigation"
import { dismissCurrentPageEntryGuide } from "./page-entry-guide-intent"
import {
  releaseExamples,
  releaseGuideConfig,
  releaseGuideSteps,
  releaseGuideTopics,
  type ReleaseGuideDestination
} from "./release-guide-content"
import statusRequest from "../../assets/guides/release-status-request.png"
import statusResult from "../../assets/guides/release-status-result.png"
import projectRequest from "../../assets/guides/release-project-request.png"
import projectResult from "../../assets/guides/release-project-result.png"

const pictures = [
  [statusRequest, statusResult],
  [projectRequest, projectResult]
]
const version = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "development"
const config = releaseGuideConfig(version)
const tourConfig = { ...config, guideId: `${config.guideId}:locations` }

/** View navigation only. Never create a chat, enter creator mode, apply or authorize a plugin. */
function revealDestination(id: ReleaseGuideDestination) {
  const state = useAppStore.getState()
  if (["mods", "creator", "plugins", "tools"].includes(id)) {
    const tab = id === "plugins" ? "plugins" : id === "tools" ? "connectors" : "mods"
    state.setShowCustomizeView(true, tab, "create")
    revealGuideSettings(tab)
  } else if (id === "project") {
    state.setShowCustomizeView(false)
    state.setShowHarnessBoardView(true)
  } else if (id === "market") {
    state.setShowCustomizeView(false)
    state.setMainView("market")
  } else {
    state.setShowCustomizeView(false)
    if (state.mainView === "harness") state.setShowHarnessBoardView(false)
    else state.setMainView("thread")
  }
}

export function ReleaseFeatureGuide({ active }: { active: boolean }) {
  const account = useAppStore((state) => state.accountRevision)
  return <ScopedReleaseFeatureGuide key={account} active={active} />
}

function ScopedReleaseFeatureGuide({ active }: { active: boolean }) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [example, setExample] = useState(0)
  const [zoom, setZoom] = useState<{ src: string; title: string } | null>(null)
  const [feedback, setFeedback] = useState("")
  const [tour, setTour] = useState<ReleaseGuideDestination | "all" | null>(null)
  const [stepId, setStepId] = useState("")
  const [request, setRequest] = useState(0)
  const [showShortcut, setShowShortcut] = useState(false)
  const [showDirectory, setShowDirectory] = useState(false)
  const directory = useRef<HTMLHeadingElement>(null)
  const manual = useRef(false)
  const claim = useRef<Promise<boolean> | null>(null)
  const root = useRef<HTMLElement | null>(document.body)
  const focus = useRef<HTMLElement | null>(null)
  const selected = releaseExamples[example]
  const steps = useMemo(
    () =>
      tour === "all" ? releaseGuideSteps : releaseGuideSteps.filter((item) => item.id === tour),
    [tour]
  )

  useEffect(() => {
    if (!active || !window.api.uiGuides) return
    let cancelled = false
    void window.api.uiGuides
      .getState(config)
      .then((state) => {
        if (!cancelled && !manual.current) setPending(state.shouldShow)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [active])

  // Wait for existing dialogs to finish. This observer exists only before the first display.
  useEffect(() => {
    if (!active || !pending || open || tour) return
    let frame = 0
    const check = () => {
      frame = 0
      if (document.visibilityState === "hidden") return
      const blocked = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(
        (element) =>
          element.getClientRects().length > 0 &&
          !element.closest('[hidden], [inert], [aria-hidden="true"]')
      )
      if (!blocked) {
        focus.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        setPending(false)
        setOpen(true)
      }
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-hidden", "inert"]
    })
    document.addEventListener("visibilitychange", schedule)
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      document.removeEventListener("visibilitychange", schedule)
    }
  }, [active, pending, open, tour])

  useEffect(() => {
    if (!open || manual.current || !window.api.uiGuides) return
    claim.current ??= window.api.uiGuides.recordDisplay(config)
    let cancelled = false
    void claim.current
      .then((claimed) => {
        if (!cancelled && !claimed) setOpen(false)
      })
      .catch(() => {
        if (!cancelled) setOpen(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const reopen = useCallback(() => {
    manual.current = true
    focus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setPending(false)
    setTour(null)
    setExample(0)
    setFeedback("")
    setShowDirectory(false)
    setOpen(true)
  }, [])

  useEffect(() => subscribeApplicationUsageGuide(reopen), [reopen])

  const dismiss = () => {
    setOpen(false)
    setZoom(null)
    setPending(false)
    if (window.api.uiGuides)
      void window.api.uiGuides
        .getState(config)
        .then(() => window.api.uiGuides.acknowledge(config))
        .catch(() => {})
  }
  const startTour = (destination: ReleaseGuideDestination | "all") => {
    dismiss()
    setShowShortcut(true)
    setTour(destination)
    setRequest((value) => value + 1)
  }
  const reveal = useCallback((step: AnchoredGuideStep) => {
    setStepId(step.id)
    revealDestination(step.id as ReleaseGuideDestination)
  }, [])

  useEffect(() => {
    if (!tour || stepId !== "project") return
    let frame = 0
    const dismissOldIntroduction = () => {
      frame = 0
      dismissCurrentPageEntryGuide("project-mode-getting-started")
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(dismissOldIntroduction)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [tour, stepId])

  return (
    <>
      <Dialog.Root
        open={active && open}
        onOpenChange={(next) => {
          if (!next) dismiss()
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[110] bg-black/40" />
          <Dialog.Content
            data-cmb-modal-dialog="true"
            aria-describedby="release-guide-description"
            onOpenAutoFocus={(event) => {
              if (showDirectory && directory.current) {
                event.preventDefault()
                directory.current.focus({ preventScroll: true })
                directory.current.scrollIntoView({ block: "start" })
              }
            }}
            className="fixed left-1/2 top-1/2 z-[111] flex max-h-[90dvh] w-[min(1050px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (!tour && focus.current?.isConnected) focus.current.focus({ preventScroll: true })
            }}
          >
            <header className="shrink-0 border-b px-6 py-5 pr-14">
              <p className="mb-2 text-xs font-medium text-primary">DEVCLAW · {version} 更新介绍</p>
              <Dialog.Title className="text-xl font-semibold">
                把助手变成适合你的工作台
              </Dialog.Title>
              <Dialog.Description
                id="release-guide-description"
                className="mt-2 text-sm text-muted-foreground"
              >
                先看两个例子，再去真实页面试一试。你只需要说清想改变什么。
              </Dialog.Description>
              <Dialog.Close
                aria-label="关闭新功能介绍"
                className="absolute right-4 top-4 rounded-md p-2 hover:bg-muted"
              >
                <X className="size-5" />
              </Dialog.Close>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
              <div className="flex flex-wrap gap-2" aria-label="选择图文示例">
                {releaseExamples.map((item, index) => (
                  <Button
                    key={item.id}
                    variant={index === example ? "secondary" : "outline"}
                    aria-pressed={index === example}
                    onClick={() => {
                      setExample(index)
                      setFeedback("")
                    }}
                  >
                    {index + 1}. {item.title}
                  </Button>
                ))}
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-2">
                {["这样提问", "应用后的界面"].map((label, index) => (
                  <figure
                    key={`${example}-${index}`}
                    className="min-w-0 overflow-hidden rounded-xl border bg-muted/20"
                  >
                    <figcaption className="flex items-center justify-between px-4 py-3 text-sm font-medium">
                      <span>{label}</span>
                      <span className="text-xs font-normal text-muted-foreground">点击放大</span>
                    </figcaption>
                    <button
                      className="relative block w-full cursor-zoom-in"
                      aria-label={`放大${selected.title}：${label}`}
                      onClick={() =>
                        setZoom({
                          src: pictures[example][index],
                          title: `${selected.title} · ${label}`
                        })
                      }
                    >
                      <img
                        src={pictures[example][index]}
                        alt={`${selected.title}：${label}，界面示例`}
                        width={1100}
                        height={650}
                        loading="lazy"
                        decoding="async"
                        className="h-auto w-full"
                      />
                      <Maximize2 className="absolute bottom-3 right-3 size-4 text-muted-foreground" />
                    </button>
                  </figure>
                ))}
              </div>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">{selected.note}</p>
              <div className="mt-5 grid gap-5 md:grid-cols-2">
                <div className="rounded-xl bg-muted/30 p-4">
                  <p className="text-sm leading-6">{selected.prompt}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(selected.prompt)
                        setFeedback("已复制，回到创造者聊天粘贴并按需修改后发送。")
                      } catch {
                        setFeedback("请选中上方需求手动复制。")
                      }
                    }}
                  >
                    <Copy className="mr-2 size-3.5" />
                    复制这段需求
                  </Button>
                  {feedback && (
                    <p role="status" className="mt-2 text-xs text-muted-foreground">
                      {feedback}
                    </p>
                  )}
                </div>
                <div>
                  <h3 className="text-sm font-semibold">接下来这样做</h3>
                  <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6">
                    {selected.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                  <p className="mt-3 text-sm text-muted-foreground">{selected.result}</p>
                </div>
              </div>
              <h3 ref={directory} tabIndex={-1} className="mb-3 mt-7 text-sm font-semibold">
                想了解哪一块？直接带你到对应位置
              </h3>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {releaseGuideTopics.map((topic) => (
                  <button
                    key={topic.id}
                    className="rounded-xl border p-3 text-left hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => startTour(topic.id)}
                  >
                    <span className="flex items-center justify-between text-sm font-medium">
                      {topic.title}
                      <ArrowRight className="size-3.5" />
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                      {topic.text}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
              <p className="text-xs text-muted-foreground">
                以后可从“自定义助手 → 新功能指南”再次打开。
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={dismiss}>
                  先自己试试
                </Button>
                <Button onClick={() => startTour("all")}>
                  <BookOpen className="mr-2 size-4" />
                  带我走一遍
                </Button>
              </div>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={!!zoom && open && active}
        onOpenChange={(next) => {
          if (!next) setZoom(null)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[120] bg-black/70" />
          <Dialog.Content
            data-cmb-modal-dialog="true"
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-[121] w-[min(1200px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-background p-4"
          >
            <Dialog.Title className="mb-3 pr-10 text-sm font-medium">{zoom?.title}</Dialog.Title>
            <Dialog.Close
              aria-label="关闭示例大图"
              className="absolute right-3 top-3 rounded p-1 hover:bg-muted"
            >
              <X className="size-5" />
            </Dialog.Close>
            {zoom && (
              <img
                src={zoom.src}
                alt={zoom.title}
                className="max-h-[80dvh] w-full object-contain"
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {tour && (
        <AnchoredGuide
          key={`${tour}:${request}`}
          active={active && !open}
          config={tourConfig}
          rootRef={root}
          steps={steps}
          request={request}
          autoStart={false}
          hideTrigger
          dialogLabel="新功能操作指引"
          returnFocusRef={focus}
          onStepChange={reveal}
          onClose={() => setTour(null)}
          onOverview={() => {
            reopen()
            setShowDirectory(true)
          }}
          persistent
          layer={130}
        />
      )}
      {active && showShortcut && !open && !tour && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={reopen}
          className="fixed bottom-4 right-4 z-[100] gap-2 shadow-md"
          aria-label="重新打开新功能指南"
        >
          <BookOpen className="size-4" />
          新功能指南
        </Button>
      )}
    </>
  )
}
