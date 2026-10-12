import { createHash } from "node:crypto"
import type { ElementHandle, Page } from "playwright"
import { BotDomainError } from "../../shared/bot-types"
import { canonicalJson } from "./validation"
import { refHandle } from "./upstream/grok-browser-actions.js"
import {
  normalizeSandBrowserExactActionArgs,
  normalizeSandBrowserElement
} from "./upstream/grok-browser-review-bounds"

type Element = ElementHandle<HTMLElement | SVGElement>
type Pages = () => { id: string; url: string }[]
/** A temporary view of the retained target, without handle ownership or a ref
 * resolver. Methods expire when the borrowing callback returns or review closes. */
export interface BotBrowserReviewedElement {
  evaluate<R>(operation: (node: HTMLElement | SVGElement) => R | Promise<R>): Promise<R>
  setInputFiles: Element["setInputFiles"]
}
export interface BotBrowserReview {
  readonly context: {
    targetPageUrl: string
    displayStateIdentity: string
    elements: unknown[]
    manualReason: string | null
    coordinateStateIdentity?: string
  }
  assert(page: Page, action: Record<string, unknown>): Promise<void>
  withElement<T>(
    index: number,
    operation: (element: BotBrowserReviewedElement) => Promise<T>
  ): Promise<T>
  dispose(): Promise<void>
}
const changed = () =>
  new BotDomainError("browser_review_changed", "页面或操作目标在审核后已变化，请重新观察并确认")
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")

/** Read semantic target metadata, never input values, cookies or storage. */
function inspect(element: Element) {
  return element.evaluate((node) => {
    if (!node.isConnected || node.ownerDocument !== document) return null
    const field =
      node instanceof HTMLInputElement ||
      node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement
        ? node
        : null
    const button = node instanceof HTMLButtonElement ? node : null
    const form = field?.form ?? button?.form
    const submitter =
      node instanceof HTMLInputElement || node instanceof HTMLButtonElement ? node : null
    const label = (
      node.getAttribute("aria-label") ||
      field?.labels?.[0]?.textContent ||
      (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? node.placeholder
        : "") ||
      (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement
        ? node.textContent
        : "") ||
      ""
    ).trim()
    const autocomplete = node.getAttribute("autocomplete") ?? ""
    const detail = {
      tag: node.tagName.toLowerCase(),
      id: node.id,
      role: node.getAttribute("role"),
      name: field?.name ?? button?.name ?? "",
      label,
      type: field instanceof HTMLInputElement ? field.type : (button?.type ?? null),
      disabled: Boolean(field?.disabled || button?.disabled),
      readonly: Boolean(
        (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
        field.readOnly
      ),
      checked:
        field instanceof HTMLInputElement && ["checkbox", "radio"].includes(field.type)
          ? field.checked
          : null,
      href: node instanceof HTMLAnchorElement ? node.href : null,
      formAction:
        field instanceof HTMLInputElement || button
          ? (node.hasAttribute("formaction")
              ? (field as HTMLInputElement | null)?.formAction || button?.formAction
              : null) ||
            form?.action ||
            null
          : (form?.action ?? null),
      formMethod: submitter?.hasAttribute("formmethod")
        ? submitter.formMethod
        : (form?.method ?? null),
      formEnctype: submitter?.hasAttribute("formenctype")
        ? submitter.formEnctype
        : (form?.enctype ?? null),
      formTarget: submitter?.hasAttribute("formtarget")
        ? submitter.formTarget
        : (form?.target ?? null),
      linkTarget: node instanceof HTMLAnchorElement ? node.target : null,
      download: node instanceof HTMLAnchorElement ? node.getAttribute("download") : null,
      sensitive:
        (field instanceof HTMLInputElement && field.type === "password") ||
        /(?:password|one-time-code|cc-number|cc-csc)/i.test(autocomplete)
    }
    return Object.values(detail).some((value) => typeof value === "string" && value.length > 8000)
      ? null
      : detail
  })
}

/** Coordinate operations bind the visible viewport, not just a semantic ref.
 * Only hashes survive this read; no screenshot/input values enter an approval
 * context or checkpoint. Dynamic pages may require a fresh explicit review. */
async function coordinateIdentity(page: Page, action: Record<string, unknown>, handles: Element[]) {
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollX,
    scrollY,
    scale: devicePixelRatio,
    visual: window.visualViewport
      ? {
          x: window.visualViewport.offsetLeft,
          y: window.visualViewport.offsetTop,
          width: window.visualViewport.width,
          height: window.visualViewport.height,
          scale: window.visualViewport.scale
        }
      : null
  }))
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    viewport.width * viewport.height > 4_194_304
  )
    throw changed()
  const boxes = await Promise.all(handles.map((handle) => handle.boundingBox()))
  const visiblePoint = (x: unknown, y: unknown) => {
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x >= viewport.width ||
      y >= viewport.height
    )
      throw changed()
  }
  for (const box of boxes) {
    if (!box || box.width <= 0 || box.height <= 0) throw changed()
    visiblePoint(box.x + box.width / 2, box.y + box.height / 2)
  }
  if (action.op === "mouse_click_xy") visiblePoint(action.x, action.y)
  if (action.op === "drag" && !action.targetRef) visiblePoint(action.targetX, action.targetY)
  if (action.op === "click" && boxes[0])
    visiblePoint(
      boxes[0].x + boxes[0].width / 2 + Number(action.offsetX ?? 0),
      boxes[0].y + boxes[0].height / 2 + Number(action.offsetY ?? 0)
    )
  const pixels = await page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 })
  return digest({ viewport, boxes, pixels: createHash("sha256").update(pixels).digest("hex") })
}

/** The original Grok page-identity fence, supplemented with actual DOM handles.
 * This object never enters a checkpoint; a recreated browser needs a new review. */
export async function prepareBotBrowserReview(
  page: Page,
  action: Record<string, unknown>,
  pages: Pages
): Promise<BotBrowserReview> {
  const actionHash = digest(action),
    url = page.url(),
    identity = () => digest(pages())
  const displayStateIdentity = identity()
  const document = await page.evaluateHandle(() => window.document)
  const elements: { handle: Element; resolve: () => Promise<Element> }[] = []
  let disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await Promise.all(
      [document.dispose(), ...elements.map(({ handle }) => handle.dispose())].map((work) =>
        work.catch(() => {})
      )
    )
  }
  try {
    let manualReason: string | null = null
    try {
      normalizeSandBrowserExactActionArgs({ ...action, op: String(action.op) })
      const purpose =
        typeof action.element === "string" ? normalizeSandBrowserElement(action.element) : undefined
      if (["click", "mouse_click_xy", "drag"].includes(String(action.op)) && !purpose)
        manualReason = "此操作缺少明确的目标与用途说明，需人工确认。"
    } catch {
      manualReason = "浏览器操作内容超出自动审核范围，需人工确认完整参数。"
    }
    const refs =
      action.op === "drag"
        ? [action.sourceRef, action.targetRef]
        : ["click", "fill", "type", "select_option"].includes(String(action.op))
          ? [action.ref]
          : []
    for (const ref of refs) {
      if (typeof ref !== "string" || !ref) {
        manualReason = "操作目标不完整，需人工确认。"
        continue
      }
      const resolve = () => refHandle(page, ref) as Promise<Element>
      elements.push({ handle: await resolve(), resolve })
    }
    if (action.op === "press_key") {
      const resolve = async () => {
        const handle = await page.evaluateHandle(() => window.document.activeElement)
        const element = handle.asElement()
        if (!element) {
          await handle.dispose()
          throw changed()
        }
        return element as Element
      }
      elements.push({ handle: await resolve(), resolve })
    }
    if (
      ["mouse_click_xy", "cdp", "drag"].includes(String(action.op)) ||
      action.offsetX ||
      action.offsetY
    )
      manualReason = "坐标、拖动或高级浏览器操作需人工确认。"
    const metadata = await Promise.all(elements.map(({ handle }) => inspect(handle)))
    if (metadata.some((value) => !value)) throw changed()
    if (metadata.some((value) => value?.sensitive))
      manualReason = "敏感输入目标需人工确认，请优先使用安全凭据工具。"
    if (metadata.some((value) => (value?.label.length ?? 0) > 500))
      manualReason = "目标说明过长，需人工确认。"
    const metadataHash = digest(metadata)
    const coordinates =
      ["mouse_click_xy", "drag"].includes(String(action.op)) ||
      typeof action.offsetX === "number" ||
      typeof action.offsetY === "number"
    const coordinateStateIdentity = coordinates
      ? await coordinateIdentity(
          page,
          action,
          elements.map(({ handle }) => handle)
        )
      : undefined
    const context = {
      targetPageUrl: url,
      displayStateIdentity,
      elements: metadata,
      manualReason,
      ...(coordinateStateIdentity ? { coordinateStateIdentity } : {})
    }
    return {
      context,
      dispose,
      async withElement<T>(
        index: number,
        operation: (element: BotBrowserReviewedElement) => Promise<T>
      ): Promise<T> {
        if (disposed || !Number.isSafeInteger(index) || index < 0 || !elements[index])
          throw changed()
        const handle = elements[index].handle
        let active = true
        const assertBorrow = () => {
          if (!active || disposed) throw changed()
        }
        const borrowed: BotBrowserReviewedElement = Object.freeze({
          async evaluate<R>(
            operation: (node: HTMLElement | SVGElement) => R | Promise<R>
          ): Promise<R> {
            assertBorrow()
            try {
              return await handle.evaluate(operation)
            } finally {
              assertBorrow()
            }
          },
          async setInputFiles(
            files: Parameters<Element["setInputFiles"]>[0],
            options?: Parameters<Element["setInputFiles"]>[1]
          ) {
            assertBorrow()
            try {
              await handle.setInputFiles(files, options)
            } finally {
              assertBorrow()
            }
          }
        })
        try {
          return await operation(borrowed)
        } finally {
          active = false
        }
      },
      async assert(currentPage, currentAction) {
        try {
          if (
            disposed ||
            currentPage !== page ||
            page.isClosed() ||
            page.url() !== url ||
            digest(currentAction) !== actionHash ||
            identity() !== displayStateIdentity ||
            !(await document.evaluate((original) => original === window.document))
          )
            throw changed()
          for (const item of elements) {
            const current = await item.resolve()
            try {
              if (!(await item.handle.evaluate((original, next) => original === next, current)))
                throw changed()
            } finally {
              await current.dispose().catch(() => {})
            }
          }
          if (
            digest(await Promise.all(elements.map(({ handle }) => inspect(handle)))) !==
            metadataHash
          )
            throw changed()
          if (
            coordinateStateIdentity &&
            (await coordinateIdentity(
              page,
              action,
              elements.map(({ handle }) => handle)
            )) !== coordinateStateIdentity
          )
            throw changed()
        } catch {
          throw changed()
        }
      }
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
