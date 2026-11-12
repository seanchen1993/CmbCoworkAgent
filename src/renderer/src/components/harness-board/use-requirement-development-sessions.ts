import { useEffect, useRef } from "react"
import { toast } from "sonner"
import { useAppStore } from "@/lib/store"
import {
  clearRequirementDevelopmentIntent,
  ensureRequirementDevelopmentPlugin,
  getRequirementDevelopmentMetadata,
  storeRequirementDevelopmentAssociation,
  REQUIREMENT_DEVELOPMENT_ONBOARDING_EVENT,
  REQUIREMENT_DEVELOPMENT_ONBOARDING_KEY,
  type RequirementDevelopmentIntent,
  type RequirementDevelopmentOnboardingIntent
} from "@/lib/requirement-development"
import type { HarnessProjectListItem } from "../../../../shared/harness-board-types"

export function useRequirementDevelopmentSessionRestore(): void {
  const addThreadSummary = useAppStore((state) => state.addThreadSummary)
  useEffect(() => {
    let cancelled = false
    void window.api.requirements
      .list()
      .then(async (requirements) => {
        const threads = new Map(
          useAppStore.getState().threads.map((thread) => [thread.thread_id, thread] as const)
        )
        const ids = [...new Set(requirements.flatMap((item) => item.developmentThreadIds ?? []))]
        const loaded = await Promise.all(
          ids
            .filter((threadId) => !getRequirementDevelopmentMetadata(threads.get(threadId)))
            .map((threadId) => window.api.threads.get(threadId).catch(() => null))
        )
        if (cancelled) return
        loaded.forEach((thread) => {
          if (thread) addThreadSummary(thread)
        })
      })
      .catch((error) => {
        console.warn("[HarnessBoard] Failed to restore requirement sessions:", error)
      })
    return () => {
      cancelled = true
    }
  }, [addThreadSummary])
}

export function useRequirementDevelopmentOnboarding(input: {
  openSession: (threadId: string, context: { projectId: string; featureSlug?: string }) => void
  openProjectChoice: (
    intent: RequirementDevelopmentIntent,
    projects: HarnessProjectListItem[]
  ) => void
}): void {
  useRequirementDevelopmentSessionRestore()
  const callbacksRef = useRef(input)
  callbacksRef.current = input

  useEffect(() => {
    const consumeIntent = (): void => {
      const raw = window.sessionStorage.getItem(REQUIREMENT_DEVELOPMENT_ONBOARDING_KEY)
      if (!raw) return
      try {
        const intent = JSON.parse(raw) as RequirementDevelopmentOnboardingIntent
        if (intent.action === "open-session") {
          window.sessionStorage.removeItem(REQUIREMENT_DEVELOPMENT_ONBOARDING_KEY)
          void (async () => {
            const state = useAppStore.getState()
            let thread = state.threads.find((item) => item.thread_id === intent.threadId) ?? null
            if (!thread) {
              thread = await window.api.threads.get(intent.threadId)
              if (thread) useAppStore.getState().addThreadSummary(thread)
            }
            if (!thread) throw new Error("未找到关联的开发会话")
            const requirementMetadata = getRequirementDevelopmentMetadata(thread)
            if (requirementMetadata) {
              storeRequirementDevelopmentAssociation(thread.thread_id, requirementMetadata)
            }
            const feature =
              thread.metadata?.harnessFeature &&
              typeof thread.metadata.harnessFeature === "object" &&
              !Array.isArray(thread.metadata.harnessFeature)
                ? (thread.metadata.harnessFeature as Record<string, unknown>)
                : null
            const projectId = typeof feature?.projectId === "string" ? feature.projectId : ""
            const featureSlug = typeof feature?.slug === "string" ? feature.slug : ""
            callbacksRef.current.openSession(
              intent.threadId,
              projectId && featureSlug ? { projectId, featureSlug } : { projectId: "" }
            )
          })().catch((error) => {
            toast.error(error instanceof Error ? error.message : "打开开发会话失败")
          })
          return
        }
        if (intent.action !== "create-development" || !intent.requirementId || !intent.prompt) {
          throw new Error("invalid requirement development intent")
        }
        void ensureRequirementDevelopmentPlugin()
          .then(() => window.api.harnessBoard.listProjects())
          .then((projects) => callbacksRef.current.openProjectChoice(intent, projects))
          .catch((error) => {
            clearRequirementDevelopmentIntent()
            toast.error(error instanceof Error ? error.message : "无法准备需求开发环境")
          })
      } catch {
        toast.error("无法读取需求开发上下文，请重试")
      }
    }
    consumeIntent()
    window.addEventListener(REQUIREMENT_DEVELOPMENT_ONBOARDING_EVENT, consumeIntent)
    return () => window.removeEventListener(REQUIREMENT_DEVELOPMENT_ONBOARDING_EVENT, consumeIntent)
  }, [])
}
