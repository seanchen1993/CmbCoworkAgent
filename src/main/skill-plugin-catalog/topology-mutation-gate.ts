import {
  bumpHookCatalogGlobalRevision,
  getHookCatalogGlobalRevision
} from "../hook-catalog/revision"

let activeTopologyMutations = 0
let resolveIdle: (() => void) | null = null
let idlePromise: Promise<void> = Promise.resolve()

/**
 * Fence an asynchronous skill/plugin catalog tree mutation. The leading and
 * trailing revisions prevent a Worker snapshot from representing either side
 * of a partially written directory tree, while the busy flag closes the gap
 * between an idle wait and the final synchronous disabled-store CAS.
 */
export function beginSkillCatalogTopologyMutation(): () => void {
  bumpHookCatalogGlobalRevision()
  if (activeTopologyMutations === 0) {
    idlePromise = new Promise<void>((resolve) => {
      resolveIdle = resolve
    })
  }
  activeTopologyMutations += 1

  let ended = false
  return () => {
    if (ended) return
    ended = true
    bumpHookCatalogGlobalRevision()
    activeTopologyMutations -= 1
    if (activeTopologyMutations === 0) {
      const completeIdle = resolveIdle
      resolveIdle = null
      idlePromise = Promise.resolve()
      completeIdle?.()
    }
  }
}

export function isSkillCatalogTopologyMutationBusy(): boolean {
  return activeTopologyMutations > 0
}

export async function waitForSkillCatalogTopologyIdle(): Promise<void> {
  while (activeTopologyMutations > 0) {
    const pendingIdle = idlePromise
    await pendingIdle
  }
}

export function getSkillCatalogTopologyRevision(): number {
  return getHookCatalogGlobalRevision()
}

export function resetSkillCatalogTopologyMutationGateForTests(): void {
  activeTopologyMutations = 0
  resolveIdle?.()
  resolveIdle = null
  idlePromise = Promise.resolve()
}
