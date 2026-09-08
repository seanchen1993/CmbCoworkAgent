export interface PostRunMemoryMaintenanceEligibility {
  memoryEnabled: boolean
  conversationLength: number
}

export function shouldSchedulePostRunMemoryMaintenance({
  memoryEnabled,
  conversationLength
}: PostRunMemoryMaintenanceEligibility): boolean {
  // Keep short turns eligible: the scope coalescer may merge them with a
  // running/pending batch whose aggregate conversation crosses the summary
  // threshold. Only turns with no usable conversation should be skipped here.
  return memoryEnabled && conversationLength > 0
}

/**
 * Run independent memory namespaces one at a time. A failed namespace must not
 * prevent later namespaces from being attempted, while callers can use the
 * returned successful entries to defer follow-up Dream work until every
 * summarization attempt has settled.
 */
export async function runMemoryNamespacesSequentially<Namespace>(
  namespaces: readonly Namespace[],
  summarize: (namespace: Namespace) => Promise<void>,
  onError?: (namespace: Namespace, error: unknown) => void
): Promise<Namespace[]> {
  const successful: Namespace[] = []

  for (const namespace of namespaces) {
    try {
      await summarize(namespace)
      successful.push(namespace)
    } catch (error) {
      try {
        onError?.(namespace, error)
      } catch {
        // Best-effort diagnostics must not skip the remaining namespace.
      }
    }
  }

  return successful
}
