import React from "react"

export interface ChatVirtualPrependLayoutContext {
  windowKey: string
  firstItemIndex: number
  scrollParent: HTMLElement | null
}

interface Props extends React.ComponentPropsWithoutRef<"div"> {
  context?: ChatVirtualPrependLayoutContext
  forwardedRef: React.ForwardedRef<HTMLDivElement>
}

interface Anchor {
  element: HTMLElement
  offset: number
  viewport: HTMLElement
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

  private setRoot = (root: HTMLDivElement | null): void => {
    this.root = root
    this.assignRef(this.props.forwardedRef, root)
  }

  private assignRef(ref: React.ForwardedRef<HTMLDivElement>, root: HTMLDivElement | null): void {
    if (typeof ref === "function") ref(root)
    else if (ref) ref.current = root
  }

  getSnapshotBeforeUpdate(previous: Props): Anchor | null {
    const before = previous.context,
      after = this.props.context
    const viewport = after?.scrollParent
    if (
      !this.root ||
      !viewport ||
      !before ||
      !after ||
      before.windowKey !== after.windowKey ||
      before.scrollParent !== viewport ||
      after.firstItemIndex >= before.firstItemIndex
    )
      return null
    const bounds = viewport.getBoundingClientRect()
    for (const element of this.root.querySelectorAll<HTMLElement>("[data-chat-message-id]")) {
      const rect = element.getBoundingClientRect()
      if (rect.bottom > bounds.top && rect.top < bounds.bottom && rect.height > 0)
        return { element, offset: rect.top - bounds.top, viewport }
    }
    return null
  }

  componentDidUpdate(previous: Props, _state: unknown, snapshot: Anchor | null): void {
    if (previous.forwardedRef !== this.props.forwardedRef) {
      this.assignRef(previous.forwardedRef, null)
      this.assignRef(this.props.forwardedRef, this.root)
    }
    if (
      previous.context?.windowKey !== this.props.context?.windowKey ||
      previous.context?.scrollParent !== this.props.context?.scrollParent
    )
      this.finish()
    if (snapshot) {
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
