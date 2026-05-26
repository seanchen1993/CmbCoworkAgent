import type { Thread } from "@/types"

export function isHarnessFeatureThread(thread: Thread | null | undefined): boolean {
  const harnessFeature = thread?.metadata?.harnessFeature
  if (!harnessFeature || typeof harnessFeature !== "object") {
    return false
  }

  const metadata = harnessFeature as Record<string, unknown>
  return typeof metadata.projectId === "string" && typeof metadata.slug === "string"
}

export function findFirstChatThread(threads: Thread[]): Thread | null {
  return threads.find((thread) => !isHarnessFeatureThread(thread)) ?? null
}
