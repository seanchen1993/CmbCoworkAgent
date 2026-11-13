import React from "react"
import type { VirtuosoHandle } from "react-virtuoso"
import { isChatRowPresented } from "./chat-row-presentation"
import { hasChatViewportScrollOwner } from "./chat-viewport-scroll-owner"
import { isChatScrollNavigationActive } from "./chat-scroll-navigation"

export interface ChatVirtualPrependLayoutContext {
  windowKey: string
  firstItemIndex: number
  scrollParent: HTMLElement | null
  virtuosoRef?: React.RefObject<VirtuosoHandle | null>
}

interface Props extends React.ComponentPropsWithoutRef<"div"> {
  context?: ChatVirtualPrependLayoutContext
  forwardedRef: React.ForwardedRef<HTMLDivElement>
}

interface Anchor {
  kind: "prepend"
  element: HTMLElement
  offset: number
  viewport: HTMLElement
}

interface RangeSnapshot {
  kind: "range"
  root: HTMLDivElement
  viewport: HTMLElement
  windowKey: string
  firstItemIndex: number
  signature: string
  element: HTMLElement
  item: Element
  memberKey: string
  memberIndex: number
  messageId: string
  handle: VirtuosoHandle
  handleRef: React.RefObject<VirtuosoHandle | null>
}
interface RangeTask { snapshot: RangeSnapshot; frame?: number }
type Snapshot = Anchor | RangeSnapshot

interface Member { key: string; index: number | undefined }

function readMembers(props: Props): Member[] {
  return React.Children.toArray(props.children).flatMap(child => {
    if (!React.isValidElement<{ "data-index"?: number }>(child)) return []
    return [{ key: String(child.key ?? ""), index: child.props["data-index"] }]
  })
}

function signatureOf(members: Member[]): string {
  return members.map(member => `${member.key.length}:${member.key}:${member.index ?? ""}`).join("|")
}

function memberSignature(props: Props): string {
  return signatureOf(readMembers(props))
}

function rangeOwnerActive(viewport: HTMLElement): boolean {
  return isChatScrollNavigationActive(viewport) ||
    (["search", "session-restore", "history-restore", "detached"] as const)
      .some(kind => hasChatViewportScrollOwner(viewport, kind))
}

/**
 * Virtuoso applies prepend deviation as margin before its next-frame scrollBy.
 * Keep the existing, current DOM in place during that paint-only transaction;
 * native scroll offsets, item sizes and measured identities remain untouched.
 */
export class ChatVirtualPrependLayout extends React.Component<Props> {
  private root: HTMLDivElement | null = null
  private anchor: Anchor | null = null
  private correction = 0
  private frame: number | undefined
  private waitingFrame: number | undefined
  private frames = 0
  private rangeTask: RangeTask | null = null

  private setRoot = (root: HTMLDivElement | null): void => {
    this.root = root
    this.assignRef(this.props.forwardedRef, root)
  }

  private assignRef(ref: React.ForwardedRef<HTMLDivElement>, root: HTMLDivElement | null): void {
    if (typeof ref === "function") ref(root)
    else if (ref) ref.current = root
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const before = previous.context,
      after = this.props.context
    const viewport = after?.scrollParent
    if (
      !this.root ||
      !viewport ||
      !before ||
      !after ||
      before.windowKey !== after.windowKey ||
      before.scrollParent !== viewport
    )
      return null
    if (after.firstItemIndex === before.firstItemIndex) return this.snapshotRange(previous)
    if (after.firstItemIndex > before.firstItemIndex) return null
    const bounds = viewport.getBoundingClientRect()
    for (const element of this.root.querySelectorAll<HTMLElement>("[data-chat-message-id]")) {
      const rect = element.getBoundingClientRect()
      if (rect.bottom > bounds.top && rect.top < bounds.bottom && rect.height > 0)
        return { kind: "prepend", element, offset: rect.top - bounds.top, viewport }
    }
    return null
  }

  componentDidUpdate(previous: Props, _state: unknown, snapshot: Snapshot | null): void {
    if (previous.forwardedRef !== this.props.forwardedRef) {
      this.assignRef(previous.forwardedRef, null)
      this.assignRef(this.props.forwardedRef, this.root)
    }
    if (
      previous.context?.windowKey !== this.props.context?.windowKey ||
      previous.context?.scrollParent !== this.props.context?.scrollParent
    ) {
      this.finish()
      this.cancelRangeTask()
    }
    if (previous.context?.firstItemIndex !== this.props.context?.firstItemIndex) this.cancelRangeTask()
    if (snapshot?.kind === "range") this.queueRangeRefresh(snapshot)
    if (snapshot?.kind === "prepend") {
      this.finish()
      this.anchor = snapshot
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
        snapshot.viewport.addEventListener(event, this.finish, { passive: true, capture: true })
      snapshot.viewport.parentElement?.addEventListener("pointerdown", this.finish, true)
      // A prepend without a native deviation must not retain an old DOM anchor
      // for an unrelated later resize. This performs no extra geometry read.
      this.waitingFrame = requestAnimationFrame(() => {
        this.waitingFrame = undefined
        if (this.frame === undefined) this.finish()
      })
    }
    const deviation = this.props.style?.marginTop
    if (this.anchor && typeof deviation === "number" && deviation > 0) {
      if (this.waitingFrame !== undefined) cancelAnimationFrame(this.waitingFrame)
      this.waitingFrame = undefined
      this.updateCorrection()
      if (this.anchor && this.frame === undefined) this.frame = requestAnimationFrame(this.poll)
    } else if (this.frame !== undefined) this.finish()
  }

  componentWillUnmount(): void {
    this.finish()
    this.cancelRangeTask()
  }

  private snapshotRange(previous: Props): RangeSnapshot | null {
    const context = this.props.context, root = this.root, viewport = context?.scrollParent
    if (this.rangeTask || this.anchor || !root || !root.isConnected || !viewport ||
      !viewport.isConnected || !context || this.props.style?.translate !== undefined ||
      (typeof this.props.style?.marginTop === "number" && this.props.style.marginTop !== 0) ||
      rangeOwnerActive(viewport)) return null
    const next = readMembers(this.props), old = readMembers(previous), signature = signatureOf(next)
    if (signature === signatureOf(old)) return null
    const oldKeys = new Map<number, string>(), retained = new Map<number, string>()
    for (const member of old) if (member.index !== undefined) oldKeys.set(member.index, member.key)
    for (const member of next) {
      if (member.index !== undefined && oldKeys.get(member.index) === member.key)
        retained.set(member.index, member.key)
    }
    if (retained.size === 0) return null
    const forward = next[0]?.index !== undefined && old[0]?.index !== undefined &&
      next[0].index < old[0].index
    // Read the native handle only at this actual commit, never during render.
    const handle = context.virtuosoRef?.current
    if (!handle) return null
    const bounds = viewport.getBoundingClientRect()
    let weak: RangeSnapshot | null = null
    for (const item of root.children) {
      const rawIndex = item.getAttribute("data-index")
      if (rawIndex === null) continue
      const memberIndex = Number(rawIndex), memberKey = retained.get(memberIndex)
      if (memberKey === undefined) continue
      for (const element of item.querySelectorAll<HTMLElement>("[data-chat-message-id]")) {
        if (!isChatRowPresented(element)) continue
        const row = element.getBoundingClientRect()
        if (row.height <= 0) continue
        const possiblyVisible = row.bottom > bounds.top && row.top < bounds.bottom
        if (!possiblyVisible && (!forward || weak)) continue
        for (const body of element.querySelectorAll<HTMLElement>("[data-chat-search-text]")) {
          if (body.closest('[aria-hidden="true"]') ||
            (typeof body.checkVisibility === "function" &&
              !body.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) continue
          const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            const value = text.nodeValue ?? "", nonempty = /\S/.exec(value)
            if (!nonempty) continue
            const range = body.ownerDocument.createRange()
            let qualified = false
            if (possiblyVisible) {
              range.selectNodeContents(text)
              for (const rect of range.getClientRects()) {
                if (rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom &&
                  rect.right > bounds.left && rect.left < bounds.right) {
                  qualified = true
                  break
                }
              }
            } else {
              // A layout-only fallback needs one real line box, not all rects of
              // an offscreen giant text. Preserve complete Unicode code points.
              const start = nonempty.index, point = value.codePointAt(start)!
              range.setStart(text, start)
              range.setEnd(text, start + (point > 0xffff ? 2 : 1))
              const rect = range.getBoundingClientRect()
              qualified = rect.width > 0 && rect.height > 0 &&
                rect.right > bounds.left && rect.left < bounds.right
            }
            if (!qualified) continue
            const snapshot: RangeSnapshot = { kind: "range", root, viewport,
              windowKey: context.windowKey, firstItemIndex: context.firstItemIndex, signature,
              item, memberKey, memberIndex, element,
              messageId: element.dataset.chatMessageId ?? "", handle, handleRef: context.virtuosoRef! }
            if (possiblyVisible) return snapshot
            weak = snapshot
            break
          }
          if (!possiblyVisible && weak) break
        }
      }
    }
    // This retained offscreen body grants measurement only. Native compensation
    // still owns positioning; no old offset is restored or guessed here.
    return weak
  }

  private rangeCurrent(task: RangeTask): boolean {
    const snapshot = task.snapshot, context = this.props.context
    return this.rangeTask === task && this.root === snapshot.root &&
      snapshot.root.isConnected && snapshot.viewport.isConnected &&
      context?.windowKey === snapshot.windowKey && context.scrollParent === snapshot.viewport &&
      context.firstItemIndex === snapshot.firstItemIndex &&
      context.virtuosoRef === snapshot.handleRef && context.virtuosoRef.current === snapshot.handle &&
      memberSignature(this.props) === snapshot.signature && !this.anchor &&
      this.props.style?.translate === undefined &&
      !(typeof this.props.style?.marginTop === "number" && this.props.style.marginTop !== 0) &&
      !rangeOwnerActive(snapshot.viewport) && snapshot.root.contains(snapshot.element) &&
      snapshot.item.parentElement === snapshot.root && snapshot.item.contains(snapshot.element) &&
      snapshot.item.getAttribute("data-index") !== null &&
      Number(snapshot.item.getAttribute("data-index")) === snapshot.memberIndex &&
      readMembers(this.props).some(member => member.key === snapshot.memberKey &&
        member.index === snapshot.memberIndex) &&
      snapshot.element.dataset.chatMessageId === snapshot.messageId &&
      isChatRowPresented(snapshot.element)
  }

  private queueRangeRefresh(snapshot: RangeSnapshot): void {
    if (this.rangeTask) return
    const task: RangeTask = { snapshot }
    this.rangeTask = task
    // The parent native list rebinds its layout subscription after this child's
    // didUpdate. An immediate stream publication here would have no listener.
    queueMicrotask(() => {
      if (!this.rangeCurrent(task)) {
        if (this.rangeTask === task) this.cancelRangeTask()
        return
      }
      // Keep the exact token across the resulting React commit chain. One
      // checkpoint releases it without automatically scheduling another refresh.
      task.frame = requestAnimationFrame(() => {
        if (this.rangeTask === task) this.rangeTask = null
      })
      snapshot.handle.refreshItemSizes()
    })
  }

  private cancelRangeTask(): void {
    const task = this.rangeTask
    this.rangeTask = null
    if (task?.frame !== undefined) cancelAnimationFrame(task.frame)
  }

  private updateCorrection(): void {
    const anchor = this.anchor,
      root = this.root
    if (
      !anchor ||
      !root ||
      !root.contains(anchor.element) ||
      !anchor.viewport.isConnected ||
      this.props.style?.translate !== undefined
    ) {
      this.finish()
      return
    }
    const relativeTop =
      anchor.element.getBoundingClientRect().top -
      anchor.viewport.getBoundingClientRect().top -
      this.correction
    this.correction = anchor.offset - relativeTop
    root.style.translate = this.correction ? `0 ${this.correction}px` : ""
  }

  private poll = (): void => {
    this.frame = undefined
    this.updateCorrection()
    // The library's native transaction is two frames. Never keep an unrelated
    // scroll or a broken virtual window pinned behind a permanent transform.
    if (this.anchor && ++this.frames < 3) this.frame = requestAnimationFrame(this.poll)
    else this.finish()
  }

  private finish = (): void => {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame)
    if (this.waitingFrame !== undefined) cancelAnimationFrame(this.waitingFrame)
    if (this.anchor) {
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"])
        this.anchor.viewport.removeEventListener(event, this.finish, true)
      this.anchor.viewport.parentElement?.removeEventListener("pointerdown", this.finish, true)
    }
    this.frame = undefined
    this.waitingFrame = undefined
    if (this.root) this.root.style.translate = String(this.props.style?.translate ?? "")
    this.anchor = null
    this.correction = 0
    this.frames = 0
  }

  render(): React.JSX.Element {
    const { context: _context, forwardedRef: _forwardedRef, ...props } = this.props
    void _context
    void _forwardedRef
    return <div {...props} ref={this.setRoot} />
  }
}
