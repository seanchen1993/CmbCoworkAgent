import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"

interface Following {
  id: string
  body: HTMLElement
  top: number
  enabled: boolean
  child?: Element | null
  observer?: ResizeObserver
  frame?: number
}

/** Local permits never survive renderer reload, even if an old host token is still published. */
export class FunctionScrollFollow {
  private readonly sites = new Map<string, Following>()

  prepare(pane: string, id: string, body: HTMLElement): void {
    this.stop(pane)
    this.sites.set(pane, { id, body, top: body.scrollTop, enabled: false })
  }

  async acknowledge(
    pane: string,
    id: string,
    body: HTMLElement,
    followEnd: boolean,
    send: () => Promise<void>
  ): Promise<void> {
    if (followEnd) this.prepare(pane, id, body)
    else this.stop(pane)
    try {
      await send()
    } catch (error) {
      this.stop(pane, id)
      throw error
    }
  }

  stop(pane: string, id?: string): void {
    const site = this.sites.get(pane)
    if (id !== undefined && site?.id !== id) return
    site?.observer?.disconnect()
    if (site?.frame !== undefined) cancelAnimationFrame(site.frame)
    this.sites.delete(pane)
  }

  close(): void {
    for (const pane of this.sites.keys()) this.stop(pane)
  }

  observe(event: Event): void {
    for (const [pane, site] of this.sites) {
      const target = event.target
      if (!(target instanceof Node) || !site.body.contains(target)) continue
      if (
        (event.type === "scroll" &&
          target === site.body &&
          Math.abs(site.body.scrollTop - site.top) > 1) ||
        event.type === "wheel" ||
        (event instanceof KeyboardEvent &&
          ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
      )
        this.stop(pane)
    }
  }

  sync(panes: FunctionPaneSnapshot[], sections: Map<string, HTMLElement>): void {
    for (const [key, site] of this.sites) {
      const pane = panes.find((pane) => pane.key === key)
      const body = sections.get(key)?.querySelector<HTMLElement>("[data-function-pane-body]")
      if (
        !pane ||
        body !== site.body ||
        !body.isConnected ||
        (pane.scrollFollowToken !== site.id && pane.imperativeScroll?.id !== site.id)
      ) {
        this.stop(key)
        continue
      }
      if (pane.scrollFollowToken !== site.id) continue
      site.enabled = true
      const follow = () => {
        if (
          this.sites.get(key) !== site ||
          !site.enabled ||
          !site.body.isConnected ||
          document.visibilityState !== "visible"
        )
          return
        const max = site.body.scrollHeight - site.body.clientHeight
        if (
          Math.abs(site.body.scrollTop - site.top) > 1 &&
          !(site.top > max && Math.abs(site.body.scrollTop - max) <= 1)
        ) {
          this.stop(key)
          return
        }
        site.body.scrollTop = max
        site.top = site.body.scrollTop
      }
      if (!site.observer)
        site.observer = new ResizeObserver(() => {
          if (site.frame !== undefined) return
          site.frame = requestAnimationFrame(() => {
            site.frame = undefined
            follow()
          })
        })
      if (site.child !== body.firstElementChild) {
        site.observer.disconnect()
        site.child = body.firstElementChild
        site.observer.observe(body)
        if (site.child) site.observer.observe(site.child)
      }
      follow()
    }
  }
}
