import type { Page } from "playwright"

/** Isolated test page only. Stack collection changes timings; never use as a benchmark. */
export async function installChatScrollWriteDiagnostic(page: Page): Promise<void> {
  const install = () => {
    const writes: unknown[] = []
    Reflect.set(window, "chatScrollWriteDiagnostic", writes)
    function record(node: Element, operation: string, requestedTop: unknown): void {
      if (!node.matches("[data-radix-scroll-area-viewport]")) return
      const threadId = node.closest("[data-chat-thread-id]")?.getAttribute("data-chat-thread-id")
      if (!threadId) return
      const owners = Reflect.get(window, "chatAnchorOwnersDiagnostic")
      writes.push({
        atMs: performance.now(),
        operation,
        before: node.scrollTop,
        requestedTop: typeof requestedTop === "number" ? requestedTop : null,
        threadId,
        owners: owners instanceof Map ? [...owners.values()].slice(0, 8) : null,
        stack: new Error().stack?.slice(0, 2400) ?? ""
      })
      if (writes.length > 128) writes.shift()
    }
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!
    Object.defineProperty(Element.prototype, "scrollTop", {
      ...descriptor,
      set(this: Element, value: number) {
        record(this, "scrollTop", value)
        descriptor.set!.call(this, value)
      }
    })
    for (const method of ["scrollTo", "scrollBy"] as const) {
      const original = Element.prototype[method]
      Element.prototype[method] = function (this: Element, ...args: unknown[]) {
        const first = args[0]
        record(this, method, typeof first === "object" && first !== null
          ? Reflect.get(first, "top") : args[1])
        Reflect.apply(original, this, args)
      } as typeof original
    }
  }
  await page.evaluate(`((__name) => (${install.toString()}))(value => value)()`)
}
