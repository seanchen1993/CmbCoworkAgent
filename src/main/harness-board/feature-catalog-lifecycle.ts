type CatalogListener = (projectId: string, featureSlugs: ReadonlySet<string>) => void
const listeners = new Set<CatalogListener>()
const currentReads = new Map<string, symbol>()

export function onHarnessFeatureCatalogChange(listener: CatalogListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(projectId: string, slugs: ReadonlySet<string>): void {
  for (const listener of listeners) {
    try {
      listener(projectId, slugs)
    } catch (error) {
      // The project mutation has already committed. A later catalog read can retry cleanup.
      console.error("[HarnessBoard] Feature catalog listener failed", error)
    }
  }
}

export function harnessProjectDeleted(projectId: string): void {
  currentReads.delete(projectId)
  publish(projectId, new Set())
}

/** Reads from the board, Bot and background reporter can finish out of order. */
export function beginHarnessFeatureCatalogRead(projectIds: readonly string[]) {
  const token = Symbol()
  for (const id of projectIds) currentReads.set(id, token)
  return {
    observed(projectId: string, runs: { slug: string }[]) {
      if (currentReads.get(projectId) === token && listeners.size)
        publish(projectId, new Set(runs.map((run) => run.slug)))
    },
    finish() {
      for (const id of projectIds) if (currentReads.get(id) === token) currentReads.delete(id)
    }
  }
}

/** A successful but stale asynchronous access check must not recreate a removed follow. */
export async function withCurrentHarnessFeature<T, R>(
  projectId: string,
  slug: string,
  read: () => Promise<T>,
  commit: (result: T) => R
): Promise<R> {
  let removed = false
  const stop = onHarnessFeatureCatalogChange((id, slugs) => {
    if (id === projectId && !slugs.has(slug)) removed = true
  })
  try {
    const result = await read()
    if (removed) throw new Error("项目或 Feature 已删除，请刷新后重试")
    return commit(result)
  } finally {
    stop()
  }
}
