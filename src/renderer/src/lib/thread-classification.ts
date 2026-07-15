import type { Thread } from "@/types"

export function isHarnessFeatureThread(thread: Thread | null | undefined): boolean {
  const harnessFeature = thread?.metadata?.harnessFeature
  if (!harnessFeature || typeof harnessFeature !== "object") {
    return false
  }

  const metadata = harnessFeature as Record<string, unknown>
  return typeof metadata.projectId === "string" && typeof metadata.slug === "string"
}

export function isHarnessProjectSessionThread(thread: Thread | null | undefined): boolean {
  const harnessProjectSession = thread?.metadata?.harnessProjectSession
  if (!harnessProjectSession || typeof harnessProjectSession !== "object") {
    return false
  }

  const metadata = harnessProjectSession as Record<string, unknown>
  return typeof metadata.projectId === "string" && typeof metadata.kind === "string"
}

export function isHarnessProjectModeThread(thread: Thread | null | undefined): boolean {
  return isHarnessFeatureThread(thread) || isHarnessProjectSessionThread(thread)
}

export function findFirstChatThread(threads: Thread[]): Thread | null {
  return threads.find((thread) => !isHarnessProjectModeThread(thread)) ?? null
}
