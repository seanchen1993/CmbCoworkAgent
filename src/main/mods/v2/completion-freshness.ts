import { sameCompletionBinding, type CompletionEvidenceBinding } from "./completion-evidence"
import { isSameWorkspacePath } from "../../../shared/workspace-path"

interface Proof {
  binding: CompletionEvidenceBinding
  capture(signal: AbortSignal): Promise<CompletionEvidenceBinding>
}

/** Host-only freshness checks. No guest calls, model calls, or background polling. */
export class CompletionFreshness {
  private readonly proofs = new Map<string, Proof>()
  private timer?: ReturnType<typeof setTimeout>
  private controller?: AbortController
  private dirty = false
  private closed = false

  constructor(
    private readonly stale: (id: string, binding: CompletionEvidenceBinding, reason: string) => void
  ) {}

  track(id: string, binding: CompletionEvidenceBinding, capture: Proof["capture"]): void {
    if (this.closed) return
    if (this.proofs.size >= 32 && !this.proofs.has(id)) {
      const [oldest, proof] = this.proofs.entries().next().value!
      this.invalidate(oldest, proof, "evidence-retention-limit")
    }
    this.proofs.set(id, { binding, capture })
  }

  changed(): void {
    if (this.closed || !this.proofs.size) return
    this.dirty = true
    if (this.timer || this.controller) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.recheck()
    }, 75)
    this.timer.unref()
  }

  matchesWorkspace(workspace: string): boolean {
    return [...this.proofs.values()].some((proof) =>
      isSameWorkspacePath(proof.binding.workspace, workspace)
    )
  }

  private invalidate(id: string, proof: Proof, reason: string): void {
    if (this.proofs.get(id) !== proof) return
    this.proofs.delete(id)
    try {
      this.stale(id, proof.binding, reason)
    } catch (error) {
      // Authority teardown must still stop the runtime when storage is unavailable.
      // No proof remains live, and no checkpoint can reuse this failed publication.
      console.warn("[Mods] Unable to persist evidence invalidation", error)
    }
  }

  private async recheck(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    this.dirty = false
    // Bound the whole sweep, not each proof independently. An uncooperative capture
    // cannot retain this monitor indefinitely; late results cannot restore a PASS.
    let rejectTimeout!: (error: Error) => void
    const aborted = new Promise<never>((_, reject) => {
      rejectTimeout = reject
    })
    const onAbort = () => rejectTimeout(controller.signal.reason)
    controller.signal.addEventListener("abort", onAbort, { once: true })
    const timeout = setTimeout(
      () => controller.abort(Error("COMPLETION_FRESHNESS_TIMEOUT")),
      10_000
    )
    timeout.unref()
    try {
      for (const [id, proof] of [...this.proofs]) {
        if (this.closed) break
        try {
          controller.signal.throwIfAborted()
          const actual = await Promise.race([proof.capture(controller.signal), aborted])
          if (!this.closed && !sameCompletionBinding(proof.binding, actual))
            this.invalidate(id, proof, "input-changed")
        } catch (error) {
          if (!this.closed)
            this.invalidate(
              id,
              proof,
              error instanceof Error ? error.message.slice(0, 2048) : "COMPLETION_FRESHNESS_FAILED"
            )
        }
      }
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener("abort", onAbort)
      this.controller = undefined
      if (this.dirty) this.changed()
    }
  }

  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort(Error(reason))
    for (const [id, proof] of this.proofs) this.invalidate(id, proof, reason)
  }
}
