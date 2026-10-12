import { createHash, randomUUID } from "node:crypto"
import type { ElementHandle, Frame, Page } from "playwright"
import type { BotNativeSelect, BotNativeSelectOption } from "../../shared/bot-computer"
import { BotDomainError } from "../../shared/bot-types"
import type { GrokBrowserInputGuard } from "./upstream/grok-browser-actions.js"

type SelectHandle = ElementHandle<HTMLSelectElement>
type Snapshot = {
  label: string
  multiple: boolean
  options: BotNativeSelectOption[]
  fingerprint: string
}
type Receipt = {
  page: Page
  handle: SelectHandle
  snapshot: Snapshot
  view: BotNativeSelect
}

/** Trusted browser observation only. No hidden option values are sent to the UI or Teach. */
export interface BotNativeSelectObservation {
  label: string
  multiple: boolean
  requested: number[]
  selected: number[]
  labels: { index: number; label: string }[]
  labelsTruncated: boolean
}

async function snapshot(handle: SelectHandle, requireFocus: boolean): Promise<Snapshot | null> {
  // This callback is self-contained in the document's realm, including iframe realms.
  const value = await handle.evaluate((element, focused) => {
    if (
      !(element instanceof HTMLSelectElement) ||
      !element.isConnected ||
      element.matches(":disabled")
    )
      return null
    const visible = (item: Element) => {
      for (let current: Element | null = item; current; current = current.parentElement) {
        const currentStyle = getComputedStyle(current)
        if (
          (current instanceof HTMLElement && current.hidden) ||
          currentStyle.display === "none" ||
          currentStyle.visibility !== "visible" ||
          Number(currentStyle.opacity) === 0
        )
          return false
      }
      return true
    }
    let active = document.activeElement
    for (let depth = 0; depth < 32 && active?.shadowRoot?.activeElement; depth++)
      active = active.shadowRoot.activeElement
    if (focused && active !== element) return null
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element)
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      !visible(element) ||
      style.visibility !== "visible" ||
      style.display === "none"
    )
      return null
    if (element.options.length > 256) return null
    let size = 0,
      unavailableSelected = false
    const options: BotNativeSelectOption[] = [],
      identity: unknown[] = []
    for (let index = 0; index < element.options.length; index++) {
      const option = element.options[index],
        group = option.parentElement
      const grouped = group instanceof HTMLOptGroupElement
      const label = option.label,
        groupLabel = grouped ? group.label : ""
      // Bound the complete identity, rather than silently authorizing a truncated option list.
      if (label.length > 1024 || option.value.length > 1024 || groupLabel.length > 1024) return null
      size += label.length + option.value.length + groupLabel.length
      if (size > 64_000) return null
      const disabled = option.disabled || (grouped && group.disabled)
      const optionVisible = visible(option)
      identity.push([label, option.value, groupLabel, disabled, optionVisible])
      if (!optionVisible || disabled) {
        unavailableSelected ||= option.selected
        continue
      }
      options.push({
        index,
        label: label.slice(0, 160),
        ...(grouped ? { group: groupLabel.slice(0, 160) } : {}),
        selected: option.selected
      })
    }
    if (!options.length || (element.multiple && unavailableSelected)) return null
    const label = (
      element.getAttribute("aria-label") ||
      Array.from(element.labels ?? [])
        .map((item) => item.textContent)
        .join(" ") ||
      "选择选项"
    ).slice(0, 160)
    return {
      label,
      multiple: element.multiple,
      options,
      identity: JSON.stringify([element.multiple, identity])
    }
  }, requireFocus)
  if (!value) return null
  return {
    label: value.label,
    multiple: value.multiple,
    options: value.options,
    fingerprint: createHash("sha256").update(value.identity).digest("hex")
  }
}

/** Follow only the active focus chain; never enumerate unrelated frame contents. */
async function focusedSelect(page: Page): Promise<SelectHandle | null> {
  let frame: Frame | null = page.mainFrame()
  for (let depth = 0; frame && depth < 16; depth++) {
    const candidate = await frame.evaluateHandle(() => {
      let element = document.activeElement
      for (let index = 0; index < 32 && element?.shadowRoot?.activeElement; index++)
        element = element.shadowRoot.activeElement
      return element
    })
    const element = candidate.asElement()
    let retained = false
    try {
      if (!element) return null
      const kind = await element.evaluate((item) => item.tagName.toLowerCase())
      if (kind === "select") {
        retained = true
        return element as SelectHandle
      }
      if (kind !== "iframe" && kind !== "frame") return null
      frame = await element.contentFrame()
    } finally {
      if (!retained) await candidate.dispose().catch(() => {})
    }
  }
  return null
}

async function focusedAncestors(page: Page, handle: SelectHandle): Promise<boolean> {
  let frame = await handle.ownerFrame()
  for (let depth = 0; frame && depth < 16; depth++) {
    const parent = frame.parentFrame()
    if (!parent) return frame === page.mainFrame()
    const iframe = await frame.frameElement()
    try {
      if (
        !(await iframe.evaluate((element) => {
          let active = document.activeElement
          for (let index = 0; index < 32 && active?.shadowRoot?.activeElement; index++)
            active = active.shadowRoot.activeElement
          return element.isConnected && active === element
        }))
      )
        return false
    } finally {
      await iframe.dispose().catch(() => {})
    }
    frame = parent
  }
  return false
}

function observation(value: Snapshot, requested: number[]): BotNativeSelectObservation {
  const selected = value.options.filter((option) => option.selected)
  return {
    label: value.label.slice(0, 80),
    multiple: value.multiple,
    requested: [...requested],
    selected: selected.map((option) => option.index),
    // Keep the Teach event below its existing 4 KB bound, even for a 256-item multiple select.
    labels: selected.slice(0, 4).map((option) => ({
      index: option.index,
      label: option.label.slice(0, 24)
    })),
    labelsTruncated: selected.length > 4
  }
}

/** One retained element per surface. Frame/control invalidation revokes authority immediately;
 * the next capture joins disposal before retaining a replacement. */
export class BotNativeSelectController {
  private receipt?: Receipt
  private disposal = Promise.resolve()
  private version = 0
  private suppressed = false
  private lease?: ReturnType<typeof setTimeout>
  private renew(): void {
    clearTimeout(this.lease)
    this.lease = setTimeout(() => this.invalidate(), 15_000)
    this.lease.unref()
  }

  keepAlive(): void {
    if (this.receipt) this.renew()
  }
  private dispose(handle: SelectHandle): Promise<void> {
    const next = this.disposal.then(() => handle.dispose().catch(() => {}))
    this.disposal = next
    return next
  }
  invalidate(): void {
    this.version++
    clearTimeout(this.lease)
    this.lease = undefined
    const receipt = this.receipt
    this.receipt = undefined
    if (receipt) void this.dispose(receipt.handle)
  }
  /** Only an explicit browser input reopens a chooser after selection/dismissal. */
  reset(): void {
    this.invalidate()
    this.suppressed = false
  }
  async close(): Promise<void> {
    this.invalidate()
    await this.disposal
  }
  async capture(page: Page): Promise<BotNativeSelect | undefined> {
    if (this.suppressed) return undefined
    const version = this.version
    await this.disposal
    if (version !== this.version) return undefined
    const previous = this.receipt
    if (previous?.page === page) {
      const current = await snapshot(previous.handle, true).catch(() => null)
      if (
        current &&
        current.fingerprint === previous.snapshot.fingerprint &&
        (await focusedAncestors(page, previous.handle).catch(() => false))
      ) {
        if (version !== this.version || this.receipt !== previous) return undefined
        previous.snapshot = current
        previous.view = {
          ...previous.view,
          label: current.label,
          options: current.options
        }
        this.renew()
        return previous.view
      }
    }
    this.invalidate()
    await this.disposal
    const freshVersion = this.version
    const handle = await focusedSelect(page).catch(() => null)
    if (!handle) return undefined
    let retained = false
    try {
      const current = await snapshot(handle, true)
      if (!current || freshVersion !== this.version || this.suppressed) return undefined
      const view: BotNativeSelect = {
        token: randomUUID(),
        label: current.label,
        multiple: current.multiple,
        options: current.options
      }
      this.receipt = { page, handle, snapshot: current, view }
      retained = true
      this.renew()
      return view
    } finally {
      if (!retained) await this.dispose(handle)
    }
  }
  private consume(token: unknown): Receipt {
    const receipt = this.receipt
    if (typeof token !== "string" || !receipt || token !== receipt.view.token)
      throw new BotDomainError("stale_frame", "选项已变化，请重新点击下拉框")
    this.receipt = undefined
    this.version++
    clearTimeout(this.lease)
    this.lease = undefined
    this.suppressed = true
    return receipt
  }
  async dismiss(page: Page, token: unknown): Promise<void> {
    const receipt = this.consume(token)
    try {
      if (receipt.page !== page) throw new BotDomainError("wrong_target", "选项不属于当前页面")
    } finally {
      await this.dispose(receipt.handle)
    }
  }
  async select(
    page: Page,
    token: unknown,
    indices: unknown,
    guard: GrokBrowserInputGuard,
    before: (details: BotNativeSelectObservation) => Promise<void>
  ): Promise<BotNativeSelectObservation> {
    const receipt = this.consume(token)
    try {
      if (receipt.page !== page) throw new BotDomainError("wrong_target", "选项不属于当前页面")
      const check = async () => {
        guard.assert(page)
        const current = await snapshot(receipt.handle, true)
        if (
          !current ||
          current.fingerprint !== receipt.snapshot.fingerprint ||
          !(await focusedAncestors(page, receipt.handle))
        )
          throw new BotDomainError("stale_frame", "页面或选项已变化，请重新点击下拉框")
        guard.assert(page)
        return current
      }
      const current = await check()
      if (
        !Array.isArray(indices) ||
        indices.length > 256 ||
        (!current.multiple && indices.length !== 1) ||
        new Set(indices).size !== indices.length ||
        indices.some(
          (index) =>
            !Number.isSafeInteger(index) ||
            !current.options.some((option) => option.index === index)
        )
      )
        throw new BotDomainError("invalid_input", "请选择有效的可用选项")
      const requested = indices as number[]
      await before(observation(current, requested))
      // Teach may await capture. Revalidate the same element and options after that await.
      await check()
      // Do not replay after an ambiguous response to this single dispatch.
      await receipt.handle.selectOption(
        requested.map((index) => ({ index })),
        { timeout: 10_000 }
      )
      guard.assert(page)
      const actual = await snapshot(receipt.handle, false)
      if (!actual || actual.fingerprint !== current.fingerprint)
        throw new BotDomainError("stale_frame", "选择已发送，但页面已变化，请核对结果")
      guard.assert(page)
      return observation(actual, requested)
    } finally {
      await this.dispose(receipt.handle)
    }
  }
}
