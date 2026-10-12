import { setTimeout as delay } from "node:timers/promises"
import type { Frame, JSHandle, Page } from "playwright"
import type { BotHumanInput } from "../../shared/bot-computer"

class TeachDocumentChanged extends Error {}
const navigationContextLost = (error: unknown): boolean =>
  error instanceof TeachDocumentChanged ||
  (error instanceof Error &&
    /Execution context was destroyed|Cannot find context with specified id|Execution context is not available in detached frame/.test(
      error.message
    ))

/** Conservative visible credential-field gate, supplemented by the explicit user pause control.
 * Transient navigation is retried before capture, never treated as safe. Every
 * pass binds its own Documents and current frame set; an unknown failure or a
 * third unstable pass still pauses recording. No handles survive a pass.
 * It is not a claim to recognize secrets displayed as arbitrary text or in an image.
 */
export async function teachHasSensitiveInput(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const documents: { frame: Frame; document: JSHandle<Document> }[] = []
    let retry = false
    try {
      if (page.isClosed()) return true
      const frames = page.frames()
      if (!frames.length) return true
      for (const frame of frames) {
        if (frame.isDetached()) throw new TeachDocumentChanged()
        const document = await frame.evaluateHandle(() => window.document)
        documents.push({ frame, document })
        const sensitive = await document.evaluate((original) => {
          if (original !== window.document || original.readyState === "loading") return null
          // Keep the browser callback self-contained under both Vite and tsx transforms.
          const roots: (Document | ShadowRoot)[] = [original]
          while (roots.length) {
            const root = roots.pop()!
            for (const element of root.querySelectorAll("*")) {
              if (element.shadowRoot) roots.push(element.shadowRoot)
              if (!(element instanceof HTMLInputElement)) continue
              const marker = `${element.type} ${element.autocomplete} ${element.name} ${element.id}`
              if (!/password|one-time-code|cc-number|cc-csc|secret|token|api[_-]?key/i.test(marker))
                continue
              const rect = element.getBoundingClientRect(),
                style = getComputedStyle(element)
              if (
                rect.width > 0 &&
                rect.height > 0 &&
                style.visibility !== "hidden" &&
                style.display !== "none"
              )
                return true
            }
          }
          return false
        })
        if (sensitive === null) throw new TeachDocumentChanged()
        if (sensitive) return true
      }
      const current = page.frames()
      if (
        current.length !== frames.length ||
        current.some((frame, index) => frame !== frames[index])
      )
        throw new TeachDocumentChanged()
      for (const { frame, document } of documents)
        if (
          frame.isDetached() ||
          !(await document.evaluate(
            (original) => original === window.document && original.readyState !== "loading"
          ))
        )
          throw new TeachDocumentChanged()
      if (page.isClosed()) return true
      return false
    } catch (error) {
      if (!navigationContextLost(error) || attempt === 2 || page.isClosed()) return true
      retry = true
    } finally {
      await Promise.all(documents.map(({ document }) => document.dispose().catch(() => {})))
    }
    // Capture and input collection remain behind the existing service safety gate.
    if (retry) await delay(50)
  }
  return true
}

export function teachSafeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ""
    url.password = ""
    url.hash = ""
    for (const name of [...url.searchParams.keys()])
      if (/token|secret|password|auth|^code$|api.?key/i.test(name))
        url.searchParams.set(name, "[redacted]")
    return url.toString()
  } catch {
    return ""
  }
}

export async function teachInputDetails(
  page: Page,
  input: BotHumanInput
): Promise<Record<string, unknown>> {
  const element = await page
    .evaluate(
      ({ x, y, kind }) => {
        let target =
          kind === "click" && x !== undefined && y !== undefined
            ? document.elementFromPoint(x, y)
            : document.activeElement
        while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement
        if (!target) return null
        return {
          tag: target.tagName.toLowerCase(),
          role: target.getAttribute("role"),
          label: (
            target.getAttribute("aria-label") ||
            target.getAttribute("placeholder") ||
            (target instanceof HTMLInputElement
              ? Array.from(target.labels ?? [])
                  .map((label) => label.textContent)
                  .join(" ")
              : target.textContent) ||
            ""
          ).slice(0, 300)
        }
      },
      { x: input.x, y: input.y, kind: input.kind }
    )
    .catch(() => null)
  return {
    ...(element ? { element } : {}),
    ...(input.text !== undefined ? { text: input.text.slice(0, 2000) } : {}),
    ...(input.key !== undefined ? { key: input.key } : {}),
    ...(input.url !== undefined ? { url: teachSafeUrl(input.url) } : {}),
    ...(input.deltaY !== undefined ? { deltaY: input.deltaY } : {}),
    ...(input.x !== undefined ? { x: input.x, y: input.y } : {})
  }
}
