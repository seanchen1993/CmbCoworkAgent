import { useCallback, useEffect, useRef, useState } from "react"
import { useAppStore } from "@/lib/store"
import { isDevelopmentThreadMetadata } from "../../../../shared/mods/development-scope"
import { AnchoredGuide, type AnchoredGuideStep } from "./AnchoredGuide"
import {
  applicationUsageGuideSteps,
  subscribeApplicationUsageGuide
} from "./application-usage-guide"

const config = { guideId: "application-controls-walkthrough", revision: 1, maxShowCount: 1 }

/** The existing chat help button opens this walkthrough across the real application controls. */
export function ApplicationUsageGuide({ active }: { active: boolean }) {
  return active ? <ActiveApplicationUsageGuide /> : null
}

function ActiveApplicationUsageGuide() {
  const rootRef = useRef<HTMLElement | null>(document.body)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [request, setRequest] = useState(0)
  const [autoEligible, setAutoEligible] = useState(false)
  const [unobscured, setUnobscured] = useState(false)
  useEffect(() => {
    let frame = 0
    const visible = (element: Element) =>
      element.getClientRects().length > 0 &&
      !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
      getComputedStyle(element).visibility !== "hidden"
    const check = () => {
      frame = 0
      const blocked = Array.from(
        document.querySelectorAll(
          '[role="dialog"], [data-cmb-modal-dialog], [data-sparks-tour-open]'
        )
      ).some((element) => element.getAttribute("aria-label") !== "应用使用指引" && visible(element))
      setUnobscured(!blocked)
      const state = useAppStore.getState()
      const thread = state.threads.find((item) => item.thread_id === state.currentThreadId)
      const metadata = thread?.metadata as { workspacePath?: unknown } | undefined
      const creator = Array.from(
        document.querySelectorAll<HTMLElement>('[data-app-guide="creator"][aria-pressed="true"]')
      ).find(
        (element) =>
          visible(element) &&
          element.closest("[data-chat-thread-id]")?.getAttribute("data-chat-thread-id") ===
            state.currentThreadId &&
          !element.closest('[aria-busy="true"]')
      )
      const eligible =
        !blocked &&
        document.visibilityState !== "hidden" &&
        state.mainView === "thread" &&
        !!thread &&
        isDevelopmentThreadMetadata(thread.metadata) &&
        typeof metadata?.workspacePath === "string" &&
        !!metadata.workspacePath.trim() &&
        !!creator
      if (eligible && !returnFocusRef.current)
        returnFocusRef.current =
          document.activeElement instanceof HTMLElement && document.activeElement !== document.body
            ? document.activeElement
            : (creator ?? null)
      setAutoEligible(eligible)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-pressed",
        "aria-busy",
        "data-chat-thread-id",
        "hidden",
        "inert",
        "aria-hidden",
        "class",
        "style",
        "role"
      ]
    })
    const unsubscribe = useAppStore.subscribe(schedule)
    document.addEventListener("visibilitychange", schedule)
    schedule()
    return () => {
      observer.disconnect()
      unsubscribe()
      cancelAnimationFrame(frame)
      document.removeEventListener("visibilitychange", schedule)
    }
  }, [])
  useEffect(
    () =>
      subscribeApplicationUsageGuide(() => {
        returnFocusRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        setRequest((current) => current + 1)
      }),
    []
  )
  const reveal = useCallback((step: AnchoredGuideStep) => {
    // Expanding navigation is a reversible view action. Do not click any target control.
    if (step.id === "customize") useAppStore.getState().setSidebarCollapsed(false)
  }, [])
  return (
    <AnchoredGuide
      active={unobscured}
      config={config}
      rootRef={rootRef}
      steps={applicationUsageGuideSteps}
      request={request}
      autoStart={autoEligible}
      hideTrigger
      dialogLabel="应用使用指引"
      returnFocusRef={returnFocusRef}
      onStepChange={reveal}
    />
  )
}
