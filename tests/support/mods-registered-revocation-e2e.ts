import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import type { ElectronApplication, Page } from "playwright"
import { openModsResults, openModsSettings } from "./mods-sidebar-navigation"

interface Request {
  messages: Array<{ role: string; content: string }>
  [key: string]: unknown
}
interface Options {
  app: ElectronApplication
  page: Page
  root: string
  workspace: string
  controlThreadId: string
  artifacts: string
  requests: Request[]
  until(check: () => Promise<boolean>, label: string): Promise<void>
  pass(label: string): void
  restart(): Promise<{ app: ElectronApplication; page: Page }>
}

interface RegisteredRevocationDiagnosticHandle {
  browserErrors: string[]
  diagnosticErrors: string[]
  onError(error: Error): void
}
const registeredRevocationDiagnostics = new WeakMap<Page, RegisteredRevocationDiagnosticHandle>()

/** Observe the existing submission only; diagnostic failures must never prevent its execution. */
export async function installRegisteredRevocationDiagnostics(page: Page): Promise<void> {
  if (registeredRevocationDiagnostics.has(page)) return
  const browserErrors: string[] = [], diagnosticErrors: string[] = []
  const onError = (error: Error) => { browserErrors.push(String(error.stack ?? error)) }
  registeredRevocationDiagnostics.set(page, { browserErrors, diagnosticErrors, onError })
  page.on("pageerror", onError)
  try {
    // tsx's serialized local function names are harness plumbing, including on a restarted page.
    await page.evaluate("window.__name = value => value")
    await page.evaluate(() => {
      const events: Array<Record<string, unknown>> = [], errors: string[] = [], samplingErrors: string[] = []
      const mutations: Array<Record<string, unknown>> = [], errorTimeline: Array<Record<string, unknown>> = []
      const timers = new Set<number>()
      const identities = new WeakMap<Element, number>()
      let sequence = 0
      const identity = (element: Element | null | undefined) => {
        if (!element) return null
        if (!identities.has(element)) identities.set(element, ++sequence)
        return identities.get(element)
      }
      const initialInput = document.querySelector("textarea.composer-textarea")
      const initialForm = initialInput?.closest("form")
      const snapshot = () => {
        const input = document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")
        const form = input?.closest("form")
        return { draftLength: input?.value.length, disabled: input?.disabled,
          textareaCount: document.querySelectorAll("textarea.composer-textarea").length,
          sameInput: input === initialInput, inputConnected: input?.isConnected,
          inputId: identity(input), formId: identity(form), formConnected: form?.isConnected,
          inputAttributes: input ? Object.fromEntries(Array.from(input.attributes)
            .map(attribute => [attribute.name, attribute.value])) : null,
          formAttributes: form ? Object.fromEntries(Array.from(form.attributes)
            .map(attribute => [attribute.name, attribute.value])) : null,
          active: document.activeElement?.tagName, activeClass: document.activeElement?.className,
          buttons: Array.from(form?.querySelectorAll("button") ?? []).map(button => ({
            id: identity(button), connected: button.isConnected,
            type: button.type, disabled: button.disabled, text: button.innerText,
            title: button.title, ariaLabel: button.getAttribute("aria-label") })) }
      }
      const sample = () => {
        try { return snapshot() }
        catch (error) {
          if (samplingErrors.length < 20) samplingErrors.push(String(error))
          return { samplingFailed: true }
        }
      }
      const listener = (event: Event) => {
        if (events.length >= 100) return
        const target = event.target instanceof Element ? event.target : undefined
        const button = target?.closest("button")
        const point = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : undefined
        const hit = point ? document.elementFromPoint(point.x, point.y) : null
        const hitButton = hit?.closest("button")
        const record = { type: event.type, phase: event.eventPhase === Event.CAPTURING_PHASE
          ? "capture" : "bubble", at: performance.now(), trusted: event.isTrusted,
          key: event instanceof KeyboardEvent ? event.key : undefined,
          target: target?.tagName, targetClass: target?.getAttribute("class"),
          targetId: identity(target), buttonId: identity(button), point,
          hitTag: hit?.tagName, hitId: identity(hit), hitButtonId: identity(hitButton),
          hitButtonDisabled: hitButton?.disabled,
          buttonText: button?.innerText, buttonType: button?.type, buttonDisabled: button?.disabled,
          defaultPrevented: event.defaultPrevented, capture: sample() }
        events.push(record)
        queueMicrotask(() => Object.assign(record, { defaultPreventedAfterMicrotask: event.defaultPrevented,
          connectedAfterMicrotask: target?.isConnected, afterMicrotask: sample() }))
        const timer = window.setTimeout(() => {
          timers.delete(timer)
          Object.assign(record, { defaultPreventedAfterTurn: event.defaultPrevented,
            connectedAfterTurn: target?.isConnected, afterTurn: sample() })
        }, 0)
        timers.add(timer)
      }
      const original = Error
      const recordError = (error: Error) => {
        try { if (errors.length < 30) {
          errorTimeline.push({ at: performance.now(), index: errors.length })
          errors.push(String(error.stack).slice(0, 10000))
        } }
        catch (samplingError) { samplingErrors.push(String(samplingError)) }
        return error
      }
      const wrapper = new Proxy(original, {
        apply(target, receiver, args) { return recordError(Reflect.apply(target, receiver, args)) },
        construct(target, args, newTarget) {
          return recordError(Reflect.construct(target, args, newTarget) as Error)
        }
      })
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (mutations.length >= 300) break
          const target = record.target instanceof Element ? record.target : undefined
          const form = document.querySelector("textarea.composer-textarea")?.closest("form")
          const inForm = target && (target === form || form?.contains(target) ||
            target === initialForm || initialForm?.contains(target))
          const name = record.attributeName ?? ""
          if (record.type === "attributes") {
            if (!inForm || !(["disabled", "readonly", "title", "hidden", "inert"].includes(name) ||
              name.startsWith("aria-") || name.startsWith("data-"))) continue
          } else if (!inForm && ![...record.addedNodes, ...record.removedNodes].some(node =>
            node instanceof Element && (node.matches("textarea.composer-textarea") ||
              node.querySelector("textarea.composer-textarea")))) continue
          mutations.push({ at: performance.now(), type: record.type, attribute: name,
            oldValue: record.oldValue, value: record.attributeName ? target?.getAttribute(name) : undefined,
            target: target?.tagName, targetId: identity(target), connected: target?.isConnected,
            added: record.addedNodes.length, removed: record.removedNodes.length, snapshot: sample() })
        }
      })
      observer.observe(document.body, { attributes: true, attributeOldValue: true,
        childList: true, subtree: true })
      const eventTypes = ["pointerdown", "pointerup", "pointercancel", "mousedown", "mouseup",
        "click", "submit", "keydown", "input", "change", "focusin", "focusout"]
      const state = { events, errors, errorTimeline, mutations, samplingErrors, timers,
        observer, eventTypes, snapshot: sample, listener, original, wrapper }
      Object.assign(globalThis, { __modsRegisteredRevocationDiagnostics: state, Error: wrapper })
      for (const type of eventTypes) {
        document.addEventListener(type, listener, true)
        document.addEventListener(type, listener, false)
      }
      events.push({ type: "installed", snapshot: sample() })
    })
  } catch (error) {
    diagnosticErrors.push(String(error instanceof Error ? error.stack ?? error.message : error))
    console.error("Unable to install registered revocation diagnostics", error)
  }
}

/** Always restore both event phases and Error, even if sampling the final DOM fails. */
export async function collectRegisteredRevocationDiagnostics(page: Page): Promise<Record<string, unknown>> {
  const handle = registeredRevocationDiagnostics.get(page)
  registeredRevocationDiagnostics.delete(page)
  const diagnosticErrors = handle?.diagnosticErrors ?? []
  let result: Record<string, unknown> = { missing: true }
  try { if (handle) page.off("pageerror", handle.onError) }
  catch (error) { diagnosticErrors.push(String(error)) }
  try {
    result = await page.evaluate(() => {
      const global = globalThis as typeof globalThis & {
        __modsRegisteredRevocationDiagnostics?: { events: unknown[]; errors: string[];
          errorTimeline: unknown[]; mutations: unknown[]; observer: MutationObserver; eventTypes: string[];
          samplingErrors: string[]; timers: Set<number>;
          snapshot(): unknown; listener(event: Event): void; original: ErrorConstructor;
          wrapper: ErrorConstructor }
      }
      const state = global.__modsRegisteredRevocationDiagnostics
      if (!state) return { missing: true }
      try {
        let final: unknown, bodyTail: string | undefined, samplingError: string | undefined
        try { final = state.snapshot(); bodyTail = document.body.innerText.slice(-7000) }
        catch (error) { samplingError = String(error) }
        return { events: state.events, errors: state.errors, errorTimeline: state.errorTimeline,
          mutations: state.mutations, samplingErrors: state.samplingErrors,
          closedStacks: state.errors.filter(error => error.includes("MODS_PROMPT_EDITOR_CLOSED")),
          final, bodyTail, ...(samplingError ? { samplingError } : {}) }
      } finally {
        state.observer.disconnect()
        for (const timer of state.timers) window.clearTimeout(timer)
        state.timers.clear()
        for (const type of state.eventTypes) {
          document.removeEventListener(type, state.listener, true)
          document.removeEventListener(type, state.listener, false)
        }
        if (global.Error === state.wrapper) global.Error = state.original
        delete global.__modsRegisteredRevocationDiagnostics
      }
    })
  } catch (error) {
    diagnosticErrors.push(String(error instanceof Error ? error.stack ?? error.message : error))
    console.error("Unable to collect registered revocation diagnostics", error)
  }
  return { ...result, browserErrors: handle?.browserErrors ?? [], diagnosticErrors }
}

/** A short reproduction of the full suite's real restart/settings/thread/send interleaving. */
export async function verifyRegisteredRevocation(options: Options): Promise<void> {
  let { page } = options
  const { root, workspace, controlThreadId, artifacts, requests, until, pass } = options
  const evidence: Record<string, unknown> = { scope: "Real source Electron; public IPC and DOM only" }
  let registryThread = ""
  const select = async (title: string) => {
    await page.getByText(title, { exact: true }).first().click()
    await page.locator("textarea.composer-textarea").waitFor({ state: "visible" })
  }
  const command = async (id: string, name: string, text = "") => {
    const before = new Set((await page.evaluate(thread => window.api.mods.jobs(thread), id))
      .map(job => job.id))
    await page.locator("textarea.composer-textarea").fill(`/${name} ${text}`)
    await page.locator("textarea.composer-textarea").press("Enter")
    let result: string | undefined
    await until(async () => {
      const job = (await page.evaluate(thread => window.api.mods.jobs(thread), id))
        .find(item => !before.has(item.id) && item.command === name)
      if (!job || ["queued", "running"].includes(job.state)) return false
      assert.equal(job.state, "succeeded", job.error)
      result = job.result?.text
      return typeof result === "string"
    }, `${name} completes once through the real composer`)
    return result!
  }
  const schemas = (request: Request) => {
    assert(Array.isArray(request.tools))
    return (request.tools as Array<{ function: { name: string; parameters: unknown } }>)
      .map(tool => tool.function)
  }
  try {
    await page.evaluate(id => window.api.mods.configure(id, true, true), controlThreadId)
    for (const [name, directory] of [
      ["function-commands", join(root, "resources/mods/function-commands")],
      ["host-foundation", join(root, "tests/fixtures/mods-v2/host-foundation")],
      ["site-board", join(root, "tests/fixtures/mods-v2/site-board")]
    ]) {
      const zip = new AdmZip()
      zip.addLocalFolder(directory)
      const installed = await page.evaluate(({ bytes, name }) =>
        window.api.plugins.install(new Uint8Array(bytes).buffer, `${name}.zip`, "local"),
      { bytes: [...zip.toBuffer()], name })
      assert.equal(installed.success, true, installed.error)
    }
    await page.reload({ waitUntil: "domcontentloaded" })
    await select("Mods E2E")
    await openModsSettings(page)
    for (const name of ["function-commands", "host-foundation", "site-board"]) {
      const row = page.locator(`[data-function-mod-id="${name}"]`)
      await row.getByRole("button", { name: "授权以上能力", exact: true }).click()
      await until(async () => (await page.evaluate(id => window.api.mods.status(id), controlThreadId))
        .functionMods?.some(mod => mod.name === name && mod.state === "ready") === true,
      `${name} receives its real project digest grant`)
    }
    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    await select("Mods E2E")
    await openModsResults(page)
    const above = () => page.locator('[data-function-site="AbovePrompt"]')
    await above().getByRole("button", { name: "Site increment", exact: true }).waitFor()
    await above().getByRole("textbox", { name: "Site note", exact: true }).waitFor()
    assert((await above().innerText()).includes("SITE_ABOVE count:0"))
    evidence.siteFixture = { name: "site-board", component: "AbovePrompt",
      autoFocusButton: "Site increment", input: "Site note" }
    const note = "registered-revocation-persisted-note"
    assert((await command(controlThreadId, "claw-info", note)).includes(note))
    const descriptor = (await page.evaluate(id => window.api.mods.commands(id), controlThreadId))
      .find(entry => entry.modId === "function:function-commands" && entry.command === "claw-info")
    assert(descriptor)
    registryThread = await page.evaluate(async workspace => {
      const thread = await window.api.threads.create({ title: "Registered tools", workspacePath: workspace,
        agentMode: "normal" })
      const id = (thread as unknown as { thread_id?: string; id: string }).thread_id ??
        (thread as unknown as { id: string }).id
      await window.api.workspace.set(id, workspace)
      return id
    }, workspace)
    await page.reload({ waitUntil: "domcontentloaded" })
    await select("Registered tools")
    await openModsResults(page)
    const beforeRegistered = requests.length
    await page.locator("textarea.composer-textarea").fill("[mods-registered] 请调用自定义工具查看项目概览。")
    await page.locator("textarea.composer-textarea").press("Enter")
    await page.getByText("REGISTERED_TOOL_OK", { exact: true }).first().waitFor({ timeout: 30000 })
    await until(async () => (await page.evaluate(id => window.api.mods.turnNotices(id), registryThread))
      .some(notice => notice.text.startsWith("本轮完成")), "registered native turn settles")
    await page.getByRole("button", { name: "停止生成", exact: true }).waitFor({ state: "hidden" })
    const registered = requests.slice(beforeRegistered)
    assert.equal(registered.length, 3, "Original deferred discovery, registered call and final response")
    const toolName = "mcp__function-commands__project_brief"
    const tool = registered.flatMap(schemas).find(tool => tool.name === toolName)
    assert(tool)
    assert.deepEqual(tool.parameters, { type: "object", properties: {
      limit: { type: "integer", minimum: 1, maximum: 20 }
    }, additionalProperties: false })
    const actualResult = registered.find(request => request.messages.at(-1)?.role === "tool" &&
      String(request.messages.at(-1)?.content).includes("files"))
    assert(actualResult)
    assert(JSON.stringify(actualResult.messages.at(-1)).includes(note))
    const audit = await page.evaluate(id => window.api.mods.audit(id), registryThread)
    assert(audit.some(row => row.identity?.toolCallId === "registered-model" &&
      row.toolId === `function:${toolName}` && row.status === "succeeded" && row.publication === "published"))
    const beforeSdk = requests.length
    const transcript = await command(registryThread, "claw-session")
    assert(transcript.includes("REGISTERED_TOOL_OK"))
    assert(transcript.includes("用户轮次：1"))
    assert.equal(requests.length, beforeSdk, "Session SDK reads the real history without a provider call")
    evidence.registered = { providerRequests: registered, audit, sdkTranscript: transcript }
    pass("focused registry discovers and executes the approved original tool, then reads its real SDK history")

    // Preserve the same real pane preference and reopened-pane order as the full base suite.
    await select("Mods E2E")
    await openModsResults(page)
    await command(controlThreadId, "claw-board")
    const board = () => page.locator('[data-function-pane="claw-board"]')
    await board().waitFor({ state: "visible" })
    for (const count of [1, 2]) {
      await board().getByRole("button", { name: "加一", exact: true }).click()
      await board().getByText(`点击次数：${count}`, { exact: true }).waitFor()
    }
    await board().getByRole("textbox", { name: "项目备注", exact: true }).fill("这是保存到项目的偏好")
    await board().getByRole("button", { name: "保存备注", exact: true }).click()
    await board().getByText("备注：这是保存到项目的偏好 · 视图：检视", { exact: true }).waitFor()
    await board().getByRole("combobox", { name: "面板视图", exact: true }).selectOption("build")
    await board().getByText("备注：这是保存到项目的偏好 · 视图：构建", { exact: true }).waitFor()
    evidence.paneBeforeRestart = await board().innerText()

    const restarted = await options.restart()
    page = restarted.page
    await select("Mods E2E")
    await openModsResults(page)
    const persisted = await command(controlThreadId, "claw-info")
    assert(persisted.includes("本次会话查询：1"))
    assert(persisted.includes(note))
    assert.equal(await page.evaluate(async ({ id, descriptor }) => {
      try { await window.api.mods.enqueue(id, descriptor, { text: "old runtime" }); return false }
      catch { return true }
    }, { id: controlThreadId, descriptor }), true)
    evidence.restart = { persisted, oldDescriptorRejected: true }
    pass("focused complete restart preserves grants and preference while retiring the old descriptor")
    await command(controlThreadId, "claw-board")
    await board().waitFor({ state: "visible" })
    await board().getByText("点击次数：2", { exact: true }).waitFor()
    await board().getByText("备注：这是保存到项目的偏好 · 视图：构建", { exact: true }).waitFor()
    evidence.paneAfterRestart = await board().innerText()
    pass("focused restart reopens the actual persisted Claw pane before settings revocation")
    await openModsSettings(page)
    await page.locator('[data-function-mod-id="function-commands"]')
      .getByRole("button", { name: "撤销权限", exact: true }).click()
    await until(async () => !(await page.evaluate(id => window.api.mods.commands(id), controlThreadId))
      .some(entry => entry.modId === "function:function-commands"), "real settings revocation completes")
    assert((await page.evaluate(id => window.api.mods.commands(id), controlThreadId))
      .some(entry => entry.modId === "function:host-foundation"))
    await page.getByRole("button", { name: "返回应用", exact: true }).click()
    await select("Registered tools")
    await openModsResults(page)
    assert.deepEqual(await page.evaluate(id => window.api.mods.turnNotices(id), registryThread), [])
    await until(async () => await page.locator("[data-function-turn-notices]").count() === 0,
      "old registry turn notices disappear")
    await above().getByRole("button", { name: "Site increment", exact: true }).waitFor()
    await above().getByRole("textbox", { name: "Site note", exact: true }).waitFor()
    evidence.siteBeforeSend = await above().innerText()
    assert(String(evidence.siteBeforeSend).includes("SITE_ABOVE count:0"),
      "The surviving real AbovePrompt provider renders in the original registry after revocation")
    await installRegisteredRevocationDiagnostics(page)
    const beforeRemoved = requests.length
    try {
      await page.locator("textarea.composer-textarea")
        .fill("[mods-registered-removed] 请确认撤权后的工具列表。")
      await page.locator("form").filter({ has: page.locator("textarea.composer-textarea") })
        .locator('button[type="submit"]').click()
      await page.getByText("REGISTERED_TOOL_REMOVED_OK", { exact: true }).first().waitFor({ timeout: 30000 })
      const removed = requests.slice(beforeRemoved)
      assert(removed.length > 0)
      assert(removed.every(request => !schemas(request).some(tool => tool.name === toolName)))
      evidence.removed = removed
      evidence.status = "passed"
      pass("focused restart/settings revocation sends once in the original registry thread and excludes the retired tool schema")
    } finally {
      evidence.prompt = await collectRegisteredRevocationDiagnostics(page)
      evidence.requestsAfterClick = requests.slice(beforeRemoved)
      try { await page.screenshot({ path: join(artifacts, "registered-revocation-final.png") }) }
      catch (error) {
        evidence.screenshotError = String(error)
        console.error("Unable to capture registered revocation diagnostics", error)
      }
    }
  } catch (error) {
    evidence.status = "failed"
    evidence.error = error instanceof Error ? error.stack : String(error)
    throw error
  } finally {
    evidence.registryThread = registryThread
    evidence.controlThread = controlThreadId
    try { writeFileSync(join(artifacts, "registered-revocation-focus.json"), JSON.stringify(evidence, null, 2)) }
    catch (error) { console.error("Unable to preserve registered revocation evidence", error) }
  }
}
