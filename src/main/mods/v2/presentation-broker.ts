import { randomUUID } from "node:crypto"
import {
  validatePresentationReport,
  type FunctionPresentationReport,
  type FunctionPresentationSnapshot
} from "../../../shared/mods/v2/presentation"
import type { FunctionFeedbackEntry } from "../../../shared/mods/v2/ui-feedback"

export interface NativePresentationBinding {
  entries: FunctionFeedbackEntry[]
  signal: AbortSignal
  assertLive(): void
  present(report: FunctionPresentationReport): void
  pause(): void
}
type Publication = {
  receipt: string
  binding: NativePresentationBinding
  ids: Set<string>
  sequence: number
  cleanup(): void
}

/** One instance belongs to the original native desktop owner object, never its reused string. */
export class FunctionPresentationPublisher {
  private publication?: Publication
  private revision = 0
  private closed = false

  async publish(
    read: () => Promise<NativePresentationBinding | undefined>
  ): Promise<FunctionPresentationSnapshot> {
    const revision = ++this.revision
    this.release()
    const binding = await read()
    if (this.closed || revision !== this.revision) throw Error("MODS_DESKTOP_OWNER")
    if (!binding) return { entries: [] }
    binding.assertLive()
    binding.signal.throwIfAborted()
    const receipt = randomUUID()
    const abort = () => {
      if (this.publication?.receipt === receipt) this.release()
    }
    this.publication = {
      receipt,
      binding,
      sequence: 0,
      ids: new Set(binding.entries.filter((row) => row.kind === "toast").map((row) => row.id)),
      cleanup: () => binding.signal.removeEventListener("abort", abort)
    }
    binding.signal.addEventListener("abort", abort, { once: true })
    return { receipt, entries: binding.entries }
  }

  report(report: FunctionPresentationReport): void {
    validatePresentationReport(report)
    const publication = this.publication
    if (
      this.closed ||
      !publication ||
      publication.receipt !== report.receipt ||
      report.sequence <= publication.sequence
    )
      return
    publication.binding.assertLive()
    publication.binding.signal.throwIfAborted()
    if (
      [...report.shown, ...report.hovered, ...report.dismissed].some(
        (id) => !publication.ids.has(id)
      )
    )
      throw Error("MODS_UI_PRESENTATION_ID")
    publication.sequence = report.sequence
    publication.binding.present(report)
  }

  private release(): void {
    const previous = this.publication
    this.publication = undefined
    if (!previous) return
    previous.cleanup()
    previous.binding.pause()
  }

  pause(): void {
    this.publication?.binding.pause()
  }

  close(): void {
    this.closed = true
    this.revision++
    this.release()
  }
}
