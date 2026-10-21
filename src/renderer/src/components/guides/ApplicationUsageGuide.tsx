import { useCallback, useEffect, useRef, useState } from "react"
import { useAppStore } from "@/lib/store"
import { useDevelopmentCreatorMode } from "@/lib/use-development-mode"
import { isDevelopmentThreadMetadata } from "../../../../shared/mods/development-scope"
import { AnchoredGuide, type AnchoredGuideStep } from "./AnchoredGuide"
import {
  applicationUsageGuideSteps,
  subscribeApplicationUsageGuide
} from "./application-usage-guide"

const config = { guideId: "application-controls-walkthrough", revision: 1, maxShowCount: 1 }

/** The existing chat help button opens this walkthrough across the real application controls. */
export function ApplicationUsageGuide({ active }: { active: boolean }) {
  const threadId = useAppStore((state) => state.currentThreadId)
  const workspace = useAppStore((state) => {
    const thread = state.threads.find((item) => item.thread_id === state.currentThreadId)
    const metadata = thread?.metadata as { workspacePath?: unknown } | undefined
    return active &&
      state.mainView === "thread" &&
      isDevelopmentThreadMetadata(thread?.metadata) &&
      typeof metadata?.workspacePath === "string" &&
      metadata.workspacePath.trim()
      ? metadata.workspacePath
      : null
  })
  const creator = useDevelopmentCreatorMode(active && workspace ? threadId : null, workspace)
  return active && creator ? <ActiveApplicationUsageGuide /> : null
}

function ActiveApplicationUsageGuide() {
  const rootRef = useRef<HTMLElement | null>(document.body)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const [request, setRequest] = useState(0)
  const [autoEligible, setAutoEligible] = useState(false)
  const [unobscured, setUnobscured] = useState(false)
  const eligibleRef = useRef(false)
  const scopeRef = useRef("")
  const [scope, setScope] = useState("")
  const [hasWorkspace, setHasWorkspace] = useState(false)
  useEffect(() => {
    let frame = 0
    let controls: HTMLElement[] = []
    let dialogs: Element[] = []
    const selectors =
      '[data-app-guide], [role="dialog"], [data-cmb-modal-dialog], [data-sparks-tour-open]'
    const visible = (element: Element) =>
      element.getClientRects().length > 0 &&
      !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
      getComputedStyle(element).visibility !== "hidden"
    const check = () => {
      frame = 0
      dialogs = Array.from(
        document.querySelectorAll(
          '[role="dialog"], [data-cmb-modal-dialog], [data-sparks-tour-open]'
        )
      )
      const blocked = dialogs.some(
        (element) => element.getAttribute("aria-label") !== "应用使用指引" && visible(element)
      )
      setUnobscured(!blocked)
      const state = useAppStore.getState()
      const thread = state.threads.find((item) => item.thread_id === state.currentThreadId)
      const metadata = thread?.metadata as { workspacePath?: unknown } | undefined
      const nextScope = JSON.stringify([
        state.accountRevision,
        state.currentThreadId,
        metadata?.workspacePath
      ])
      if (nextScope !== scopeRef.current) {
        scopeRef.current = nextScope
        setScope(nextScope)
        setRequest(0)
        returnFocusRef.current = null
      }
      controls = Array.from(document.querySelectorAll<HTMLElement>("[data-app-guide]"))
      const creator = controls
        .filter((element) => element.matches('[data-app-guide="creator"][aria-pressed="true"]'))
        .find(
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
      eligibleRef.current = eligible
      setHasWorkspace(
        controls
          .filter((element) => element.matches('[data-app-guide="workspace"]'))
          .some(
            (element) =>
              visible(element) &&
              element.closest("[data-chat-thread-id]")?.getAttribute("data-chat-thread-id") ===
                state.currentThreadId
          )
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check)
    }
    const relevant = (record: MutationRecord) => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement
      if (!target) return false
      if (target.closest(selectors)) return true
      if (record.type === "attributes")
        return [...controls, ...dialogs].some((element) => target.contains(element))
      return [...record.addedNodes, ...record.removedNodes].some(
        (node) =>
          node instanceof Element &&
          (node.matches(selectors) ||
            !!node.querySelector(selectors) ||
            [...controls, ...dialogs].some((element) => node.contains(element)))
      )
    }
    const observer = new MutationObserver((records) => {
      if (records.some(relevant)) schedule()
    })
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
    const callerKey = () =>
      JSON.stringify([
        useAppStore.getState().accountRevision,
        useAppStore.getState().currentThreadId,
        useAppStore.getState().mainView
      ])
    let caller = callerKey()
    const unsubscribe = useAppStore.subscribe(() => {
      const next = callerKey()
      if (caller !== next) {
        eligibleRef.current = false
        setAutoEligible(false)
        setRequest(0)
      }
      if (caller !== next) schedule()
      caller = next
    })
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
        if (!eligibleRef.current) return
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
      key={scope}
      active={autoEligible && unobscured}
      config={config}
      rootRef={rootRef}
      steps={applicationUsageGuideSteps.filter((step) => step.id !== "workspace" || hasWorkspace)}
      request={request}
      autoStart={autoEligible}
      hideTrigger
      dialogLabel="应用使用指引"
      returnFocusRef={returnFocusRef}
      onStepChange={reveal}
    />
  )
}
