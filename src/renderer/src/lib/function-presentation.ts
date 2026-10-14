import type { FunctionFeedbackEntry } from "../../../shared/mods/v2/ui-feedback"
import { isModSiteChangeScope } from "../../../shared/mods/types"
import type { FunctionPresentationSnapshot } from "../../../shared/mods/v2/presentation"
import {
  desktopChatRegions,
  desktopElementPresented,
  readDesktopPaneDrawings
} from "./function-desktop"

export interface FeedbackPresentation {
  entries: FunctionFeedbackEntry[]
  held: boolean
  owner?: string
}
const empty: FeedbackPresentation = { entries: [], held: false }
const owners = new Map<string, FunctionPresentation>()
const listeners = new Map<string, Set<() => void>>()
export const readFunctionPresentation = (thread: string): FeedbackPresentation =>
  owners.get(thread)?.snapshot ?? empty
export function subscribeFunctionPresentation(thread: string, listener: () => void): () => void {
  const group = listeners.get(thread) ?? new Set()
  listeners.set(thread, group)
  group.add(listener)
  return () => {
    group.delete(listener)
    if (!group.size) listeners.delete(thread)
  }
}
function notify(thread: string): void {
  for (const listener of listeners.get(thread) ?? []) listener()
}
export function readThreadToastBlock(thread: string): { present: boolean; held: boolean } {
  const root = document.querySelector<HTMLElement>(`[data-chat-thread-id="${CSS.escape(thread)}"]`)
  const present = desktopElementPresented(root)
  const regions = present && root ? desktopChatRegions(root, thread) : []
  return {
    present,
    held: regions.some((region) =>
      [...region.querySelectorAll<HTMLElement>("[data-function-hold-toasts='true']")].some(
        desktopElementPresented
      )
    )
  }
}
export function dismissFunctionToast(thread: string, id: string): void {
  owners.get(thread)?.dismiss(id)
}

/** One mounted chat, one coalesced layout observer; no periodic per-toast IPC. */
export class FunctionPresentation {
  snapshot: FeedbackPresentation = empty
  private publication: FunctionPresentationSnapshot = { entries: [] }
  private pendingDismiss = new Set<string>()
  private sequence = 0
  private request = 0
  private fingerprint = ""
  private frame = 0
  private closed = false
  private observer: MutationObserver
  private stopCards: () => void
  private root: () => HTMLElement | null
  constructor(
    private readonly thread: string,
    private readonly owner: string,
    root: () => HTMLElement | null,
    private ready: Promise<unknown>
  ) {
    owners.get(thread)?.close()
    owners.set(thread, this)
    this.snapshot = { entries: [], held: false, owner }
    notify(thread)
    this.root = root
    this.observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            this.relevant(record.target) ||
            [...record.addedNodes, ...record.removedNodes].some((node) => this.relevant(node))
        )
      )
        this.schedule()
    })
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "hidden",
        "inert",
        "aria-hidden",
        "style",
        "class",
        "data-function-pane-generation",
        "data-function-hold-toasts"
      ]
    })
    for (const name of ["scroll", "pointerover", "pointerout", "focusin", "focusout"])
      document.addEventListener(name, this.schedule, true)
    document.addEventListener("visibilitychange", this.visibility)
    window.addEventListener("resize", this.schedule)
    this.stopCards = window.api.mods.onCardsChanged((event) => {
      if (event.threadId !== thread || event.scope === "records" || isModSiteChangeScope(event.scope)) return
      if (event.scope === "panes") this.schedule()
      else this.refresh()
    })
    this.refresh()
  }
  private relevant(node: Node): boolean {
    if (!(node instanceof HTMLElement)) return false
    return Boolean(
      node.matches(
        "[data-function-panes], [data-function-pane-key], [data-function-feedback], [data-feedback-id], [data-claw-sidebar-host]"
      ) ||
      node.closest("[data-function-panes], [data-function-feedback], [data-claw-sidebar-host]") ||
      node.querySelector("[data-function-pane-key], [data-feedback-id]")
    )
  }
  rebind(ready: Promise<unknown>): void {
    this.ready = ready
    this.publication = { entries: [] }
    this.snapshot = { entries: [], held: false, owner: this.owner }
    this.fingerprint = ""
    notify(this.thread)
    this.refresh()
  }
  refresh = (): void => {
    const request = ++this.request
    void this.ready
      .then(() => window.api.mods.desktopFeedback(this.thread, this.owner))
      .then(
        (value) => {
          if (this.closed || request !== this.request) return
          this.publication = value
          const retained = new Set(
            value.entries.filter((row) => row.kind === "toast").map((row) => row.id)
          )
          for (const id of this.pendingDismiss)
            if (!retained.has(id)) this.pendingDismiss.delete(id)
          this.snapshot = {
            ...this.snapshot,
            entries: value.entries.filter((row) => !this.pendingDismiss.has(row.id))
          }
          this.fingerprint = ""
          notify(this.thread)
          this.schedule()
        },
        () => {
          if (this.closed || request !== this.request) return
          this.publication = { entries: [] }
          this.snapshot = { ...this.snapshot, entries: [] }
          notify(this.thread)
        }
      )
  }
  dismiss(id: string): void {
    if (!this.publication.entries.some((row) => row.id === id && row.kind === "toast")) return
    this.pendingDismiss.add(id)
    this.snapshot = {
      ...this.snapshot,
      entries: this.snapshot.entries.filter((row) => row.id !== id)
    }
    notify(this.thread)
    this.schedule()
  }
  private schedule = (): void => {
    if (this.closed || this.frame || document.visibilityState !== "visible") return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.layout()
    })
  }
  private visibility = (): void => {
    // Background Chromium can stop rAF entirely; the main clock must pause immediately.
    if (document.visibilityState !== "visible") {
      cancelAnimationFrame(this.frame)
      this.frame = 0
      this.layout()
    } else this.schedule()
  }
  private layout(): void {
    const root = this.root()
    const present = root?.dataset.chatThreadId === this.thread && desktopElementPresented(root)
    const regions = present && root ? desktopChatRegions(root, this.thread) : []
    const drawings = readDesktopPaneDrawings(regions).map((row) => {
      const node = regions
        .flatMap((region) => [...region.querySelectorAll<HTMLElement>("[data-function-pane-key]")])
        .find(
          (node) =>
            node.dataset.functionPaneKey === row.key &&
            node.dataset.functionPaneGeneration === row.generation
        )
      const shown = desktopElementPresented(node ?? null)
      return { ...row, isShown: shown, isFocused: shown && row.isFocused }
    })
    const held = regions.some((region) =>
      [...region.querySelectorAll<HTMLElement>("[data-function-hold-toasts='true']")].some(
        desktopElementPresented
      )
    )
    if (held !== this.snapshot.held) {
      this.snapshot = { ...this.snapshot, held }
      notify(this.thread)
    }
    const receipt = this.publication.receipt
    if (!receipt) return
    const ids = new Set(
      this.publication.entries.filter((row) => row.kind === "toast").map((row) => row.id)
    )
    const nodes = regions
      .flatMap((region) => [...region.querySelectorAll<HTMLElement>("[data-feedback-id]")])
      .filter((node) => ids.has(node.dataset.feedbackId!))
    const shown =
      !held && present
        ? nodes.filter(desktopElementPresented).map((node) => node.dataset.feedbackId!)
        : []
    const hovered = nodes
      .filter((node) => node.matches(":hover, :focus-within"))
      .map((node) => node.dataset.feedbackId!)
    const dismissed = [...this.pendingDismiss].filter((id) => ids.has(id))
    const content = {
      receipt,
      present: Boolean(present),
      panes: drawings,
      shown: [...new Set(shown)],
      hovered: [...new Set(hovered)],
      dismissed
    }
    const fingerprint = JSON.stringify(content)
    if (fingerprint === this.fingerprint) return
    this.fingerprint = fingerprint
    void window.api.mods
      .desktopPresent({
        ...content,
        threadId: this.thread,
        owner: this.owner,
        sequence: ++this.sequence
      })
      // A void ACK may be an ignored old receipt. Retain cancellation until a protected
      // new publication confirms absence; otherwise retry it with that new receipt.
      .catch(() => {
        if (!this.closed && this.publication.receipt === receipt) this.refresh()
      })
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.request++
    cancelAnimationFrame(this.frame)
    this.observer.disconnect()
    this.stopCards()
    for (const name of ["scroll", "pointerover", "pointerout", "focusin", "focusout"])
      document.removeEventListener(name, this.schedule, true)
    document.removeEventListener("visibilitychange", this.visibility)
    window.removeEventListener("resize", this.schedule)
    this.pendingDismiss.clear()
    if (owners.get(this.thread) === this) {
      owners.delete(this.thread)
      notify(this.thread)
    }
  }
}
