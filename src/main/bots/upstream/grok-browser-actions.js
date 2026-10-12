// Adapted from Grok Bot 0.18 reconstruction; see PROVENANCE.json in this directory.
// Changes: retain page actions; inject a Bot-scoped context and exact target registry.
// No Linux launcher, remote shell, global tab adoption or filesystem state.
const ACTION_TIMEOUT_MS = 10000
const NAVIGATE_TIMEOUT_MS = 25000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Match locked Playwright's chord split, including a literal "+" in Control++.
// A failed delegated press does not expose which tokens reached keydown.
export async function pressGrokBrowserKey(page, key, stopCleanup) {
  if (typeof key !== "string" || key.length > 100)
    throw new Error("Browser key exceeds 100 characters")
  const keyboard = page.keyboard,
    browser = page.context?.().browser()
  let stopping
  const stop = () => {
    if (stopping) return
    // Fence the original owner synchronously, then join the captured transport.
    // Never race a still-live press or keyup to release the serial queue.
    try {
      stopping = Promise.resolve(stopCleanup ? stopCleanup(browser) : browser?.close())
    } catch (stopError) {
      stopping = Promise.reject(stopError)
    }
    void stopping.catch(() => {})
  }
  const pressTimer = setTimeout(stop, ACTION_TIMEOUT_MS)
  try {
    await keyboard.press(key)
  } catch (error) {
    clearTimeout(pressTimer)
    if (!stopping) {
      const tokens = []
      let building = ""
      for (const char of key) {
        if (char === "+" && building) {
          tokens.push(building)
          building = ""
        } else building += char
      }
      tokens.push(building)
      const cleanupTimer = setTimeout(stop, 5_000)
      try {
        for (let index = tokens.length - 1; index >= 0; index--) {
          if (stopping) break
          try {
            await keyboard.up(tokens[index])
          } catch {
            // Best-effort release never replaces the original failed effect.
          }
        }
      } finally {
        clearTimeout(cleanupTimer)
      }
    }
    if (stopping) await stopping.catch(() => {})
    throw error
  } finally {
    clearTimeout(pressTimer)
  }
  if (stopping) {
    await stopping.catch(() => {})
    // A late accepted reply cannot prove the timed-out effect or its closure.
    throw new Error("Browser key input timed out; outcome is unconfirmed")
  }
}
async function targetIdOf(context, page) {
  const session = await context.newCDPSession(page)
  try {
    return (await session.send("Target.getTargetInfo")).targetInfo.targetId
  } finally {
    await session.detach().catch(() => {})
  }
}
async function resolvePage(request, context, state) {
  const viewId = request.viewId || state.lastViewId
  const targetId = state.views[viewId]
  if (!targetId) throw new Error("Browser view is not registered to this Bot")
  for (const page of context.pages()) {
    if (!page.isClosed() && (await targetIdOf(context, page)) === targetId) {
      state.lastViewId = viewId
      page.setDefaultTimeout(ACTION_TIMEOUT_MS)
      return { page, viewId }
    }
  }
  throw new Error("Browser target was closed; observe the current Bot before continuing")
}
export async function refHandle(page, ref) {
  const handle = await page.evaluateHandle((r) => {
    const map = globalThis.__sandRefs
    return map instanceof Map ? map.get(r) : undefined
  }, ref)
  const element = handle.asElement()
  if (element === null) {
    await handle.dispose().catch(() => {})
    throw new Error(
      "Unknown or stale ref " +
        JSON.stringify(ref) +
        ". Take a fresh browser_snapshot and use a ref from it."
    )
  }
  return element
}

// Reviews and secure-input requests own longer-lived handles returned by
// refHandle. Ordinary actions release their separate handle as soon as they end.
async function withRefHandle(page, ref, operation) {
  const element = await refHandle(page, ref)
  try {
    return await operation(element)
  } finally {
    // Closing/navigation can invalidate the remote object during an action.
    // Cleanup must not replace the original result or dispatch error.
    await element.dispose().catch(() => {})
  }
}

// Keep the page-side program as source: host transpilers must not inject helpers
// (such as __name) into code serialized into the isolated browser runtime.
const SNAPSHOT_FN = String.raw`((opts) => {
  const doc = globalThis.document
  const win = globalThis.window
  const root = opts.selector ? doc.querySelector(opts.selector) : doc.body
  if (!root) return { lines: ["(no matching element for selector)"], refCount: 0 }
  const refs = new Map()
  globalThis.__sandRefs = refs
  let refCounter = 0
  const lines = []
  const maxNodes = 400
  let nodeCount = 0
  const interactiveMatcher =
    "a[href], button, input, select, textarea, summary, " +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
    '[role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="combobox"], ' +
    '[role="option"], [role="switch"], [role="searchbox"], [role="textbox"], ' +
    '[role="slider"], [contenteditable="true"], [onclick]'
  const isVisible = (el) => {
    if (el.getAttribute("aria-hidden") === "true") return false
    const style = win.getComputedStyle(el)
    if (style.display === "none" || style.visibility === "hidden") return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const trim = (text, max) => {
    const t = (text ?? "").replace(/\s+/g, " ").trim()
    return t.length > max ? t.slice(0, max) + "…" : t
  }
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label")
    if (aria) return trim(aria, 80)
    if (el.labels && el.labels.length > 0) return trim(el.labels[0].innerText, 80)
    const placeholder = el.getAttribute("placeholder")
    if (placeholder) return trim(placeholder, 80)
    const alt = el.getAttribute("alt")
    if (alt) return trim(alt, 80)
    const title = el.getAttribute("title")
    if (title) return trim(title, 80)
    const isSecret =
      el.getAttribute("type")?.toLowerCase() === "password" ||
      ["current-password", "new-password"].includes(el.getAttribute("autocomplete")?.toLowerCase())
    return trim(el.innerText ?? (isSecret ? "" : el.value) ?? "", 80)
  }
  const roleOf = (el) => {
    const explicit = el.getAttribute("role")
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === "a") return "link"
    if (tag === "button" || tag === "summary") return "button"
    if (tag === "select") return "combobox"
    if (tag === "textarea") return "textbox"
    if (tag === "input") {
      const type = (el.getAttribute("type") ?? "text").toLowerCase()
      if (type === "button" || type === "submit" || type === "reset") return "button"
      if (type === "checkbox") return "checkbox"
      if (type === "radio") return "radio"
      if (type === "range") return "slider"
      return "textbox"
    }
    if (/^h[1-6]$/.test(tag)) return "heading"
    return tag
  }
  const describe = (el, depth) => {
    const role = roleOf(el)
    const name = nameOf(el)
    let line = "  ".repeat(Math.min(depth, 6)) + "- " + role
    if (name) line += " " + JSON.stringify(name)
    if (el.matches(interactiveMatcher) && !el.disabled) {
      refCounter += 1
      const ref = "e" + String(refCounter)
      refs.set(ref, el)
      line += " [ref=" + ref + "]"
    }
    if (el.disabled) line += " disabled"
    if (el.checked === true) line += " checked"
    const tag = el.tagName.toLowerCase()
    if (tag === "select") {
      // Native option children are not walked. Report the actual selection,
      // including an empty placeholder, without reading an unbounded option list.
      const options = el.selectedOptions
      const selected = []
      const count = options.length
      for (let index = 0; index < Math.min(count, 4); index++) {
        const option = options.item(index)
        if (option)
          selected.push({ value: trim(option.value, 40), label: trim(option.label, 80) })
      }
      line += " selected=" + JSON.stringify(selected)
      if (count > 4) line += " (selection truncated; " + count + " selected options)"
    }
    if (
      (tag === "input" || tag === "textarea") &&
      typeof el.value === "string" &&
      el.value.length > 0
    ) {
      const inputType = (el.getAttribute("type") ?? "").toLowerCase()
      const isSecret =
        inputType === "password" ||
        el.getAttribute("autocomplete") === "current-password" ||
        el.getAttribute("autocomplete") === "new-password"
      line += " value=" + (isSecret ? '"<redacted>"' : JSON.stringify(trim(el.value, 40)))
    }
    if (tag === "a") {
      const href = el.getAttribute("href")
      if (href && !href.startsWith("javascript:")) line += " href=" + JSON.stringify(trim(href, 80))
    }
    return line
  }
  const walk = (el, depth) => {
    if (nodeCount >= maxNodes || depth > (opts.maxDepth ?? 20)) return
    if (!(el instanceof win.HTMLElement)) return
    const tag = el.tagName.toLowerCase()
    if (tag === "script" || tag === "style" || tag === "noscript") return
    if (!isVisible(el)) return
    const isInteractive = el.matches(interactiveMatcher)
    const isHeading = /^h[1-6]$/.test(tag)
    const isTextual =
      !opts.interactive &&
      (tag === "p" || tag === "li" || tag === "label" || tag === "td" || tag === "th")
    let childDepth = depth
    if (
      isInteractive ||
      isHeading ||
      (isTextual &&
        trim(el.innerText, 10).length > 0 &&
        el.querySelector(interactiveMatcher) === null)
    ) {
      nodeCount += 1
      lines.push(describe(el, depth))
      childDepth = depth + 1
      if (isInteractive || isTextual) return
    }
    for (const child of el.children) walk(child, childDepth)
  }
  walk(root, 0)
  if (nodeCount >= maxNodes) lines.push("(snapshot truncated at " + String(maxNodes) + " elements)")
  return { lines, refCount: refCounter }
})`

function clickOptionsFor(args) {
  const options = { timeout: ACTION_TIMEOUT_MS }
  if (args.button === "right" || args.button === "middle") options.button = args.button
  if (Array.isArray(args.modifiers) && args.modifiers.length > 0) options.modifiers = args.modifiers
  if (typeof args.holdDurationMs === "number" && args.holdDurationMs > 0)
    options.delay = Math.min(args.holdDurationMs, 5000)
  if (args.doubleClick === true) options.clickCount = 2
  return options
}

// Chromium may report a completed navigation failure through goto's rejection.
// Preserve the browser's explicit HTTP/network failure without retrying or
// claiming the remote request succeeded. This settles only this navigation
// attempt; subsequent work must observe the page. Deadline, abort, target and
// automation transport/authority failures still have no confirmed receipt.
const TERMINAL_NAVIGATION_ERRORS = new Set([
  "ERR_HTTP_RESPONSE_CODE_FAILURE",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET",
  "ERR_EMPTY_RESPONSE"
])
async function navigatePage(page, url) {
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATE_TIMEOUT_MS
    })
    if (response && response.status() >= 400)
      return {
        summary:
          "Navigation received HTTP " + response.status() + "; inspect the page before continuing",
        data: JSON.stringify({
          navigation: { status: "http_error", httpStatus: response.status() },
          requiresObservation: true
        })
      }
  } catch (error) {
    const code = error instanceof Error ? error.message.match(/\bnet::(ERR_[A-Z_]+)\b/)?.[1] : null
    if (page.isClosed() || !code || !TERMINAL_NAVIGATION_ERRORS.has(code)) throw error
    const status = code === "ERR_HTTP_RESPONSE_CODE_FAILURE" ? "http_error" : "network_error"
    return {
      summary:
        "Navigation failed with " +
        code +
        "; inspect the page before continuing. This request was not retried, and remote work is not confirmed.",
      data: JSON.stringify({
        navigation: { status, errorCode: code },
        requiresObservation: true
      })
    }
  }
  return null
}

const OPS = {
  navigate: async ({ request, context, state, beforeInput }) => {
    if (request.newTab === true) {
      await beforeInput.prepare()
      beforeInput.assert()
      const page = await context.newPage()
      const viewId =
        typeof request.viewId === "string" && request.viewId.length > 0
          ? request.viewId
          : "tab-" + String(Date.now())
      state.views[viewId] = await targetIdOf(context, page)
      state.lastViewId = viewId
      page.setDefaultTimeout(ACTION_TIMEOUT_MS)
      await beforeInput.prepare(page)
      beforeInput.assert(page)
      const failure = await navigatePage(page, request.url)
      beforeInput.assert(page)
      if (failure) return { page, viewId, ...failure }
      await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {})
      return { page, viewId, summary: "Opened " + request.url + " in a new tab" }
    }
    const { page, viewId } = await resolvePage(request, context, state)
    await beforeInput.prepare(page)
    beforeInput.assert(page)
    const failure = await navigatePage(page, request.url)
    beforeInput.assert(page)
    if (failure) return { page, viewId, ...failure }
    await page.waitForLoadState("load", { timeout: 5000 }).catch(() => {})
    return { page, viewId, summary: "Navigated to " + request.url }
  },
  snapshot: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    const options = {
      interactive: request.interactive === true,
      maxDepth: typeof request.maxDepth === "number" ? request.maxDepth : 20,
      selector:
        typeof request.selector === "string" && request.selector.length > 0
          ? request.selector
          : undefined
    }
    // Explicit invocation of an app-owned script; arguments remain JSON data.
    const result = await page.evaluate(SNAPSHOT_FN + "(" + JSON.stringify(options) + ")")
    const data = result.lines.join("\n")
    return {
      page,
      viewId,
      summary: "Captured page snapshot (" + String(result.refCount) + " interactive refs)",
      data
    }
  },
  click: async ({ request, context, state, beforeInput }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    return withRefHandle(page, request.ref, async (element) => {
      const options = clickOptionsFor(request)
      if (typeof request.offsetX === "number" || typeof request.offsetY === "number") {
        const box = await element.boundingBox()
        if (box !== null) {
          options.position = {
            x: box.width / 2 + (request.offsetX ?? 0),
            y: box.height / 2 + (request.offsetY ?? 0)
          }
        }
      }
      await beforeInput.prepare(page)
      beforeInput.assert(page)
      await element.click(options)
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {})
      return { page, viewId, summary: "Clicked " + (request.element ?? request.ref) }
    })
  },
  mouse_click_xy: async ({ request, context, state, beforeInput }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    await beforeInput.prepare(page)
    beforeInput.assert(page)
    await page.mouse.click(request.x, request.y, {
      button: request.button === "right" || request.button === "middle" ? request.button : "left"
    })
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {})
    return {
      page,
      viewId,
      summary: "Clicked at (" + String(request.x) + ", " + String(request.y) + ")"
    }
  },
  type: async ({ request, context, state, beforeInput }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    return withRefHandle(page, request.ref, async (element) => {
      await beforeInput.prepare(page)
      beforeInput.assert(page)
      await element.click({ timeout: ACTION_TIMEOUT_MS })
      if (request.clear === true) {
        await beforeInput.prepare(page)
        beforeInput.assert(page)
        await element.fill("")
      }
      await beforeInput.prepare(page)
      beforeInput.assert(page)
      await page.keyboard.type(request.text, { delay: request.slowly === true ? 40 : 0 })
      if (request.submit === true) {
        await beforeInput.prepare(page)
        beforeInput.assert(page)
        await pressGrokBrowserKey(page, "Enter", beforeInput.stopKeyboardCleanup)
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {})
      }
      return { page, viewId, summary: "Typed into " + (request.element ?? request.ref) }
    })
  },
  fill: async ({ request, context, state, beforeInput }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    return withRefHandle(page, request.ref, async (element) => {
      await beforeInput.prepare(page)
      beforeInput.assert(page)
      await element.fill(request.value)
      return { page, viewId, summary: "Filled " + (request.element ?? request.ref) }
    })
  },
  select_option: async ({ request, context, state, beforeInput }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    return withRefHandle(page, request.ref, async (element) => {
      const values = Array.isArray(request.values) ? request.values : []
      await beforeInput.prepare(page)
      beforeInput.assert(page)
      // Playwright strings already match option value or label. Never replay
      // a selection after an ambiguous response to the first change event.
      const selected = await element.selectOption(values)
      return {
        page,
        viewId,
        summary: "Selected " + JSON.stringify(selected) + " in " + (request.element ?? request.ref)
      }
    })
  },
  press_key: async ({ request, context, state, beforeInput }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    await beforeInput.prepare(page)
    beforeInput.assert(page)
    await pressGrokBrowserKey(page, request.key, beforeInput.stopKeyboardCleanup)
    await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {})
    return { page, viewId, summary: "Pressed " + request.key }
  },
  scroll: async ({ request, context, state, beforeInput }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    if (typeof request.ref === "string" && request.ref.length > 0) {
      return withRefHandle(page, request.ref, async (element) => {
        await beforeInput.prepare(page)
        beforeInput.assert(page)
        await element.scrollIntoViewIfNeeded()
        return {
          page,
          viewId,
          summary: "Scrolled " + (request.element ?? request.ref) + " into view"
        }
      })
    }
    const amount = typeof request.amount === "number" && request.amount > 0 ? request.amount : 300
    let deltaX = typeof request.deltaX === "number" ? request.deltaX : 0
    let deltaY = typeof request.deltaY === "number" ? request.deltaY : 0
    if (deltaX === 0 && deltaY === 0) {
      const direction = request.direction ?? "down"
      if (direction === "up") deltaY = -amount
      else if (direction === "down") deltaY = amount
      else if (direction === "left") deltaX = -amount
      else deltaX = amount
    }
    await beforeInput.prepare(page)
    beforeInput.assert(page)
    await page.mouse.wheel(deltaX, deltaY)
    await sleep(200)
    return { page, viewId, summary: "Scrolled by (" + String(deltaX) + ", " + String(deltaY) + ")" }
  },
  tabs: async ({ request, context, state, beforeInput }) => {
    const pages = context.pages().filter((p) => !p.isClosed())
    if (request.action === "list") {
      const entries = []
      for (let i = 0; i < pages.length; i++) {
        entries.push({
          index: i,
          url: pages[i].url(),
          title: await pages[i].title().catch(() => "")
        })
      }
      return {
        summary: "Listed " + String(pages.length) + " tab(s)",
        data: JSON.stringify(entries, null, 1)
      }
    }
    if (request.action === "new") {
      await beforeInput.prepare()
      beforeInput.assert()
      const page = await context.newPage()
      const viewId = "tab-" + String(Date.now())
      state.views[viewId] = await targetIdOf(context, page)
      state.lastViewId = viewId
      return { page, viewId, summary: "Opened a new tab" }
    }
    let page
    if (typeof request.index === "number") {
      page = pages[request.index]
      if (page === undefined) {
        throw new Error(
          "No tab at index " + String(request.index) + " (" + String(pages.length) + " open)"
        )
      }
    } else if (request.action === "close") {
      const currentTarget =
        state.lastViewId !== undefined ? state.views[state.lastViewId] : undefined
      if (currentTarget !== undefined) {
        for (const p of pages) {
          try {
            if ((await targetIdOf(context, p)) === currentTarget) {
              page = p
              break
            }
          } catch {
            /* Closed tabs can disappear while matching an owned target. */
          }
        }
      }
      if (page === undefined) {
        throw new Error("No current tab to close; pass an index from browser_tabs list.")
      }
    } else {
      throw new Error('Tab index is required for "' + String(request.action) + '".')
    }
    if (request.action === "select") {
      await beforeInput.prepare(page)
      beforeInput.assert(page)
      await page.bringToFront().catch(() => {})
      const targetId = await targetIdOf(context, page)
      let viewId = Object.keys(state.views).find((k) => state.views[k] === targetId)
      if (viewId === undefined) {
        viewId = "tab-" + String(Date.now())
        state.views[viewId] = targetId
      }
      state.lastViewId = viewId
      return { page, viewId, summary: "Selected tab " + String(request.index) }
    }
    if (request.action === "close") {
      const targetId = await targetIdOf(context, page).catch(() => undefined)
      const closedUrl = page.url()
      await beforeInput.prepare(page)
      beforeInput.assert(page)
      await page.close()
      if (targetId !== undefined) {
        state.deletedViews = state.deletedViews ?? []
        for (const key of Object.keys(state.views)) {
          if (state.views[key] === targetId) {
            delete state.views[key]
            state.deletedViews.push(key)
            if (state.lastViewId === key) state.lastViewId = undefined
          }
        }
      }
      return { summary: "Closed tab (" + closedUrl + ")" }
    }
    throw new Error("Unknown tabs action: " + String(request.action))
  },
  screenshot: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    return { page, viewId, summary: "Took a screenshot", fullPage: request.fullPage === true }
  },
  drag: async ({ request, context, state, beforeInput, guarded }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    return withRefHandle(page, request.sourceRef, async (source) => {
      // A reviewed drag must use the visible geometry that was approved.
      // Explicit scroll + observation prepares a different viewport.
      if (!guarded) await source.scrollIntoViewIfNeeded()
      const sourceBox = await source.boundingBox()
      if (sourceBox === null) throw new Error("The drag source has no visible bounding box.")
      let targetX
      let targetY
      if (typeof request.targetRef === "string" && request.targetRef.length > 0) {
        const targetBox = await withRefHandle(page, request.targetRef, async (target) => {
          const box = await target.boundingBox()
          if (box === null) throw new Error("The drag target has no visible bounding box.")
          return box
        })
        targetX = targetBox.x + targetBox.width / 2
        targetY = targetBox.y + targetBox.height / 2
      } else if (typeof request.targetX === "number" && typeof request.targetY === "number") {
        targetX = request.targetX
        targetY = request.targetY
      } else {
        throw new Error("drag needs targetRef or targetX/targetY.")
      }
      const startX = sourceBox.x + sourceBox.width / 2
      const startY = sourceBox.y + sourceBox.height / 2
      let downAttempted = false
      let failed = false
      let cleanupFailed = false
      let cleanupError
      try {
        await beforeInput.prepare(page)
        beforeInput.assert(page)
        await page.mouse.move(startX, startY)
        await beforeInput.prepare(page)
        beforeInput.assert(page)
        downAttempted = true
        await page.mouse.down()
        const steps = 12
        for (let i = 1; i <= steps; i++) {
          await beforeInput.prepare(page)
          beforeInput.assert(page)
          await page.mouse.move(
            startX + ((targetX - startX) * i) / steps,
            startY + ((targetY - startY) * i) / steps
          )
        }
      } catch (error) {
        failed = true
        throw error
      } finally {
        if (downAttempted) {
          // Releasing an already pressed button is cleanup, not a new input
          // admission. Takeover/cancellation must never prevent this attempt.
          try {
            await page.mouse.up()
          } catch (error) {
            if (!failed) {
              cleanupFailed = true
              cleanupError = error
            }
          }
        }
      }
      if (cleanupFailed) throw cleanupError
      return {
        page,
        viewId,
        summary:
          "Dragged " +
          request.sourceRef +
          " to (" +
          String(Math.round(targetX)) +
          ", " +
          String(Math.round(targetY)) +
          ")"
      }
    })
  },
  get_bounding_box: async ({ request, context, state }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    return withRefHandle(page, request.ref, async (element) => {
      const box = await element.boundingBox()
      if (box === null) throw new Error("The element has no visible bounding box.")
      return {
        page,
        viewId,
        summary: "Bounding box for " + (request.element ?? request.ref),
        data: JSON.stringify({
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height)
        })
      }
    })
  },
  highlight: async ({ request, context, state, beforeInput }) => {
    const { page, viewId } = await resolvePage(request, context, state)
    await beforeInput.prepare(page)
    beforeInput.assert(page)
    await page.bringToFront().catch(() => {})
    return withRefHandle(page, request.ref, async (element) => {
      await beforeInput.prepare(page)
      beforeInput.assert(page)
      await element.scrollIntoViewIfNeeded()
      const durationMs = Math.min(
        typeof request.durationMs === "number" && request.durationMs > 0
          ? request.durationMs
          : 2000,
        5000
      )
      await beforeInput.prepare(page)
      beforeInput.assert(page)
      await element.evaluate((el, ms) => {
        const doc = el.ownerDocument
        const rect = el.getBoundingClientRect()
        const overlay = doc.createElement("div")
        overlay.style.cssText =
          "position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #ff4d4f;" +
          "border-radius:4px;background:rgba(255,77,79,0.15);" +
          "left:" +
          String(rect.left - 3) +
          "px;top:" +
          String(rect.top - 3) +
          "px;" +
          "width:" +
          String(rect.width) +
          "px;height:" +
          String(rect.height) +
          "px;"
        doc.body.appendChild(overlay)
        setTimeout(() => overlay.remove(), ms)
      }, durationMs)
      await sleep(300)
      return {
        page,
        viewId,
        summary:
          "Highlighted " + (request.element ?? request.ref) + " for " + String(durationMs) + "ms"
      }
    })
  },
  cdp: async ({ request, context, state }) => {
    const method = typeof request.method === "string" ? request.method : ""
    const deniedPrefixes = [
      "Browser.",
      "Target.",
      "Storage.",
      "SystemInfo.",
      "Security.",
      "Input.",
      "Tethering.",
      "Cast."
    ]
    const deniedMethods = [
      "Network.setCookie",
      "Network.setCookies",
      "Network.getCookies",
      "Network.getAllCookies",
      "Network.deleteCookies",
      "Network.clearBrowserCookies",
      "Network.clearBrowserCache"
    ]
    if (
      method.length === 0 ||
      deniedPrefixes.some((p) => method.startsWith(p)) ||
      deniedMethods.includes(method)
    ) {
      throw new Error(
        "CDP method " +
          JSON.stringify(method) +
          " is denied. Browser-wide, storage, cookie, cache, permission, target-management, and input commands are not allowed; use the dedicated browser tools instead."
      )
    }
    const { page, viewId } = await resolvePage(request, context, state)
    const session = await context.newCDPSession(page)
    try {
      const result = await session.send(
        method,
        request.params && typeof request.params === "object" ? request.params : {}
      )
      let serialized = JSON.stringify(result)
      const max = 20000
      if (serialized.length > max) {
        serialized =
          serialized.slice(0, max) + " …(truncated " + String(serialized.length - max) + " chars)"
      }
      return { page, viewId, summary: "Ran CDP " + method, data: serialized }
    } finally {
      await session.detach().catch(() => {})
    }
  }
}

export async function executeGrokBrowserAction(request, context, state, inputGuard) {
  if (!Object.hasOwn(OPS, request.op)) throw new Error("Unsupported browser operation")
  return OPS[request.op]({
    request,
    context,
    state,
    beforeInput: inputGuard ?? { prepare: async () => {}, assert: () => {} },
    guarded: Boolean(inputGuard)
  })
}
