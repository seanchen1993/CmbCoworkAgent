// Panel reads opened by the user stay independent. File-watcher refreshes can join a checkout
// that will already refresh the same worktree, even when the initiating view has unmounted.
const pending = new Map<Promise<void>, string>()
const listeners = new Set<() => void>()
let pendingRoots: ReadonlySet<string> = new Set()

function notifyGitCheckoutsChanged(): void {
  pendingRoots = new Set(pending.values())
  for (const listener of listeners) listener()
}

export function subscribeGitCheckouts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getPendingGitCheckoutRoots(): ReadonlySet<string> {
  return pendingRoots
}

export function worktreeRootKey(root: string): string {
  return window.electron?.process.platform === "win32" ? root.toLowerCase() : root
}

export function beginGitCheckout(root: string): () => void {
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  pending.set(done, worktreeRootKey(root))
  notifyGitCheckoutsChanged()
  return () => {
    if (pending.delete(done)) notifyGitCheckoutsChanged()
    finish()
  }
}

export function pendingGitCheckouts(roots: string[]): Promise<void> | undefined {
  if (!pending.size || !roots.length) return undefined
  const keys = new Set(roots.map(worktreeRootKey))
  // A multi-repository read can still update the other worktrees while one hook is running.
  for (const key of keys) {
    if (!pendingRoots.has(key)) return undefined
  }
  const matches: Promise<void>[] = []
  for (const [done, root] of pending) {
    if (keys.has(root)) matches.push(done)
  }
  return Promise.race(matches)
}
